//! A `pi --mode rpc` process spoken to in JSONL over stdio: launch, framing, orderly shutdown.

use serde_json::{Value, json};
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn framing_keeps_unicode_separators_and_strips_crlf() {
        let v = parse_line("{\"t\":\"a\u{2028}b\"}\r\n".as_bytes()).unwrap().unwrap();
        assert_eq!(v["t"], "a\u{2028}b");
        assert!(parse_line(b"  \r\n").is_none());
    }
}
