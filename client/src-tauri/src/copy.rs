//! A folder of this computer packed as a tar archive, to be copied into a project, or
//! handed off (it then stays on the VM in place of the share).
//!
//! Symbolic links are left out rather than followed: following one could pack files
//! from outside the folder. A copy skips build output and dependency folders wherever
//! they are: they are large, and rebuilt on the VM anyway. A hand off keeps all of the
//! folder, git included (Pi goes on alone with it), but the rebuilt folders at its top.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

pub const SKIP: &[&str] = &[".git", "node_modules", "target", "__pycache__", ".venv", "venv", ".DS_Store", "Thumbs.db"];
/// Rebuilt from the project (npm install, cargo build): left out of a hand off at the
/// folder's top only. A "target" deeper is as likely a folder of yours.
pub const REBUILT: &[&str] = &["node_modules", "target", "__pycache__", ".venv", "venv"];
/// The systems' own files, left out everywhere.
pub const JUNK: &[&str] = &[".DS_Store", "Thumbs.db"];

#[derive(Clone, Copy, PartialEq)]
pub enum Pack {
    /// Into a project: SKIP everywhere.
    Copy,
    /// A hand off: REBUILT at the top, JUNK everywhere.
    HandOff,
}

impl Pack {
    fn skips(self, top: bool, name: &str) -> bool {
        match self {
            Pack::Copy => SKIP.contains(&name),
            Pack::HandOff => JUNK.contains(&name) || (top && REBUILT.contains(&name)),
        }
    }
}

/// What a take back compares (takeback.rs, and the picker's copy-manifest): what a hand
/// off took, but git's own files (never brought back).
pub fn take_back_skips(top: bool, name: &str) -> bool {
    name == ".git" || Pack::HandOff.skips(top, name)
}

/// The archive, how many files it holds, and the names left out at the folder's top.
/// Fails past `max_bytes` of file content.
pub fn tar_folder(root: &Path, max_bytes: u64, pack: Pack) -> Result<(Vec<u8>, usize, Vec<String>)> {
    let name = root.file_name().context("a folder without a name")?;
    let mut builder = tar::Builder::new(Vec::new());
    builder.follow_symlinks(false);
    let (mut total, mut count, mut left) = (0u64, 0usize, Vec::new());
    let mut pending = vec![(root.to_path_buf(), PathBuf::from(name))];
    while let Some((dir, rel)) = pending.pop() {
        builder.append_dir(&rel, &dir).with_context(|| format!("{}", dir.display()))?;
        let top = dir == root;
        for entry in fs::read_dir(&dir).with_context(|| format!("{}", dir.display()))? {
            let entry = entry?;
            let file_name = entry.file_name();
            if let Some(n) = file_name.to_str().filter(|n| pack.skips(top, n)) {
                if top && !JUNK.contains(&n) {
                    left.push(n.to_string());
                }
                continue;
            }
            let kind = entry.file_type()?;
            let path = entry.path();
            let inside = rel.join(&file_name);
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                pending.push((path, inside));
            } else if kind.is_file() {
                total += entry.metadata()?.len();
                count += 1;
                if total > max_bytes {
                    bail!("folder larger than {} MB: share it live instead", max_bytes / (1024 * 1024));
                }
                builder.append_path_with_name(&path, &inside).with_context(|| format!("{}", path.display()))?;
            }
        }
    }
    left.sort();
    Ok((builder.into_inner()?, count, left))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packs_files_and_skips_build_folders() {
        let dir = std::env::temp_dir().join(format!("pier-copy-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let root = dir.join("mockups");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::create_dir_all(root.join("node_modules/x")).unwrap();
        fs::write(root.join("a.txt"), b"hello").unwrap();
        fs::write(root.join("sub/b.txt"), b"world").unwrap();
        fs::write(root.join("node_modules/x/big.js"), b"skip me").unwrap();
        let (bytes, count, _) = tar_folder(&root, 1024, Pack::Copy).unwrap();
        assert_eq!(count, 2);
        let mut archive = tar::Archive::new(bytes.as_slice());
        let names: Vec<String> = archive
            .entries()
            .unwrap()
            .map(|e| e.unwrap().path().unwrap().to_string_lossy().replace('\\', "/"))
            .collect();
        assert!(names.iter().any(|n| n == "mockups/a.txt"), "{names:?}");
        assert!(names.iter().any(|n| n == "mockups/sub/b.txt"), "{names:?}");
        assert!(!names.iter().any(|n| n.contains("node_modules")), "{names:?}");
        assert!(tar_folder(&root, 3, Pack::Copy).is_err(), "the size cap applies");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_hand_off_keeps_git_and_what_is_deeper() {
        let dir = std::env::temp_dir().join(format!("pier-handoff-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let root = dir.join("app");
        for sub in [".git", "node_modules/x", "java/target"] {
            fs::create_dir_all(root.join(sub)).unwrap();
        }
        fs::write(root.join(".git/HEAD"), b"ref: refs/heads/main").unwrap();
        fs::write(root.join("node_modules/x/big.js"), b"skip me").unwrap();
        fs::write(root.join("java/target/Main.java"), b"mine").unwrap();
        let (bytes, count, left) = tar_folder(&root, 1024, Pack::HandOff).unwrap();
        assert_eq!(count, 2);
        assert_eq!(left, vec!["node_modules".to_string()]);
        let mut archive = tar::Archive::new(bytes.as_slice());
        let names: Vec<String> = archive.entries().unwrap().map(|e| e.unwrap().path().unwrap().to_string_lossy().replace('\\', "/")).collect();
        assert!(names.iter().any(|n| n == "app/.git/HEAD"), "{names:?}");
        assert!(names.iter().any(|n| n == "app/java/target/Main.java"), "{names:?}");
        assert!(take_back_skips(false, ".git") && !take_back_skips(false, "target") && take_back_skips(true, "target"));
        let _ = fs::remove_dir_all(dir);
    }
}
