//! Pi's saved sessions on disk (read-only): Pier lists them, Pi itself reopens them with `--session`.

use serde::Deserialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Titles already read, by file and modification time: finding one reads the whole file, so only changed files are reread.
pub type TitleCache = HashMap<PathBuf, (SystemTime, String)>;

const TITLE_CHARS: usize = 60;

#[derive(Debug, Clone)]
pub struct SavedSession {
    pub path: PathBuf,
    pub modified: SystemTime,
    pub bytes: u64,
    /// First user message, or the file name when there is none yet.
    pub title: String,
}

pub fn home() -> PathBuf {
    PathBuf::from(std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).unwrap_or_default())
}

/// Pi's folder name for a cwd: separators and `:` become `-`, wrapped in `--`.
// shortcut: default session dir only (ignores `--session-dir` and settings), read Pi's setting if someone moves it.
pub fn dir_for(cwd: &Path) -> PathBuf {
    let s = cwd.to_string_lossy();
    // Pi names the folder after its plain cwd: no verbatim `\\?\` prefix, no trailing separator. Case does not matter.
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s).trim_end_matches(['/', '\\']);
    let name: String = s.trim_start_matches(['/', '\\']).chars().map(|c| if matches!(c, '/' | '\\' | ':') { '-' } else { c }).collect();
    home().join(".pi/agent/sessions").join(format!("--{name}--"))
}

/// Sessions saved for `cwd`, newest first, at most `max`.
pub fn list(cwd: &Path, max: usize) -> Vec<SavedSession> {
    list_cached(cwd, max, &mut TitleCache::new())
}

/// Like `list`, reading only the files that are new or changed since they went into `cache`.
pub fn list_cached(cwd: &Path, max: usize, cache: &mut TitleCache) -> Vec<SavedSession> {
    list_dir(&dir_for(cwd), max, cache)
}

fn list_dir(folder: &Path, max: usize, cache: &mut TitleCache) -> Vec<SavedSession> {
    let Ok(dir) = std::fs::read_dir(folder) else { return vec![] };
    let mut files: Vec<(PathBuf, SystemTime, u64)> = dir
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|p| {
            let meta = p.metadata().ok()?;
            Some((p, meta.modified().ok()?, meta.len()))
        })
        .collect();
    files.sort_by_key(|f| std::cmp::Reverse(f.1));
    files.truncate(max);
    files
        .into_iter()
        .map(|(path, modified, bytes)| {
            let title = match cache.get(&path) {
                Some((at, title)) if *at == modified => title.clone(),
                _ => {
                    let title = title_of(&path);
                    cache.insert(path.clone(), (modified, title.clone()));
                    title
                }
            };
            SavedSession { title, path, modified, bytes }
        })
        .collect()
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

/// Characters shown on each side of a match.
const SNIPPET_SIDE: usize = 40;

/// The first user or assistant message of the session containing `query` (case-insensitive), as a one-line excerpt
/// around the match; `None` when no message has it. Tool calls, tool output and thinking are not searched.
pub fn search(path: &Path, query: &str) -> Option<String> {
    let q = query.to_lowercase();
    let file = std::fs::File::open(path).ok()?;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if !line.contains(r#""type":"message""#) || !(line.contains(r#""role":"user""#) || line.contains(r#""role":"assistant""#)) {
            continue;
        }
        let Some(m) = serde_json::from_str::<Line>(&line).ok().and_then(|l| l.message) else { continue };
        if let Some(s) = snippet(&m.content.text(), &q) {
            return Some(s);
        }
    }
    None
}

/// `text` around the first match of the lowercase `q`, on one line.
fn snippet(text: &str, q: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let at = lower.find(q)?;
    // Positions in `lower` match `text` only if every character keeps its byte length when lowercased.
    // Otherwise the excerpt is shown in lowercase rather than cut mid-character.
    let same_offsets = text.chars().all(|c| {
        let mut l = c.to_lowercase();
        matches!((l.next(), l.next()), (Some(x), None) if x.len_utf8() == c.len_utf8())
    });
    let source = if same_offsets { text } else { lower.as_str() };
    let before: String = source[..at].chars().rev().take(SNIPPET_SIDE).collect::<Vec<_>>().into_iter().rev().collect();
    let rest: String = source[at..].chars().take(q.chars().count() + SNIPPET_SIDE).collect();
    let lead = if before.chars().count() < source[..at].chars().count() { "…" } else { "" };
    let tail = if rest.len() < source.len() - at { "…" } else { "" };
    Some(format!("{lead}{before}{rest}{tail}").split_whitespace().collect::<Vec<_>>().join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_are_cached_until_the_file_changes() {
        let dir = std::env::temp_dir().join(format!("pier-titles-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.jsonl");
        std::fs::write(&file, r#"{"type":"message","message":{"role":"user","content":"first"}}"#).unwrap();
        let mut cache = TitleCache::new();
        assert_eq!(list_dir(&dir, 5, &mut cache)[0].title, "first");

        let at = std::fs::metadata(&file).unwrap().modified().unwrap();
        cache.insert(file.clone(), (at, "from cache".into()));
        assert_eq!(list_dir(&dir, 5, &mut cache)[0].title, "from cache", "unchanged file: not read again");

        std::thread::sleep(std::time::Duration::from_millis(30));
        std::fs::write(&file, r#"{"type":"message","message":{"role":"user","content":"second"}}"#).unwrap();
        assert_eq!(list_dir(&dir, 5, &mut cache)[0].title, "second", "changed file: read again");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn search_finds_messages_not_tool_output() {
        let path = std::env::temp_dir().join(format!("pier-search-{}.jsonl", std::process::id()));
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"message","message":{"role":"user","content":"Fix the PARSER please"}}"#,
                "\n",
                r#"{"type":"message","message":{"role":"toolResult","toolName":"bash","content":[{"type":"text","text":"zebra in a log"}]}}"#,
                "\n",
                r#"{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Done.\nThe tokenizer now handles nested quotes, which the old parser choked on."}]}}"#,
                "\n",
            ),
        )
        .unwrap();
        assert_eq!(search(&path, "parser").as_deref(), Some("Fix the PARSER please"), "case-insensitive, first match");
        assert_eq!(search(&path, "TOKENIZER").as_deref(), Some("Done. The tokenizer now handles nested quotes, which the ol…"));
        assert_eq!(search(&path, "zebra"), None, "tool output is not searched");
        let long = format!("{}needle{}", "a".repeat(100), "b".repeat(100));
        // 'ẞ' (3 bytes) lowercases to 'ß' (2) and 'İ' (2) to 'i̇' (3): same total length, shifted positions.
        assert!(snippet("ẞİ needle", "needle").unwrap().contains("needle"), "no panic on shifted positions");
        let s = snippet(&long, "needle").unwrap();
        assert!(s.starts_with('…') && s.ends_with('…') && s.contains("needle"), "{s}");
        std::fs::remove_file(&path).unwrap();
    }

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
            r#"{"type":"session_info","id":"a","name":"Old name"}"#,
            "\n",
            r#"{"type":"message","message":{"role":"user","content":"again"}}"#,
            "\n",
            r#"{"type":"session_info","id":"b","name":"Parser rewrite"}"#,
            "\n",
        );
        std::fs::write(&path, named).unwrap();
        assert_eq!(title_of(&path), "Parser rewrite", "the last name wins over the first prompt");
        std::fs::write(&path, r#"{"type":"session","version":3}"#).unwrap();
        assert_eq!(title_of(&path), path.file_stem().unwrap().to_string_lossy());

        std::fs::remove_file(&path).unwrap();
    }
}
