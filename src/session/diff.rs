//! Reading unified diffs (Pi's patches and the approval previews) line by line, for coloring.

/// What a line of a unified diff is.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LineKind {
    /// `Index:`, `===`, `---`, `+++`: which file.
    Header,
    /// `@@ -a,b +c,d @@`: where the next lines are.
    Hunk,
    Added,
    Removed,
    Context,
    /// Pier's own remarks in a preview, in parentheses, and `\ No newline at end of file`.
    Note,
}

/// Kind of one diff line. Headers are checked before `+`/`-`, since `+++`/`---` start with them.
pub fn line_kind(line: &str) -> LineKind {
    if line.starts_with("+++") || line.starts_with("---") || line.starts_with("Index:") || line.starts_with("===") {
        LineKind::Header
    } else if line.starts_with("@@") {
        LineKind::Hunk
    } else if line.starts_with('+') {
        LineKind::Added
    } else if line.starts_with('-') {
        LineKind::Removed
    } else if line.starts_with('(') || line.starts_with('\\') || line.starts_with('…') {
        LineKind::Note
    } else {
        LineKind::Context
    }
}

/// Lines added and removed, for a one-line summary (`+3 −1`).
pub fn counts(diff: &str) -> (usize, usize) {
    diff.lines().fold((0, 0), |(a, r), l| match line_kind(l) {
        LineKind::Added => (a + 1, r),
        LineKind::Removed => (a, r + 1),
        _ => (a, r),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PATCH: &str = "Index: a.txt\n===================================================================\n--- a.txt\n+++ a.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n\\ No newline at end of file";

    #[test]
    fn kinds_and_counts() {
        let kinds: Vec<_> = PATCH.lines().map(line_kind).collect();
        use LineKind::*;
        assert_eq!(kinds, [Header, Header, Header, Header, Hunk, Context, Removed, Added, Context, Note]);
        assert_eq!(counts(PATCH), (1, 1), "the --- and +++ headers are not counted");
        assert_eq!(line_kind("(approximate preview: …)"), Note);
        assert_eq!(line_kind("… preview cut: 12 lines not shown"), Note);
        assert_eq!(line_kind(""), Context);
    }
}
