//! Checkpoints: the project folder's files saved before each message, to put them back later.
//!
//! A shadow git repository per folder, in `%APPDATA%\pier\checkpoints\`, with the folder as its work tree: the
//! project's own git (branches, index, refs) is never touched, and folders without git work too. The project's
//! `.gitignore` files are honored, so build output is not saved. Git must be installed.

use crate::pi::process::fingerprint;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process;
use std::sync::mpsc::{Receiver, Sender, channel};

/// A checkpoint that would save more than this (new or changed since the last one) is refused: a folder
/// without a `.gitignore` can hold build output or a whole home directory.
const MAX_FILES: usize = 20_000;
const MAX_BYTES: u64 = 500 * 1024 * 1024;
/// Keeps every checkpoint reachable, so git's cleanup never drops one.
const HEAD_REF: &str = "refs/pier/checkpoints";

pub fn dir() -> PathBuf {
    std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("pier").join("checkpoints")
}

fn git_command() -> process::Command {
    #[allow(unused_mut)]
    let mut cmd = process::Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up from a windowed app
    }
    cmd
}

pub struct Repo {
    git_dir: PathBuf,
    work: PathBuf,
}

impl Repo {
    /// The shadow repository for `work`, under `root`; created on first use.
    pub fn new(root: &Path, work: &Path) -> Self {
        let key = std::fs::canonicalize(work).unwrap_or_else(|_| work.to_path_buf()).to_string_lossy().to_lowercase();
        Self { git_dir: root.join(format!("{:016x}.git", fingerprint(key.as_bytes()))), work: work.to_path_buf() }
    }

    fn git(&self, args: &[&str], stdin: Option<&[u8]>) -> Result<Vec<u8>, String> {
        let mut cmd = git_command();
        cmd.arg("--git-dir")
            .arg(&self.git_dir)
            .arg("--work-tree")
            .arg(&self.work)
            .arg("--literal-pathspecs") // a file named `*.rs` is that file, not a pattern
            // Exact bytes back on restore, long Windows paths, and no fsmonitor daemon from the user's config.
            .args(["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.longpaths=true", "-c", "core.fsmonitor=false"])
            .args(["-c", "core.quotepath=false"])
            .args(args)
            .current_dir(&self.work)
            .env("GIT_AUTHOR_NAME", "Pier")
            .env("GIT_AUTHOR_EMAIL", "pier@localhost")
            .env("GIT_COMMITTER_NAME", "Pier")
            .env("GIT_COMMITTER_EMAIL", "pier@localhost")
            .stdin(if stdin.is_some() { process::Stdio::piped() } else { process::Stdio::null() })
            .stdout(process::Stdio::piped())
            .stderr(process::Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("cannot run git ({e}); is git installed?"))?;
        if let (Some(bytes), Some(mut pipe)) = (stdin, child.stdin.take()) {
            pipe.write_all(bytes).map_err(|e| e.to_string())?;
        }
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(format!("git {}: {}", args[0], err.lines().next().unwrap_or("failed")));
        }
        Ok(out.stdout)
    }

    fn text(&self, args: &[&str]) -> Result<String, String> {
        Ok(String::from_utf8_lossy(&self.git(args, None)?).trim().to_owned())
    }

    fn init(&self) -> Result<(), String> {
        if self.git_dir.join("HEAD").is_file() {
            return Ok(());
        }
        std::fs::create_dir_all(&self.git_dir).map_err(|e| e.to_string())?;
        let out = git_command()
            .args(["init", "--bare", "--quiet"])
            .arg(&self.git_dir)
            .stdin(process::Stdio::null())
            .output()
            .map_err(|e| format!("cannot run git ({e}); is git installed?"))?;
        if !out.status.success() {
            return Err(format!("git init: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        Ok(())
    }

    /// Refuses a checkpoint that would save too much (see `MAX_FILES`).
    fn check_size(&self) -> Result<(), String> {
        let listed = self.git(&["add", "--all", "--dry-run", "--ignore-errors"], None)?;
        let listed = String::from_utf8_lossy(&listed);
        let (mut files, mut bytes) = (0usize, 0u64);
        for line in listed.lines() {
            let Some(path) = line.strip_prefix("add '").and_then(|l| l.strip_suffix('\'')) else { continue };
            files += 1;
            bytes += std::fs::metadata(self.work.join(path)).map(|m| m.len()).unwrap_or(0);
        }
        if files > MAX_FILES || bytes > MAX_BYTES {
            return Err(format!(
                "{files} files, {} MB to save: too much (limits {MAX_FILES} files, {} MB); a .gitignore can leave build output out",
                bytes / (1024 * 1024),
                MAX_BYTES / (1024 * 1024)
            ));
        }
        Ok(())
    }

    /// The folder's files, `/`-separated and sorted, without ignored ones (for `@` mentions); at most `MAX_FILES`.
    pub fn list_files(&self) -> Result<Vec<String>, String> {
        self.init()?;
        // Saved by the last checkpoint, or new since; a file deleted since the checkpoint is filtered out below.
        let out = self.git(&["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"], None)?;
        let mut files: Vec<String> = out
            .split(|b| *b == 0)
            .filter(|p| !p.is_empty())
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .filter(|p| self.work.join(p).is_file())
            .take(MAX_FILES)
            .collect();
        files.sort();
        Ok(files)
    }

    /// Saves the folder's files as they are now; returns the checkpoint id.
    pub fn snapshot(&self) -> Result<String, String> {
        self.init()?;
        self.check_size()?;
        // --ignore-errors: a file locked by another program is skipped, not the whole checkpoint.
        self.git(&["add", "--all", "--ignore-errors"], None).or_else(|e| if e.contains("unable to") { Ok(vec![]) } else { Err(e) })?;
        let tree = self.text(&["write-tree"])?;
        let parent = self.text(&["rev-parse", "--quiet", "--verify", HEAD_REF]).unwrap_or_default();
        let mut args = vec!["commit-tree", &tree, "-m", "pier checkpoint"];
        if !parent.is_empty() {
            args.extend(["-p", &parent]);
        }
        let commit = self.text(&args)?;
        self.git(&["update-ref", HEAD_REF, &commit], None)?;
        Ok(commit)
    }

    /// Puts the folder's files back as they were at `to`. `now`: a checkpoint of the current files, taken just
    /// before (it is what lets the restore be undone). Files created since are removed; ignored files are untouched.
    pub fn restore(&self, to: &str, now: &str) -> Result<(), String> {
        let changes = self.git(&["diff", "--name-status", "-z", "--no-renames", to, now], None)?;
        let mut fields = changes.split(|b| *b == 0).filter(|f| !f.is_empty());
        let (mut back, mut created) = (Vec::new(), Vec::new());
        while let (Some(status), Some(path)) = (fields.next(), fields.next()) {
            if status == b"A" { created.push(path) } else { back.push(path) }
        }
        for path in created {
            let path = self.work.join(String::from_utf8_lossy(path).as_ref());
            std::fs::remove_file(&path).map_err(|e| format!("cannot remove {}: {e}", path.display()))?;
        }
        if !back.is_empty() {
            let list: Vec<u8> = back.join(&0u8);
            self.git(&["checkout", to, "--pathspec-from-file=-", "--pathspec-file-nul"], Some(&list))?;
        }
        Ok(())
    }
}

/// What the checkpoint thread is asked to do.
pub enum Job {
    Snapshot,
    /// Restore to this checkpoint, after saving the current files.
    Restore(String),
    /// List the folder's files, for `@` mentions.
    ListFiles,
}

/// What it did.
#[derive(Debug)]
pub enum Done {
    Snapshot(Result<String, String>),
    /// `undo`: the checkpoint of the files just before the restore. No restore happens without it.
    Restored {
        to: String,
        undo: Result<String, String>,
        result: Result<(), String>,
    },
    Files(Result<Vec<String>, String>),
}

/// A thread per tab doing the git work, so a large folder never freezes the window. Jobs run in order.
pub struct Worker {
    jobs: Sender<Job>,
    pub done: Receiver<Done>,
}

impl Worker {
    /// `wake`: called after each job, so the UI picks up the result. The thread ends with the `Worker`.
    pub fn start(repo: Repo, wake: impl Fn() + Send + 'static) -> Self {
        let (jobs, todo) = channel::<Job>();
        let (finished, done) = channel();
        std::thread::spawn(move || {
            for job in todo {
                let result = match job {
                    Job::Snapshot => Done::Snapshot(repo.snapshot()),
                    Job::Restore(to) => {
                        let undo = repo.snapshot();
                        let result = match &undo {
                            Ok(now) => repo.restore(&to, now),
                            Err(_) => Err("not restored: the current files could not be saved first".into()),
                        };
                        Done::Restored { to, undo, result }
                    }
                    Job::ListFiles => Done::Files(repo.list_files()),
                };
                if finished.send(result).is_err() {
                    break;
                }
                wake();
            }
        });
        Self { jobs, done }
    }

    pub fn send(&self, job: Job) -> bool {
        self.jobs.send(job).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn folder(name: &str) -> (PathBuf, Repo) {
        let root = std::env::temp_dir().join(format!("pier-checkpoint-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let work = root.join("project");
        fs::create_dir_all(work.join("src")).unwrap();
        let repo = Repo::new(&root.join("shadow"), &work);
        (root, repo)
    }

    #[test]
    fn restore_puts_files_back_and_can_be_undone() {
        let (root, repo) = folder("restore");
        let w = repo.work.clone();
        fs::write(w.join("a.txt"), "one\r\n").unwrap();
        fs::write(w.join("src/b.rs"), "fn b() {}").unwrap();
        fs::write(w.join("gone.txt"), "deleted later").unwrap();
        fs::write(w.join(".gitignore"), "target/\n").unwrap();
        fs::create_dir_all(w.join("target")).unwrap();
        fs::write(w.join("target/out.bin"), "build").unwrap();
        let before = repo.snapshot().unwrap();

        fs::write(w.join("a.txt"), "two").unwrap();
        fs::remove_file(w.join("gone.txt")).unwrap();
        fs::write(w.join("src/new [1].rs"), "created").unwrap();
        fs::write(w.join("target/out.bin"), "rebuilt").unwrap();
        let after = repo.snapshot().unwrap();
        assert_ne!(before, after);

        repo.restore(&before, &after).unwrap();
        assert_eq!(fs::read_to_string(w.join("a.txt")).unwrap(), "one\r\n", "exact bytes, line endings included");
        assert_eq!(fs::read_to_string(w.join("gone.txt")).unwrap(), "deleted later");
        assert!(!w.join("src/new [1].rs").exists(), "created since: removed");
        assert_eq!(fs::read_to_string(w.join("target/out.bin")).unwrap(), "rebuilt", "ignored files are untouched");
        assert_eq!(fs::read_to_string(w.join("src/b.rs")).unwrap(), "fn b() {}");

        let now = repo.snapshot().unwrap();
        repo.restore(&after, &now).unwrap();
        assert_eq!(fs::read_to_string(w.join("a.txt")).unwrap(), "two", "undo");
        assert!(w.join("src/new [1].rs").exists() && !w.join("gone.txt").exists());

        fs::write(w.join("fresh.md"), "not in any checkpoint").unwrap();
        assert_eq!(
            repo.list_files().unwrap(),
            [".gitignore", "a.txt", "fresh.md", "src/b.rs", "src/new [1].rs"],
            "new files in, deleted and ignored ones out"
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_worker_saves_before_restoring() {
        let (root, repo) = folder("worker");
        let w = repo.work.clone();
        fs::write(w.join("a.txt"), "one").unwrap();
        let worker = Worker::start(repo, || {});
        worker.send(Job::Snapshot);
        let Done::Snapshot(Ok(first)) = worker.done.recv().unwrap() else { panic!("no checkpoint") };
        fs::write(w.join("a.txt"), "two").unwrap();
        worker.send(Job::Restore(first.clone()));
        let Done::Restored { to, undo: Ok(_), result: Ok(()) } = worker.done.recv().unwrap() else { panic!("not restored") };
        assert_eq!(to, first);
        assert_eq!(fs::read_to_string(w.join("a.txt")).unwrap(), "one");
        drop(worker);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_folder_is_one_repository_whatever_the_spelling() {
        let (root, repo) = folder("key");
        let other = Repo::new(&root.join("shadow"), &repo.work.join("src").join(".."));
        assert_eq!(repo.git_dir, other.git_dir);
        fs::remove_dir_all(&root).unwrap();
    }
}
