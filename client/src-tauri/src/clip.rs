//! What the system clipboard holds that Pier reads: the files copied in the file manager.

/// Files and folders copied in the file manager (Explorer's Ctrl+C), as paths.
/// Empty when the clipboard holds none.
pub fn clipboard_paths() -> Vec<String> {
    arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.get().file_list())
        .map(|paths| paths.into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
        .unwrap_or_default()
}
