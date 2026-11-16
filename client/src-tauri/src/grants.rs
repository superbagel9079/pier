//! The paths of this computer the user handed to Pier, and only those: picked in its dialog,
//! dropped, pasted or already shared. A script in the page could else name any file (~/.ssh).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Default)]
pub struct Grants {
    paths: Mutex<Vec<PathBuf>>,
    /// The file chosen in the save dialog, the only one the report may be written to.
    save_to: Mutex<Option<PathBuf>>,
}

fn real(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

impl Grants {
    pub fn grant(&self, path: &Path) {
        let path = real(path);
        let mut paths = self.paths.lock().unwrap();
        if !paths.contains(&path) {
            paths.push(path);
        }
    }

    pub fn grant_save(&self, path: &Path) {
        *self.save_to.lock().unwrap() = Some(path.to_path_buf());
    }

    /// The save dialog's file, once: a second report needs the dialog again.
    pub fn take_save(&self, path: &str) -> bool {
        let mut chosen = self.save_to.lock().unwrap();
        if chosen.as_deref() == Some(Path::new(path)) {
            *chosen = None;
            return true;
        }
        false
    }

    /// `path` itself, resolved, when it is or is inside a path given (or one of
    /// `also`, the folders already shared); an error naming it otherwise.
    pub fn check(&self, path: &str, also: &[String]) -> Result<PathBuf, String> {
        let wanted = Path::new(path).canonicalize().map_err(|e| format!("{path}: {e}"))?;
        let given = self.paths.lock().unwrap();
        let inside = given.iter().any(|g| wanted.starts_with(g)) || also.iter().any(|a| wanted.starts_with(real(Path::new(a))));
        if inside {
            Ok(wanted)
        } else {
            log_warn!("grants.refused", path = path);
            Err(format!("{path} was not given to Pier: choose it, drop it on the window or paste it first"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_what_was_given() {
        let dir = std::env::temp_dir().join(format!("pier-grants-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("given/sub")).unwrap();
        std::fs::create_dir_all(dir.join("other")).unwrap();
        std::fs::write(dir.join("given/sub/a.txt"), "a").unwrap();
        std::fs::write(dir.join("other/secret"), "s").unwrap();
        let grants = Grants::default();
        grants.grant(&dir.join("given"));
        assert!(grants.check(dir.join("given/sub/a.txt").to_str().unwrap(), &[]).is_ok(), "inside a folder given");
        assert!(grants.check(dir.join("other/secret").to_str().unwrap(), &[]).is_err(), "never given");
        let up = dir.join("given/../other/secret");
        assert!(grants.check(up.to_str().unwrap(), &[]).is_err(), "resolved before it is checked");
        let shared = dir.join("other").to_string_lossy().into_owned();
        assert!(grants.check(dir.join("other/secret").to_str().unwrap(), &[shared]).is_ok(), "a folder already shared");
        grants.grant_save(Path::new("C:/x/report.txt"));
        assert!(!grants.take_save("C:/x/other.txt"));
        assert!(grants.take_save("C:/x/report.txt"));
        assert!(!grants.take_save("C:/x/report.txt"), "once");
        let _ = std::fs::remove_dir_all(dir);
    }
}
