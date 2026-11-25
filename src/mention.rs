//! `@file` mentions in the editor: what is being typed, which project files match, and the text once one is picked.
//! As in Pi's own editor, only the path goes into the message; the model reads the file itself.

// shortcut: only a mention at the end of the text is completed (where one types); upgrade to the cursor position
// if mid-text completion is missed.
/// The partial path after a trailing `@`, if the editor ends with one (`fix @src/ma` → `src/ma`).
pub fn query(input: &str) -> Option<&str> {
    let start = input.rfind(|c: char| c.is_whitespace()).map_or(0, |i| i + 1);
    input[start..].strip_prefix('@')
}

/// Project files matching `query`: file names starting with it first, then paths containing it (case-insensitive).
pub fn matching<'a>(files: &'a [String], query: &str) -> Vec<&'a str> {
    let q = query.to_lowercase();
    let name = |p: &str| p.rsplit('/').next().unwrap_or(p).to_lowercase();
    let (mut starts, mut contains): (Vec<&str>, Vec<&str>) =
        files.iter().map(String::as_str).filter(|p| p.to_lowercase().contains(&q)).partition(|p| name(p).starts_with(&q));
    starts.append(&mut contains);
    starts
}

/// `input` with its trailing `@partial` replaced by the picked path (quoted if it has spaces) and a space.
pub fn insert(input: &str, path: &str) -> String {
    let start = input.rfind(|c: char| c.is_whitespace()).map_or(0, |i| i + 1);
    let mention = if path.contains(char::is_whitespace) { format!("@\"{path}\"") } else { format!("@{path}") };
    format!("{}{mention} ", &input[..start])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_is_the_trailing_mention_only() {
        assert_eq!(query("@"), Some(""));
        assert_eq!(query("fix @src/ma"), Some("src/ma"));
        assert_eq!(query("fix @src/main.rs "), None, "finished: a space follows");
        assert_eq!(query("mail me@home"), None, "not a mention");
        assert_eq!(query("line one\n@RE"), Some("RE"));
    }

    #[test]
    fn names_first_then_paths() {
        let files: Vec<String> = ["docs/main-notes.md", "src/app/mod.rs", "src/main.rs", "README.md"].map(String::from).to_vec();
        assert_eq!(matching(&files, "main"), ["docs/main-notes.md", "src/main.rs"]);
        assert_eq!(matching(&files, "src"), ["src/app/mod.rs", "src/main.rs"], "folder names match as paths");
        assert_eq!(matching(&files, "MOD"), ["src/app/mod.rs"]);
        assert_eq!(matching(&files, "").len(), 4);
    }

    #[test]
    fn inserting_replaces_the_partial_path() {
        assert_eq!(insert("fix @src/ma", "src/main.rs"), "fix @src/main.rs ");
        assert_eq!(insert("@", "my notes.md"), "@\"my notes.md\" ");
    }
}
