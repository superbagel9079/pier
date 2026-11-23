//! The transcript rebuilt from Pi's events (testable without a window).

use crate::pi::process::Incoming;
use serde_json::{Value, json};
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
    pub running: bool,
    pub exited: bool,
    /// Messages Pi has accepted but not yet read (steer / follow-up), from `queue_update`.
    pub queued: Vec<String>,
    /// Queued texts handed back by `clear_queue`, for the UI to put back in the editor.
    pub restored: Vec<String>,
    pub stderr: Vec<String>,
    /// Extension status lines (`setStatus`), keyed by statusKey.
    pub status: std::collections::BTreeMap<String, String>,
    /// Records the transcript needs sent back to Pi (dialog replies); the UI flushes them.
    pub outbox: Vec<Value>,
    /// contentIndex -> entry index, for the assistant message being streamed.
    blocks: HashMap<u64, usize>,
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join(""),
        _ => String::new(),
    }
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().into_iter().flatten().map(|s| s.as_str().map(str::to_owned).unwrap_or_else(|| text_of(&s["content"]))).collect()
}

impl Transcript {
    fn push(&mut self, kind: Kind, text: impl Into<String>) -> usize {
        self.entries.push(Entry { kind, text: text.into() });
        self.entries.len() - 1
    }

    pub fn apply(&mut self, msg: Incoming) {
        match msg {
            Incoming::Event(v) => self.apply_event(&v),
            Incoming::Stderr(line) => {
                self.stderr.push(line);
                if self.stderr.len() > 200 {
                    self.stderr.remove(0);
                }
            }
            Incoming::Exited => {
                self.running = false;
                self.exited = true;
                self.queued.clear();
                self.push(Kind::Error, "Le process Pi s'est arrêté.");
            }
        }
    }

    pub fn apply_event(&mut self, v: &Value) {
        match v["type"].as_str().unwrap_or_default() {
            "agent_start" => self.running = true,
            "agent_settled" => {
                self.running = false;
                if v["aborted"].as_bool() == Some(true) {
                    self.push(Kind::Notice, "Run interrompu.");
                }
            }
            "message_start" => {
                let m = &v["message"];
                match m["role"].as_str() {
                    // User messages appear when Pi actually reads them, so a queued steer shows up at the right place.
                    Some("user") => {
                        self.push(Kind::User, text_of(&m["content"]));
                    }
                    Some("assistant") => self.blocks.clear(),
                    _ => {}
                }
            }
            "message_update" => self.apply_stream(&v["assistantMessageEvent"]),
            "message_end" => {
                let m = &v["message"];
                if m["role"] == "assistant" && m["stopReason"] == "error" {
                    let err = m["errorMessage"].as_str().unwrap_or("erreur provider");
                    self.push(Kind::Error, err);
                }
            }
            "tool_execution_end" => {
                let name = v["toolName"].as_str().unwrap_or("?");
                let status = if v["isError"].as_bool() == Some(true) { "erreur" } else { "ok" };
                self.push(Kind::Tool, format!("{name} → {status}"));
            }
            "queue_update" => {
                self.queued = strings(&v["steering"]);
                self.queued.extend(strings(&v["followUp"]));
            }
            "auto_retry_start" => {
                let n = v["attempt"].as_u64().unwrap_or(0);
                self.push(Kind::Notice, format!("Nouvel essai {n}…"));
            }
            "response" => {
                if v["success"].as_bool() == Some(false) {
                    let cmd = v["command"].as_str().unwrap_or("?");
                    let err = v["error"].as_str().unwrap_or("échec");
                    self.push(Kind::Error, format!("{cmd} : {err}"));
                } else if v["command"] == "clear_queue" {
                    self.restored = strings(&v["data"]["steering"]);
                    self.restored.extend(strings(&v["data"]["followUp"]));
                }
            }
            "extension_ui_request" => match v["method"].as_str().unwrap_or_default() {
                // Dialogs block Pi until answered.
                // shortcut: refused automatically (fail-closed) until approvals land in v1 (A.6).
                "select" | "confirm" | "input" | "editor" => {
                    let title = v["title"].as_str().unwrap_or("?");
                    self.push(Kind::Notice, format!("Dialogue « {title} » refusé (approbations pas encore gérées)."));
                    self.outbox.push(json!({"type": "extension_ui_response", "id": v["id"], "cancelled": true}));
                }
                "setStatus" => {
                    let key = v["statusKey"].as_str().unwrap_or_default().to_owned();
                    match v["statusText"].as_str() {
                        Some(text) => self.status.insert(key, text.to_owned()),
                        None => self.status.remove(&key),
                    };
                }
                "notify" => {
                    let text = v["message"].as_str().unwrap_or_default();
                    self.push(Kind::Notice, text);
                }
                _ => {} // setWidget, setTitle, set_editor_text: not shown in the spike
            },
            _ => {}
        }
    }

    fn apply_stream(&mut self, e: &Value) {
        let idx = e["contentIndex"].as_u64().unwrap_or(0);
        match e["type"].as_str().unwrap_or_default() {
            "text_start" => {
                let i = self.push(Kind::Assistant, "");
                self.blocks.insert(idx, i);
            }
            "thinking_start" => {
                let i = self.push(Kind::Thinking, "");
                self.blocks.insert(idx, i);
            }
            "toolcall_start" => {
                let name = e["toolName"].as_str().unwrap_or("?");
                let i = self.push(Kind::Tool, format!("{name} "));
                self.blocks.insert(idx, i);
            }
            "text_delta" | "thinking_delta" | "toolcall_delta" => {
                if let Some(&i) = self.blocks.get(&idx) {
                    self.entries[i].text.push_str(e["delta"].as_str().unwrap_or_default());
                }
            }
            "text_end" | "thinking_end" => {
                if let (Some(&i), Some(c)) = (self.blocks.get(&idx), e["content"].as_str()) {
                    self.entries[i].text = c.to_owned();
                }
            }
            "toolcall_end" => {
                if let Some(&i) = self.blocks.get(&idx) {
                    let tc = &e["toolCall"];
                    self.entries[i].text = format!("{} {}", tc["name"].as_str().unwrap_or("?"), tc["arguments"]);
                }
            }
            _ => {}
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
        assert!(t.running);
        let kinds: Vec<_> = t.entries.iter().map(|e| (e.kind, e.text.as_str())).collect();
        assert_eq!(kinds, [(Kind::User, "salut"), (Kind::Thinking, "hmm"), (Kind::Assistant, "Bonjour")]);

        feed(
            &mut t,
            &[
                r#"{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":1,"content":"Bonjour !"}}"#,
                r#"{"type":"agent_settled","aborted":true}"#,
            ],
        );
        assert!(!t.running);
        assert_eq!(t.entries[2].text, "Bonjour !");
        assert_eq!(t.entries.last().unwrap().kind, Kind::Notice);
    }

    #[test]
    fn queue_errors_and_cleared_queue_are_surfaced() {
        let mut t = Transcript::default();
        feed(
            &mut t,
            &[
                r#"{"type":"queue_update","steering":["stop"],"followUp":[]}"#,
                r#"{"type":"response","command":"clear_queue","success":true,"data":{"steering":["stop"],"followUp":["ensuite"]}}"#,
                r#"{"type":"response","command":"prompt","success":false,"error":"busy"}"#,
                r#"{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"403"}}"#,
            ],
        );
        assert_eq!(t.queued, ["stop"]);
        assert_eq!(t.restored, ["stop", "ensuite"]);
        let errs: Vec<_> = t.entries.iter().filter(|e| e.kind == Kind::Error).map(|e| e.text.as_str()).collect();
        assert_eq!(errs, ["prompt : busy", "403"]);
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
        assert_eq!(t.outbox, [json!({"type": "extension_ui_response", "id": "u1", "cancelled": true})]);
        assert_eq!(t.status.get("cost").map(String::as_str), Some("$0"));
        assert_eq!(t.entries.len(), 1);
        feed(&mut t, &[r#"{"type":"extension_ui_request","id":"u4","method":"setStatus","statusKey":"cost"}"#]);
        assert!(t.status.is_empty());
    }
}
