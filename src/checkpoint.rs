//! Checkpoints: the project folder's files saved before each message, to put them back later.
//!
//! A shadow git repository per folder, in `%APPDATA%\pier\checkpoints\`, with the folder as its work tree: the
//! project's own git (branches, index, refs) is never touched, and folders without git work too. The project's
//! `.gitignore` files are honored, so build output is not saved. Git must be installed.
//!
//! One `Worker` thread per folder, shared by every tab open on it: git operations on one shadow repository never
//! run at the same time.

use crate::pi::process::fingerprint;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process;
use std::sync::Arc;
use std::sync::mpsc::{Sender, channel};
use std::time::{Duration, Instant};

/// A checkpoint that would save more than this (new or changed since the last one) is refused: a folder
/// without a `.gitignore` can hold build output or a whole home directory.
const MAX_FILES: usize = 20_000;
const MAX_BYTES: u64 = 500 * 1024 * 1024;
/// After a refusal for size, checkpoints are skipped this long instead of walking the whole folder at each message.
const TOO_BIG_RETRY: Duration = Duration::from_secs(300);
/// Keeps every checkpoint reachable, so git's cleanup never drops one.
const HEAD_REF: &str = "refs/pier/checkpoints";
/// A gitlink: a nested repository, recorded as a commit id, not as files.
const GITLINK_MODE: &str = "160000";

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

/// A checkpoint taken: its id, and the files another program held locked (left out of it).
#[derive(Debug, Clone, PartialEq)]
pub struct Saved {
    pub id: String,
    pub locked: Vec<String>,
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

    /// Identifies the folder: two spellings of one folder give the same value.
    pub fn git_dir(&self) -> &Path {
        &self.git_dir
    }

    /// Runs git on the shadow repository: whether it succeeded, its output and its errors.
    fn run(&self, args: &[&str], stdin: Option<&[u8]>) -> Result<(bool, Vec<u8>, String), String> {
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
        Ok((out.status.success(), out.stdout, String::from_utf8_lossy(&out.stderr).into_owned()))
    }

    fn git(&self, args: &[&str], stdin: Option<&[u8]>) -> Result<Vec<u8>, String> {
        let (ok, out, err) = self.run(args, stdin)?;
        if !ok {
            return Err(format!("git {}: {}", args[0], err.lines().next().unwrap_or("failed")));
        }
        Ok(out)
    }

    /// `git add` that skips files another program holds open (a database, a running program) instead of failing:
    /// returns the output and the files left out.
    fn add(&self, args: &[&str]) -> Result<(Vec<u8>, Vec<String>), String> {
        let (ok, out, err) = self.run(args, None)?;
        let locked: Vec<String> =
            err.lines().filter_map(|l| l.strip_prefix("error: unable to index file '")?.strip_suffix('\'')).map(str::to_owned).collect();
        if ok || !locked.is_empty() {
            return Ok((out, locked));
        }
        Err(format!("git add: {}", err.lines().next().unwrap_or("failed")))
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
        let (listed, _) = self.add(&["add", "--all", "--dry-run", "--ignore-errors"])?;
        let listed = String::from_utf8_lossy(&listed);
        let (mut files, mut bytes) = (0usize, 0u64);
        for line in listed.lines() {
            let Some(path) = line.strip_prefix("add '").and_then(|l| l.strip_suffix('\'')) else { continue };
            files += 1;
            bytes += std::fs::metadata(self.work.join(path)).map(|m| m.len()).unwrap_or(0);
        }
        if files > MAX_FILES || bytes > MAX_BYTES {
            return Err(format!(
                "{TOO_BIG}{files} files, {} MB to save (limits {MAX_FILES} files, {} MB); a .gitignore can leave build output out",
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

    /// Saves the folder's files as they are now.
    pub fn snapshot(&self) -> Result<Saved, String> {
        self.init()?;
        self.check_size()?;
        let (_, locked) = self.add(&["add", "--all", "--ignore-errors"])?;
        let tree = self.text(&["write-tree"])?;
        let parent = self.text(&["rev-parse", "--quiet", "--verify", HEAD_REF]).unwrap_or_default();
        let mut args = vec!["commit-tree", &tree, "-m", "pier checkpoint"];
        if !parent.is_empty() {
            args.extend(["-p", &parent]);
        }
        let id = self.text(&args)?;
        self.git(&["update-ref", HEAD_REF, &id], None)?;
        // Packs loose objects now and then, so the shadow repository does not grow file by file forever.
        let _ = self.run(&["gc", "--auto", "--quiet"], None);
        Ok(Saved { id, locked })
    }

    /// Puts the folder's files back as they were at `to`. `now`: a checkpoint of the current files, taken just
    /// before (it is what lets the restore be undone). Files created since are removed, except nested repositories
    /// and files under a `.gitignore` that changed since `to` (they may have existed, only ignored then). Every
    /// file is tried; returns what was left as is, and fails only if the files could not be put back at all.
    pub fn restore(&self, to: &str, now: &str) -> Result<Vec<String>, String> {
        let raw = self.git(&["diff", "--raw", "-z", "--no-renames", "--no-abbrev", to, now], None)?;
        // `-z --raw`: ":<old mode> <new mode> <old id> <new id> <status>\0<path>\0" per change.
        let mut fields = raw.split(|b| *b == 0).filter(|f| !f.is_empty());
        let (mut back, mut created) = (Vec::new(), Vec::new());
        while let (Some(meta), Some(path)) = (fields.next(), fields.next()) {
            let meta = String::from_utf8_lossy(meta);
            let parts: Vec<&str> = meta.trim_start_matches(':').split(' ').collect();
            let path = String::from_utf8_lossy(path).into_owned();
            match (parts.get(4).copied(), parts.get(1).copied()) {
                (Some("A"), Some(GITLINK_MODE)) => {}
                (Some("A"), _) => created.push(path),
                _ => back.push(path),
            }
        }
        // Folders (as path prefixes, "" for the top) whose .gitignore changed: conservative, files there are kept.
        let changed_ignores: Vec<String> = back
            .iter()
            .chain(&created)
            .filter(|p| *p == ".gitignore" || p.ends_with("/.gitignore"))
            .map(|p| p[..p.len() - ".gitignore".len()].to_owned())
            .collect();
        let mut kept = Vec::new();
        for path in created {
            if changed_ignores.iter().any(|dir| path.starts_with(dir)) {
                kept.push(format!("{path} (kept: a .gitignore above it changed since)"));
                continue;
            }
            let full = self.work.join(&path);
            if full.is_dir() {
                continue;
            }
            if let Err(e) = std::fs::remove_file(&full) {
                kept.push(format!("{path} (not removed: {e})"));
            }
        }
        if !back.is_empty() {
            let list: Vec<u8> = back.iter().map(|p| p.as_bytes()).collect::<Vec<_>>().join(&0u8);
            self.git(&["checkout", to, "--pathspec-from-file=-", "--pathspec-file-nul"], Some(&list))?;
        }
        Ok(kept)
    }
}

/// Start of the error when a checkpoint is refused for size.
const TOO_BIG: &str = "too big to save: ";

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
    Snapshot(Result<Saved, String>),
    /// `undo`: the checkpoint of the files just before the restore. No restore happens without it. `result`: the
    /// files left as they were.
    Restored {
        to: String,
        undo: Result<Saved, String>,
        result: Result<Vec<String>, String>,
    },
    Files(Result<Vec<String>, String>),
}

/// The thread doing the git work of one folder, so a large folder never freezes the window. Jobs run in order,
/// whichever tab sent them; each answer goes back to the tab that asked. The thread ends with the last `Arc`.
pub struct Worker {
    jobs: Sender<(Job, Sender<Done>)>,
}

impl Worker {
    /// `wake`: called after each job, so the UI picks up the result.
    pub fn start(repo: Repo, wake: impl Fn() + Send + 'static) -> Arc<Self> {
        let (jobs, todo) = channel::<(Job, Sender<Done>)>();
        std::thread::spawn(move || {
            let mut too_big_since: Option<Instant> = None;
            let mut snapshot = || {
                if too_big_since.is_some_and(|t| t.elapsed() < TOO_BIG_RETRY) {
                    return Err("folder too big to save (checked a few minutes ago); add a .gitignore".to_owned());
                }
                let saved = repo.snapshot();
                too_big_since = matches!(&saved, Err(e) if e.starts_with(TOO_BIG)).then(Instant::now);
                saved
            };
            for (job, reply) in todo {
                let result = match job {
                    Job::Snapshot => Done::Snapshot(snapshot()),
                    Job::Restore(to) => {
                        let undo = snapshot();
                        let result = match &undo {
                            Ok(now) => repo.restore(&to, &now.id),
                            Err(_) => Err("not restored: the current files could not be saved first".into()),
                        };
                        Done::Restored { to, undo, result }
                    }
                    Job::ListFiles => Done::Files(repo.list_files()),
                };
                let _ = reply.send(result); // the tab may have closed meanwhile
                wake();
            }
        });
        Arc::new(Self { jobs })
    }

    pub fn send(&self, job: Job, reply: &Sender<Done>) -> bool {
        self.jobs.send((job, reply.clone())).is_ok()
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
        let before = repo.snapshot().unwrap().id;

        fs::write(w.join("a.txt"), "two").unwrap();
        fs::remove_file(w.join("gone.txt")).unwrap();
        fs::write(w.join("src/new [1].rs"), "created").unwrap();
        fs::write(w.join("target/out.bin"), "rebuilt").unwrap();
        let after = repo.snapshot().unwrap().id;
        assert_ne!(before, after);

        assert_eq!(repo.restore(&before, &after).unwrap(), Vec::<String>::new());
        assert_eq!(fs::read_to_string(w.join("a.txt")).unwrap(), "one\r\n", "exact bytes, line endings included");
        assert_eq!(fs::read_to_string(w.join("gone.txt")).unwrap(), "deleted later");
        assert!(!w.join("src/new [1].rs").exists(), "created since: removed");
        assert_eq!(fs::read_to_string(w.join("target/out.bin")).unwrap(), "rebuilt", "ignored files are untouched");
        assert_eq!(fs::read_to_string(w.join("src/b.rs")).unwrap(), "fn b() {}");

        let now = repo.snapshot().unwrap().id;
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
    fn restore_keeps_files_that_were_only_ignored_and_skips_nested_repositories() {
        let (root, repo) = folder("audit");
        let w = repo.work.clone();
        fs::write(w.join(".gitignore"), "data/\n").unwrap();
        fs::create_dir_all(w.join("data")).unwrap();
        fs::write(w.join("data/keep.txt"), "the user's").unwrap();
        fs::write(w.join("a.txt"), "one").unwrap();
        let before = repo.snapshot().unwrap().id;

        fs::write(w.join(".gitignore"), "").unwrap(); // data/ is no longer ignored: keep.txt looks "created"
        fs::create_dir_all(w.join("sub")).unwrap();
        let init = git_command().args(["init", "--quiet"]).arg(w.join("sub")).output().unwrap();
        assert!(init.status.success());
        fs::write(w.join("sub/x.txt"), "x").unwrap();
        let commit = |args: &[&str]| git_command().arg("-C").arg(w.join("sub")).args(args).output().unwrap();
        commit(&["add", "x.txt"]);
        commit(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "x"]);
        fs::write(w.join("a.txt"), "two").unwrap();
        let after = repo.snapshot().unwrap().id;

        let kept = repo.restore(&before, &after).unwrap();
        assert!(w.join("data/keep.txt").exists(), "existed at the checkpoint, only ignored: not deleted");
        assert!(kept.iter().any(|k| k.starts_with("data/keep.txt")), "and said so: {kept:?}");
        assert!(w.join("sub/x.txt").exists(), "a nested repository is left alone");
        assert_eq!(fs::read_to_string(w.join("a.txt")).unwrap(), "one", "the rest is still restored");
        assert_eq!(fs::read_to_string(w.join(".gitignore")).unwrap(), "data/\n");
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_locked_file_is_left_out_not_fatal() {
        use std::os::windows::fs::OpenOptionsExt;
        let (root, repo) = folder("locked");
        let w = repo.work.clone();
        fs::write(w.join("a.txt"), "a").unwrap();
        fs::write(w.join("b.txt"), "b").unwrap();
        let held = fs::OpenOptions::new().read(true).share_mode(0).open(w.join("a.txt")).unwrap(); // no sharing at all
        let saved = repo.snapshot().unwrap();
        assert_eq!(saved.locked, ["a.txt"]);
        drop(held);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_worker_saves_before_restoring() {
        let (root, repo) = folder("worker");
        let w = repo.work.clone();
        fs::write(w.join("a.txt"), "one").unwrap();
        let worker = Worker::start(repo, || {});
        let (reply, done) = channel();
        worker.send(Job::Snapshot, &reply);
        let Done::Snapshot(Ok(first)) = done.recv().unwrap() else { panic!("no checkpoint") };
        fs::write(w.join("a.txt"), "two").unwrap();
        worker.send(Job::Restore(first.id.clone()), &reply);
        let Done::Restored { to, undo: Ok(_), result: Ok(_) } = done.recv().unwrap() else { panic!("not restored") };
        assert_eq!(to, first.id);
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
