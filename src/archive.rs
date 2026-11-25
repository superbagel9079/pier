//! Archived sessions: hidden from Pier's Resume window, kept in `%APPDATA%\pier\archived.json`. Pi's session files
//! are never moved or changed, so Pi's own /resume still lists them.

use crate::files::write_atomic;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

pub struct Archive {
    file: PathBuf,
    sessions: BTreeSet<PathBuf>,
}

impl Archive {
    /// A missing or unreadable file means nothing archived: archiving only hides, so losing it loses nothing.
    pub fn load(file: PathBuf) -> Self {
        let sessions = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Self { file, sessions }
    }

    pub fn contains(&self, session: &Path) -> bool {
        self.sessions.contains(session)
    }

    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    /// Archives or brings back `session`, and saves the list. Reread first: another Pier window may have changed it.
    pub fn set(&mut self, session: &Path, archived: bool) -> std::io::Result<()> {
        self.sessions = Self::load(self.file.clone()).sessions;
        let changed = if archived { self.sessions.insert(session.to_path_buf()) } else { self.sessions.remove(session) };
        if !changed {
            return Ok(());
        }
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        write_atomic(&self.file, &serde_json::to_vec_pretty(&self.sessions)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archived_sessions_survive_a_restart() {
        let file = std::env::temp_dir().join(format!("pier-archive-{}", std::process::id())).join("archived.json");
        let _ = std::fs::remove_file(&file);
        let mut a = Archive::load(file.clone());
        assert!(a.is_empty(), "no file yet: nothing archived");
        let s = Path::new(r"C:\sessions\a.jsonl");
        a.set(s, true).unwrap();
        a.set(Path::new(r"C:\sessions\b.jsonl"), true).unwrap();
        a.set(Path::new(r"C:\sessions\b.jsonl"), false).unwrap();
        let again = Archive::load(file.clone());
        assert!(again.contains(s));
        assert_eq!(again.len(), 1);
        std::fs::write(&file, "not json").unwrap();
        assert!(Archive::load(file.clone()).is_empty(), "a broken file hides nothing");
        std::fs::remove_dir_all(file.parent().unwrap()).unwrap();
    }
}
