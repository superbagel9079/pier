//! The open tabs and what they do, without any UI: launching Pi in a folder, sending, stopping, closing,
//! recent folders, and which state changes need the user. The egui layer only draws this and asks the user.

use crate::checkpoint::{self, Done, Job, Repo, Worker};
use crate::pi::process::Process;
use crate::pi::protocol::{Command, ModelInfo, StreamingBehavior};
use crate::pi::sessions::{self, SavedSession};
use crate::presets::Preset;
use crate::recent;
use crate::session::journal::{self, Journal, Record};
use crate::session::state::{Attention, State};
use crate::session::transcript::{Entry, Kind, Transcript};
use std::collections::VecDeque;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

const TITLE_CHARS: usize = 24;
/// Longer names are cut: they are labels, not notes.
pub const NAME_MAX: usize = 80;

fn shorten(line: &str) -> String {
    if line.chars().count() > TITLE_CHARS { format!("{}…", line.chars().take(TITLE_CHARS).collect::<String>()) } else { line.into() }
}

/// What a new tab starts from.
pub enum Launch<'a> {
    New,
    /// A saved Pi session file to reopen, with its history.
    Resume(&'a Path),
    Preset(&'a Preset),
}

/// Tab ids are never reused, so per-tab UI state (scroll, unfolded sections) never leaks to another tab.
static NEXT_TAB_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn next_tab_id() -> u64 {
    NEXT_TAB_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// One session: a `pi --mode rpc` process, its transcript and its editor text.
pub struct Tab {
    /// Unique for the life of Pier; keys the tab's UI state.
    pub id: u64,
    proc: Option<Process>,
    pub t: Transcript,
    /// Editor text; a cleared steer comes back here.
    pub input: String,
    /// Preset name, shown until the first prompt gives a title.
    label: Option<String>,
    /// `None` once it failed; the failure is shown in the transcript.
    journal: Option<Journal>,
    /// Where Pi works: outside-folder warnings and its saved sessions depend on it.
    pub folder: PathBuf,
    /// State when last checked, to notice the changes that need the user.
    seen: State,
    /// Saves and restores the folder's files, off the UI thread. `None` without a Pi.
    checkpoints: Option<Worker>,
    /// Messages waiting for their checkpoint; each goes to Pi once its files are saved.
    waiting: VecDeque<Command>,
    restoring: bool,
}

impl Tab {
    /// `folder`: where Pi works, unless a preset names its own. `wake`: called when Pi sends something.
    fn new(pi_args: &[String], folder: &Path, launch: Launch, wake: impl Fn() + Send + Clone + 'static) -> Self {
        let mut t = Transcript::default();
        let mut args: Vec<OsString> = pi_args.iter().map(OsString::from).collect();
        let (mut cwd, mut label) = (folder, None);
        match launch {
            Launch::New => {}
            Launch::Resume(path) => {
                args.extend(["--session".into(), path.as_os_str().to_owned()]); // as is: non-UTF-8 paths survive
                t.session_file = Some(path.to_path_buf()); // listed as open before get_state answers
            }
            Launch::Preset(p) => {
                args.extend(p.args().into_iter().map(OsString::from));
                cwd = p.cwd.as_deref().unwrap_or(folder);
                label = Some(p.name.clone());
            }
        }
        let resumed = matches!(launch, Launch::Resume(_));
        let folder = cwd.to_path_buf();
        t.journal.push(Record::TabOpened {
            preset: label.clone(),
            resumed: resumed.then(|| t.session_file.clone()).flatten(),
            cwd: folder.clone(),
        });
        let checkpoint_wake = wake.clone();
        let proc = Process::spawn_in(&args, Some(cwd), wake)
            .map_err(|e| t.entries.push(Entry::new(Kind::Error, format!("Cannot start Pi: {e}"))))
            .ok();
        if proc.is_none() {
            t.state = State::Crashed;
        }
        let journal =
            Journal::create(&journal::dir()).map_err(|e| t.entries.push(Entry::new(Kind::Error, format!("Journal unavailable: {e}")))).ok();
        let seen = t.state;
        let checkpoints = proc.is_some().then(|| Worker::start(Repo::new(&checkpoint::dir(), &folder), checkpoint_wake));
        let mut tab = Self {
            id: next_tab_id(),
            proc,
            t,
            input: String::new(),
            label: label.take(),
            journal,
            folder,
            seen,
            checkpoints,
            waiting: VecDeque::new(),
            restoring: false,
        };
        tab.send(Command::GetState);
        tab.send(Command::GetAvailableThinkingLevels);
        tab.send(Command::GetSessionStats);
        tab.send(Command::GetCommands);
        if resumed {
            tab.send(Command::GetMessages);
        }
        tab
    }

    /// The session name, else the first prompt, so tabs can be told apart.
    pub fn title(&self) -> String {
        if let Some(name) = &self.t.session_name {
            return shorten(name);
        }
        let Some(first) = self.t.entries.iter().find(|e| e.kind == Kind::User) else {
            return self.label.clone().unwrap_or_else(|| "New session".into());
        };
        shorten(first.text.lines().next().unwrap_or_default())
    }

    /// Runs every frame for every tab, visible or not: background sessions keep streaming, answering and expiring.
    fn update(&mut self, now: Instant) {
        // Before Pi's events: a message's checkpoint is done before the message reaches Pi, so it shows first.
        let finished: Vec<Done> = self.checkpoints.iter().flat_map(|w| w.done.try_iter()).collect();
        for done in finished {
            self.checkpoint_done(done);
        }
        if let Some(p) = &self.proc {
            while let Ok(msg) = p.rx.try_recv() {
                self.t.apply(msg);
            }
        }
        self.t.expire(now);
        if !self.t.restored.is_empty() {
            let back = std::mem::take(&mut self.t.restored).join("\n");
            self.input = if self.input.is_empty() { back } else { format!("{back}\n{}", self.input) };
        }
    }

    /// Sends queued replies to Pi and writes queued journal lines.
    fn flush(&mut self) {
        for reply in std::mem::take(&mut self.t.outbox) {
            self.send(reply);
        }
        let records = std::mem::take(&mut self.t.journal);
        if let Some(j) = &mut self.journal
            && let Err(e) = records.iter().try_for_each(|r| j.write(r))
        {
            self.t.entries.push(Entry::new(Kind::Error, format!("Journal stopped ({}): {e}", j.path.display())));
            self.journal = None;
        }
    }

    fn send(&mut self, cmd: Command) {
        let err = match self.proc.as_mut() {
            Some(p) => p.send(&cmd).err().map(|e| e.to_string()),
            None => Some("no Pi process".into()),
        };
        if let Some(e) = err {
            self.t.entries.push(Entry::new(Kind::Error, format!("Cannot send: {e}")));
        }
    }

    /// Sends the editor text: a prompt, or a steer while a run is going.
    /// Refused until Pier's approval extension has reported in: without it, tools would run unasked.
    pub fn submit(&mut self) {
        let text = self.input.trim().to_owned();
        if text.is_empty() {
            return;
        }
        if !self.t.supervised() {
            self.t.entries.push(Entry::new(Kind::Error, "Not sent: Pi is not supervised."));
            return;
        }
        // While a run is going (or about to), Pi requires a streamingBehavior; steer lands after the current turn.
        let running = self.t.state.is_running() || !self.waiting.is_empty();
        let prompt = Command::Prompt { message: text, streaming_behavior: running.then_some(StreamingBehavior::Steer) };
        match &self.checkpoints {
            Some(w) if w.send(Job::Snapshot) => self.waiting.push_back(prompt),
            _ => self.send(prompt),
        }
        self.input.clear();
    }

    /// A checkpoint can be restored only while nothing else touches the files: no run, nothing being sent.
    pub fn can_restore(&self) -> bool {
        self.checkpoints.is_some() && !self.t.state.is_running() && self.waiting.is_empty() && !self.restoring
    }

    /// Puts the folder's files back as they were at checkpoint `id`; the files as they are now get their own
    /// checkpoint first, so the restore can be undone.
    pub fn restore(&mut self, id: &str) {
        if !self.can_restore() {
            self.t.entries.push(Entry::new(Kind::Error, "Not restored: wait until the run ends."));
            return;
        }
        if let Some(w) = &self.checkpoints
            && w.send(Job::Restore(id.to_owned()))
        {
            self.restoring = true;
        }
    }

    fn checkpoint_done(&mut self, done: Done) {
        let saved = |t: &mut Transcript, id: String, text: &str| {
            t.journal.push(Record::Checkpoint { id: id.clone() });
            t.entries.push(Entry { checkpoint: Some(id), ..Entry::new(Kind::Checkpoint, text) });
        };
        match done {
            Done::Snapshot(result) => {
                match result {
                    Ok(id) => saved(&mut self.t, id, "Files before this message"),
                    Err(e) => self.t.entries.push(Entry::new(Kind::Notice, format!("No checkpoint: {e}"))),
                }
                // Sent even without a checkpoint: the notice says so, and holding the message back would lose it.
                if let Some(prompt) = self.waiting.pop_front() {
                    self.send(prompt);
                }
            }
            Done::Restored { to, undo, result } => {
                self.restoring = false;
                if let Ok(undo) = &undo {
                    saved(&mut self.t, undo.clone(), "Files before the restore");
                }
                match (result, undo) {
                    (Ok(()), Ok(undo)) => {
                        self.t.journal.push(Record::CheckpointRestored { to, undo });
                        self.t.entries.push(Entry::new(Kind::Notice, "Files restored. Pi was not told; say so if it matters."));
                    }
                    (Err(e), _) | (Ok(()), Err(e)) => self.t.entries.push(Entry::new(Kind::Error, format!("Restore failed: {e}"))),
                }
            }
        }
    }

    /// Answers the approval the user saw (by id), if it is still the one shown.
    pub fn approve(&mut self, id: &str, allowed: bool) {
        self.t.answer(id, allowed);
    }

    /// Asks Pi for its model list (the model menu shows it).
    pub fn refresh_models(&mut self) {
        self.send(Command::GetAvailableModels);
    }

    pub fn set_model(&mut self, m: &ModelInfo) {
        self.send(Command::SetModel { provider: m.provider.clone(), model_id: m.id.clone() });
    }

    pub fn set_thinking(&mut self, level: &str) {
        self.send(Command::SetThinkingLevel { level: level.to_owned() });
    }

    /// Names the session (blank names are ignored); Pi keeps it in the session file, so Resume shows it.
    pub fn rename(&mut self, name: &str) {
        let name: String = name.trim().chars().take(NAME_MAX).collect();
        if !name.is_empty() {
            self.send(Command::SetSessionName { name });
        }
    }

    /// Like Pi's Esc: take queued messages back (they return to the editor), then abort.
    pub fn stop(&mut self) {
        self.t.journal.push(Record::StopRequested);
        self.send(Command::ClearQueue);
        self.send(Command::Abort);
    }

    #[cfg(test)]
    fn detached(folder: &str) -> Self {
        Self {
            id: next_tab_id(),
            proc: None,
            t: Transcript::default(),
            input: String::new(),
            label: None,
            journal: None,
            folder: folder.into(),
            seen: State::Ready,
            checkpoints: None,
            waiting: VecDeque::new(),
            restoring: false,
        }
    }
}

impl Drop for Tab {
    /// Closing the tab or the whole window: the last journal lines reach the disk before the tab's Pi stops.
    fn drop(&mut self) {
        self.t.journal.push(Record::TabClosed);
        if let Some(j) = &mut self.journal {
            for r in &self.t.journal {
                let _ = j.write(r); // nowhere left to show a failure
            }
        }
    }
}

/// All open tabs, the active one, and the recent project folders.
pub struct Workspace {
    pi_args: Vec<String>,
    pub tabs: Vec<Tab>,
    pub active: usize,
    /// Project folders opened before, newest first.
    pub recent: Vec<PathBuf>,
    recent_file: PathBuf,
    /// Saved-session titles already read, so opening Resume does not reread every file each time.
    titles: sessions::TitleCache,
    /// Session files of closed tabs whose Pi is still shutting down: still "open" for Resume.
    closing: Arc<Mutex<Vec<PathBuf>>>,
}

impl Workspace {
    /// Starts with no tab: the user picks the project folder first.
    pub fn new(pi_args: Vec<String>, recent_file: PathBuf) -> Self {
        let recent = recent::load(&recent_file);
        Self { pi_args, tabs: vec![], active: 0, recent, recent_file, closing: Arc::default(), titles: Default::default() }
    }

    pub fn active_tab(&mut self) -> Option<&mut Tab> {
        self.tabs.get_mut(self.active)
    }

    pub fn active_folder(&self) -> Option<PathBuf> {
        self.tabs.get(self.active).map(|t| t.folder.clone())
    }

    /// Opens a tab running Pi in `folder` and makes it active; the folder goes to the top of the recent list.
    pub fn open(&mut self, folder: &Path, launch: Launch, wake: impl Fn() + Send + Clone + 'static) {
        let tab = Tab::new(&self.pi_args, folder, launch, wake);
        self.push(tab);
    }

    fn push(&mut self, tab: Tab) {
        if let Ok(list) = recent::remember(&self.recent_file, &tab.folder) {
            self.recent = list; // a write failure only costs the shortcut next time
        }
        self.tabs.push(tab);
        self.active = self.tabs.len() - 1;
    }

    /// Closing stops the tab's Pi. Pi keeps the conversation in its own session dir (unless `--no-session`).
    // shortcut: no confirmation when closing a running tab, add one if runs get lost by mistake.
    pub fn close(&mut self, i: usize) {
        let tab = self.tabs.remove(i);
        let file = tab.t.session_file.as_ref().and_then(|p| std::fs::canonicalize(p).ok());
        if let Some(f) = &file {
            lock(&self.closing).push(f.clone());
        }
        let closing = Arc::clone(&self.closing);
        // Process::drop waits up to 3 s for Pi to exit; keep that off the caller's (UI) thread.
        std::thread::spawn(move || {
            drop(tab);
            if let Some(f) = file {
                let mut list = lock(&closing);
                if let Some(i) = list.iter().position(|p| *p == f) {
                    list.remove(i);
                }
            }
        });
        if i < self.active || self.active >= self.tabs.len() {
            self.active = self.active.saturating_sub(1);
        }
    }

    pub fn update(&mut self, now: Instant) {
        for tab in &mut self.tabs {
            tab.update(now);
        }
    }

    pub fn flush(&mut self) {
        for tab in &mut self.tabs {
            tab.flush();
        }
    }

    /// A run is going in some tab (blocked on an approval counts: the run is not over).
    pub fn any_running(&self) -> bool {
        self.tabs.iter().any(|t| t.t.state.is_running())
    }

    pub fn any_approval_pending(&self) -> bool {
        self.tabs.iter().any(|t| !t.t.approvals.is_empty())
    }

    /// Tabs waiting for an approval, for the window title.
    pub fn waiting_approvals(&self) -> usize {
        self.tabs.iter().filter(|t| !t.t.approvals.is_empty()).count()
    }

    /// The strongest reason to call the user back since the last check, among tabs they are not looking at
    /// (`focused`: the window has the focus). Each state change counts once.
    pub fn attention(&mut self, focused: bool) -> Option<Attention> {
        let mut strongest = None;
        for (i, tab) in self.tabs.iter_mut().enumerate() {
            if let Some(why) = tab.t.state.attention(tab.seen)
                && (!focused || i != self.active)
                && strongest != Some(Attention::Approval)
            {
                strongest = Some(why);
            }
            tab.seen = tab.t.state;
        }
        strongest
    }

    /// Session files open in a tab, canonical so that Pi's spelling of a path matches the listing's.
    fn open_files(&self) -> Vec<PathBuf> {
        let mut open: Vec<PathBuf> =
            self.tabs.iter().filter_map(|t| t.t.session_file.as_ref()).filter_map(|p| std::fs::canonicalize(p).ok()).collect();
        open.extend(lock(&self.closing).iter().cloned());
        open
    }

    /// Pi sessions saved for the active folder, newest first, each with whether a tab already has it open
    /// (it must not be opened twice: two Pi writing one file would corrupt it).
    pub fn saved_sessions(&mut self, max: usize) -> Vec<(SavedSession, bool)> {
        let Some(folder) = self.active_folder() else { return vec![] };
        let open = self.open_files();
        sessions::list_cached(&folder, max, &mut self.titles)
            .into_iter()
            .map(|s| {
                let is_open = std::fs::canonicalize(&s.path).is_ok_and(|p| open.contains(&p));
                (s, is_open)
            })
            .collect()
    }
}

/// A poisoned lock only means a closing thread panicked; the list itself is still usable.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Drop for Workspace {
    /// Quitting Pier: every tab's Pi shuts down at the same time, so the wait is 3 s at most, not 3 s per tab.
    fn drop(&mut self) {
        let stopping: Vec<_> = self.tabs.drain(..).map(|t| std::thread::spawn(move || drop(t))).collect();
        for h in stopping {
            let _ = h.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws(folders: &[&str], active: usize) -> Workspace {
        let file = std::env::temp_dir().join(format!("pier-ws-recent-{}-{}.json", std::process::id(), folders.len()));
        let mut w = Workspace::new(vec![], file);
        w.tabs = folders.iter().map(|f| Tab::detached(f)).collect();
        w.active = active;
        w
    }

    fn active_folder(w: &Workspace) -> Option<String> {
        w.active_folder().map(|p| p.display().to_string())
    }

    #[test]
    fn closing_keeps_a_sensible_active_tab() {
        let mut a = ws(&["0", "1", "2"], 2);
        a.close(0); // before the active one: same tab stays active
        assert_eq!(active_folder(&a).as_deref(), Some("2"));
        a.close(1); // the active one, last: previous becomes active
        assert_eq!(active_folder(&a).as_deref(), Some("1"));
        let mut b = ws(&["0", "1", "2"], 1);
        b.close(1); // the active one, not last: next becomes active
        assert_eq!(active_folder(&b).as_deref(), Some("2"));
        let mut c = ws(&["0"], 0);
        c.close(0);
        assert_eq!(active_folder(&c), None);
    }

    #[test]
    fn attention_skips_the_tab_being_looked_at() {
        let mut w = ws(&["a", "b"], 0);
        w.tabs[0].t.state = State::Blocked;
        assert_eq!(w.attention(true), None, "the user is looking at tab a");

        w.tabs[1].t.state = State::Completed;
        w.tabs[1].seen = State::Running;
        w.tabs[0].t.state = State::Running;
        w.tabs[0].seen = State::Running;
        assert_eq!(w.attention(true), Some(Attention::RunEnded), "tab b is in the background");
        assert_eq!(w.attention(true), None, "once per change");

        w.tabs[0].t.state = State::Blocked;
        w.tabs[1].t.state = State::Running;
        w.tabs[1].seen = State::Running;
        assert_eq!(w.attention(false), Some(Attention::Approval), "window unfocused: even the active tab counts");
    }

    #[test]
    fn the_session_name_titles_the_tab() {
        use crate::pi::process::parse_line;
        let mut tab = Tab::detached("a");
        let feed = |tab: &mut Tab, line: &str| tab.t.apply_event(&parse_line(line.as_bytes()).unwrap().unwrap());
        feed(&mut tab, r#"{"type":"message_start","message":{"role":"user","content":"lance les tests"}}"#);
        assert_eq!(tab.title(), "lance les tests");
        feed(&mut tab, r#"{"type":"response","command":"get_state","success":true,"data":{"sessionName":"Tests du parseur"}}"#);
        assert_eq!(tab.title(), "Tests du parseur", "a name beats the first prompt");
        feed(&mut tab, r#"{"type":"session_info_changed","name":"Un nom vraiment beaucoup trop long pour un onglet"}"#);
        assert_eq!(tab.title(), "Un nom vraiment beaucoup…");
        feed(&mut tab, r#"{"type":"session_info_changed"}"#);
        assert_eq!(tab.title(), "lance les tests", "cleared name: back to the prompt");
        feed(&mut tab, r#"{"type":"response","command":"set_session_name","success":true}"#);
        assert_eq!(tab.t.outbox, [Command::GetState], "the name is read back from Pi");
    }

    #[test]
    fn any_running_counts_blocked_runs() {
        let mut w = ws(&["a", "b"], 0);
        assert!(!w.any_running());
        w.tabs[1].t.state = State::Blocked;
        assert!(w.any_running(), "waiting on an approval is still a run");
        w.tabs[1].t.state = State::Completed;
        assert!(!w.any_running());
    }

    #[test]
    fn nothing_is_sent_before_supervision() {
        let mut tab = Tab::detached("a");
        tab.input = "rm -rf".into();
        tab.submit();
        assert_eq!(tab.input, "rm -rf", "kept for later, not sent");
        assert_eq!(tab.t.entries.last().map(|e| e.text.as_str()), Some("Not sent: Pi is not supervised."));
    }

    #[test]
    fn a_message_waits_for_its_checkpoint_and_restore_waits_for_the_run() {
        let root = std::env::temp_dir().join(format!("pier-ws-checkpoint-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let work = root.join("project");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(work.join("a.txt"), "one").unwrap();
        let mut tab = Tab::detached(work.to_str().unwrap());
        tab.checkpoints = Some(Worker::start(Repo::new(&root.join("shadow"), &work), || {}));
        tab.t.status.insert(crate::session::transcript::SUPERVISION_KEY.into(), "Supervised".into());
        let settle = |tab: &mut Tab| {
            for _ in 0..200 {
                tab.update(Instant::now());
                if tab.waiting.is_empty() && !tab.restoring {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            panic!("checkpoint never finished");
        };

        tab.input = "change a.txt".into();
        tab.submit();
        assert_eq!(tab.waiting.len(), 1, "held until the files are saved");
        tab.input = "and b".into();
        tab.submit();
        assert!(
            matches!(tab.waiting.back(), Some(Command::Prompt { streaming_behavior: Some(_), .. })),
            "a second message before the first reached Pi is a steer"
        );
        settle(&mut tab);
        let saved: Vec<_> = tab.t.entries.iter().filter_map(|e| e.checkpoint.clone()).collect();
        assert_eq!(saved.len(), 2);

        std::fs::write(work.join("a.txt"), "two").unwrap();
        tab.t.state = State::Running;
        tab.restore(&saved[0]);
        assert!(!tab.restoring, "refused during a run");
        assert_eq!(std::fs::read_to_string(work.join("a.txt")).unwrap(), "two");

        tab.t.state = State::Completed;
        tab.restore(&saved[0]);
        settle(&mut tab);
        assert_eq!(std::fs::read_to_string(work.join("a.txt")).unwrap(), "one");
        assert_eq!(tab.t.entries.iter().filter(|e| e.kind == Kind::Checkpoint).count(), 3, "plus the undo point");
        assert!(tab.t.journal.iter().any(|r| matches!(r, Record::CheckpointRestored { .. })));
        drop(tab);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_closing_tab_still_holds_its_session_file() {
        let file = std::env::temp_dir().join(format!("pier-ws-closing-{}.jsonl", std::process::id()));
        std::fs::write(&file, "").unwrap();
        let mut w = ws(&["a"], 0);
        w.tabs[0].t.session_file = Some(file.clone());
        let canonical = std::fs::canonicalize(&file).unwrap();
        assert!(w.open_files().contains(&canonical));
        lock(&w.closing).push(canonical.clone()); // what close() does while the Pi is still shutting down
        w.tabs.clear();
        assert!(w.open_files().contains(&canonical), "Resume must not reopen it yet");
        std::fs::remove_file(&file).unwrap();
    }

    #[test]
    fn opening_records_the_folder_as_recent() {
        let root = std::env::temp_dir().join(format!("pier-ws-open-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let mut w = Workspace::new(vec![], root.join("recent.json"));
        w.push(Tab::detached(root.to_str().unwrap()));
        assert_eq!(w.recent, std::slice::from_ref(&root));
        assert_eq!(w.active, 0);
        assert!(w.saved_sessions(5).iter().all(|(_, open)| !open));
        drop(w);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
