//! A folder of this computer packed as a tar archive, to be copied into a project.
//!
//! Symbolic links are left out rather than followed: following one could pack files
//! from outside the folder. Build output and dependency folders are skipped: they are
//! large, and rebuilt on the VM anyway.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

const SKIP: &[&str] = &[".git", "node_modules", "target", "__pycache__", ".venv", "venv", ".DS_Store", "Thumbs.db"];

/// The archive, and how many files it holds. Fails past `max_bytes` of file content.
pub fn tar_folder(root: &Path, max_bytes: u64) -> Result<(Vec<u8>, usize)> {
    let name = root.file_name().context("a folder without a name")?;
    let mut builder = tar::Builder::new(Vec::new());
    builder.follow_symlinks(false);
    let (mut total, mut count) = (0u64, 0usize);
    let mut pending = vec![(root.to_path_buf(), PathBuf::from(name))];
    while let Some((dir, rel)) = pending.pop() {
        builder.append_dir(&rel, &dir).with_context(|| format!("{}", dir.display()))?;
        for entry in fs::read_dir(&dir).with_context(|| format!("{}", dir.display()))? {
            let entry = entry?;
            let file_name = entry.file_name();
            if file_name.to_str().is_some_and(|n| SKIP.contains(&n)) {
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
    Ok((builder.into_inner()?, count))
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
        let (bytes, count) = tar_folder(&root, 1024).unwrap();
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
        assert!(tar_folder(&root, 3).is_err(), "the size cap applies");
        let _ = fs::remove_dir_all(dir);
    }
}
