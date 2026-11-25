//! Shell commands that run without asking, in `%APPDATA%\pier\allowlist.json` (`{"commands": [...]}`). Pier's
//! extension reads the file at each call and decides; Pier only adds entries ("always allow") and opens the file.
//! An entry matches a command that starts with it, word by word, and only a single simple command (see the extension).

use crate::files::write_atomic;
use std::path::{Path, PathBuf};

/// Used while the file does not exist: commands that only read. Same list as `DEFAULT_ALLOWED` in the extension.
pub const DEFAULTS: [&str; 9] = ["ls", "dir", "pwd", "git status", "git diff", "git log", "git show", "Get-ChildItem", "Get-Location"];

/// `PIER_ALLOWLIST` points elsewhere (tests); the extension honors the same variable.
pub fn path() -> PathBuf {
    if let Some(p) = std::env::var_os("PIER_ALLOWLIST") {
        return p.into();
    }
    std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("pier").join("allowlist.json")
}

#[derive(serde::Serialize, serde::Deserialize)]
struct File {
    commands: Vec<String>,
}

/// The entries in force: the file's, or the defaults while there is none.
pub fn load(file: &Path) -> Result<Vec<String>, String> {
    match std::fs::read(file) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(DEFAULTS.map(String::from).to_vec()),
        Err(e) => Err(e.to_string()),
        Ok(bytes) => serde_json::from_slice::<File>(&bytes).map(|f| f.commands).map_err(|e| format!("{}: {e}", file.display())),
    }
}

fn save(file: &Path, commands: Vec<String>) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    write_atomic(file, &serde_json::to_vec_pretty(&File { commands })?)
}

/// Adds `entry` (once). A broken file is not overwritten: the user's edits would be lost.
pub fn add(file: &Path, entry: &str) -> Result<(), String> {
    let mut commands = load(file)?;
    let entry = entry.split_whitespace().collect::<Vec<_>>().join(" ");
    if entry.is_empty() || commands.contains(&entry) {
        return Ok(());
    }
    commands.push(entry);
    save(file, commands).map_err(|e| e.to_string())
}

/// The file, created with the defaults if missing, to open in an editor.
pub fn ensure_file(file: &Path) -> Result<PathBuf, String> {
    if !file.exists() {
        save(file, DEFAULTS.map(String::from).to_vec()).map_err(|e| e.to_string())?;
    }
    Ok(file.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_are_added_once_and_a_broken_file_is_kept() {
        let dir = std::env::temp_dir().join(format!("pier-allowlist-{}", std::process::id()));
        let file = dir.join("allowlist.json");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(load(&file).unwrap().len(), DEFAULTS.len(), "no file: the defaults");
        add(&file, "cargo   test").unwrap();
        add(&file, "cargo test").unwrap();
        let list = load(&file).unwrap();
        assert_eq!(list.iter().filter(|c| *c == "cargo test").count(), 1);
        assert!(list.contains(&"git status".to_owned()), "the defaults are kept when the file is first written");
        std::fs::write(&file, "{ broken").unwrap();
        assert!(add(&file, "npm test").is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{ broken", "not overwritten");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn defaults_match_the_extension() {
        let source = crate::pi::process::APPROVALS_EXTENSION;
        let line = source.lines().find(|l| l.starts_with("const DEFAULT_ALLOWED")).expect("DEFAULT_ALLOWED in the extension");
        let quoted: Vec<&str> = line.split('"').skip(1).step_by(2).collect();
        assert_eq!(quoted, DEFAULTS, "the extension decides with its list while the file is missing");
    }
}
