//! Tool approvals: the queue of confirm dialogs from Pier's extension, answered by the user, by expiry, or dropped.

use super::{Kind, Transcript};
use crate::pi::protocol::Command;
use crate::session::diff;
use crate::session::journal::Record;
use crate::session::state::State;
use serde::Deserialize;
use std::time::{Duration, Instant};

/// Expire before Pi does, so an approval sent at the last second is never ignored by Pi while Pier shows it as granted.
const EXPIRY_MARGIN: Duration = Duration::from_secs(1);
/// A new approval at the front ignores clicks this long, so a double-click meant for the previous one cannot approve it.
pub const ARM_DELAY: Duration = Duration::from_millis(400);
/// Version of the structured message Pier's extension puts in the dialog.
pub(super) const ENVELOPE_VERSION: u32 = 1;

/// The structured dialog message of Pier's extension. Each part has its own field, so nothing in a command
/// (a fake warning line, a fake diff marker) can pass for something else.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    pier: u32,
    tool: String,
    #[serde(default)]
    path: Option<String>,
    detail: String,
    /// `None`: this tool's targets cannot be checked. Empty: checked, all inside the working folder.
    #[serde(default)]
    outside: Option<Vec<String>>,
    /// Shell targets are read from the command text: a hint, not a certainty.
    #[serde(default)]
    outside_guessed: bool,
    #[serde(default)]
    diff: Option<String>,
    #[serde(default)]
    risks: Vec<String>,
    #[serde(default)]
    allow_as: Option<String>,
}

/// A tool call waiting for the user's decision.
#[derive(Debug, Clone)]
pub struct Approval {
    pub id: String,
    pub title: String,
    /// The tool, when Pier's extension asks (`None` for another extension's confirm dialog).
    pub tool: Option<String>,
    /// What the user reads to decide: the command, the path next to a diff, or all the arguments.
    pub message: String,
    /// Warning when a target lies outside the working folder.
    pub outside: Option<String>,
    /// Pier cannot tell where this tool acts (MCP and extension tools).
    pub unchecked: bool,
    /// The file a write or edit targets.
    pub path: Option<String>,
    /// Another pending approval targets the same file: this preview does not include its change.
    pub same_file_pending: bool,
    pub deadline: Option<Instant>,
    /// When it reached the front of the queue, i.e. when the user could first see it.
    pub front_since: Instant,
    /// Unified diff preview of a write or edit, computed by the extension before anything changes.
    pub diff: Option<String>,
    /// Why a shell command looks dangerous, one reason per pattern found (a hint, not a guarantee).
    pub risks: Vec<String>,
    /// What "always allow" would add to the allowlist; `None` when this command can never be allowlisted.
    pub allow_as: Option<String>,
}

fn outside_warning(targets: &[String], guessed: bool) -> String {
    let how = if guessed { " (possibly, from the command text)" } else { "" };
    format!("⚠ Outside the working folder{how}: {}", targets.join(", "))
}

impl Transcript {
    /// A confirm dialog from Pi. `at`: when its line was read; the deadline counts from there, like Pi's own timer.
    /// Pier's extension sends a structured message; any other extension's text is shown as it is.
    pub(super) fn request_approval(&mut self, id: &str, title: &str, message: &str, timeout: Option<u64>, at: Instant) {
        let deadline = timeout.map(|ms| at + Duration::from_millis(ms).saturating_sub(EXPIRY_MARGIN));
        let env = serde_json::from_str::<Envelope>(message).ok().filter(|e| e.pier == ENVELOPE_VERSION);
        let (tool, message, outside, unchecked, path, diff, risks, allow_as) = match env {
            Some(e) => {
                let outside = e.outside.as_ref().filter(|t| !t.is_empty()).map(|t| outside_warning(t, e.outside_guessed));
                (Some(e.tool), e.detail, outside, e.outside.is_none(), e.path, e.diff, e.risks, e.allow_as)
            }
            None => (None, message.to_owned(), None, false, None, None, vec![], None),
        };
        // The journal keeps what was asked and how big the change is, not the diff (it can hold a file's old content).
        self.journal.push(Record::ApprovalRequested {
            id: id.to_owned(),
            title: title.to_owned(),
            detail: message.clone(),
            outside: outside.clone(),
            changes: diff.as_deref().map(|d| {
                let (added, removed) = diff::counts(d);
                format!("+{added} -{removed}")
            }),
            risks: risks.clone(),
            timeout_ms: timeout,
        });
        let same_file_pending = path.is_some() && self.approvals.iter().any(|a| a.path == path);
        let front_since = Instant::now();
        self.approvals.push_back(Approval {
            id: id.to_owned(),
            title: title.to_owned(),
            tool,
            message,
            outside,
            unchecked,
            path,
            same_file_pending,
            deadline,
            front_since,
            diff,
            risks,
            allow_as,
        });
        // Also outside a run (an extension command can ask): the tab waits on the user either way.
        if !matches!(self.state, State::Blocked | State::Crashed) {
            self.blocked_from = Some(self.state);
            self.state = State::Blocked;
        }
    }

    /// Answers approval `id`, only if it is the one shown (the front of the queue). Returns whether it was answered.
    pub fn answer(&mut self, id: &str, approved: bool) -> bool {
        if self.approvals.front().is_none_or(|a| a.id != id) {
            return false;
        }
        if approved {
            self.resolve(true, "allowed", "allowed");
        } else {
            self.resolve(false, "denied", "refused");
        }
        true
    }

    /// Whether the shown approval has been on screen long enough to take a click.
    pub fn can_answer(&self, now: Instant) -> bool {
        self.approvals.front().is_some_and(|a| now >= a.front_since + ARM_DELAY)
    }

    /// Refuses the oldest approval once its deadline has passed (Pi refuses it on its side too).
    pub fn expire(&mut self, now: Instant) {
        if self.approvals.front().and_then(|a| a.deadline).is_some_and(|d| now >= d) {
            self.resolve(false, "denied (timed out)", "expired");
        }
    }

    fn resolve(&mut self, approved: bool, verdict: &str, decision: &'static str) {
        let Some(a) = self.approvals.pop_front() else { return };
        self.outbox.push(Command::confirm(&a.id, approved));
        self.journal.push(Record::ApprovalDecided { id: a.id.clone(), decision });
        let notice = match &a.tool {
            Some(tool) => format!("{tool}: {verdict}"),
            None => format!("{} → {verdict}", a.title), // another extension's dialog: its own title
        };
        self.push(Kind::Notice, notice);
        if let Some(next) = self.approvals.front_mut() {
            next.front_since = Instant::now();
        }
        if self.approvals.is_empty() && self.state == State::Blocked {
            self.state = self.blocked_from.take().unwrap_or(State::Running);
        }
    }

    /// `answer_pi`: tell Pi too, in case some dialog still waits (not when Pi is gone).
    pub(super) fn drop_approvals(&mut self, answer_pi: bool) {
        for a in std::mem::take(&mut self.approvals) {
            if answer_pi {
                self.outbox.push(Command::cancel_dialog(&a.id));
            }
            self.journal.push(Record::ApprovalDecided { id: a.id, decision: "dropped" });
        }
    }
}
