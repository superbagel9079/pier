//! Take back, file by file: a handed-off copy on the VM compared with its original
//! folder on this computer, and the files chosen brought back into the original.
//!
//! The picker lists the copy's files with their SHA-256 (copy-manifest); the original is
//! listed the same way here, and the two compared. What is brought back replaces the
//! original's file only after that file was moved to a backup folder next to the
//! original: nothing is lost. A file deleted by Pi is deleted here only when chosen, and
//! goes to the backup folder too.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::Value;

use crate::copy::SKIP;

/// The most files compared, as the picker does (MANIFEST_MAX_FILES).
const FILES_MAX: usize = 20000;
/// Most bytes hashed on this side, as the picker does.
const BYTES_MAX: u64 = 2 * 1024 * 1024 * 1024;

/// relative path ("a/b.txt") -> (size, SHA-256 in hex)
pub type Manifest = BTreeMap<String, (u64, String)>;

/// The original folder's files, as the picker lists the copy's: links and what SKIP
/// names are left out.
pub fn local_manifest(root: &Path) -> Result<(Manifest, bool)> {
    let mut files = Manifest::new();
    let mut total = 0u64;
    let mut pending = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, rel)) = pending.pop() {
        let mut entries: Vec<_> = fs::read_dir(&dir).with_context(|| dir.display().to_string())?.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
            if SKIP.contains(&name.as_str()) {
                continue;
            }
            let kind = entry.file_type()?;
            let inside = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                pending.push((entry.path(), inside));
            } else if kind.is_file() {
                let size = entry.metadata()?.len();
                if files.len() >= FILES_MAX || total + size > BYTES_MAX {
                    return Ok((files, true));
                }
                total += size;
                files.insert(inside, (size, sha256_file(&entry.path())?));
            }
        }
    }
    Ok((files, false))
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut context = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        context.update(&buffer[..n]);
    }
    Ok(context.finish().as_ref().iter().map(|b| format!("{b:02x}")).collect())
}

/// The copy's files as the picker sent them ({"files": {rel: {"size", "sha256"}}}).
pub fn remote_manifest(reply: &Value) -> Manifest {
    let mut files = Manifest::new();
    if let Some(map) = reply.get("files").and_then(Value::as_object) {
        for (rel, info) in map {
            let size = info.get("size").and_then(Value::as_u64).unwrap_or(0);
            let hash = info.get("sha256").and_then(Value::as_str).unwrap_or_default().to_string();
            if safe_parts(rel).is_some() {
                files.insert(rel.clone(), (size, hash));
            }
        }
    }
    files
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct Change {
    pub rel: String,
    /// Size on this computer, and on the VM (None: not there).
    pub size_pc: Option<u64>,
    pub size_vm: Option<u64>,
}

#[derive(Serialize, Debug, Default)]
pub struct Comparison {
    pub changed: Vec<Change>,
    pub added: Vec<Change>,
    pub deleted: Vec<Change>,
    pub same: usize,
}

pub fn compare(local: &Manifest, remote: &Manifest) -> Comparison {
    let mut result = Comparison::default();
    for (rel, (size, hash)) in remote {
        match local.get(rel) {
            Some((_, h)) if h == hash => result.same += 1,
            Some((local_size, _)) => result.changed.push(Change { rel: rel.clone(), size_pc: Some(*local_size), size_vm: Some(*size) }),
            None => result.added.push(Change { rel: rel.clone(), size_pc: None, size_vm: Some(*size) }),
        }
    }
    for (rel, (size, _)) in local {
        if !remote.contains_key(rel) {
            result.deleted.push(Change { rel: rel.clone(), size_pc: Some(*size), size_vm: None });
        }
    }
    result
}

/// The components of a relative path from the VM, or None when it could leave the
/// folder or mean something else on Windows (C:x, a:b streams, \, device names).
pub fn safe_parts(rel: &str) -> Option<Vec<&str>> {
    if rel.is_empty() || rel.len() > 4096 || rel.starts_with('/') {
        return None;
    }
    let parts: Vec<&str> = rel.split('/').collect();
    let bad = |p: &str| {
        let stem = p.split('.').next().unwrap_or_default().to_ascii_uppercase();
        let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit());
        p.is_empty() || p == "." || p == ".." || p.contains(['\\', ':', '<', '>', '"', '|', '?', '*']) || p.chars().any(char::is_control)
            || p.ends_with('.') || p.ends_with(' ') || device
    };
    if parts.iter().any(|p| bad(p)) {
        return None;
    }
    Some(parts)
}

/// root joined with a checked relative path; None when it is not one.
fn inside(root: &Path, rel: &str) -> Option<PathBuf> {
    let mut path = root.to_path_buf();
    for part in safe_parts(rel)? {
        path.push(part);
    }
    path.components().all(|c| !matches!(c, Component::ParentDir)).then_some(path)
}

/// The original's file at rel, at most `max` bytes (empty when it has none).
pub fn read_local(root: &Path, rel: &str, max: u64) -> Result<Vec<u8>> {
    let Some(path) = inside(root, rel) else { bail!("not a file of the folder: {rel}") };
    match fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_file() => {
            let mut bytes = Vec::new();
            fs::File::open(&path)?.take(max + 1).read_to_end(&mut bytes)?;
            Ok(bytes)
        }
        _ => Ok(Vec::new()),
    }
}

#[derive(Serialize, Debug, Default)]
pub struct Applied {
    pub taken: Vec<String>,
    pub deleted: Vec<String>,
    pub skipped: Vec<String>,
    /// Where the replaced and deleted files went; None when nothing was replaced.
    pub backup: Option<String>,
}

/// Brings the files of `archive` (a tar of the copy's files, from the picker) named in
/// `take` into `root`, and deletes `delete` there. Every file replaced or deleted is
/// first moved to `backup` (created only if needed). Files are marked as coming from
/// elsewhere (Mark of the Web), as a take-back is.
pub fn apply(root: &Path, backup: &Path, archive: Option<&Path>, take: &HashSet<String>, delete: &[String]) -> Result<Applied> {
    let real_root = root.canonicalize().with_context(|| root.display().to_string())?;
    let mut applied = Applied::default();
    let mut backed_up = false;
    let mut save_old = |path: &Path, rel: &str, applied: &mut Applied| -> Result<()> {
        let Some(saved) = inside(backup, rel) else { bail!("not a file of the folder: {rel}") };
        if let Some(parent) = saved.parent() {
            fs::create_dir_all(parent)?;
        }
        if fs::rename(path, &saved).is_err() {
            fs::copy(path, &saved)?;
            fs::remove_file(path)?;
        }
        if !backed_up {
            backed_up = true;
            applied.backup = Some(backup.display().to_string());
        }
        Ok(())
    };
    if let Some(archive) = archive {
        let mut tar = tar::Archive::new(fs::File::open(archive)?);
        let (mut total, mut n) = (0u64, 0u32);
        for entry in tar.entries()? {
            let mut entry = entry?;
            let rel = entry.path()?.to_string_lossy().replace('\\', "/");
            if !entry.header().entry_type().is_file() || !take.contains(&rel) {
                continue;
            }
            total += entry.header().size().unwrap_or(0);
            if total > crate::TAKEBACK_UNPACKED_MAX {
                bail!("the files chosen are more than {} GB: stopped", crate::TAKEBACK_UNPACKED_MAX >> 30);
            }
            let Some(target) = inside(root, &rel) else {
                applied.skipped.push(rel);
                continue;
            };
            let parent = target.parent().context("a file without a folder")?;
            fs::create_dir_all(parent)?;
            // The folder written in must really be inside the original (no junction or
            // link on the way), and the file itself not a link.
            let real_parent = parent.canonicalize()?;
            let is_link = fs::symlink_metadata(&target).is_ok_and(|m| m.file_type().is_symlink() || m.is_dir());
            if !real_parent.starts_with(&real_root) || is_link {
                applied.skipped.push(rel);
                continue;
            }
            n += 1;
            let tmp = parent.join(format!(".pier-takeback-{}-{n}.tmp", std::process::id()));
            let mut out = fs::File::create(&tmp)?;
            if let Err(err) = std::io::copy(&mut entry, &mut out) {
                drop(out);
                let _ = fs::remove_file(&tmp);
                return Err(err.into());
            }
            drop(out);
            if target.exists() {
                save_old(&target, &rel, &mut applied)?;
            }
            fs::rename(&tmp, &target)?;
            crate::mark_from_elsewhere(&target);
            applied.taken.push(rel);
        }
    }
    for rel in delete {
        let Some(target) = inside(root, rel) else {
            applied.skipped.push(rel.clone());
            continue;
        };
        let real_parent = target.parent().and_then(|p| p.canonicalize().ok());
        let plain = fs::symlink_metadata(&target).is_ok_and(|m| m.is_file());
        if !plain || !real_parent.is_some_and(|p| p.starts_with(&real_root)) {
            applied.skipped.push(rel.clone());
            continue;
        }
        save_old(&target, rel, &mut applied)?;
        applied.deleted.push(rel.clone());
    }
    Ok(applied)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pier-takeback-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("orig/sub")).unwrap();
        dir
    }

    #[test]
    fn paths_from_the_vm_are_checked() {
        assert_eq!(safe_parts("a/b.txt"), Some(vec!["a", "b.txt"]));
        for bad in ["", "/etc/x", "../x", "a/../b", "a//b", "a\\b", "C:x", "a:b", "NUL", "con.txt", "COM1", "x.", "a/b ", "a\nb"] {
            assert!(safe_parts(bad).is_none(), "{bad:?}");
        }
        assert!(safe_parts("COMMON.md").is_some());
    }

    #[test]
    fn compares_by_content() {
        let dir = sandbox("compare");
        let root = dir.join("orig");
        fs::write(root.join("same.txt"), "x").unwrap();
        fs::write(root.join("changed.txt"), "old").unwrap();
        fs::write(root.join("sub/gone.txt"), "bye").unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/skip.js"), "skip").unwrap();
        let (local, truncated) = local_manifest(&root).unwrap();
        assert!(!truncated);
        assert!(!local.contains_key("node_modules/skip.js"));
        let mut remote = Manifest::new();
        remote.insert("same.txt".into(), local["same.txt"].clone());
        remote.insert("changed.txt".into(), (3, "other".into()));
        remote.insert("new.txt".into(), (1, "h".into()));
        let result = compare(&local, &remote);
        assert_eq!(result.same, 1);
        assert_eq!(result.changed.iter().map(|c| c.rel.as_str()).collect::<Vec<_>>(), ["changed.txt"]);
        assert_eq!(result.added.iter().map(|c| c.rel.as_str()).collect::<Vec<_>>(), ["new.txt"]);
        assert_eq!(result.deleted.iter().map(|c| c.rel.as_str()).collect::<Vec<_>>(), ["sub/gone.txt"]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn applies_with_a_backup() {
        let dir = sandbox("apply");
        let root = dir.join("orig");
        fs::write(root.join("changed.txt"), "old").unwrap();
        fs::write(root.join("sub/gone.txt"), "bye").unwrap();
        fs::write(root.join("kept.txt"), "mine").unwrap();
        // The picker's tar: two files chosen, one not, one trying to climb out.
        let archive = dir.join("files.tar");
        {
            let mut builder = tar::Builder::new(fs::File::create(&archive).unwrap());
            for (name, body) in [("changed.txt", "new"), ("sub/new.txt", "fresh"), ("kept.txt", "pi's"), ("../escape.txt", "x")] {
                let mut header = tar::Header::new_gnu();
                header.set_size(body.len() as u64);
                header.set_mode(0o644);
                header.set_entry_type(tar::EntryType::Regular);
                let name_bytes = name.as_bytes();
                header.as_old_mut().name[..name_bytes.len()].copy_from_slice(name_bytes);
                header.set_cksum();
                builder.append(&header, body.as_bytes()).unwrap();
            }
            builder.finish().unwrap();
        }
        let take: HashSet<String> = ["changed.txt", "sub/new.txt", "../escape.txt"].iter().map(|s| s.to_string()).collect();
        let backup = dir.join("orig (before Pi's changes)");
        let applied = apply(&root, &backup, Some(&archive), &take, &["sub/gone.txt".to_string()]).unwrap();
        assert_eq!(fs::read_to_string(root.join("changed.txt")).unwrap(), "new");
        assert_eq!(fs::read_to_string(root.join("sub/new.txt")).unwrap(), "fresh");
        assert_eq!(fs::read_to_string(root.join("kept.txt")).unwrap(), "mine", "not chosen: not touched");
        assert!(!root.join("sub/gone.txt").exists());
        assert_eq!(fs::read_to_string(backup.join("changed.txt")).unwrap(), "old");
        assert_eq!(fs::read_to_string(backup.join("sub/gone.txt")).unwrap(), "bye");
        assert!(!dir.join("escape.txt").exists());
        assert_eq!(applied.skipped, vec!["../escape.txt".to_string()]);
        assert_eq!(read_local(&root, "changed.txt", 10).unwrap(), b"new");
        assert!(read_local(&root, "../x", 10).is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
