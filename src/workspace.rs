//! The open tabs and what they do, without any UI: launching Pi in a folder, sending, stopping, closing,
//! recent folders, and which state changes need the user. The egui layer only draws this and asks the user.

use crate::archive::Archive;
use crate::attach::Image;
use crate::checkpoint::{self, Done, Job, Repo, Worker};
use crate::mention;
use crate::pi::process::Process;
use crate::pi::protocol::{Command, ModelInfo, StreamingBehavior};
use crate::pi::sessions::{self, SavedSession};
use crate::presets::Preset;
use crate::recent;
use crate::session::journal::{self, Journal, Record};
use crate::session::state::{Attention, State};
use crate::session::transcript::{Entry, Kind, Transcript};
use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Instant;

const TITLE_CHARS: usize = 24;
/// Text of the checkpoint taken before a message (the Fork menu pairs them by it).
const BEFORE_MESSAGE: &str = "Files before this message";
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
    /// A fork (entry id) to send once its files are restored.
    fork_after_restore: Option<String>,
    /// Images to send with the next message.
    pub images: Vec<Image>,
    /// The project's files, for `@` mentions; reread each time a new mention starts.
    files: Vec<String>,
    files_asked: bool,
    /// A message waiting in Pi's queue carries images (editing the queue would lose them).
    pub queued_images: bool,
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
            fork_after_restore: None,
            images: vec![],
            files: vec![],
            files_asked: false,
            queued_images: false,
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
        if !self.run_going() {
            self.queued_images = false; // the run is over: nothing waits in Pi's queue any more
        }
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
        self.send_input(false);
    }

    /// Like `submit`, but while a run is going the message waits until Pi is done (a follow-up), not a steer.
    pub fn queue_after(&mut self) {
        self.send_input(true);
    }

    /// Whether a run is going or about to start (a message waits for its checkpoint).
    fn run_going(&self) -> bool {
        self.t.state.is_running() || !self.waiting.is_empty()
    }

    /// Sends a prompt once its checkpoint is taken (directly when there are no checkpoints).
    fn dispatch(&mut self, prompt: Command) {
        match &self.checkpoints {
            Some(w) if w.send(Job::Snapshot) => self.waiting.push_back(prompt),
            _ => self.send(prompt),
        }
    }

    fn send_input(&mut self, after: bool) {
        let text = self.input.trim().to_owned();
        if text.is_empty() && self.images.is_empty() {
            return;
        }
        if !self.t.supervised() {
            self.t.entries.push(Entry::new(Kind::Error, "Not sent: Pi is not supervised."));
            return;
        }
        if let Some(m) = self.t.model.as_ref().filter(|m| !self.images.is_empty() && !m.takes_images()) {
            let msg = format!("Not sent: {} does not read images. Remove them or pick another model.", m.key());
            self.t.entries.push(Entry::new(Kind::Error, msg));
            return;
        }
        // While a run is going (or about to), Pi requires a streamingBehavior; steer lands after the current turn.
        let behavior = self.run_going().then_some(if after { StreamingBehavior::FollowUp } else { StreamingBehavior::Steer });
        let images: Vec<_> = std::mem::take(&mut self.images).iter().map(Image::to_content).collect();
        // Editing the queue gives back text only: remember that a waiting message carries images.
        self.queued_images |= behavior.is_some() && !images.is_empty();
        self.dispatch(Command::Prompt { message: text, streaming_behavior: behavior, images });
        self.input.clear();
    }

    /// Takes the waiting messages back from Pi to edit them (Pi reads none of them meanwhile).
    pub fn edit_queue(&mut self) {
        if self.t.queued.is_empty() || self.t.queue_edit_pending {
            return;
        }
        self.t.queue_edit_pending = true;
        self.queued_images = false; // they are lost from here on; the warning was shown before the click
        self.send(Command::ClearQueue);
    }

    /// Sends the edited queue back in its order; empty messages are dropped. If the run ended meanwhile, the first
    /// one starts a new run.
    pub fn send_queue_back(&mut self) {
        let Some(draft) = self.t.queue_draft.take() else { return };
        if !self.t.supervised() {
            self.t.queue_draft = Some(draft);
            self.t.entries.push(Entry::new(Kind::Error, "Not sent: Pi is not supervised."));
            return;
        }
        for item in draft.into_iter().filter(|i| !i.text.trim().is_empty()) {
            let behavior = self.run_going().then_some(if item.after { StreamingBehavior::FollowUp } else { StreamingBehavior::Steer });
            self.dispatch(Command::prompt(item.text.trim(), behavior));
        }
    }

    /// While the editor ends with `@partial`: matching project files (the first `max`) and how many match in all.
    /// The file list is asked for once per mention, so files created meanwhile show up next time.
    pub fn file_suggestions(&mut self, max: usize) -> Option<(Vec<String>, usize)> {
        let Some(query) = mention::query(&self.input) else {
            self.files_asked = false;
            return None;
        };
        if !self.files_asked {
            self.files_asked = true;
            if let Some(w) = &self.checkpoints {
                w.send(Job::ListFiles);
            }
        }
        let found = mention::matching(&self.files, query);
        Some((found.iter().take(max).map(|s| s.to_string()).collect(), found.len()))
    }

    /// Replaces the trailing `@partial` with the picked file.
    pub fn mention(&mut self, path: &str) {
        self.input = mention::insert(&self.input, path);
    }

    /// Adds an image to the next message; a refused one is said in the transcript.
    pub fn attach(&mut self, image: Result<Image, String>) {
        match image {
            Ok(i) => self.images.push(i),
            Err(e) => self.t.entries.push(Entry::new(Kind::Error, format!("Image not attached: {e}"))),
        }
    }

    /// A run is going, or a message, a restore or a fork is on its way.
    pub fn busy(&self) -> bool {
        self.t.state.is_running() || !self.waiting.is_empty() || self.restoring || self.fork_after_restore.is_some()
    }

    /// A checkpoint can be restored only while nothing else touches the files: no run, nothing being sent.
    pub fn can_restore(&self) -> bool {
        self.checkpoints.is_some() && !self.busy()
    }

    /// Asks Pi which messages a fork can start from (the Fork menu shows them).
    pub fn refresh_fork_messages(&mut self) {
        self.send(Command::GetForkMessages);
    }

    /// The checkpoint taken just before the message `text` was sent in this tab, if any (the last one, if sent twice).
    /// Checkpoints and the messages they precede come in the same order, so the n-th one belongs to the next user
    /// message not already claimed.
    pub fn checkpoint_before(&self, text: &str) -> Option<String> {
        let mut pending = VecDeque::new();
        let mut found = None;
        for e in &self.t.entries {
            match e.kind {
                Kind::Checkpoint if e.text == BEFORE_MESSAGE => pending.extend(e.checkpoint.clone()),
                Kind::User => {
                    // Pi's fork list gives the text alone; the transcript may add " (+1 image)".
                    let same = e.text.strip_prefix(text).is_some_and(|rest| rest.is_empty() || rest.starts_with(" (+"));
                    if let Some(id) = pending.pop_front()
                        && same
                    {
                        found = Some(id);
                    }
                }
                _ => {}
            }
        }
        found
    }

    /// Switches the tab to a new session going on from just before the user message `entry_id` (the original stays
    /// in Resume); its text comes back to the editor. `restore`: first put the files back as they were before it.
    pub fn fork(&mut self, entry_id: &str, restore: Option<String>) {
        if self.busy() {
            self.t.entries.push(Entry::new(Kind::Error, "Not forked: wait until the run ends."));
            return;
        }
        match (restore, &self.checkpoints) {
            (Some(checkpoint), Some(w)) => {
                if w.send(Job::Restore(checkpoint)) {
                    self.restoring = true;
                    self.fork_after_restore = Some(entry_id.to_owned());
                }
            }
            _ => self.send(Command::Fork { entry_id: entry_id.to_owned() }),
        }
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
            Done::Files(Ok(files)) => self.files = files,
            Done::Files(Err(e)) => self.t.entries.push(Entry::new(Kind::Notice, format!("File list unavailable for @: {e}"))),
            Done::Snapshot(result) => {
                match result {
                    Ok(id) => saved(&mut self.t, id, BEFORE_MESSAGE),
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
                let fork = self.fork_after_restore.take();
                match (result, undo) {
                    (Ok(()), Ok(undo)) => {
                        self.t.journal.push(Record::CheckpointRestored { to, undo });
                        match fork {
                            Some(entry_id) => self.send(Command::Fork { entry_id }),
                            None => self.t.entries.push(Entry::new(Kind::Notice, "Files restored. Pi was not told; say so if it matters.")),
                        }
                    }
                    (Err(e), _) | (Ok(()), Err(e)) => {
                        let what = if fork.is_some() { "Not forked: the files could not be restored" } else { "Restore failed" };
                        self.t.entries.push(Entry::new(Kind::Error, format!("{what}: {e}")));
                    }
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
            fork_after_restore: None,
            images: vec![],
            files: vec![],
            files_asked: false,
            queued_images: false,
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
    titles: Arc<Mutex<sessions::TitleCache>>,
    /// Session files of closed tabs whose Pi is still shutting down: still "open" for Resume.
    closing: Arc<Mutex<Vec<PathBuf>>>,
    /// What the Resume window shows.
    pub browser: Browser,
    browser_tx: Sender<Browsed>,
    browser_rx: Receiver<Browsed>,
    /// Sessions hidden from Resume.
    pub archive: Archive,
}

/// The Resume window's sessions for one folder, listed and searched off the UI thread (a folder can hold hundreds
/// of sessions, some several MB).
#[derive(Default)]
pub struct Browser {
    pub folder: Option<PathBuf>,
    /// Newest first, each with its canonical path (to tell whether a tab has it open).
    pub sessions: Vec<(SavedSession, Option<PathBuf>)>,
    pub loading: bool,
    /// The last message search: its query, and the matching sessions with an excerpt.
    pub found: Option<(String, HashMap<PathBuf, String>)>,
    pub searching: bool,
    pub error: Option<String>,
}

enum Browsed {
    Listed(PathBuf, Vec<(SavedSession, Option<PathBuf>)>),
    Found(String, HashMap<PathBuf, String>),
}

impl Workspace {
    /// Starts with no tab: the user picks the project folder first. Pier's other lists (archived sessions) live
    /// next to `recent_file`.
    pub fn new(pi_args: Vec<String>, recent_file: PathBuf) -> Self {
        let recent = recent::load(&recent_file);
        let archive = Archive::load(recent_file.with_file_name("archived.json"));
        let (browser_tx, browser_rx) = channel();
        Self {
            pi_args,
            tabs: vec![],
            active: 0,
            recent,
            recent_file,
            closing: Arc::default(),
            titles: Arc::default(),
            browser: Browser::default(),
            browser_tx,
            browser_rx,
            archive,
        }
    }

    /// Lists every session saved for the active folder, in the background; `wake` repaints when done.
    pub fn load_sessions(&mut self, wake: impl Fn() + Send + 'static) {
        let Some(folder) = self.active_folder() else { return };
        self.browser = Browser { folder: Some(folder.clone()), loading: true, ..Browser::default() };
        let (titles, tx) = (Arc::clone(&self.titles), self.browser_tx.clone());
        std::thread::spawn(move || {
            let list = sessions::list_cached(&folder, usize::MAX, &mut lock(&titles));
            let list = list.into_iter().map(|s| (std::fs::canonicalize(&s.path).ok(), s)).map(|(c, s)| (s, c)).collect();
            let _ = tx.send(Browsed::Listed(folder, list));
            wake();
        });
    }

    /// Searches the listed sessions' messages for `query`, in the background; `wake` repaints when done.
    pub fn search_sessions(&mut self, query: &str, wake: impl Fn() + Send + 'static) {
        let query = query.trim().to_owned();
        if query.is_empty() {
            self.browser.found = None;
            return;
        }
        self.browser.searching = true;
        let paths: Vec<PathBuf> = self.browser.sessions.iter().map(|(s, _)| s.path.clone()).collect();
        let tx = self.browser_tx.clone();
        std::thread::spawn(move || {
            let found = paths.into_iter().filter_map(|p| sessions::search(&p, &query).map(|s| (p, s))).collect();
            let _ = tx.send(Browsed::Found(query, found));
            wake();
        });
    }

    /// Hides a session from Resume, or brings it back; Pi's file is not touched.
    pub fn set_archived(&mut self, session: &Path, archived: bool) {
        self.browser.error = self.archive.set(session, archived).err().map(|e| format!("Archive list not saved: {e}"));
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
        while let Ok(msg) = self.browser_rx.try_recv() {
            match msg {
                // A listing for a folder the window no longer shows is dropped.
                Browsed::Listed(folder, list) if self.browser.folder.as_ref() == Some(&folder) => {
                    self.browser.sessions = list;
                    self.browser.loading = false;
                }
                Browsed::Listed(..) => {}
                Browsed::Found(query, found) => {
                    self.browser.found = Some((query, found));
                    self.browser.searching = false;
                }
            }
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

    /// Session files open in a tab (or still closing), canonical so that Pi's spelling of a path matches the
    /// listing's. A session must not be opened twice: two Pi writing one file would corrupt it.
    pub fn open_files(&self) -> Vec<PathBuf> {
        let mut open: Vec<PathBuf> =
            self.tabs.iter().filter_map(|t| t.t.session_file.as_ref()).filter_map(|p| std::fs::canonicalize(p).ok()).collect();
        open.extend(lock(&self.closing).iter().cloned());
        open
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
    fn images_wait_for_a_model_that_reads_them_and_mentions_complete() {
        use crate::pi::protocol::ModelInfo;
        let mut tab = Tab::detached("a");
        tab.t.status.insert(crate::session::transcript::SUPERVISION_KEY.into(), "Supervised".into());
        let model = |input: &[&str]| ModelInfo {
            id: "m".into(),
            provider: "p".into(),
            name: None,
            reasoning: false,
            input: input.iter().map(|s| s.to_string()).collect(),
        };
        tab.t.model = Some(model(&["text"]));
        tab.attach(Image::from_rgba(1, 1, &[0, 0, 0, 255]));
        tab.attach(Err("big.png: too big".into()));
        assert_eq!(tab.images.len(), 1);
        tab.submit();
        assert_eq!(tab.images.len(), 1, "kept: the model would not see it");
        assert!(tab.t.entries.last().unwrap().text.contains("does not read images"));
        tab.t.model = Some(model(&["text", "image"]));
        tab.submit();
        assert!(tab.images.is_empty(), "an image alone, without text, is a message too");

        tab.files = ["src/main.rs", "src/app/mod.rs"].map(String::from).to_vec();
        tab.input = "look at @mai".into();
        assert_eq!(tab.file_suggestions(8), Some((vec!["src/main.rs".to_owned()], 1)));
        tab.mention("src/main.rs");
        assert_eq!(tab.input, "look at @src/main.rs ");
        assert_eq!(tab.file_suggestions(8), None);
        assert!(!tab.files_asked, "the next @ asks for a fresh list");
    }

    #[test]
    fn the_queue_is_edited_away_from_pi_and_sent_back_in_order() {
        use crate::session::transcript::QueueItem;
        let root = std::env::temp_dir().join(format!("pier-ws-queue-{}", std::process::id()));
        let work = root.join("project");
        std::fs::create_dir_all(&work).unwrap();
        let mut tab = Tab::detached(work.to_str().unwrap());
        // A checkpoint worker holds each message in `waiting`, where the test can read what would go to Pi.
        tab.checkpoints = Some(Worker::start(Repo::new(&root.join("shadow"), &work), || {}));
        tab.t.status.insert(crate::session::transcript::SUPERVISION_KEY.into(), "Supervised".into());
        tab.t.state = State::Running;
        tab.input = "after you're done".into();
        tab.queue_after();
        assert!(matches!(tab.waiting.back(), Some(Command::Prompt { streaming_behavior: Some(StreamingBehavior::FollowUp), .. })));

        tab.t.queued = vec![QueueItem { text: "x".into(), after: false }];
        tab.edit_queue();
        assert!(tab.t.queue_edit_pending);
        for _ in 0..200 {
            tab.update(Instant::now());
            if tab.waiting.is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        tab.t.state = State::Completed; // the run ended while the user was editing
        tab.t.queue_draft = Some(vec![
            QueueItem { text: "first".into(), after: false },
            QueueItem { text: "  ".into(), after: false },
            QueueItem { text: "last".into(), after: true },
        ]);
        tab.send_queue_back();
        let sent: Vec<_> = tab
            .waiting
            .iter()
            .map(|c| match c {
                Command::Prompt { message, streaming_behavior, .. } => (message.as_str(), *streaming_behavior),
                _ => unreachable!(),
            })
            .collect();
        assert_eq!(sent, [("first", None), ("last", Some(StreamingBehavior::FollowUp))], "blank dropped; the first starts a run");
        assert!(tab.t.queue_draft.is_none());
        drop(tab);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn checkpoints_pair_with_the_messages_they_precede() {
        let mut tab = Tab::detached("a");
        let checkpoint = |id: &str| Entry { checkpoint: Some(id.into()), ..Entry::new(Kind::Checkpoint, BEFORE_MESSAGE) };
        tab.t.entries = vec![
            Entry::new(Kind::User, "resumed, no checkpoint"),
            checkpoint("c1"),
            checkpoint("c2"), // a steer sent before the first message showed up
            Entry::new(Kind::User, "first"),
            Entry::new(Kind::Assistant, "…"),
            Entry::new(Kind::User, "steer"),
            Entry { checkpoint: Some("undo".into()), ..Entry::new(Kind::Checkpoint, "Files before the restore") },
            checkpoint("c3"),
            Entry::new(Kind::User, "first"),
        ];
        assert_eq!(tab.checkpoint_before("steer").as_deref(), Some("c2"));
        assert_eq!(tab.checkpoint_before("first").as_deref(), Some("c3"), "sent twice: the latest");
        assert_eq!(tab.checkpoint_before("resumed, no checkpoint"), None);
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

        // Resume lists the folder's sessions in the background; archiving hides one, next to recent.json.
        let sessions_dir = sessions::dir_for(&root);
        std::fs::create_dir_all(&sessions_dir).unwrap();
        let file = sessions_dir.join(format!("pier-ws-{}.jsonl", std::process::id()));
        std::fs::write(&file, r#"{"type":"message","message":{"role":"user","content":"find the zebra"}}"#).unwrap();
        let settle = |w: &mut Workspace| {
            for _ in 0..100 {
                w.update(Instant::now());
                if !w.browser.loading && !w.browser.searching {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        };
        w.load_sessions(|| {});
        settle(&mut w);
        assert_eq!(w.browser.sessions.len(), 1);
        assert_eq!(w.browser.sessions[0].0.title, "find the zebra");
        w.search_sessions("ZEBRA", || {});
        settle(&mut w);
        assert!(w.browser.found.as_ref().is_some_and(|(_, f)| f.contains_key(&file)));
        w.set_archived(&file, true);
        assert!(Archive::load(root.join("archived.json")).contains(&file), "saved next to recent.json");
        drop(w);
        std::fs::remove_dir_all(&sessions_dir).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    }
}
