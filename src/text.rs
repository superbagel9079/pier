//! Shortening text for display.

/// At most `max` characters, with `…` when cut.
pub fn shorten(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_owned(),
    }
}

/// At most `max` bytes (cut on a character boundary), with ` …` when cut. Takes the string so short text is not copied.
pub fn cap_bytes(mut text: String, max: usize) -> String {
    if text.len() > max {
        text.truncate(text.floor_char_boundary(max));
        text.push_str(" …");
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cuts_on_characters_and_says_so() {
        assert_eq!(shorten("abcdef", 3), "abc…");
        assert_eq!(shorten("abc", 3), "abc");
        assert_eq!(shorten("éèà", 2), "éè…");
        assert_eq!(cap_bytes("éé".into(), 3), "é …", "never splits a character");
        assert_eq!(cap_bytes("ok".into(), 3), "ok");
    }
}
