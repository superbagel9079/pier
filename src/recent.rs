//! Recently opened project folders, newest first, kept in `%APPDATA%\pier\recent.json`.

use std::path::{Path, PathBuf};

const MAX: usize = 10;

pub fn path() -> PathBuf {
    std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("pier").join("recent.json")
}

/// A missing or unreadable file gives an empty list: it is a convenience, losing it costs one folder pick.
/// Folders that no longer exist are left out.
pub fn load(file: &Path) -> Vec<PathBuf> {
    let list: Vec<PathBuf> = std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    list.into_iter().filter(|p| p.is_dir()).collect()
}

/// Windows paths ignore case and a trailing separator.
fn same(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().trim_end_matches(['/', '\\']).to_lowercase();
    if cfg!(windows) { norm(a) == norm(b) } else { a == b }
}

/// Puts `folder` first, without duplicates, keeps at most `MAX`, and saves. Returns the new list.
pub fn remember(file: &Path, folder: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut list = load(file);
    list.retain(|p| !same(p, folder));
    list.insert(0, folder.to_path_buf());
    list.truncate(MAX);
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // Atomic: another Pier window may read or write the list at the same moment.
    crate::files::write_atomic(file, &serde_json::to_vec_pretty(&list)?)?;
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newest_first_no_duplicates_bounded() {
        let root = std::env::temp_dir().join(format!("pier-recent-{}", std::process::id()));
        let file = root.join("recent.json");
        let dirs: Vec<PathBuf> = (0..12).map(|i| root.join(format!("p{i}"))).collect();
        for d in &dirs {
            std::fs::create_dir_all(d).unwrap();
        }
        assert!(load(&file).is_empty(), "no file yet");
        for d in &dirs {
            remember(&file, d).unwrap();
        }
        let list = remember(&file, &dirs[5]).unwrap();
        assert_eq!(list.len(), MAX);
        assert_eq!(list[0], dirs[5], "reopened folder moves to the top");
        assert_eq!(list.iter().filter(|p| **p == dirs[5]).count(), 1);
        assert_eq!(list[1], dirs[11]);

        std::fs::remove_dir(&dirs[11]).unwrap();
        assert!(!load(&file).contains(&dirs[11]), "deleted folders are left out");
        std::fs::write(&file, "not json").unwrap();
        assert!(load(&file).is_empty(), "a broken file is not fatal");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
