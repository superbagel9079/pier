//! The transcript rebuilt from Pi's events (testable without a window).

use super::state::State;
use crate::pi::process::Incoming;
use crate::pi::protocol::{ClearedQueue, Command, Event, Queued, Role, StreamEvent, UiRequest};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    User,
    Assistant,
    Thinking,
    Tool,
    Notice,
    Error,
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub kind: Kind,
    pub text: String,
}

#[derive(Default)]
pub struct Transcript {
    pub entries: Vec<Entry>,
    pub state: State,
    /// The last assistant message of the current run ended in error.
    run_failed: bool,
    /// Messages Pi has accepted but not yet read (steer / follow-up), from `queue_update`.
    pub queued: Vec<String>,
    /// Queued texts handed back by `clear_queue`, for the UI to put back in the editor.
    pub restored: Vec<String>,
    pub stderr: Vec<String>,
    /// Extension status lines (`setStatus`), keyed by statusKey.
    pub status: std::collections::BTreeMap<String, String>,
    /// Records the transcript needs sent back to Pi (dialog replies); the UI flushes them.
    pub outbox: Vec<Command>,
    /// contentIndex -> entry index, for the assistant message being streamed.
    blocks: HashMap<u64, usize>,
}

fn texts(steering: &[Queued], follow_up: &[Queued]) -> Vec<String> {
    steering.iter().chain(follow_up).map(Queued::text).collect()
}

impl Transcript {
    fn push(&mut self, kind: Kind, text: impl Into<String>) -> usize {
        self.entries.push(Entry { kind, text: text.into() });
        self.entries.len() - 1
    }

    pub fn apply(&mut self, msg: Incoming) {
        match msg {
            Incoming::Event(ev) => self.apply_event(&ev),
            Incoming::Stderr(line) => {
                self.stderr.push(line);
                if self.stderr.len() > 200 {
                    self.stderr.remove(0);
                }
            }
            Incoming::Exited => {
                self.state = State::Crashed;
                self.queued.clear();
                self.push(Kind::Error, "Le process Pi s'est arrêté.");
            }
        }
    }

    pub fn apply_event(&mut self, ev: &Event) {
        if *ev == Event::AgentStart {
            self.run_failed = false;
        }
        self.state = self.state.on_event(ev, self.run_failed);
        match ev {
            Event::AgentSettled { aborted: true } => {
                self.push(Kind::Notice, "Run interrompu.");
            }
            Event::MessageStart { message } => match message.role {
                // User messages appear when Pi actually reads them, so a queued steer shows up at the right place.
                Role::User => {
                    self.push(Kind::User, message.content.text());
                }
                Role::Assistant => self.blocks.clear(),
                Role::Other => {}
            },
            Event::MessageUpdate { assistant_message_event } => self.apply_stream(assistant_message_event),
            Event::MessageEnd { message } if message.is_error() => {
                self.run_failed = true;
                let err = message.error_message.as_deref().unwrap_or("erreur provider");
                self.push(Kind::Error, err);
            }
            Event::ToolExecutionEnd { tool_name, is_error } => {
                let status = if *is_error { "erreur" } else { "ok" };
                self.push(Kind::Tool, format!("{tool_name} → {status}"));
            }
            Event::QueueUpdate { steering, follow_up } => self.queued = texts(steering, follow_up),
            Event::AutoRetryStart { attempt } => {
                self.push(Kind::Notice, format!("Nouvel essai {attempt}…"));
            }
            Event::Response { command, success: false, error, .. } => {
                let err = error.as_deref().unwrap_or("échec");
                self.push(Kind::Error, format!("{command} : {err}"));
            }
            Event::Response { command, data, .. } if command == "clear_queue" => {
                let q: ClearedQueue = serde_json::from_value(data.clone()).unwrap_or_default();
                self.restored = texts(&q.steering, &q.follow_up);
            }
            Event::ExtensionUiRequest(req) => match req {
                // Dialogs block Pi until answered.
                // shortcut: refused automatically (fail-closed) until approvals land in v1 (A.6).
                UiRequest::Select { id, title }
                | UiRequest::Confirm { id, title }
                | UiRequest::Input { id, title }
                | UiRequest::Editor { id, title } => {
                    self.push(Kind::Notice, format!("Dialogue « {title} » refusé (approbations pas encore gérées)."));
                    self.outbox.push(Command::ExtensionUiResponse { id: id.clone(), cancelled: true });
                }
                UiRequest::SetStatus { status_key, status_text } => {
                    match status_text {
                        Some(text) => self.status.insert(status_key.clone(), text.clone()),
                        None => self.status.remove(status_key),
                    };
                }
                UiRequest::Notify { message } => {
                    self.push(Kind::Notice, message.clone());
                }
                UiRequest::Other => {}
            },
            _ => {}
        }
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
            StreamEvent::ToolcallStart { content_index, tool_name } => {
                let i = self.push(Kind::Tool, format!("{} ", tool_name.as_deref().unwrap_or("?")));
                self.blocks.insert(*content_index, i);
            }
            StreamEvent::TextDelta { content_index, delta }
            | StreamEvent::ThinkingDelta { content_index, delta }
            | StreamEvent::ToolcallDelta { content_index, delta } => {
                if let Some(&i) = self.blocks.get(content_index) {
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
                    self.entries[i].text = format!("{} {}", tool_call.name, tool_call.arguments);
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
                r#"{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"salut"}]}}"#,
                r#"{"type":"message_start","message":{"role":"assistant","content":[]}}"#,
                r#"{"type":"message_update","assistantMessageEvent":{"type":"thinking_start","contentIndex":0}}"#,
                r#"{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"hmm"}}"#,
                r#"{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":1}}"#,
                r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"Bon"}}"#,
                r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"jour"}}"#,
            ],
        );
        assert_eq!(t.state, State::Running);
        let kinds: Vec<_> = t.entries.iter().map(|e| (e.kind, e.text.as_str())).collect();
        assert_eq!(kinds, [(Kind::User, "salut"), (Kind::Thinking, "hmm"), (Kind::Assistant, "Bonjour")]);

        feed(
            &mut t,
            &[
                r#"{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":1,"content":"Bonjour !"}}"#,
                r#"{"type":"agent_settled","aborted":true}"#,
            ],
        );
        assert_eq!(t.state, State::Stopped);
        assert_eq!(t.entries[2].text, "Bonjour !");
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
                r#"{"type":"response","command":"clear_queue","success":true,"data":{"steering":["stop"],"followUp":["ensuite"]}}"#,
                r#"{"type":"response","command":"prompt","success":false,"error":"busy"}"#,
                r#"{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"403"}}"#,
                r#"{"type":"agent_settled"}"#,
            ],
        );
        assert_eq!(t.queued, ["stop"]);
        assert_eq!(t.restored, ["stop", "ensuite"]);
        let errs: Vec<_> = t.entries.iter().filter(|e| e.kind == Kind::Error).map(|e| e.text.as_str()).collect();
        assert_eq!(errs, ["prompt : busy", "403"]);
        assert_eq!(t.state, State::Failed, "a run ending on a provider error is not 'completed'");
    }

    #[test]
    fn extension_dialogs_are_refused_and_status_is_kept() {
        let mut t = Transcript::default();
        feed(
            &mut t,
            &[
                r#"{"type":"extension_ui_request","id":"u1","method":"confirm","title":"Allow bash?"}"#,
                r#"{"type":"extension_ui_request","id":"u2","method":"setStatus","statusKey":"cost","statusText":"$0"}"#,
                r#"{"type":"extension_ui_request","id":"u3","method":"setWidget","widgetKey":"w"}"#,
            ],
        );
        assert_eq!(t.outbox, [Command::ExtensionUiResponse { id: "u1".into(), cancelled: true }]);
        assert_eq!(t.status.get("cost").map(String::as_str), Some("$0"));
        assert_eq!(t.entries.len(), 1);
        feed(&mut t, &[r#"{"type":"extension_ui_request","id":"u4","method":"setStatus","statusKey":"cost"}"#]);
        assert!(t.status.is_empty());
    }

    #[test]
    fn exit_is_terminal() {
        let mut t = Transcript::default();
        t.apply(Incoming::Exited);
        feed(&mut t, &[r#"{"type":"agent_start"}"#]);
        assert_eq!(t.state, State::Crashed);
    }
}
