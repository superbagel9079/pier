//! Lending a folder of this computer to the VM, live, without copying it.
//!
//! On the VM, `pi-pick --share-serve MOUNT` runs sshfs in passive mode: sshfs speaks
//! SFTP over its stdin and stdout, which are this SSH channel, and this module answers
//! as the SFTP server. The VM therefore sees exactly one folder of this computer, and
//! nothing listens on any network port. Read-only unless the user allowed writing.
//!
//! Every path sshfs asks for is confined to the shared folder: ".." cannot climb out,
//! and a symlink or junction pointing outside is refused once resolved.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use russh_sftp::protocol::{Attrs, Data, File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode, Version};

/// Entries returned per READDIR reply, to stay well under SFTP packet limits.
const DIR_CHUNK: usize = 100;
/// Largest READ answered at once.
const READ_MAX: u32 = 256 * 1024;

enum Open {
    Dir { path: PathBuf, pending: Option<Vec<File>> },
    File(fs::File),
}

pub struct ShareFs {
    root: PathBuf,
    writable: bool,
    handles: HashMap<String, Open>,
    next: u64,
}

impl ShareFs {
    /// `root` must exist; it is canonicalized so confinement checks compare like with like.
    pub fn new(root: &Path, writable: bool) -> std::io::Result<Self> {
        Ok(Self { root: root.canonicalize()?, writable, handles: HashMap::new(), next: 0 })
    }

    /// The SFTP path as seen by the VM, normalized: "/" is the shared folder.
    fn virtual_path(path: &str) -> Result<Vec<String>, StatusCode> {
        let mut parts: Vec<String> = Vec::new();
        for part in path.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                // Backslashes and colons would let a name escape on Windows ("..\x",
                // "C:x", alternate data streams "a:b").
                p if p.contains('\\') || p.contains(':') => {
                    log_warn!("share.refused", path = path, reason = "backslash or colon in a name");
                    return Err(StatusCode::PermissionDenied);
                }
                p => parts.push(p.to_string()),
            }
        }
        Ok(parts)
    }

    /// Local path for an SFTP path, refused if it resolves outside the shared folder.
    fn resolve(&self, path: &str) -> Result<PathBuf, StatusCode> {
        let mut full = self.root.clone();
        for part in Self::virtual_path(path)? {
            full.push(part);
        }
        // Existing paths (a link too, even one pointing nowhere) are checked once links
        // are resolved; a path being created is checked through its parent. Anything
        // that cannot be resolved is refused.
        let exists = std::fs::symlink_metadata(&full).is_ok();
        let anchor = if exists { Some(full.clone()) } else { full.parent().map(Path::to_path_buf) };
        let inside = anchor.and_then(|a| a.canonicalize().ok()).is_some_and(|real| real.starts_with(&self.root));
        if !inside {
            log_warn!("share.refused", path = path, reason = "outside the shared folder, or unresolvable", root = self.root.display());
            return Err(StatusCode::PermissionDenied);
        }
        Ok(full)
    }

    fn new_handle(&mut self, open: Open) -> String {
        self.next += 1;
        let handle = format!("h{}", self.next);
        self.handles.insert(handle.clone(), open);
        handle
    }

    fn must_write(&self) -> Result<(), StatusCode> {
        if self.writable {
            return Ok(());
        }
        log_debug!("share.read-only", root = self.root.display());
        Err(StatusCode::PermissionDenied)
    }
}

fn status_of(err: std::io::Error) -> StatusCode {
    match err.kind() {
        ErrorKind::NotFound => StatusCode::NoSuchFile,
        ErrorKind::PermissionDenied => {
            log_debug!("share.io", err = err);
            StatusCode::PermissionDenied
        }
        _ => {
            log_warn!("share.io", err = err);
            StatusCode::Failure
        }
    }
}

fn ok(id: u32) -> Status {
    Status { id, status_code: StatusCode::Ok, error_message: "Ok".into(), language_tag: "en-US".into() }
}

fn attrs(path: &Path) -> Result<FileAttributes, StatusCode> {
    fs::metadata(path).map(|m| FileAttributes::from(&m)).map_err(status_of)
}

impl russh_sftp::server::Handler for ShareFs {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(&mut self, _version: u32, _extensions: HashMap<String, String>) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let parts = Self::virtual_path(&path)?;
        Ok(Name { id, files: vec![File::dummy(format!("/{}", parts.join("/")))] })
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        Ok(Attrs { id, attrs: attrs(&self.resolve(&path)?)? })
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        // Links are presented as what they point to: the VM never sees a link it
        // could follow on its own side.
        Ok(Attrs { id, attrs: attrs(&self.resolve(&path)?)? })
    }

    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, Self::Error> {
        match self.handles.get(&handle) {
            Some(Open::File(file)) => Ok(Attrs { id, attrs: FileAttributes::from(&file.metadata().map_err(status_of)?) }),
            Some(Open::Dir { path, .. }) => Ok(Attrs { id, attrs: attrs(path)? }),
            None => Err(StatusCode::Failure),
        }
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        let dir = self.resolve(&path)?;
        if !dir.is_dir() {
            return Err(StatusCode::NoSuchFile);
        }
        Ok(Handle { id, handle: self.new_handle(Open::Dir { path: dir, pending: None }) })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        let Some(Open::Dir { path, pending }) = self.handles.get_mut(&handle) else {
            return Err(StatusCode::Failure);
        };
        if pending.is_none() {
            let mut files = Vec::new();
            for entry in fs::read_dir(&*path).map_err(status_of)?.flatten() {
                // Names that are not valid Unicode cannot be named back over SFTP.
                let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
                if let Ok(meta) = fs::metadata(entry.path()) {
                    files.push(File::new(name, FileAttributes::from(&meta)));
                }
            }
            *pending = Some(files);
        }
        let remaining = pending.as_mut().expect("filled above");
        if remaining.is_empty() {
            return Err(StatusCode::Eof);
        }
        let take = remaining.len().min(DIR_CHUNK);
        Ok(Name { id, files: remaining.drain(..take).collect() })
    }

    async fn open(&mut self, id: u32, filename: String, pflags: OpenFlags, _attrs: FileAttributes) -> Result<Handle, Self::Error> {
        let writes = pflags.intersects(OpenFlags::WRITE | OpenFlags::APPEND | OpenFlags::CREATE | OpenFlags::TRUNCATE);
        if writes {
            self.must_write()?;
        }
        let path = self.resolve(&filename)?;
        let file = OpenOptions::new()
            .read(pflags.contains(OpenFlags::READ) || !writes)
            .write(pflags.contains(OpenFlags::WRITE))
            .append(pflags.contains(OpenFlags::APPEND))
            .create(pflags.contains(OpenFlags::CREATE) && !pflags.contains(OpenFlags::EXCLUDE))
            .create_new(pflags.contains(OpenFlags::CREATE) && pflags.contains(OpenFlags::EXCLUDE))
            .truncate(pflags.contains(OpenFlags::TRUNCATE))
            .open(&path)
            .map_err(status_of)?;
        Ok(Handle { id, handle: self.new_handle(Open::File(file)) })
    }

    async fn read(&mut self, id: u32, handle: String, offset: u64, len: u32) -> Result<Data, Self::Error> {
        let Some(Open::File(file)) = self.handles.get_mut(&handle) else {
            return Err(StatusCode::Failure);
        };
        file.seek(SeekFrom::Start(offset)).map_err(status_of)?;
        let mut data = vec![0; len.min(READ_MAX) as usize];
        let n = file.read(&mut data).map_err(status_of)?;
        if n == 0 {
            return Err(StatusCode::Eof);
        }
        data.truncate(n);
        Ok(Data { id, data })
    }

    async fn write(&mut self, id: u32, handle: String, offset: u64, data: Vec<u8>) -> Result<Status, Self::Error> {
        self.must_write()?;
        let Some(Open::File(file)) = self.handles.get_mut(&handle) else {
            return Err(StatusCode::Failure);
        };
        file.seek(SeekFrom::Start(offset)).map_err(status_of)?;
        file.write_all(&data).map_err(status_of)?;
        Ok(ok(id))
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.handles.remove(&handle);
        Ok(ok(id))
    }

    async fn setstat(&mut self, id: u32, _path: String, _attrs: FileAttributes) -> Result<Status, Self::Error> {
        // Permissions and times are not carried over; accepted so "touch" works.
        self.must_write()?;
        Ok(ok(id))
    }

    async fn fsetstat(&mut self, id: u32, _handle: String, _attrs: FileAttributes) -> Result<Status, Self::Error> {
        self.must_write()?;
        Ok(ok(id))
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        self.must_write()?;
        fs::remove_file(self.resolve(&filename)?).map_err(status_of)?;
        Ok(ok(id))
    }

    async fn mkdir(&mut self, id: u32, path: String, _attrs: FileAttributes) -> Result<Status, Self::Error> {
        self.must_write()?;
        fs::create_dir(self.resolve(&path)?).map_err(status_of)?;
        Ok(ok(id))
    }

    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        self.must_write()?;
        let dir = self.resolve(&path)?;
        if dir == self.root {
            return Err(StatusCode::PermissionDenied);
        }
        fs::remove_dir(dir).map_err(status_of)?;
        Ok(ok(id))
    }

    async fn rename(&mut self, id: u32, oldpath: String, newpath: String) -> Result<Status, Self::Error> {
        self.must_write()?;
        fs::rename(self.resolve(&oldpath)?, self.resolve(&newpath)?).map_err(status_of)?;
        Ok(ok(id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh_sftp::server::Handler;

    fn sandbox(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pier-share-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("shared/sub")).unwrap();
        fs::write(dir.join("shared/a.txt"), b"hello").unwrap();
        fs::write(dir.join("secret.txt"), b"outside").unwrap();
        dir
    }

    #[test]
    fn paths_stay_inside() {
        assert_eq!(ShareFs::virtual_path("/a/../../b").unwrap(), vec!["b"]);
        assert!(ShareFs::virtual_path("/..\\secret").is_err());
        assert!(ShareFs::virtual_path("/C:secret").is_err());
        assert!(ShareFs::virtual_path("/a.txt:stream").is_err());
        let dir = sandbox("paths");
        let fs = ShareFs::new(&dir.join("shared"), false).unwrap();
        assert!(fs.resolve("/../secret.txt").unwrap().starts_with(&fs.root));
        let _ = fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn read_only_by_default() {
        let dir = sandbox("ro");
        let mut fs = ShareFs::new(&dir.join("shared"), false).unwrap();
        let handle = fs.open(1, "/a.txt".into(), OpenFlags::READ, FileAttributes::empty()).await.unwrap().handle;
        assert_eq!(fs.read(2, handle.clone(), 0, 100).await.unwrap().data, b"hello");
        assert_eq!(fs.read(3, handle, 5, 100).await.unwrap_err(), StatusCode::Eof);
        let write = fs.open(4, "/new.txt".into(), OpenFlags::WRITE | OpenFlags::CREATE, FileAttributes::empty()).await;
        assert_eq!(write.unwrap_err(), StatusCode::PermissionDenied);
        assert_eq!(fs.remove(5, "/a.txt".into()).await.unwrap_err(), StatusCode::PermissionDenied);
        assert!(dir.join("shared/a.txt").exists());
        // ".." never reaches the file next to the shared folder.
        let escaped = fs.open(6, "/../secret.txt".into(), OpenFlags::READ, FileAttributes::empty()).await;
        assert_eq!(escaped.unwrap_err(), StatusCode::NoSuchFile);
        let _ = fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn listing_and_writing_when_allowed() {
        let dir = sandbox("rw");
        let mut fs = ShareFs::new(&dir.join("shared"), true).unwrap();
        let handle = fs.opendir(1, "/".into()).await.unwrap().handle;
        let mut names: Vec<String> = fs.readdir(2, handle.clone()).await.unwrap().files.into_iter().map(|f| f.filename).collect();
        names.sort();
        assert_eq!(names, vec!["a.txt", "sub"]);
        assert_eq!(fs.readdir(3, handle).await.unwrap_err(), StatusCode::Eof);
        let w = fs.open(4, "/sub/b.txt".into(), OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE, FileAttributes::empty()).await.unwrap().handle;
        fs.write(5, w.clone(), 0, b"written".to_vec()).await.unwrap();
        fs.close(6, w).await.unwrap();
        assert_eq!(fs::read(dir.join("shared/sub/b.txt")).unwrap(), b"written");
        assert_eq!(fs.rmdir(7, "/".into()).await.unwrap_err(), StatusCode::PermissionDenied);
        let _ = fs::remove_dir_all(dir);
    }
}
