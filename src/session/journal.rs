//! Per-tab JSONL journal (G.34): what Pi's own session file does not hold, above all the approval decisions.

use serde::Serialize;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// One journal line. Never holds launch arguments: they can carry an API key.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "event", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Record {
    TabOpened {
        #[serde(skip_serializing_if = "Option::is_none")]
        preset: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        resumed: Option<PathBuf>,
        cwd: PathBuf,
    },
    /// Pi's session file, to find the conversation that goes with this journal.
    SessionFile {
        path: PathBuf,
    },
    RunStarted,
    RunEnded {
        outcome: &'static str,
    },
    StopRequested,
    ApprovalRequested {
        id: String,
        title: String,
        detail: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u64>,
    },
    /// `decision`: allowed, refused, expired, or dropped (the run ended before an answer).
    ApprovalDecided {
        id: String,
        decision: &'static str,
    },
    PiExited,
    /// The user closed the tab, which stops its Pi.
    TabClosed,
}

pub fn dir() -> PathBuf {
    std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("pier").join("journal")
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or_default()
}

/// One file per tab, written line by line and unbuffered so a crash loses nothing already logged.
// shortcut: files are never rotated or pruned; they stay small (no stream text), add cleanup if the folder grows.
pub struct Journal {
    file: File,
    pub path: PathBuf,
}

impl Journal {
    pub fn create(dir: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let mut ms = now_ms();
        loop {
            // Two tabs opened in the same millisecond must not share a file.
            let path = dir.join(format!("{ms}.jsonl"));
            match OpenOptions::new().append(true).create_new(true).open(&path) {
                Ok(file) => return Ok(Self { file, path }),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => ms += 1,
                Err(e) => return Err(e),
            }
        }
    }

    pub fn write(&mut self, r: &Record) -> std::io::Result<()> {
        let mut v = serde_json::to_value(r)?;
        v["ts"] = now_ms().to_string().into();
        let mut line = serde_json::to_vec(&v)?;
        line.push(b'\n');
        self.file.write_all(&line)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_line_per_record_and_no_shared_files() {
        let dir = std::env::temp_dir().join(format!("pier-journal-{}", std::process::id()));
        let mut a = Journal::create(&dir).unwrap();
        let b = Journal::create(&dir).unwrap();
        assert_ne!(a.path, b.path);
        a.write(&Record::ApprovalDecided { id: "a1".into(), decision: "allowed" }).unwrap();
        a.write(&Record::RunEnded { outcome: "completed" }).unwrap();
        let lines: Vec<serde_json::Value> =
            std::fs::read_to_string(&a.path).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["event"], "approval_decided");
        assert_eq!(lines[0]["decision"], "allowed");
        assert!(lines[0]["ts"].as_str().is_some_and(|s| !s.is_empty()));
        assert_eq!(lines[1]["outcome"], "completed");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
