//! One Pi session: a `pi --mode rpc` process spoken to in JSONL over stdio,
//! plus the transcript model rebuilt from its events (testable without a window).

use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

pub enum Incoming {
    Event(Value),
    Stderr(String),
    Exited,
}

pub struct Process {
    child: Child,
    stdin: Option<ChildStdin>,
    pub rx: Receiver<Incoming>,
    next_id: u64,
}

/// `pi` on Windows is a .ps1/.cmd shim; we run node + the launcher directly so no
/// cmd.exe sits between us and Pi.
// shortcut: paths are the default managed-install ones, add a setting when another install layout shows up.
fn pi_command() -> Command {
    let home = PathBuf::from(std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).unwrap_or_default());
    let launcher = home.join(".pi/agent/bin/pi-launcher.js");
    let bundled_node = PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default()).join("pi-node/current/node.exe");
    let mut cmd = Command::new(if bundled_node.is_file() { bundled_node } else { PathBuf::from("node") });
    cmd.arg(launcher);
    cmd
}

impl Process {
    pub fn spawn(extra_args: &[String], wake: impl Fn() + Send + Clone + 'static) -> std::io::Result<Self> {
        let mut cmd = pi_command();
        cmd.args(["--mode", "rpc"]).args(extra_args);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn()?;
        let (tx, rx) = channel();

        // stdout must be read continuously or Pi blocks on backpressure.
        let stdout = child.stdout.take().expect("piped stdout");
        let (out_tx, out_wake) = (tx.clone(), wake.clone());
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let msg = match parse_line(&buf) {
                            None => continue,
                            Some(Ok(v)) => Incoming::Event(v),
                            Some(Err(e)) => Incoming::Stderr(format!("stdout non-JSON ({e})")),
                        };
                        if out_tx.send(msg).is_err() {
                            break;
                        }
                        out_wake();
                    }
                }
            }
            let _ = out_tx.send(Incoming::Exited);
            out_wake();
        });

        let stderr = child.stderr.take().expect("piped stderr");
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if tx.send(Incoming::Stderr(line)).is_err() {
                    break;
                }
                wake();
            }
        });

        Ok(Self { stdin: child.stdin.take(), child, rx, next_id: 0 })
    }

    pub fn send(&mut self, mut cmd: Value) -> std::io::Result<()> {
        // Replies (extension_ui_response) must echo the request id; only commands get a fresh one.
        if cmd.get("id").is_none() {
            self.next_id += 1;
            cmd["id"] = json!(format!("pier-{}", self.next_id));
        }
        let stdin = self.stdin.as_mut().ok_or(std::io::ErrorKind::BrokenPipe)?;
        let mut line = serde_json::to_vec(&cmd)?;
        line.push(b'\n');
        stdin.write_all(&line)?;
        stdin.flush()
    }
}

impl Drop for Process {
    /// Closing stdin is Pi's orderly shutdown; kill only if it does not exit in time.
    fn drop(&mut self) {
        drop(self.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        // shortcut: kills the launcher only; its inner node child normally exits on the same stdin EOF. Use a Job Object if orphans show up.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Split on LF only (never U+2028/U+2029), strip an optional CR, skip blank lines.
pub fn parse_line(raw: &[u8]) -> Option<serde_json::Result<Value>> {
    let line = raw.strip_suffix(b"\n").unwrap_or(raw);
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    if line.iter().all(u8::is_ascii_whitespace) {
        return None;
    }
    Some(serde_json::from_slice(line))
}

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

    fn feed(t: &mut Transcript, lines: &[&str]) {
        for l in lines {
            t.apply_event(&parse_line(l.as_bytes()).unwrap().unwrap());
        }
    }

    #[test]
    fn framing_keeps_unicode_separators_and_strips_crlf() {
        let v = parse_line("{\"t\":\"a\u{2028}b\"}\r\n".as_bytes()).unwrap().unwrap();
        assert_eq!(v["t"], "a\u{2028}b");
        assert!(parse_line(b"  \r\n").is_none());
    }

    #[test]
    fn rebuilds_a_streamed_run() {
        let mut t = Transcript::default();
        feed(&mut t, &[
            r#"{"type":"agent_start"}"#,
            r#"{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"salut"}]}}"#,
            r#"{"type":"message_start","message":{"role":"assistant","content":[]}}"#,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"thinking_start","contentIndex":0}}"#,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"hmm"}}"#,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":1}}"#,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"Bon"}}"#,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"jour"}}"#,
        ]);
        assert!(t.running);
        let kinds: Vec<_> = t.entries.iter().map(|e| (e.kind, e.text.as_str())).collect();
        assert_eq!(kinds, [(Kind::User, "salut"), (Kind::Thinking, "hmm"), (Kind::Assistant, "Bonjour")]);

        feed(&mut t, &[
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":1,"content":"Bonjour !"}}"#,
            r#"{"type":"agent_settled","aborted":true}"#,
        ]);
        assert!(!t.running);
        assert_eq!(t.entries[2].text, "Bonjour !");
        assert_eq!(t.entries.last().unwrap().kind, Kind::Notice);
    }

    #[test]
    fn queue_errors_and_cleared_queue_are_surfaced() {
        let mut t = Transcript::default();
        feed(&mut t, &[
            r#"{"type":"queue_update","steering":["stop"],"followUp":[]}"#,
            r#"{"type":"response","command":"clear_queue","success":true,"data":{"steering":["stop"],"followUp":["ensuite"]}}"#,
            r#"{"type":"response","command":"prompt","success":false,"error":"busy"}"#,
            r#"{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"403"}}"#,
        ]);
        assert_eq!(t.queued, ["stop"]);
        assert_eq!(t.restored, ["stop", "ensuite"]);
        let errs: Vec<_> = t.entries.iter().filter(|e| e.kind == Kind::Error).map(|e| e.text.as_str()).collect();
        assert_eq!(errs, ["prompt : busy", "403"]);
    }

    /// Real Pi over the network: `PIER_TEST_MODEL=openrouter/... cargo test -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_prompt_steer_and_stop() {
        let model = std::env::var("PIER_TEST_MODEL").expect("set PIER_TEST_MODEL");
        let args = ["--no-session", "--no-tools", "--model", &model].map(String::from);
        let mut p = Process::spawn(&args, || {}).unwrap();
        let mut t = Transcript::default();
        let pump = |p: &mut Process, t: &mut Transcript, until: &dyn Fn(&Transcript) -> bool, secs: u64| {
            let end = Instant::now() + Duration::from_secs(secs);
            while Instant::now() < end && !until(t) {
                if let Ok(m) = p.rx.recv_timeout(Duration::from_millis(200)) {
                    t.apply(m);
                }
                for r in std::mem::take(&mut t.outbox) {
                    p.send(r).unwrap();
                }
            }
        };

        p.send(json!({"type": "prompt", "message": "Reply with exactly the word: bonjour"})).unwrap();
        pump(&mut p, &mut t, &|t| t.entries.iter().any(|e| e.kind == Kind::Assistant) && !t.running, 60);
        let reply: String = t.entries.iter().filter(|e| e.kind == Kind::Assistant).map(|e| e.text.clone()).collect();
        assert!(reply.to_lowercase().contains("bonjour"), "reply: {reply:?} errors: {:?}", t.entries);

        p.send(json!({"type": "prompt", "message": "Count from 1 to 3000 in words, one per line."})).unwrap();
        pump(&mut p, &mut t, &|t| t.running && t.entries.last().is_some_and(|e| e.text.len() > 200), 60);
        p.send(json!({"type": "prompt", "message": "STEER-MARK", "streamingBehavior": "steer"})).unwrap();
        pump(&mut p, &mut t, &|t| !t.queued.is_empty(), 15);
        assert_eq!(t.queued, ["STEER-MARK"], "steer should be visible as queued");

        p.send(json!({"type": "clear_queue"})).unwrap();
        p.send(json!({"type": "abort"})).unwrap();
        pump(&mut p, &mut t, &|t| !t.running && !t.restored.is_empty(), 30);
        assert!(!t.running);
        assert_eq!(t.restored, ["STEER-MARK"], "cleared steer must come back to the editor");
        assert!(t.entries.iter().any(|e| e.text == "Run interrompu."));
        eprintln!("{} entries, status {:?}", t.entries.len(), t.status);
    }

    #[test]
    fn extension_dialogs_are_refused_and_status_is_kept() {
        let mut t = Transcript::default();
        feed(&mut t, &[
            r#"{"type":"extension_ui_request","id":"u1","method":"confirm","title":"Allow bash?"}"#,
            r#"{"type":"extension_ui_request","id":"u2","method":"setStatus","statusKey":"cost","statusText":"$0"}"#,
            r#"{"type":"extension_ui_request","id":"u3","method":"setWidget","widgetKey":"w"}"#,
        ]);
        assert_eq!(t.outbox, [json!({"type": "extension_ui_response", "id": "u1", "cancelled": true})]);
        assert_eq!(t.status.get("cost").map(String::as_str), Some("$0"));
        assert_eq!(t.entries.len(), 1);
        feed(&mut t, &[r#"{"type":"extension_ui_request","id":"u4","method":"setStatus","statusKey":"cost"}"#]);
        assert!(t.status.is_empty());
    }
}
