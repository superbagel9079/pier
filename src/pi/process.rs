//! A `pi --mode rpc` process spoken to in JSONL over stdio: launch, framing, orderly shutdown.
//! Threads per process: stdout reader, stderr reader, stdin writer. The UI thread never blocks on Pi.

use super::protocol::{Command, Event};
use serde::de::DeserializeOwned;
use serde_json::json;
use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{self, Child, Stdio};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::{Duration, Instant};

pub enum Incoming {
    /// With the moment the reader thread got it: Pi's dialog timeouts run from then, not from when the UI looks.
    Event(Event, Instant),
    Stderr(String),
    Exited,
}

pub struct Process {
    child: Child,
    /// Lines for the writer thread; dropping it closes Pi's stdin (orderly shutdown).
    writer: Option<Sender<Vec<u8>>>,
    pub rx: Receiver<Incoming>,
    next_id: u64,
    /// Holds the launcher, the real Pi it starts and everything Pi's tools start; closing it kills them all.
    #[cfg(windows)]
    _job: Option<job::Job>,
}

/// `pi` on Windows is a .ps1/.cmd shim: run node and the launcher directly so no cmd.exe sits in between.
// shortcut: paths are the default managed-install ones, add a setting when another install layout shows up.
fn pi_command() -> process::Command {
    let home = super::sessions::home();
    let launcher = home.join(".pi/agent/bin/pi-launcher.js");
    let bundled_node = PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default()).join("pi-node/current/node.exe");
    let mut cmd = process::Command::new(if bundled_node.is_file() { bundled_node } else { PathBuf::from("node") });
    cmd.arg(launcher);
    cmd
}

pub(crate) const APPROVALS_EXTENSION: &str = include_str!("../../extension/pier-approvals.ts");

/// FNV-1a: a stable content fingerprint (not for security, only to name the file after its content).
pub(crate) fn fingerprint(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3))
}

/// Writes Pier's approval extension where Pi can load it, named by content hash so two Pier builds never clash.
// shortcut: old versions' files are never pruned, prune them if the folder ever matters.
fn approvals_extension() -> std::io::Result<PathBuf> {
    let dir = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("pier");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("pier-approvals-{:016x}.ts", fingerprint(APPROVALS_EXTENSION.as_bytes())));
    // Written atomically: another tab's Pi may be loading the file right now.
    if std::fs::read(&path).ok().as_deref() != Some(APPROVALS_EXTENSION.as_bytes()) {
        crate::files::write_atomic(&path, APPROVALS_EXTENSION.as_bytes())?;
    }
    Ok(path)
}

impl Process {
    /// Always loads Pier's approval extension: no launch without supervision.
    pub fn spawn(extra_args: &[impl AsRef<OsStr>], wake: impl Fn() + Send + Clone + 'static) -> std::io::Result<Self> {
        Self::spawn_in(extra_args, None, wake)
    }

    /// `cwd`: the folder Pi works in; Pier's own when `None`.
    pub fn spawn_in(
        extra_args: &[impl AsRef<OsStr>],
        cwd: Option<&Path>,
        wake: impl Fn() + Send + Clone + 'static,
    ) -> std::io::Result<Self> {
        let mut cmd = pi_command();
        cmd.args(["--mode", "rpc", "-e"]).arg(approvals_extension()?).args(extra_args);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn()?;
        // shortcut: assigned right after spawn, before node starts Pi, use a suspended start if that gap ever matters.
        #[cfg(windows)]
        let job = job::Job::new().and_then(|j| j.assign(&child).map(|()| j));
        #[cfg(windows)]
        let job = match job {
            Ok(j) => Some(j),
            Err(e) => {
                let _ = child.kill();
                return Err(std::io::Error::other(format!("Job Object: {e}")));
            }
        };
        let (tx, rx) = channel();

        // stdout must be read continuously or Pi blocks on backpressure.
        let stdout = child.stdout.take().expect("piped stdout");
        let (out_tx, out_wake) = (tx.clone(), wake.clone());
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let msg = match parse_line(&buf) {
                            None => continue,
                            Some(Ok(v)) => Incoming::Event(v, Instant::now()),
                            // Not silent: a shape Pier misreads shows up in the status bar.
                            Some(Err(e)) => {
                                Incoming::Stderr(format!("unreadable event ({e}): {}", String::from_utf8_lossy(&buf).trim_end()))
                            }
                        };
                        if out_tx.send(msg).is_err() {
                            break;
                        }
                        out_wake();
                    }
                }
            }
            let _ = out_tx.send(Incoming::Exited);
            out_wake();
        });

        let stderr = child.stderr.take().expect("piped stderr");
        let (err_tx, err_wake) = (tx.clone(), wake.clone());
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if err_tx.send(Incoming::Stderr(line)).is_err() {
                    break;
                }
                err_wake();
            }
        });

        // A big prompt while Pi is busy can block on the pipe: that wait belongs here, not on the UI thread.
        let mut stdin = child.stdin.take().expect("piped stdin");
        let (line_tx, line_rx) = channel::<Vec<u8>>();
        std::thread::spawn(move || {
            for line in line_rx {
                if let Err(e) = stdin.write_all(&line).and_then(|()| stdin.flush()) {
                    let _ = tx.send(Incoming::Stderr(format!("cannot write to Pi: {e}")));
                    wake();
                    break;
                }
            }
        });

        Ok(Self {
            child,
            writer: Some(line_tx),
            rx,
            next_id: 0,
            #[cfg(windows)]
            _job: job,
        })
    }

    /// Queues a command for Pi. Fails only once the writer has stopped (Pi gone or its stdin broken).
    pub fn send(&mut self, cmd: &Command) -> std::io::Result<()> {
        let mut cmd = serde_json::to_value(cmd)?;
        // Replies (extension_ui_response) must echo the request id; only commands get a fresh one.
        if cmd.get("id").is_none() {
            self.next_id += 1;
            cmd["id"] = json!(format!("pier-{}", self.next_id));
        }
        let mut line = serde_json::to_vec(&cmd)?;
        line.push(b'\n');
        let writer = self.writer.as_ref().ok_or(std::io::ErrorKind::BrokenPipe)?;
        writer.send(line).map_err(|_| std::io::ErrorKind::BrokenPipe.into())
    }

    /// OS id of the launcher, the root of the tab's process tree.
    pub fn id(&self) -> u32 {
        self.child.id()
    }

    /// Closes Pi's stdin, its orderly shutdown; `Drop` then waits for the exit.
    pub fn begin_shutdown(&mut self) {
        self.writer.take();
    }
}

impl Drop for Process {
    /// Closing stdin is Pi's orderly shutdown; after 3 s, the whole process tree is killed (the Job Object goes with it).
    fn drop(&mut self) {
        self.begin_shutdown();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.child.try_wait() {
                return; // the Job Object still kills whatever Pi's tools left behind
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectExtendedLimitInformation, SetInformationJobObject,
    };

    /// A Windows Job Object that kills every process in it when its last handle closes (on drop, or when Pier dies).
    pub struct Job(HANDLE);

    // The handle is only used through kernel calls that are safe from any thread.
    unsafe impl Send for Job {}

    impl Job {
        pub fn new() -> std::io::Result<Self> {
            // SAFETY: plain Win32 calls; the handle is checked and owned by `Job`.
            unsafe {
                let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if h.is_null() {
                    return Err(std::io::Error::last_os_error());
                }
                let job = Job(h);
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    (&raw const info).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(job)
            }
        }

        /// Puts the process in the job; the processes it starts afterwards join it too.
        pub fn assign(&self, child: &std::process::Child) -> std::io::Result<()> {
            // SAFETY: both handles are valid for the duration of the call.
            if unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) } == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: we own the handle; closing the last one kills the job's processes.
            unsafe { CloseHandle(self.0) };
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::time::{Duration, Instant};

        /// A grandchild (started by the child, like Pi started by its launcher) dies with the job.
        #[test]
        fn dropping_the_job_kills_the_whole_tree() {
            let mut child = std::process::Command::new("cmd").args(["/c", "ping -n 60 127.0.0.1 >nul"]).spawn().unwrap();
            let job = Job::new().unwrap();
            job.assign(&child).unwrap();
            std::thread::sleep(Duration::from_millis(500)); // let cmd start ping, the grandchild
            let ping_running = || {
                let out = std::process::Command::new("tasklist").args(["/fi", &format!("pid ne {}", std::process::id())]).output().unwrap();
                String::from_utf8_lossy(&out.stdout).lines().filter(|l| l.to_lowercase().starts_with("ping.exe")).count()
            };
            let before = ping_running();
            assert!(before >= 1, "ping should run");
            drop(job);
            let end = Instant::now() + Duration::from_secs(5);
            while ping_running() >= before && Instant::now() < end {
                std::thread::sleep(Duration::from_millis(100));
            }
            assert!(ping_running() < before, "the grandchild must die with the job");
            assert!(child.wait().is_ok());
        }
    }
}

/// Split on LF only (never U+2028/U+2029), strip an optional CR, skip blank lines.
pub fn parse_line<T: DeserializeOwned>(raw: &[u8]) -> Option<serde_json::Result<T>> {
    let line = raw.strip_suffix(b"\n").unwrap_or(raw);
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    if line.iter().all(u8::is_ascii_whitespace) {
        return None;
    }
    Some(serde_json::from_slice(line))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_file_name_follows_its_content() {
        assert_eq!(fingerprint(b"a"), fingerprint(b"a"));
        assert_ne!(fingerprint(b"a"), fingerprint(b"b"));
        let p = approvals_extension().unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), APPROVALS_EXTENSION);
        assert!(p.file_name().unwrap().to_string_lossy().starts_with("pier-approvals-"));
    }

    #[test]
    fn framing_keeps_unicode_separators_and_strips_crlf() {
        let v: serde_json::Value = parse_line("{\"t\":\"a\u{2028}b\"}\r\n".as_bytes()).unwrap().unwrap();
        assert_eq!(v["t"], "a\u{2028}b");
        assert!(parse_line::<serde_json::Value>(b"  \r\n").is_none());
    }
}
