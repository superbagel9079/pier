//! Tool approvals: the queue of confirm dialogs from Pier's extension, answered by the user, by expiry, or dropped.

use super::{Kind, Transcript};
use crate::pi::protocol::Command;
use crate::session::journal::Record;
use crate::session::state::State;
use std::time::{Duration, Instant};

/// Expire before Pi does, so an approval sent at the last second is never ignored by Pi while Pier shows it as granted.
const EXPIRY_MARGIN: Duration = Duration::from_secs(1);
/// A new approval at the front ignores clicks this long, so a double-click meant for the previous one cannot approve it.
pub const ARM_DELAY: Duration = Duration::from_millis(400);
/// First line the approval extension puts in the message when a target is outside the working folder.
const OUTSIDE_PREFIX: &str = "⚠ Hors du dossier de travail";
/// Line after which the extension puts a diff preview of a write or edit.
const DIFF_MARK: &str = "\n⟦aperçu des modifications⟧\n";

/// A tool call waiting for the user's decision.
#[derive(Debug, Clone)]
pub struct Approval {
    pub id: String,
    pub title: String,
    pub message: String,
    /// The target lies outside the working folder, as reported by Pier's extension.
    pub outside: Option<String>,
    pub deadline: Option<Instant>,
    /// When it reached the front of the queue, i.e. when the user could first see it.
    pub front_since: Instant,
    /// Unified diff preview of a write or edit, computed by the extension before anything changes.
    pub diff: Option<String>,
}

/// Splits the extension's outside-folder warning line off the dialog message.
fn split_outside(message: &str) -> (Option<String>, String) {
    match message.split_once('\n') {
        Some((first, rest)) if first.starts_with(OUTSIDE_PREFIX) => (Some(first.to_owned()), rest.to_owned()),
        _ => (None, message.to_owned()),
    }
}

impl Transcript {
    /// A confirm dialog from Pi. `at`: when its line was read; the deadline counts from there, like Pi's own timer.
    pub(super) fn request_approval(&mut self, id: &str, title: &str, message: &str, timeout: Option<u64>, at: Instant) {
        let deadline = timeout.map(|ms| at + Duration::from_millis(ms).saturating_sub(EXPIRY_MARGIN));
        self.journal.push(Record::ApprovalRequested {
            id: id.to_owned(),
            title: title.to_owned(),
            detail: message.to_owned(),
            timeout_ms: timeout,
        });
        let (message, diff) = match message.split_once(DIFF_MARK) {
            Some((m, d)) => (m, Some(d.to_owned())),
            None => (message, None),
        };
        let (outside, message) = split_outside(message);
        let front_since = Instant::now();
        let approval = Approval { id: id.to_owned(), title: title.to_owned(), message, outside, deadline, front_since, diff };
        self.approvals.push_back(approval);
        if self.state == State::Running {
            self.state = State::Blocked;
        }
    }

    /// Answers approval `id`, only if it is the one shown (the front of the queue). Returns whether it was answered.
    pub fn answer(&mut self, id: &str, approved: bool) -> bool {
        if self.approvals.front().is_none_or(|a| a.id != id) {
            return false;
        }
        if approved {
            self.resolve(true, "autorisé", "allowed");
        } else {
            self.resolve(false, "refusé", "refused");
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
            self.resolve(false, "refusé (délai expiré)", "expired");
        }
    }

    fn resolve(&mut self, approved: bool, verdict: &str, decision: &'static str) {
        let Some(a) = self.approvals.pop_front() else { return };
        self.outbox.push(Command::confirm(&a.id, approved));
        self.journal.push(Record::ApprovalDecided { id: a.id.clone(), decision });
        self.push(Kind::Notice, format!("{} {verdict}", a.title.trim_end_matches(" ?")));
        if let Some(next) = self.approvals.front_mut() {
            next.front_since = Instant::now();
        }
        if self.approvals.is_empty() && self.state == State::Blocked {
            self.state = State::Running;
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
