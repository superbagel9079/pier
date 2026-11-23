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
    // Pi names the folder after its plain cwd: no verbatim `\\?\` prefix, no trailing separator.
    // (Case does not matter: Windows folder names are case-insensitive.)
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s).trim_end_matches(['/', '\\']);
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
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    message: Option<super::protocol::Message>,
    /// Set on `session_info` entries.
    #[serde(default)]
    name: Option<String>,
}

fn shorten(text: &str) -> String {
    let first = text.lines().find(|l| !l.trim().is_empty()).unwrap_or_default().trim();
    if first.chars().count() > TITLE_CHARS { format!("{}…", first.chars().take(TITLE_CHARS).collect::<String>()) } else { first.into() }
}

/// The session's name (its last `session_info` entry) if it has one, else its first user message.
/// Only lines that can hold either are parsed: session files can be large.
fn title_of(path: &Path) -> String {
    let fallback = || path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let Ok(file) = std::fs::File::open(path) else { return fallback() };
    let (mut name, mut first_prompt) = (None, None);
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let maybe_name = line.contains(r#""type":"session_info""#);
        let maybe_prompt = first_prompt.is_none() && line.contains(r#""role":"user""#);
        if !maybe_name && !maybe_prompt {
            continue;
        }
        let Ok(l) = serde_json::from_str::<Line>(&line) else { continue };
        if l.kind == "session_info" {
            name = l.name.filter(|n| !n.trim().is_empty()); // a later entry without a name clears it
        } else if let Some(m) = l.message
            && m.role == super::protocol::Role::User
        {
            first_prompt = Some(shorten(&m.content.text()));
        }
    }
    name.map(|n| shorten(&n)).or(first_prompt).unwrap_or_else(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_name_matches_pi() {
        let d = dir_for(Path::new(r"C:\Users\leo\Downloads\brainstorming\pier"));
        assert_eq!(d.file_name().unwrap(), "--C--Users-leo-Downloads-brainstorming-pier--");
        assert_eq!(dir_for(Path::new("/home/a/b")).file_name().unwrap(), "--home-a-b--");
        assert_eq!(d, dir_for(Path::new(r"C:\Users\leo\Downloads\brainstorming\pier\")), "trailing separator");
        assert_eq!(d, dir_for(Path::new(r"\\?\C:\Users\leo\Downloads\brainstorming\pier")), "verbatim prefix");
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
        let named = concat!(
            r#"{"type":"message","message":{"role":"user","content":"ls"}}"#,
            "\n",
            r#"{"type":"session_info","id":"a","name":"Ancien nom"}"#,
            "\n",
            r#"{"type":"message","message":{"role":"user","content":"encore"}}"#,
            "\n",
            r#"{"type":"session_info","id":"b","name":"Refonte du parseur"}"#,
            "\n",
        );
        std::fs::write(&path, named).unwrap();
        assert_eq!(title_of(&path), "Refonte du parseur", "the last name wins over the first prompt");
        std::fs::write(&path, r#"{"type":"session","version":3}"#).unwrap();
        assert_eq!(title_of(&path), path.file_stem().unwrap().to_string_lossy());
        std::fs::remove_file(&path).unwrap();
    }
}
