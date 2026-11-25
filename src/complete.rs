//! Completion in the editor: `/` lists Pi's commands, `@` the project's files. As in Pi's own editor, a mention puts
//! only the path in the message; the model reads the file itself.

use crate::pi::protocol::PiCommand;

/// Suggestions shown at once; typing narrows the rest.
pub const SHOWN_MAX: usize = 8;

/// `items` containing `query` (case-insensitive), those whose `key` starts with it first.
fn ranked<'a, T>(items: impl Iterator<Item = &'a T>, query: &str, text: impl Fn(&T) -> &str, key: impl Fn(&str) -> &str) -> Vec<&'a T>
where
    T: 'a,
{
    let q = query.to_lowercase();
    let (mut starts, mut contains): (Vec<&T>, Vec<&T>) =
        items.filter(|i| text(i).to_lowercase().contains(&q)).partition(|i| key(text(i)).to_lowercase().starts_with(&q));
    starts.append(&mut contains);
    starts
}

/// Commands matching a typed `/partial`. Empty once a space follows the name (the user is writing arguments).
/// Pier's own commands (the mode switch) are driven from its menus, not typed.
pub fn commands<'a>(commands: &'a [PiCommand], input: &str) -> Vec<&'a PiCommand> {
    let Some(query) = input.strip_prefix('/') else { return vec![] };
    if query.contains(char::is_whitespace) {
        return vec![];
    }
    ranked(commands.iter().filter(|c| !c.name.starts_with("pier-")), query, |c| &c.name, |n| n)
}

// shortcut: only a mention at the end of the text is completed, track the cursor if mid-text completion is missed.
/// The partial path after a trailing `@`, if the editor ends with one (`fix @src/ma` → `src/ma`).
pub fn mention_query(input: &str) -> Option<&str> {
    let start = input.rfind(|c: char| c.is_whitespace()).map_or(0, |i| i + 1);
    input[start..].strip_prefix('@')
}

/// Project files matching `query`: file names starting with it first, then paths containing it.
pub fn files<'a>(files: &'a [String], query: &str) -> Vec<&'a String> {
    ranked(files.iter(), query, String::as_str, |p| p.rsplit('/').next().unwrap_or(p))
}

/// `input` with its trailing `@partial` replaced by the picked path (quoted if it has spaces) and a space.
pub fn insert_mention(input: &str, path: &str) -> String {
    let start = input.rfind(|c: char| c.is_whitespace()).map_or(0, |i| i + 1);
    let mention = if path.contains(char::is_whitespace) { format!("@\"{path}\"") } else { format!("@{path}") };
    format!("{}{mention} ", &input[..start])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mention_query_is_the_trailing_mention_only() {
        assert_eq!(mention_query("@"), Some(""));
        assert_eq!(mention_query("fix @src/ma"), Some("src/ma"));
        assert_eq!(mention_query("fix @src/main.rs "), None, "finished: a space follows");
        assert_eq!(mention_query("mail me@home"), None, "not a mention");
        assert_eq!(mention_query("line one\n@RE"), Some("RE"));
    }

    #[test]
    fn file_names_first_then_paths() {
        let all: Vec<String> = ["docs/main-notes.md", "src/app/mod.rs", "src/main.rs", "README.md"].map(String::from).to_vec();
        assert_eq!(files(&all, "main"), ["docs/main-notes.md", "src/main.rs"]);
        assert_eq!(files(&all, "src"), ["src/app/mod.rs", "src/main.rs"], "folder names match as paths");
        assert_eq!(files(&all, "MOD"), ["src/app/mod.rs"]);
        assert_eq!(files(&all, "").len(), 4);
    }

    #[test]
    fn inserting_replaces_the_partial_path() {
        assert_eq!(insert_mention("fix @src/ma", "src/main.rs"), "fix @src/main.rs ");
        assert_eq!(insert_mention("@", "my notes.md"), "@\"my notes.md\" ");
    }
}
