//! Reading unified diffs (Pi's patches and the approval previews) line by line, for coloring and counting.

/// What a line of a unified diff is.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LineKind {
    /// `Index:`, `===`, `---`, `+++` outside a hunk: which file.
    Header,
    /// `@@ -a,b +c,d @@`: where the next lines are.
    Hunk,
    Added,
    Removed,
    Context,
    /// Pier's own remarks in a preview, in parentheses, and `\ No newline at end of file`.
    Note,
}

/// Line counts announced by a hunk header `@@ -a,b +c,d @@` (a missing count means 1).
fn hunk_sizes(line: &str) -> Option<(usize, usize)> {
    let mut parts = line.strip_prefix("@@ ")?.split(' ');
    let size = |p: Option<&str>, sign: char| -> Option<usize> {
        let range = p?.strip_prefix(sign)?;
        range.split_once(',').map_or(Some(1), |(_, n)| n.parse().ok())
    };
    Some((size(parts.next(), '-')?, size(parts.next(), '+')?))
}

/// Kind of every line. Inside a hunk, lines are read against the counts its header announced, so a removed
/// `-- comment` (`--- comment`) or a removed `---` stays a removed line, not a file header.
pub fn classify(diff: &str) -> Vec<(LineKind, &str)> {
    let (mut old_left, mut new_left) = (0usize, 0usize);
    diff.lines()
        .map(|line| {
            let in_hunk = old_left > 0 || new_left > 0;
            let kind = if in_hunk && line.starts_with('-') {
                old_left = old_left.saturating_sub(1);
                LineKind::Removed
            } else if in_hunk && line.starts_with('+') {
                new_left = new_left.saturating_sub(1);
                LineKind::Added
            } else if in_hunk && (line.starts_with(' ') || line.is_empty()) {
                old_left = old_left.saturating_sub(1);
                new_left = new_left.saturating_sub(1);
                LineKind::Context
            } else if line.starts_with("@@") {
                (old_left, new_left) = hunk_sizes(line).unwrap_or((0, 0));
                LineKind::Hunk
            } else if line.starts_with("+++") || line.starts_with("---") || line.starts_with("Index:") || line.starts_with("===") {
                LineKind::Header
            } else if line.starts_with('(') || line.starts_with('\\') || line.starts_with('…') {
                LineKind::Note
            } else if line.starts_with('+') {
                LineKind::Added
            } else if line.starts_with('-') {
                LineKind::Removed
            } else {
                LineKind::Context
            };
            (kind, line)
        })
        .collect()
}

/// Keeps the first `max` lines of a patch, and says how many were dropped: a patch kept in memory for the whole
/// session must stay bounded (a regenerated file can be thousands of lines).
pub fn cap_lines(patch: String, max: usize) -> String {
    let total = patch.lines().count();
    if total <= max {
        return patch;
    }
    let mut kept: Vec<&str> = patch.lines().take(max).collect();
    let note = format!("… {} more lines not kept", total - max);
    kept.push(&note);
    kept.join("\n")
}

/// Lines added and removed, for a one-line summary (`+3 −1`).
pub fn counts(diff: &str) -> (usize, usize) {
    classify(diff).iter().fold((0, 0), |(a, r), (kind, _)| match kind {
        LineKind::Added => (a + 1, r),
        LineKind::Removed => (a, r + 1),
        _ => (a, r),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(diff: &str) -> Vec<LineKind> {
        classify(diff).into_iter().map(|(k, _)| k).collect()
    }

    #[test]
    fn kinds_and_counts() {
        use LineKind::*;
        let patch = "Index: a.txt\n===================================================================\n--- a.txt\n+++ a.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n\\ No newline at end of file";
        assert_eq!(kinds(patch), [Header, Header, Header, Header, Hunk, Context, Removed, Added, Context, Note]);
        assert_eq!(counts(patch), (1, 1), "the --- and +++ headers are not counted");
        assert_eq!(kinds("(approximate preview: …)"), [Note]);
        assert_eq!(kinds("… preview cut: 12 lines not shown"), [Note]);
    }

    #[test]
    fn long_patches_are_capped_and_say_so() {
        let patch: String = (0..10).map(|i| format!("+l{i}")).collect::<Vec<_>>().join("\n");
        let capped = cap_lines(patch.clone(), 4);
        assert_eq!(capped.lines().count(), 5);
        assert!(capped.ends_with("… 6 more lines not kept"));
        assert_eq!(kinds(&capped).last(), Some(&LineKind::Note));
        assert_eq!(cap_lines(patch.clone(), 10), patch);
    }

    #[test]
    fn removed_lines_that_look_like_headers_stay_removed() {
        use LineKind::*;
        // Removing a SQL comment `-- old` and a Markdown rule `---`, then a second file's header.
        let patch = "--- q.sql\n+++ q.sql\n@@ -1,3 +1,1 @@\n--- old\n----\n keep\n--- r.md\n+++ r.md\n@@ -1 +1 @@\n-a\n+b";
        assert_eq!(kinds(patch), [Header, Header, Hunk, Removed, Removed, Context, Header, Header, Hunk, Removed, Added]);
        assert_eq!(counts(patch), (1, 3));
        assert_eq!(hunk_sizes("@@ -5 +5,2 @@"), Some((1, 2)), "a missing count means one line");
    }
}
