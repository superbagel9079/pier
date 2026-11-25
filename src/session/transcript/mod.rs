//! The transcript rebuilt from Pi's events (testable without a window). Tool approvals live in `approvals`.

mod approvals;

pub use approvals::{ARM_DELAY, Approval};

use super::diff;
use super::journal::Record;
use super::state::State;
use crate::pi::process::Incoming;
use crate::pi::protocol::{
    AssistantPart, ClearedQueue, Command, Event, ForkMessage, HistoryMessage, ModelInfo, PiCommand, Queued, Role, SessionStats, StateData,
    StreamEvent, UiRequest, patch_of,
};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::time::Instant;

/// Status key set by Pier's approval extension once it is active in Pi.
pub const SUPERVISION_KEY: &str = "pier-supervision";
/// Permission modes of Pier's extension: the key `/pier-mode` takes, and the label it reports as its status.
pub const MODES: [(&str, &str); 3] = [("supervised", "Supervised"), ("accept-edits", "Accept edits"), ("plan", "Plan (read-only)")];

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    User,
    Assistant,
    Thinking,
    Tool,
    Notice,
    Error,
    /// The project's files saved at this point (`Entry::checkpoint`), with a Restore button.
    Checkpoint,
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub kind: Kind,
    pub text: String,
    /// For tool entries: the call id, linking a call to its result.
    pub tool_id: Option<String>,
    /// For a tool call: `Some(true)` once it ran fine, `Some(false)` if it failed or was refused.
    pub ok: Option<bool>,
    /// For an `edit` that ran: the exact unified patch Pi reports.
    pub diff: Option<String>,
    /// Lines added and removed in diff, counted once.
    pub diff_counts: (usize, usize),
    /// For a checkpoint entry: its id in the folder's checkpoint repository.
    pub checkpoint: Option<String>,
    /// For a checkpoint taken before a message: that message's text (what Fork pairs it by).
    pub before: Option<String>,
}

impl Entry {
    pub fn new(kind: Kind, text: impl Into<String>) -> Self {
        Self { kind, text: text.into(), tool_id: None, ok: None, diff: None, diff_counts: (0, 0), checkpoint: None, before: None }
    }
}

/// Lines of an edit's patch kept for the whole session (the full patch stays in Pi's session file).
const PATCH_MAX_LINES: usize = 3000;
/// Tool call text kept for display; the full arguments (a whole written file) stay in Pi's session file.
const TOOL_TEXT_MAX: usize = 2000;

/// Stderr lines kept, and the length of one: an unreadable event is logged whole.
const STDERR_LINES: usize = 200;
const STDERR_LINE_MAX: usize = 2000;

fn cap(text: String) -> String {
    crate::text::cap_bytes(text, TOOL_TEXT_MAX)
}

/// The state of one Pi session, rebuilt from its events. Outside the core it is read through the accessors below and
/// changed only through methods (here or on `Tab`); the queue draft is the one thing the UI edits, as a form.
#[derive(Default)]
pub struct Transcript {
    pub(crate) entries: Vec<Entry>,
    pub(crate) state: State,
    /// The last assistant message of the current run ended in error.
    run_failed: bool,
    /// Messages Pi has accepted but not yet read (steer / follow-up), from `queue_update`.
    pub(crate) queued: Vec<QueueItem>,
    /// Queued texts handed back by `clear_queue`, for the UI to put back in the editor.
    pub(crate) restored: Vec<String>,
    /// The queue taken back from Pi to be edited; Pi reads none of it until it is sent back.
    pub(crate) queue_draft: Option<Vec<QueueItem>>,
    /// The next `clear_queue` answer is for editing, not for the editor.
    pub(crate) queue_edit_pending: bool,
    pub(crate) stderr: VecDeque<String>,
    /// Extension status lines (`setStatus`), keyed by statusKey.
    pub(crate) status: std::collections::BTreeMap<String, String>,
    /// Records the transcript needs sent back to Pi (dialog replies); the UI flushes them.
    pub(crate) outbox: Vec<Command>,
    /// Confirm dialogs waiting for the user, oldest first.
    pub(crate) approvals: VecDeque<Approval>,
    /// Pi's session file, from `get_state` (or the one being resumed): two Pi writing one file would corrupt it.
    pub(crate) session_file: Option<PathBuf>,
    /// Lines for the tab's journal file; the UI writes them out.
    pub(crate) journal: Vec<Record>,
    /// Current model and thinking level, from `get_state`.
    pub(crate) model: Option<ModelInfo>,
    pub(crate) thinking: Option<String>,
    /// Models Pi knows, from `get_available_models` (asked when the model menu opens).
    pub(crate) models: Vec<ModelInfo>,
    /// provider/id of each model in lowercase, for the menu's search.
    pub(crate) model_keys: Vec<String>,
    /// Thinking levels the current model accepts.
    pub(crate) thinking_levels: Vec<String>,
    /// The session's display name, from `get_state` and `session_info_changed`.
    pub(crate) session_name: Option<String>,
    /// Cost and context usage, refreshed after each assistant message and each model change.
    pub(crate) stats: Option<SessionStats>,
    /// Pi's `/` commands (extensions, prompt templates, skills), from `get_commands`.
    pub(crate) commands: Vec<PiCommand>,
    /// User messages a fork can start from, from `get_fork_messages` (asked when the Fork menu opens).
    pub(crate) fork_messages: Vec<ForkMessage>,
    /// A fork just switched the session: the history about to load is the fork's, not a resume.
    forked: bool,
    /// Checkpoint entry kept across a fork (the undo point of a restore made for it), shown after the fork's history.
    carried: Option<Entry>,
    /// contentIndex -> entry index, for the assistant message being streamed.
    blocks: HashMap<u64, usize>,
    /// State to return to once the approval queue empties (an approval can arrive outside a run).
    blocked_from: Option<State>,
}

/// Read-only view for the UI and the live tests.
impl Transcript {
    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }
    pub fn state(&self) -> State {
        self.state
    }
    /// Messages Pi has accepted but not yet read.
    pub fn queued(&self) -> &[QueueItem] {
        &self.queued
    }
    /// Queued texts handed back by `clear_queue`, not yet put back in the editor.
    pub fn restored(&self) -> &[String] {
        &self.restored
    }
    pub fn queue_draft(&self) -> Option<&[QueueItem]> {
        self.queue_draft.as_deref()
    }
    /// The queue taken back for editing, to change in place before sending it back.
    pub fn queue_draft_mut(&mut self) -> Option<&mut Vec<QueueItem>> {
        self.queue_draft.as_mut()
    }
    pub fn queue_edit_pending(&self) -> bool {
        self.queue_edit_pending
    }
    pub fn stderr(&self) -> &VecDeque<String> {
        &self.stderr
    }
    pub fn status(&self) -> &std::collections::BTreeMap<String, String> {
        &self.status
    }
    pub fn approvals(&self) -> &VecDeque<Approval> {
        &self.approvals
    }
    pub fn session_file(&self) -> Option<&PathBuf> {
        self.session_file.as_ref()
    }
    /// Journal lines not written out yet.
    pub fn journal(&self) -> &[Record] {
        &self.journal
    }
    pub fn model(&self) -> Option<&ModelInfo> {
        self.model.as_ref()
    }
    pub fn thinking(&self) -> Option<&str> {
        self.thinking.as_deref()
    }
    pub fn models(&self) -> &[ModelInfo] {
        &self.models
    }
    pub fn model_keys(&self) -> &[String] {
        &self.model_keys
    }
    pub fn thinking_levels(&self) -> &[String] {
        &self.thinking_levels
    }
    pub fn session_name(&self) -> Option<&str> {
        self.session_name.as_deref()
    }
    pub fn stats(&self) -> Option<&SessionStats> {
        self.stats.as_ref()
    }
    pub fn commands(&self) -> &[PiCommand] {
        &self.commands
    }
    pub fn fork_messages(&self) -> &[ForkMessage] {
        &self.fork_messages
    }
    /// The replies to send to Pi; whoever drives Pi sends them.
    pub fn take_outbox(&mut self) -> Vec<Command> {
        std::mem::take(&mut self.outbox)
    }
}

fn texts(steering: &[Queued], follow_up: &[Queued]) -> Vec<String> {
    steering.iter().chain(follow_up).map(Queued::text).collect()
}

/// A message waiting in Pi's queue.
#[derive(Debug, Clone, PartialEq)]
pub struct QueueItem {
    pub text: String,
    /// A follow-up (read when Pi is done), not a steer (read after the current tool calls).
    pub after: bool,
}

fn items(steering: &[Queued], follow_up: &[Queued]) -> Vec<QueueItem> {
    let steers = steering.iter().map(|q| QueueItem { text: q.text(), after: false });
    steers.chain(follow_up.iter().map(|q| QueueItem { text: q.text(), after: true })).collect()
}

impl Transcript {
    /// A line telling the user something went wrong.
    pub fn error(&mut self, text: impl Into<String>) {
        self.push(Kind::Error, text);
    }

    /// A line telling the user what happened.
    pub fn notice(&mut self, text: impl Into<String>) {
        self.push(Kind::Notice, text);
    }

    fn push(&mut self, kind: Kind, text: impl Into<String>) -> usize {
        self.entries.push(Entry::new(kind, text));
        self.entries.len() - 1
    }

    /// True only once Pier's approval extension has reported in; until then tools may run unasked.
    pub fn supervised(&self) -> bool {
        self.status.contains_key(SUPERVISION_KEY)
    }

    pub fn apply(&mut self, msg: Incoming) {
        match msg {
            Incoming::Event(ev, at) => self.apply_event_at(&ev, at),
            Incoming::Stderr(line) => {
                self.stderr.push_back(crate::text::cap_bytes(line, STDERR_LINE_MAX));
                if self.stderr.len() > STDERR_LINES {
                    self.stderr.pop_front();
                }
            }
            Incoming::Exited => {
                self.state = State::Crashed;
                self.queued.clear();
                self.drop_approvals(false);
                self.journal.push(Record::PiExited);
                self.push(Kind::Error, "The Pi process exited.");
            }
        }
    }

    pub fn apply_event(&mut self, ev: &Event) {
        self.apply_event_at(ev, Instant::now());
    }

    /// `at`: when Pi's line was read; dialog deadlines count from there, like Pi's own timer.
    pub fn apply_event_at(&mut self, ev: &Event, at: Instant) {
        if *ev == Event::AgentStart {
            self.run_failed = false;
            self.journal.push(Record::RunStarted);
        }
        self.state = self.state.on_event(ev, self.run_failed);
        if matches!(ev, Event::AgentSettled { .. }) {
            // Pi no longer waits on these (abort or its own timeout); answering them later would be meaningless.
            self.drop_approvals(true);
            self.blocked_from = None;
            let outcome = match self.state {
                State::Stopped => "stopped",
                State::Failed => "failed",
                _ => "completed",
            };
            self.journal.push(Record::RunEnded { outcome });
            // Something may have switched the session file meanwhile; the "already open" guard needs the current one.
            self.outbox.extend([Command::GetState, Command::GetSessionStats]);
        }
        match ev {
            Event::AgentSettled { aborted: true } => {
                self.push(Kind::Notice, "Run stopped.");
            }
            Event::MessageStart { message } => match message.role {
                // User messages appear when Pi actually reads them, so a queued steer shows up at the right place.
                Role::User => {
                    self.push(Kind::User, message.content.text_and_images());
                }
                Role::Assistant => self.blocks.clear(),
                Role::Other => {}
            },
            Event::MessageUpdate { assistant_message_event } => self.apply_stream(assistant_message_event),
            // Each finished answer moves the context gauge, even in the middle of a long run.
            Event::MessageEnd { message } if message.role == Role::Assistant && !message.is_error() => {
                self.outbox.push(Command::GetSessionStats);
            }
            Event::MessageEnd { message } if message.is_error() => {
                self.run_failed = true;
                let err = message.error_message.as_deref().unwrap_or("provider error");
                self.push(Kind::Error, err);
            }
            Event::ToolExecutionEnd { tool_call_id, tool_name, is_error, result } => {
                let patch = result.as_ref().and_then(|r| patch_of(&r.details));
                self.tool_result(tool_call_id.as_deref(), tool_name, *is_error, patch);
            }
            Event::QueueUpdate { steering, follow_up } => self.queued = items(steering, follow_up),
            Event::AutoRetryStart { attempt } => {
                self.push(Kind::Notice, format!("Retry {attempt}…"));
            }
            Event::Response { command, success: false, error, .. } => {
                if command == "clear_queue" {
                    self.queue_edit_pending = false; // or Edit queue stays disabled, and the next Stop goes astray
                }
                let err = error.as_deref().unwrap_or("failed");
                self.push(Kind::Error, format!("{command}: {err}"));
            }
            Event::Response { command, data, .. } if command == "clear_queue" => {
                let q: ClearedQueue = serde_json::from_value(data.clone()).unwrap_or_default();
                if std::mem::take(&mut self.queue_edit_pending) {
                    let taken = items(&q.steering, &q.follow_up);
                    if taken.is_empty() {
                        self.push(Kind::Notice, "Nothing left to edit: Pi had already read the queue.");
                    } else {
                        self.queue_draft.get_or_insert_default().extend(taken);
                    }
                } else {
                    // Appended: a second Stop's empty answer must not erase what the first one gave back.
                    self.restored.extend(texts(&q.steering, &q.follow_up));
                }
            }
            Event::Response { command, data, .. } if command == "get_state" => {
                let s: StateData = serde_json::from_value(data.clone()).unwrap_or_default();
                if let Some(f) = s.session_file.map(PathBuf::from)
                    && self.session_file.as_ref() != Some(&f)
                {
                    self.journal.push(Record::SessionFile { path: f.clone() });
                    self.session_file = Some(f);
                }
                self.model = s.model.or(self.model.take());
                self.thinking = s.thinking_level.or(self.thinking.take());
                self.session_name = s.session_name; // absent means no name: not "keep the old one"
            }
            Event::Response { command, data, .. } if command == "get_available_models" => {
                self.models = serde_json::from_value(data["models"].clone()).unwrap_or_default();
                self.models.sort_by_key(ModelInfo::key);
                self.model_keys = self.models.iter().map(|m| m.key().to_lowercase()).collect();
            }
            Event::Response { command, data, .. } if command == "get_available_thinking_levels" => {
                self.thinking_levels = serde_json::from_value(data["levels"].clone()).unwrap_or_default();
            }
            Event::Response { command, .. } if command == "set_model" || command == "set_thinking_level" => {
                // Pi may clamp the thinking level and the context window changes: read both back.
                self.outbox.extend([Command::GetState, Command::GetAvailableThinkingLevels, Command::GetSessionStats]);
            }
            Event::Response { command, .. } if command == "set_session_name" => self.outbox.push(Command::GetState),
            Event::Response { command, data, .. } if command == "get_commands" => {
                self.commands = serde_json::from_value(data["commands"].clone()).unwrap_or_default();
                self.commands.sort_by(|a, b| a.name.cmp(&b.name));
            }
            Event::Response { command, data, .. } if command == "get_session_stats" => {
                self.stats = serde_json::from_value(data.clone()).ok();
            }
            Event::Response { command, data, .. } if command == "get_fork_messages" => {
                self.fork_messages = serde_json::from_value(data["messages"].clone()).unwrap_or_default();
            }
            Event::Response { command, data, .. } if command == "fork" => self.forked_to(data),
            Event::ThinkingLevelChanged { level } => self.thinking = Some(level.clone()),
            Event::SessionInfoChanged { name } => self.session_name = name.clone(),
            Event::Response { command, data, .. } if command == "get_messages" => self.load_history(&data["messages"]),
            Event::ExtensionUiRequest(req) => match req {
                // Dialogs block Pi until answered.
                UiRequest::Confirm { id, title, message, timeout } => self.request_approval(id, title, message, *timeout, at),
                // shortcut: other dialogs are refused (fail-closed), add them when an extension Pier relies on needs them.
                UiRequest::Select { id, title } | UiRequest::Input { id, title } | UiRequest::Editor { id, title } => {
                    self.push(Kind::Notice, format!("Dialog \"{title}\" denied (type not handled by Pier)."));
                    self.outbox.push(Command::cancel_dialog(id));
                }
                UiRequest::SetStatus { status_key, status_text } => {
                    match status_text {
                        Some(text) => self.status.insert(status_key.clone(), text.clone()),
                        None => self.status.remove(status_key),
                    };
                }
                UiRequest::Notify { message } => self.notified(message),
                UiRequest::Other => {}
            },
            _ => {}
        }
    }

    /// Shows a resumed session's past messages, in the same entry kinds as a live run.
    fn load_history(&mut self, messages: &serde_json::Value) {
        let list = messages.as_array().map(Vec::as_slice).unwrap_or_default();
        for raw in list {
            match <HistoryMessage as serde::Deserialize>::deserialize(raw) {
                Ok(HistoryMessage::User { content }) => {
                    self.push(Kind::User, content.text_and_images());
                }
                Ok(HistoryMessage::Assistant { content, stop_reason, error_message }) => {
                    for part in content {
                        match part {
                            AssistantPart::Text { text } => self.push(Kind::Assistant, text),
                            AssistantPart::Thinking { thinking } => self.push(Kind::Thinking, thinking),
                            AssistantPart::ToolCall { id, name, arguments } => {
                                let i = self.push(Kind::Tool, cap(format!("{name} {arguments}")));
                                self.entries[i].tool_id = id;
                                i
                            }
                            AssistantPart::Other => continue,
                        };
                    }
                    if stop_reason.as_deref() == Some("error") {
                        self.push(Kind::Error, error_message.unwrap_or_else(|| "provider error".into()));
                    }
                }
                Ok(HistoryMessage::ToolResult { tool_call_id, tool_name, is_error, details }) => {
                    self.tool_result(tool_call_id.as_deref(), &tool_name, is_error, patch_of(&details));
                }
                Ok(HistoryMessage::Other) => {}
                Err(e) => {
                    self.push(Kind::Notice, format!("Unreadable history message ({e})."));
                }
            }
        }
        if std::mem::take(&mut self.forked) {
            self.push(Kind::Notice, "Forked: a new session goes on from here; the original is in Resume.");
            self.entries.extend(self.carried.take());
        } else if !list.is_empty() {
            self.push(Kind::Notice, "Session resumed.");
        }
    }

    /// A notification: a decision Pier's extension took without asking (a permission mode), or plain text.
    fn notified(&mut self, message: &str) {
        #[derive(serde::Deserialize)]
        struct Auto {
            pier: u32,
            auto: String,
            tool: String,
            detail: String,
            mode: String,
        }
        match serde_json::from_str::<Auto>(message) {
            Ok(a) if a.pier == approvals::ENVELOPE_VERSION && (a.auto == "allowed" || a.auto == "denied") => {
                let first = a.detail.lines().next().unwrap_or_default();
                self.push(Kind::Notice, cap(format!("{} {first} → {} ({})", a.tool, a.auto, a.mode)));
                let decision = if a.auto == "allowed" { "auto-allowed" } else { "auto-denied" };
                self.journal.push(Record::AutoDecided { tool: a.tool, detail: a.detail, decision, mode: a.mode });
            }
            _ => {
                self.push(Kind::Notice, message);
            }
        }
    }

    /// Pi switched to a fork: the transcript starts over from the fork's history, and the message it was forked
    /// from goes back to the editor, to be edited and sent again.
    fn forked_to(&mut self, data: &serde_json::Value) {
        if data["cancelled"].as_bool() == Some(true) {
            self.push(Kind::Notice, "Fork cancelled by an extension.");
            return;
        }
        self.journal.push(Record::Forked { from: self.session_file.clone() });
        // Files restored for this fork keep their undo point; only notices, no conversation, may follow it.
        let last = self.entries.iter().rposition(|e| matches!(e.kind, Kind::Checkpoint | Kind::User | Kind::Assistant | Kind::Tool));
        self.carried = last.filter(|&i| self.entries[i].kind == Kind::Checkpoint).map(|i| self.entries[i].clone());
        self.entries.clear();
        self.blocks.clear();
        self.queued.clear();
        self.fork_messages.clear();
        self.stats = None;
        self.forked = true;
        if let Some(text) = data["text"].as_str().filter(|t| !t.is_empty()) {
            self.restored.push(text.to_owned());
        }
        self.outbox.extend([Command::GetState, Command::GetMessages, Command::GetSessionStats]);
    }

    /// A tool finished: marks its call entry and adds a result line tagged with the call id.
    /// An edit's exact patch goes on the result line, where the transcript shows it.
    fn tool_result(&mut self, id: Option<&str>, tool_name: &str, is_error: bool, patch: Option<String>) {
        if let Some(id) = id
            && let Some(call) = self.entries.iter_mut().rev().find(|e| e.tool_id.as_deref() == Some(id) && e.ok.is_none())
        {
            call.ok = Some(!is_error);
        }
        let status = if is_error { "error" } else { "ok" };
        let i = self.push(Kind::Tool, format!("{tool_name} → {status}"));
        self.entries[i].tool_id = id.map(str::to_owned);
        self.entries[i].ok = Some(!is_error);
        let patch = patch.map(|p| diff::cap_lines(p, PATCH_MAX_LINES));
        self.entries[i].diff_counts = patch.as_deref().map(diff::counts).unwrap_or_default();
        self.entries[i].diff = patch;
    }

    fn apply_stream(&mut self, e: &StreamEvent) {
        match e {
            StreamEvent::TextStart { content_index } => {
                let i = self.push(Kind::Assistant, "");
                self.blocks.insert(*content_index, i);
            }
            StreamEvent::ThinkingStart { content_index } => {
                let i = self.push(Kind::Thinking, "");
                self.blocks.insert(*content_index, i);
            }
            StreamEvent::ToolcallStart { content_index, id, tool_name } => {
                let i = self.push(Kind::Tool, format!("{} ", tool_name.as_deref().unwrap_or("?")));
                self.entries[i].tool_id = id.clone();
                self.blocks.insert(*content_index, i);
            }
            StreamEvent::TextDelta { content_index, delta } | StreamEvent::ThinkingDelta { content_index, delta } => {
                if let Some(&i) = self.blocks.get(content_index) {
                    self.entries[i].text.push_str(delta);
                }
            }
            StreamEvent::ToolcallDelta { content_index, delta } => {
                if let Some(&i) = self.blocks.get(content_index)
                    && self.entries[i].text.len() <= TOOL_TEXT_MAX
                {
                    self.entries[i].text.push_str(delta);
                }
            }
            StreamEvent::TextEnd { content_index, content } | StreamEvent::ThinkingEnd { content_index, content } => {
                if let (Some(&i), Some(c)) = (self.blocks.get(content_index), content) {
                    self.entries[i].text = c.clone();
                }
            }
            StreamEvent::ToolcallEnd { content_index, tool_call } => {
                if let Some(&i) = self.blocks.get(content_index) {
                    self.entries[i].text = cap(format!("{} {}", tool_call.name, tool_call.arguments));
                }
            }
            StreamEvent::Other => {}
        }
    }
}

#[cfg(test)]
mod tests;
