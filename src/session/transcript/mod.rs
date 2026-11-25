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
/// Suggestions shown at once by the `/` palette; typing narrows the rest.
pub const PALETTE_MAX: usize = 8;

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
    /// For a checkpoint entry: its id in the folder's checkpoint repository.
    pub checkpoint: Option<String>,
    /// For a checkpoint taken before a message: that message's text (what Fork pairs it by).
    pub before: Option<String>,
}

impl Entry {
    pub fn new(kind: Kind, text: impl Into<String>) -> Self {
        Self { kind, text: text.into(), tool_id: None, ok: None, diff: None, checkpoint: None, before: None }
    }
}

/// Lines of an edit's patch kept for the whole session (the full patch stays in Pi's session file).
const PATCH_MAX_LINES: usize = 3000;
/// Tool call text kept for display; the full arguments (a whole written file) stay in Pi's session file.
const TOOL_TEXT_MAX: usize = 2000;

fn cap(mut text: String) -> String {
    if text.len() > TOOL_TEXT_MAX {
        let mut end = TOOL_TEXT_MAX;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str(" …");
    }
    text
}

#[derive(Default)]
pub struct Transcript {
    pub entries: Vec<Entry>,
    pub state: State,
    /// The last assistant message of the current run ended in error.
    run_failed: bool,
    /// Messages Pi has accepted but not yet read (steer / follow-up), from `queue_update`.
    pub queued: Vec<QueueItem>,
    /// Queued texts handed back by `clear_queue`, for the UI to put back in the editor.
    pub restored: Vec<String>,
    /// The queue taken back from Pi to be edited; Pi reads none of it until it is sent back.
    pub queue_draft: Option<Vec<QueueItem>>,
    /// The next `clear_queue` answer is for editing, not for the editor.
    pub queue_edit_pending: bool,
    pub stderr: Vec<String>,
    /// Extension status lines (`setStatus`), keyed by statusKey.
    pub status: std::collections::BTreeMap<String, String>,
    /// Records the transcript needs sent back to Pi (dialog replies); the UI flushes them.
    pub outbox: Vec<Command>,
    /// Confirm dialogs waiting for the user, oldest first.
    pub approvals: VecDeque<Approval>,
    /// Pi's session file, from `get_state` (or the one being resumed): two Pi writing one file would corrupt it.
    pub session_file: Option<PathBuf>,
    /// Lines for the tab's journal file; the UI writes them out.
    pub journal: Vec<Record>,
    /// Current model and thinking level, from `get_state`.
    pub model: Option<ModelInfo>,
    pub thinking: Option<String>,
    /// Models Pi knows, from `get_available_models` (asked when the model menu opens).
    pub models: Vec<ModelInfo>,
    /// Thinking levels the current model accepts.
    pub thinking_levels: Vec<String>,
    /// The session's display name, from `get_state` and `session_info_changed`.
    pub session_name: Option<String>,
    /// Cost and context usage, refreshed after each assistant message and each model change.
    pub stats: Option<SessionStats>,
    /// Pi's `/` commands (extensions, prompt templates, skills), from `get_commands`.
    pub commands: Vec<PiCommand>,
    /// User messages a fork can start from, from `get_fork_messages` (asked when the Fork menu opens).
    pub fork_messages: Vec<ForkMessage>,
    /// A fork just switched the session: the history about to load is the fork's, not a resume.
    forked: bool,
    /// Checkpoint entry kept across a fork (the undo point of a restore made for it), shown after the fork's history.
    carried: Option<Entry>,
    /// contentIndex -> entry index, for the assistant message being streamed.
    blocks: HashMap<u64, usize>,
    /// State to return to once the approval queue empties (an approval can arrive outside a run).
    blocked_from: Option<State>,
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
    fn push(&mut self, kind: Kind, text: impl Into<String>) -> usize {
        self.entries.push(Entry::new(kind, text));
        self.entries.len() - 1
    }

    /// Commands matching a typed `/partial`: names starting with it first, then names containing it.
    /// Empty once a space follows the name (the user is writing arguments).
    pub fn matching_commands(&self, input: &str) -> Vec<&PiCommand> {
        let Some(query) = input.strip_prefix('/') else { return vec![] };
        if query.contains(char::is_whitespace) {
            return vec![];
        }
        let q = query.to_lowercase();
        // Pier's own commands (the mode switch) are driven from Pier's menus, not typed.
        let (mut starts, mut contains): (Vec<_>, Vec<_>) = self
            .commands
            .iter()
            .filter(|c| !c.name.starts_with("pier-") && c.name.to_lowercase().contains(&q))
            .partition(|c| c.name.to_lowercase().starts_with(&q));
        starts.append(&mut contains);
        starts
    }

    /// True only once Pier's approval extension has reported in; until then tools may run unasked.
    pub fn supervised(&self) -> bool {
        self.status.contains_key(SUPERVISION_KEY)
    }

    pub fn apply(&mut self, msg: Incoming) {
        match msg {
            Incoming::Event(ev, at) => self.apply_event_at(&ev, at),
            Incoming::Stderr(line) => {
                self.stderr.push(line);
                if self.stderr.len() > 200 {
                    self.stderr.remove(0);
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
            match serde_json::from_value::<HistoryMessage>(raw.clone()) {
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
        self.entries[i].diff = patch.map(|p| diff::cap_lines(p, PATCH_MAX_LINES));
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
mod tests {
    use super::*;
    use crate::pi::process::parse_line;
    use std::time::Duration;

    fn feed(t: &mut Transcript, lines: &[&str]) {
        for l in lines {
            t.apply_event(&parse_line(l.as_bytes()).unwrap().unwrap());
        }
    }

    #[test]
    fn rebuilds_a_streamed_run() {
        let mut t = Transcript::default();
        feed(
            &mut t,
            &[
                r#"{"type":"agent_start"}"#,
                r#"{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}"#,
                r#"{"type":"message_start","message":{"role":"assistant","content":[]}}"#,
                r#"{"type":"message_update","assistantMessageEvent":{"type":"thinking_start","contentIndex":0}}"#,
                r#"{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"hmm"}}"#,
                r#"{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":1}}"#,
                r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"Hel"}}"#,
                r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"lo"}}"#,
            ],
        );
        assert_eq!(t.state, State::Running);
        let kinds: Vec<_> = t.entries.iter().map(|e| (e.kind, e.text.as_str())).collect();
        assert_eq!(kinds, [(Kind::User, "hello"), (Kind::Thinking, "hmm"), (Kind::Assistant, "Hello")]);

        feed(
            &mut t,
            &[
                r#"{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":1,"content":"Hello!"}}"#,
                r#"{"type":"agent_settled","aborted":true}"#,
            ],
        );
        assert_eq!(t.state, State::Stopped);
        assert_eq!(t.entries[2].text, "Hello!");
        assert_eq!(t.entries.last().unwrap().kind, Kind::Notice);
    }

    #[test]
    fn queue_errors_and_cleared_queue_are_surfaced() {
        let mut t = Transcript::default();
        feed(
            &mut t,
            &[
                r#"{"type":"agent_start"}"#,
                r#"{"type":"queue_update","steering":["stop"],"followUp":[]}"#,
                r#"{"type":"response","command":"clear_queue","success":true,"data":{"steering":["stop"],"followUp":["then this"]}}"#,
                r#"{"type":"response","command":"prompt","success":false,"error":"busy"}"#,
                r#"{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"403"}}"#,
                r#"{"type":"agent_settled"}"#,
            ],
        );
        assert_eq!(t.queued, [QueueItem { text: "stop".into(), after: false }]);
        assert_eq!(t.restored, ["stop", "then this"]);

        // Taken back for editing: kept apart, with each message's kind, not dumped into the editor.
        t.restored.clear();
        t.queue_edit_pending = true;
        feed(&mut t, &[r#"{"type":"response","command":"clear_queue","success":true,"data":{"steering":["a"],"followUp":["b"]}}"#]);
        let draft = t.queue_draft.clone().unwrap();
        assert_eq!(draft, [QueueItem { text: "a".into(), after: false }, QueueItem { text: "b".into(), after: true }]);
        assert!(t.restored.is_empty() && !t.queue_edit_pending);
        feed(&mut t, &[r#"{"type":"response","command":"clear_queue","success":true,"data":{"steering":["c"]}}"#]);
        assert_eq!(t.restored, ["c"], "a later Stop goes back to the editor as before");
        t.queue_edit_pending = true;
        feed(&mut t, &[r#"{"type":"response","command":"clear_queue","success":false,"error":"busy"}"#]);
        assert!(!t.queue_edit_pending, "a failed take-back does not leave Edit queue stuck");
        let errs: Vec<_> = t.entries.iter().filter(|e| e.kind == Kind::Error).map(|e| e.text.as_str()).collect();
        assert_eq!(errs, ["prompt: busy", "403", "clear_queue: busy"]);
        assert_eq!(t.state, State::Failed, "a run ending on a provider error is not 'completed'");
    }

    #[test]
    fn unhandled_dialogs_are_refused_and_status_is_kept() {
        let mut t = Transcript::default();
        feed(
            &mut t,
            &[
                r#"{"type":"extension_ui_request","id":"u1","method":"select","title":"Pick"}"#,
                r#"{"type":"extension_ui_request","id":"u2","method":"setStatus","statusKey":"cost","statusText":"$0"}"#,
                r#"{"type":"extension_ui_request","id":"u3","method":"setWidget","widgetKey":"w"}"#,
            ],
        );
        assert_eq!(t.outbox, [Command::cancel_dialog("u1")]);
        assert_eq!(t.status.get("cost").map(String::as_str), Some("$0"));
        assert_eq!(t.entries.len(), 1);
        feed(&mut t, &[r#"{"type":"extension_ui_request","id":"u4","method":"setStatus","statusKey":"cost"}"#]);
        assert!(t.status.is_empty());
    }

    #[test]
    fn approvals_block_until_answered_or_expired() {
        let mut t = Transcript::default();
        assert!(!t.supervised());
        feed(
            &mut t,
            &[
                r#"{"type":"extension_ui_request","id":"s","method":"setStatus","statusKey":"pier-supervision","statusText":"Supervised"}"#,
                r#"{"type":"agent_start"}"#,
                r#"{"type":"extension_ui_request","id":"a1","method":"confirm","title":"Allow bash?","message":"ls","timeout":60000}"#,
                r#"{"type":"extension_ui_request","id":"a2","method":"confirm","title":"Allow write?","message":"x.txt","timeout":60000}"#,
            ],
        );
        assert!(t.supervised());
        assert_eq!(t.state, State::Blocked);
        assert!(t.outbox.is_empty(), "nothing is answered for the user");

        assert!(t.answer("a1", true));
        assert_eq!(t.outbox, [Command::confirm("a1", true)]);
        assert_eq!(t.state, State::Blocked, "a2 still waits");

        t.expire(Instant::now());
        assert_eq!(t.approvals.len(), 1, "not expired yet");
        t.expire(Instant::now() + Duration::from_secs(59));
        assert_eq!(t.outbox, [Command::confirm("a1", true), Command::confirm("a2", false)]);
        assert_eq!(t.state, State::Running);
        assert_eq!(t.entries.last().unwrap().text, "Allow write? → denied (timed out)");

        feed(&mut t, &[r#"{"type":"extension_ui_request","id":"a3","method":"confirm","title":"Allow bash?"}"#]);
        feed(&mut t, &[r#"{"type":"agent_settled","aborted":true}"#]);
        assert!(t.approvals.is_empty(), "an aborted run drops its pending approvals");
        assert_eq!(t.state, State::Stopped);
    }

    #[test]
    fn risks_and_the_allowlist_proposal_reach_the_approval() {
        let mut t = Transcript::default();
        let env = r#"{\"pier\":1,\"tool\":\"bash\",\"detail\":\"rm -rf build\",\"outside\":[],\"outsideGuessed\":true,\"diff\":null,\"risks\":[\"deletes recursively\"],\"allowAs\":null}"#;
        let ok = r#"{\"pier\":1,\"tool\":\"bash\",\"detail\":\"cargo build\",\"outside\":[],\"diff\":null,\"risks\":[],\"allowAs\":\"cargo build\"}"#;
        feed(
            &mut t,
            &[
                &format!(r#"{{"type":"extension_ui_request","id":"a1","method":"confirm","title":"Allow bash?","message":"{env}"}}"#),
                &format!(r#"{{"type":"extension_ui_request","id":"a2","method":"confirm","title":"Allow bash?","message":"{ok}"}}"#),
            ],
        );
        assert_eq!(t.approvals[0].risks, ["deletes recursively"]);
        assert_eq!(t.approvals[0].allow_as, None);
        assert_eq!(t.approvals[1].allow_as.as_deref(), Some("cargo build"));
        assert!(matches!(&t.journal[0], Record::ApprovalRequested { risks, .. } if risks == &["deletes recursively"]));
    }

    #[test]
    fn decisions_taken_by_a_mode_are_shown_and_journaled() {
        let mut t = Transcript::default();
        let auto = r#"{\"pier\":1,\"auto\":\"allowed\",\"tool\":\"write\",\"detail\":\"src/a.rs\",\"mode\":\"Accept edits\"}"#;
        feed(
            &mut t,
            &[
                &format!(r#"{{"type":"extension_ui_request","id":"n1","method":"notify","message":"{auto}"}}"#),
                r#"{"type":"extension_ui_request","id":"n2","method":"notify","message":"{\"pier\":1,\"auto\":\"rm -rf\"}"}"#,
                r#"{"type":"response","command":"get_commands","success":true,"data":{"commands":[{"name":"pier-mode","source":"extension"},{"name":"plan","source":"prompt"}]}}"#,
            ],
        );
        assert_eq!(t.entries[0].text, "write src/a.rs → allowed (Accept edits)");
        assert_eq!(
            t.journal,
            [Record::AutoDecided {
                tool: "write".into(),
                detail: "src/a.rs".into(),
                decision: "auto-allowed",
                mode: "Accept edits".into()
            }]
        );
        assert!(t.entries[1].text.contains("rm -rf"), "anything else stays plain text, never a decision");
        let names: Vec<_> = t.matching_commands("/p").iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["plan"], "Pier's own command is not offered in the palette");
    }

    #[test]
    fn a_fork_starts_the_transcript_over_and_gives_the_message_back() {
        let mut t = Transcript::default();
        feed(
            &mut t,
            &[
                r#"{"type":"response","command":"get_state","success":true,"data":{"sessionFile":"a.jsonl"}}"#,
                r#"{"type":"message_start","message":{"role":"user","content":"one"}}"#,
                r#"{"type":"message_start","message":{"role":"user","content":"two"}}"#,
                r#"{"type":"response","command":"get_fork_messages","success":true,"data":{"messages":[{"entryId":"e1","text":"one"},{"entryId":"e2","text":"two"}]}}"#,
            ],
        );
        assert_eq!(t.fork_messages.iter().map(|m| m.entry_id.as_str()).collect::<Vec<_>>(), ["e1", "e2"]);
        t.outbox.clear();

        feed(&mut t, &[r#"{"type":"response","command":"fork","success":true,"data":{"text":"two","cancelled":false}}"#]);
        assert!(t.entries.is_empty() && t.fork_messages.is_empty());
        assert_eq!(t.restored, ["two"], "back to the editor");
        assert_eq!(t.outbox, [Command::GetState, Command::GetMessages, Command::GetSessionStats]);
        assert!(t.journal.contains(&Record::Forked { from: Some(PathBuf::from("a.jsonl")) }));

        feed(
            &mut t,
            &[
                r#"{"type":"response","command":"get_state","success":true,"data":{"sessionFile":"b.jsonl"}}"#,
                r#"{"type":"response","command":"get_messages","success":true,"data":{"messages":[{"role":"user","content":"one"}]}}"#,
            ],
        );
        assert_eq!(t.session_file, Some(PathBuf::from("b.jsonl")));
        assert_eq!(t.entries.len(), 2);
        assert!(t.entries[1].text.starts_with("Forked"), "not 'resumed': {:?}", t.entries[1].text);

        let before = t.entries.len();
        feed(&mut t, &[r#"{"type":"response","command":"fork","success":true,"data":{"cancelled":true}}"#]);
        assert_eq!(t.entries.len(), before + 1, "a cancelled fork keeps everything");
    }

    #[test]
    fn resumed_history_and_session_file() {
        let mut t = Transcript::default();
        feed(
            &mut t,
            &[
                r#"{"type":"response","command":"get_state","success":true,"data":{"sessionFile":"C:/s/a.jsonl","isStreaming":false}}"#,
                r#"{"type":"response","command":"get_messages","success":true,"data":{"messages":[
                    {"role":"system","content":""},
                    {"role":"user","content":"ls please","timestamp":1},
                    {"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"toolCall","id":"c1","name":"bash","arguments":{"command":"ls"}}],"stopReason":"toolUse"},
                    {"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[],"isError":false},
                    {"role":"assistant","content":[{"type":"text","text":"there you go"}],"stopReason":"error","errorMessage":"403"},
                    {"role":"bashExecution","command":"x"}
                ]}}"#,
            ],
        );
        assert_eq!(t.session_file, Some(PathBuf::from("C:/s/a.jsonl")));
        let got: Vec<_> = t.entries.iter().map(|e| (e.kind, e.text.as_str())).collect();
        assert_eq!(
            got,
            [
                (Kind::User, "ls please"),
                (Kind::Thinking, "hmm"),
                (Kind::Tool, r#"bash {"command":"ls"}"#),
                (Kind::Tool, "bash → ok"),
                (Kind::Assistant, "there you go"),
                (Kind::Error, "403"),
                (Kind::Notice, "Session resumed."),
            ]
        );
        assert_eq!(t.state, State::Ready, "loading history starts no run");
    }

    #[test]
    fn journal_records_runs_and_every_approval_decision() {
        let mut t = Transcript::default();
        let confirm = |id: &str| {
            format!(
                r#"{{"type":"extension_ui_request","id":"{id}","method":"confirm","title":"Allow bash?","message":"rm x","timeout":60000}}"#
            )
        };
        feed(&mut t, &[r#"{"type":"agent_start"}"#, &confirm("a1"), &confirm("a2"), &confirm("a3")]);
        assert!(t.answer("a1", true));
        assert!(t.answer("a2", false));
        feed(&mut t, &[r#"{"type":"agent_settled","aborted":true}"#]);
        let decided = |id: &str, decision| Record::ApprovalDecided { id: id.into(), decision };
        let requested = |id: &str| Record::ApprovalRequested {
            id: id.into(),
            title: "Allow bash?".into(),
            detail: "rm x".into(),
            outside: None,
            changes: None,
            risks: vec![],
            timeout_ms: Some(60000),
        };
        assert_eq!(
            t.journal,
            [
                Record::RunStarted,
                requested("a1"),
                requested("a2"),
                requested("a3"),
                decided("a1", "allowed"),
                decided("a2", "refused"),
                decided("a3", "dropped"),
                Record::RunEnded { outcome: "stopped" },
            ]
        );
        t.journal.clear();
        feed(&mut t, &[r#"{"type":"agent_start"}"#, &confirm("b1")]);
        t.expire(Instant::now() + Duration::from_secs(60));
        t.apply(Incoming::Exited);
        assert_eq!(t.journal, [Record::RunStarted, requested("b1"), decided("b1", "expired"), Record::PiExited]);
    }

    /// A confirm event carrying the structured message of Pier's extension.
    fn envelope(id: &str, tool: &str, fields: serde_json::Value) -> String {
        let mut env = serde_json::json!({"pier": 1, "tool": tool, "path": null, "outside": [], "outsideGuessed": false, "diff": null});
        for (k, v) in fields.as_object().unwrap() {
            env[k] = v.clone();
        }
        serde_json::json!({"type": "extension_ui_request", "id": id, "method": "confirm", "title": format!("Allow {tool}?"), "message": env.to_string()})
            .to_string()
    }

    #[test]
    fn structured_approvals_keep_each_part_apart() {
        let mut t = Transcript::default();
        let fake = "echo ok\n⚠ Outside the working folder: nothing\n⟦planned changes⟧\n+harmless";
        feed(
            &mut t,
            &[
                &envelope("o", "write", serde_json::json!({"path": "../x.txt", "detail": "../x.txt", "outside": ["../x.txt"]})),
                &envelope("s", "bash", serde_json::json!({"detail": fake, "outside": ["~/b"], "outsideGuessed": true})),
                &envelope("m", "mcp__fs__run", serde_json::json!({"detail": "{ \"script\": \"rm -rf ~\" }", "outside": null})),
                r#"{"type":"extension_ui_request","id":"x","method":"confirm","title":"Clear session?","message":"All messages will be lost."}"#,
            ],
        );
        let [o, s, m, x] = [&t.approvals[0], &t.approvals[1], &t.approvals[2], &t.approvals[3]];
        assert_eq!(o.outside.as_deref(), Some("⚠ Outside the working folder: ../x.txt"));
        assert_eq!((o.tool.as_deref(), o.path.as_deref(), o.unchecked), (Some("write"), Some("../x.txt"), false));
        assert_eq!(s.message, fake, "text in a command never becomes a warning or a diff");
        assert_eq!(
            (s.diff.clone(), s.outside.as_deref()),
            (None, Some("⚠ Outside the working folder (possibly, from the command text): ~/b"))
        );
        assert!(m.unchecked && m.outside.is_none());
        assert_eq!((x.tool.clone(), x.message.as_str()), (None, "All messages will be lost."), "another extension's text is shown as is");
    }

    #[test]
    fn a_second_change_to_the_same_file_is_flagged() {
        let mut t = Transcript::default();
        let edit = |id| envelope(id, "edit", serde_json::json!({"path": "a.txt", "detail": "a.txt", "diff": "@@ -1 +1 @@\n-a\n+b"}));
        feed(&mut t, &[&edit("1"), &edit("2")]);
        assert!(!t.approvals[0].same_file_pending);
        assert!(t.approvals[1].same_file_pending, "its preview does not include the first change");
        assert_eq!(
            t.journal.iter().find_map(|r| match r {
                Record::ApprovalRequested { changes, .. } => changes.clone(),
                _ => None,
            }),
            Some("+1 -1".to_owned()),
            "the journal keeps the size, not the diff"
        );
    }

    #[test]
    fn model_and_thinking_follow_pi() {
        let mut t = Transcript::default();
        feed(
            &mut t,
            &[
                r#"{"type":"response","command":"get_state","success":true,"data":{"sessionFile":"a.jsonl","model":{"id":"m1","provider":"p","name":"M1","cost":{}},"thinkingLevel":"low"}}"#,
                r#"{"type":"response","command":"get_available_models","success":true,"data":{"models":[{"id":"z","provider":"q"},{"id":"m1","provider":"p"}]}}"#,
                r#"{"type":"response","command":"get_available_thinking_levels","success":true,"data":{"levels":["off","low","high"]}}"#,
            ],
        );
        assert_eq!(t.model.as_ref().map(ModelInfo::key).as_deref(), Some("p/m1"));
        assert_eq!(t.thinking.as_deref(), Some("low"));
        assert_eq!(t.models.iter().map(ModelInfo::key).collect::<Vec<_>>(), ["p/m1", "q/z"], "sorted");
        assert_eq!(t.thinking_levels, ["off", "low", "high"]);

        feed(&mut t, &[r#"{"type":"response","command":"set_model","success":true,"data":{"id":"z","provider":"q"}}"#]);
        assert_eq!(t.outbox, [Command::GetState, Command::GetAvailableThinkingLevels, Command::GetSessionStats], "read back, don't guess");
        feed(&mut t, &[r#"{"type":"thinking_level_changed","level":"high"}"#]);
        assert_eq!(t.thinking.as_deref(), Some("high"));
        feed(&mut t, &[r#"{"type":"response","command":"get_state","success":true,"data":{"sessionFile":"a.jsonl"}}"#]);
        assert_eq!(t.model.as_ref().map(|m| m.id.as_str()), Some("m1"), "a state without model keeps the last one");
        let files = t.journal.iter().filter(|r| matches!(r, Record::SessionFile { .. })).count();
        assert_eq!(files, 1, "the session file is journaled once, not on every get_state");
    }

    #[test]
    fn a_click_only_answers_the_approval_shown() {
        let mut t = Transcript::default();
        let confirm = |id: &str| format!(r#"{{"type":"extension_ui_request","id":"{id}","method":"confirm","title":"Allow bash?"}}"#);
        feed(&mut t, &[&confirm("a"), &confirm("b")]);
        assert!(!t.can_answer(Instant::now()), "just arrived: clicks are ignored");
        assert!(t.can_answer(Instant::now() + ARM_DELAY));
        assert!(!t.answer("b", true), "b is not the one on screen");
        assert!(t.answer("a", true));
        assert!(!t.answer("a", true), "a second click on a is not passed on to b");
        assert!(!t.can_answer(Instant::now()), "b just reached the front: armed again");
        assert_eq!(t.outbox, [Command::confirm("a", true)]);

        feed(&mut t, &[r#"{"type":"agent_settled"}"#]);
        assert_eq!(
            t.outbox[1..],
            [Command::cancel_dialog("b"), Command::GetState, Command::GetSessionStats],
            "a dropped dialog is answered, and the session file is re-read after the run"
        );
    }

    #[test]
    fn tool_calls_link_to_results_and_stay_small() {
        let mut t = Transcript::default();
        let big = "x".repeat(10_000);
        feed(
            &mut t,
            &[
                r#"{"type":"message_update","assistantMessageEvent":{"type":"toolcall_start","contentIndex":0,"id":"c1","toolName":"write"}}"#,
                &format!(
                    r#"{{"type":"message_update","assistantMessageEvent":{{"type":"toolcall_end","contentIndex":0,"toolCall":{{"id":"c1","name":"write","arguments":{{"content":"{big}"}}}}}}}}"#
                ),
                r#"{"type":"tool_execution_end","toolCallId":"c1","toolName":"write","isError":true}"#,
            ],
        );
        assert_eq!(t.entries[0].tool_id.as_deref(), Some("c1"));
        assert_eq!(t.entries[0].ok, Some(false), "the call knows its result");
        assert!(t.entries[0].text.len() < 2100, "a written file is not kept whole in memory");
        assert_eq!((t.entries[1].text.as_str(), t.entries[1].tool_id.as_deref()), ("write → error", Some("c1")));

        // Two Stops: the second, empty answer must not erase the steer the first one gave back.
        feed(
            &mut t,
            &[
                r#"{"type":"response","command":"clear_queue","success":true,"data":{"steering":["keep me"],"followUp":[]}}"#,
                r#"{"type":"response","command":"clear_queue","success":true,"data":{"steering":[],"followUp":[]}}"#,
            ],
        );
        assert_eq!(t.restored, ["keep me"]);
    }

    #[test]
    fn session_stats_are_read_and_refreshed_per_answer() {
        let mut t = Transcript::default();
        feed(&mut t, &[r#"{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"stop"}}"#]);
        assert_eq!(t.outbox, [Command::GetSessionStats], "each finished answer asks for fresh numbers");
        feed(
            &mut t,
            &[
                r#"{"type":"response","command":"get_session_stats","success":true,"data":{"cost":0.45,"tokens":{"total":105000},"contextUsage":{"tokens":60000,"contextWindow":200000,"percent":30}}}"#,
            ],
        );
        let s = t.stats.clone().unwrap();
        assert_eq!(s.cost, 0.45);
        let c = s.context_usage.unwrap();
        assert_eq!((c.tokens, c.context_window, c.percent), (Some(60000), 200000, Some(30.0)));
        feed(
            &mut t,
            &[
                r#"{"type":"response","command":"get_session_stats","success":true,"data":{"cost":0.5,"contextUsage":{"tokens":null,"contextWindow":200000,"percent":null}}}"#,
            ],
        );
        assert_eq!(t.stats.unwrap().context_usage.unwrap().percent, None, "after a compaction: unknown, not 0");
    }

    #[test]
    fn slash_palette_matches_prefix_first() {
        let mut t = Transcript::default();
        feed(
            &mut t,
            &[r#"{"type":"response","command":"get_commands","success":true,"data":{"commands":[
                {"name":"skill:review","description":"Review code","source":"skill"},
                {"name":"fix-tests","description":"Fix failing tests","source":"prompt"},
                {"name":"prune","source":"extension"}
            ]}}"#],
        );
        let names = |input: &str| t.matching_commands(input).iter().map(|c| c.name.clone()).collect::<Vec<_>>();
        assert_eq!(names("/"), ["fix-tests", "prune", "skill:review"], "all, sorted");
        assert_eq!(names("/pr"), ["prune"]);
        assert_eq!(names("/RE"), ["skill:review"], "case-insensitive, matches inside the name too");
        assert_eq!(names("/t"), ["fix-tests"], "contains, not only prefix");
        assert!(names("/fix-tests now").is_empty(), "arguments being typed: palette gone");
        assert!(names("fix").is_empty(), "only after a leading /");
    }

    #[test]
    fn diffs_reach_the_approval_and_the_edit_result() {
        let mut t = Transcript::default();
        feed(
            &mut t,
            &[
                &envelope("w", "write", serde_json::json!({"path": "x", "detail": "x", "diff": "--- x\n+++ x\n@@ -0,0 +1 @@\n+hi"})),
                &envelope("b", "bash", serde_json::json!({"detail": "ls"})),
            ],
        );
        let w = &t.approvals[0];
        assert_eq!(w.message, "x", "the path stays apart from the preview");
        assert_eq!(w.diff.as_deref(), Some("--- x\n+++ x\n@@ -0,0 +1 @@\n+hi"));
        assert_eq!(t.approvals[1].diff, None);

        feed(
            &mut t,
            &[
                r#"{"type":"message_update","assistantMessageEvent":{"type":"toolcall_start","contentIndex":0,"id":"e1","toolName":"edit"}}"#,
                r#"{"type":"tool_execution_end","toolCallId":"e1","toolName":"edit","isError":false,"result":{"content":[],"details":{"diff":"x","patch":"--- a\n+++ a\n@@ -1 +1 @@\n-b\n+B"}}}"#,
                r#"{"type":"tool_execution_end","toolCallId":"b1","toolName":"bash","isError":false,"result":{"content":[],"details":{}}}"#,
            ],
        );
        let result = t.entries.iter().find(|e| e.text == "edit → ok").unwrap();
        assert_eq!(result.diff.as_deref(), Some("--- a\n+++ a\n@@ -1 +1 @@\n-b\n+B"));
        assert_eq!(t.entries.iter().find(|e| e.text == "bash → ok").unwrap().diff, None);
    }

    #[test]
    fn an_approval_outside_a_run_blocks_then_returns_to_the_previous_state() {
        let mut t = Transcript::default();
        feed(&mut t, &[r#"{"type":"extension_ui_request","id":"x","method":"confirm","title":"Allow bash?","message":"ls"}"#]);
        assert_eq!(t.state, State::Blocked, "an extension command can ask while no run is going");
        assert!(t.answer("x", false));
        assert_eq!(t.state, State::Ready, "back to where it was, not to Running");

        feed(
            &mut t,
            &[
                r#"{"type":"agent_start"}"#,
                r#"{"type":"extension_ui_request","id":"y","method":"confirm","title":"Allow bash?","message":"ls"}"#,
            ],
        );
        assert!(t.answer("y", true));
        assert_eq!(t.state, State::Running);
    }

    #[test]
    fn exit_is_terminal() {
        let mut t = Transcript::default();
        t.apply(Incoming::Exited);
        feed(&mut t, &[r#"{"type":"agent_start"}"#]);
        assert_eq!(t.state, State::Crashed);
    }
}
