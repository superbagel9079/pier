//! Pi's saved sessions on disk (read-only): Pier lists them, Pi itself reopens them with `--session`.

use serde::Deserialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

const TITLE_CHARS: usize = 60;

#[derive(Debug, Clone)]
pub struct SavedSession {
    pub path: PathBuf,
    pub modified: SystemTime,
    /// First user message, or the file name when there is none yet.
    pub title: String,
}

pub fn home() -> PathBuf {
    PathBuf::from(std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).unwrap_or_default())
}

/// Pi's folder name for a cwd: separators and `:` become `-`, wrapped in `--`.
// shortcut: default session dir only, ignores `--session-dir` and settings; read Pi's setting if someone moves it.
pub fn dir_for(cwd: &Path) -> PathBuf {
    let s = cwd.to_string_lossy();
    let name: String = s.trim_start_matches(['/', '\\']).chars().map(|c| if matches!(c, '/' | '\\' | ':') { '-' } else { c }).collect();
    home().join(".pi/agent/sessions").join(format!("--{name}--"))
}

/// Sessions saved for `cwd`, newest first, at most `max`.
pub fn list(cwd: &Path, max: usize) -> Vec<SavedSession> {
    let Ok(dir) = std::fs::read_dir(dir_for(cwd)) else { return vec![] };
    let mut files: Vec<(PathBuf, SystemTime)> = dir
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|p| Some((p.metadata().ok()?.modified().ok()?, p)))
        .map(|(m, p)| (p, m))
        .collect();
    files.sort_by_key(|f| std::cmp::Reverse(f.1));
    files.truncate(max);
    files.into_iter().map(|(path, modified)| SavedSession { title: title_of(&path), path, modified }).collect()
}

#[derive(Deserialize)]
struct Line {
    #[serde(default)]
    message: Option<super::protocol::Message>,
}

/// Reads only until the first user message; session files can be large.
fn title_of(path: &Path) -> String {
    let fallback = || path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let Ok(file) = std::fs::File::open(path) else { return fallback() };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        // Skip parsing the big system/assistant lines.
        if !line.contains(r#""role":"user""#) {
            continue;
        }
        let Some(m) = serde_json::from_str::<Line>(&line).ok().and_then(|l| l.message) else { continue };
        if m.role == super::protocol::Role::User {
            let text = m.content.text();
            let first = text.lines().find(|l| !l.trim().is_empty()).unwrap_or_default().trim();
            return if first.chars().count() > TITLE_CHARS {
                format!("{}…", first.chars().take(TITLE_CHARS).collect::<String>())
            } else {
                first.into()
            };
        }
    }
    fallback()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_name_matches_pi() {
        let d = dir_for(Path::new(r"C:\Users\leo\Downloads\brainstorming\pier"));
        assert_eq!(d.file_name().unwrap(), "--C--Users-leo-Downloads-brainstorming-pier--");
        assert_eq!(dir_for(Path::new("/home/a/b")).file_name().unwrap(), "--home-a-b--");
    }

    #[test]
    fn title_is_the_first_user_message() {
        let path = std::env::temp_dir().join(format!("pier-title-{}.jsonl", std::process::id()));
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"session","version":3,"id":"x","cwd":"/p"}"#,
                "\n",
                r#"{"type":"message","message":{"role":"system","content":""}}"#,
                "\n",
                r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"\nfix the build\nplease"}]}}"#,
                "\n",
            ),
        )
        .unwrap();
        assert_eq!(title_of(&path), "fix the build");
        std::fs::write(&path, r#"{"type":"session","version":3}"#).unwrap();
        assert_eq!(title_of(&path), path.file_stem().unwrap().to_string_lossy());
        std::fs::remove_file(&path).unwrap();
    }
}
