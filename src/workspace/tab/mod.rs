//! One tab: a Pi process, its transcript, and what goes through it (messages, checkpoints, forks, approvals).

mod checkpoints;

use crate::attach::Image;
use crate::checkpoint::{Done, Job, Worker};
use crate::complete;
use crate::pi::process::Process;
use crate::pi::protocol::{Command, ModelInfo, StreamingBehavior};
use crate::presets::Preset;
use crate::session::journal::{self, Journal, Record};
use crate::session::state::State;
use crate::session::transcript::{Kind, Transcript};
use crate::text;
use checkpoints::Checkpoints;
use std::collections::VecDeque;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::Instant;

const TITLE_CHARS: usize = 24;
/// Text of the checkpoint taken before a message (the Fork menu pairs them by it).
const BEFORE_MESSAGE: &str = "Files before this message";
/// Longer names are cut: they are labels, not notes.
pub const NAME_MAX: usize = 80;

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
    pub(super) seen: State,
    /// Saves and restores the folder's files, off the UI thread. `None` without a Pi.
    pub(super) checkpoints: Option<Checkpoints>,
    /// Another tab on the same folder is running or sending: restoring here would change files under its feet.
    pub folder_busy_elsewhere: bool,
    /// Messages waiting for their checkpoint; each goes to Pi once its files are saved.
    waiting: VecDeque<Command>,
    /// Checkpoints still to come for messages Stop took back.
    orphan_snapshots: usize,
    /// The last `@` query and its matches, so typing elsewhere does not filter 20 000 paths each frame.
    file_matches: Option<(String, Vec<String>, usize)>,
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
    /// Images being prepared on their own thread, and where they arrive.
    preparing_images: usize,
    image_tx: Sender<Result<Image, String>>,
    image_rx: Receiver<Result<Image, String>>,
    /// The session file as Pi names it and its canonical form, resolved once per change rather than per frame.
    pub(super) canonical_session: Option<(PathBuf, PathBuf)>,
}

impl Tab {
    /// `folder`: where Pi works, unless a preset names its own. `wake`: called when Pi sends something.
    /// `worker`: the checkpoint worker of the folder the tab ends up in.
    pub(super) fn new(
        pi_args: &[String],
        folder: &Path,
        launch: Launch,
        wake: impl Fn() + Send + Clone + 'static,
        worker: impl FnOnce(&Path) -> Arc<Worker>,
    ) -> Self {
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
        let proc = Process::spawn_in(&args, Some(cwd), wake).map_err(|e| t.error(format!("Cannot start Pi: {e}"))).ok();
        if proc.is_none() {
            t.state = State::Crashed;
        }
        let journal = Journal::create(&journal::dir()).map_err(|e| t.error(format!("Journal unavailable: {e}"))).ok();
        let seen = t.state;
        let checkpoints = proc.is_some().then(|| Checkpoints::new(worker(&folder)));
        let image_channel = channel();
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
            folder_busy_elsewhere: false,
            waiting: VecDeque::new(),
            orphan_snapshots: 0,
            file_matches: None,
            restoring: false,
            fork_after_restore: None,
            images: vec![],
            files: vec![],
            files_asked: false,
            queued_images: false,
            preparing_images: 0,
            image_tx: image_channel.0.clone(),
            image_rx: image_channel.1,
            canonical_session: None,
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
            return text::shorten(name, TITLE_CHARS);
        }
        let Some(first) = self.t.entries.iter().find(|e| e.kind == Kind::User) else {
            return self.label.clone().unwrap_or_else(|| "New session".into());
        };
        text::shorten(first.text.lines().next().unwrap_or_default(), TITLE_CHARS)
    }

    /// Runs every frame for every tab, visible or not: background sessions keep streaming, answering and expiring.
    pub(super) fn update(&mut self, now: Instant) {
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
        while let Ok(image) = self.image_rx.try_recv() {
            self.preparing_images -= 1;
            self.attach(image);
        }
        if self.t.session_file.as_ref() != self.canonical_session.as_ref().map(|(raw, _)| raw) {
            self.canonical_session = self.t.session_file.as_ref().and_then(|p| Some((p.clone(), std::fs::canonicalize(p).ok()?)));
        }
        if !self.run_going() {
            self.queued_images = false; // the run is over: nothing waits in Pi's queue any more
        }
        if !self.t.restored.is_empty() {
            let back = std::mem::take(&mut self.t.restored).join("\n");
            self.input = if self.input.is_empty() { back } else { format!("{back}\n{}", self.input) };
        }
    }

    /// Sends queued replies to Pi and writes queued journal lines.
    pub(super) fn flush(&mut self) {
        for reply in std::mem::take(&mut self.t.outbox) {
            self.send(reply);
        }
        let records = std::mem::take(&mut self.t.journal);
        if let Some(j) = &mut self.journal
            && let Err(e) = records.iter().try_for_each(|r| j.write(r))
        {
            self.t.error(format!("Journal stopped ({}): {e}", j.path.display()));
            self.journal = None;
        }
    }

    fn send(&mut self, cmd: Command) {
        let err = match self.proc.as_mut() {
            Some(p) => p.send(&cmd).err().map(|e| e.to_string()),
            None => Some("no Pi process".into()),
        };
        if let Some(e) = err {
            self.t.error(format!("Cannot send: {e}"));
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
            self.t.error("Not sent: Pi is not supervised.");
            return;
        }
        if self.preparing_images > 0 {
            self.t.error("Not sent yet: an image is still being prepared. Send again in a moment.");
            return;
        }
        if let Some(m) = self.t.model.as_ref().filter(|m| !self.images.is_empty() && !m.takes_images()) {
            let msg = format!("Not sent: {} does not read images. Remove them or pick another model.", m.key());
            self.t.error(msg);
            return;
        }
        // While a run is going (or about to), Pi requires a streamingBehavior; steer lands after the current turn.
        let behavior = self.run_going().then_some(if after { StreamingBehavior::FollowUp } else { StreamingBehavior::Steer });
        let images: Vec<_> = std::mem::take(&mut self.images).into_iter().map(|i| i.content).collect();
        // Editing the queue gives back text only: remember that a waiting message carries images.
        self.queued_images |= behavior.is_some() && !images.is_empty();
        self.dispatch(Command::Prompt { message: text, streaming_behavior: behavior, images });
        self.input.clear();
    }

    /// The permission mode Pier's extension reports (its label), once supervised.
    pub fn mode(&self) -> Option<&str> {
        self.t.status.get(crate::session::transcript::SUPERVISION_KEY).map(String::as_str)
    }

    /// Asks Pier's extension to switch mode (a `MODES` key). Runs at once, even during a run, and never reaches the
    /// model; the status shows the new mode once the extension has applied it.
    pub fn set_mode(&mut self, key: &str) {
        self.send(Command::prompt(format!("/pier-mode {key}"), None));
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

    /// Sends the edited queue back in order, dropping empty messages; if the run ended, the first starts a new run.
    pub fn send_queue_back(&mut self) {
        let Some(draft) = self.t.queue_draft.take() else { return };
        if !self.t.supervised() {
            self.t.queue_draft = Some(draft);
            self.t.error("Not sent: Pi is not supervised.");
            return;
        }
        for item in draft.into_iter().filter(|i| !i.text.trim().is_empty()) {
            let behavior = self.run_going().then_some(if item.after { StreamingBehavior::FollowUp } else { StreamingBehavior::Steer });
            self.dispatch(Command::prompt(item.text.trim(), behavior));
        }
    }

    /// Drops the messages taken back for editing: Pi never reads them.
    pub fn discard_queue(&mut self) {
        self.t.queue_draft = None;
    }

    /// While the editor ends with `@partial`: matching project files (the first `max`) and how many match in all.
    /// The file list is asked for once per mention, so files created meanwhile show up next time.
    pub fn file_suggestions(&mut self, max: usize) -> Option<(Vec<String>, usize)> {
        let Some(query) = complete::mention_query(&self.input) else {
            // Mention over: the list (up to 20 000 paths) is freed and read again at the next `@`.
            self.files_asked = false;
            self.files = Vec::new();
            self.file_matches = None;
            return None;
        };
        if !self.files_asked {
            self.files_asked = true;
            if let Some(w) = &self.checkpoints {
                w.send(Job::ListFiles);
            }
        }
        if self.file_matches.as_ref().is_none_or(|(q, ..)| q != query) {
            let found = complete::files(&self.files, query);
            let first = found.iter().take(max).map(|s| s.to_string()).collect();
            self.file_matches = Some((query.to_owned(), first, found.len()));
        }
        self.file_matches.as_ref().map(|(_, first, total)| (first.clone(), *total))
    }

    /// Replaces the trailing `@partial` with the picked file.
    pub fn mention(&mut self, path: &str) {
        self.input = complete::insert_mention(&self.input, path);
    }

    /// Adds an image to the next message; a refused one is said in the transcript.
    pub fn attach(&mut self, image: Result<Image, String>) {
        match image {
            Ok(i) => self.images.push(i),
            Err(e) => self.t.error(format!("Image not attached: {e}")),
        }
    }

    /// Prepares an image (read, encode) on its own thread; it joins the next message when ready.
    pub fn attach_later(&mut self, prepare: impl FnOnce() -> Result<Image, String> + Send + 'static) {
        self.preparing_images += 1;
        let ready = self.image_tx.clone();
        std::thread::spawn(move || {
            let _ = ready.send(prepare());
        });
    }

    /// Images still being prepared: the UI keeps repainting until they arrive.
    pub fn preparing_images(&self) -> usize {
        self.preparing_images
    }

    /// A run is going, or a message, a restore or a fork is on its way.
    pub fn busy(&self) -> bool {
        self.t.state.is_running() || !self.waiting.is_empty() || self.restoring || self.fork_after_restore.is_some()
    }

    /// Answers the approval the user saw (by id), if it is still the one shown.
    pub fn approve(&mut self, id: &str, allowed: bool) {
        self.t.answer(id, allowed);
    }

    /// Allows the shown approval and adds what its command was offered as to the allowlist, so it runs without
    /// asking next time. Only the extension's own proposal is added, never a text from elsewhere.
    pub fn approve_always(&mut self, id: &str) {
        let entry = self.t.approvals.front().filter(|a| a.id == id).and_then(|a| a.allow_as.clone());
        if let Some(entry) = entry
            && let Err(e) = crate::allowlist::add(&crate::allowlist::path(), &entry)
        {
            self.t.error(format!("Not added to the allowlist: {e}"));
        }
        self.approve(id, true);
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
        // Messages still waiting for a checkpoint come back to the editor too, or they would start a new run after Stop.
        let held: Vec<String> = self
            .waiting
            .drain(..)
            .filter_map(|c| match c {
                Command::Prompt { message, .. } => Some(message),
                _ => None,
            })
            .collect();
        // Their checkpoints still come back, in order: they must not take the next message's place.
        self.orphan_snapshots += held.len();
        self.t.restored.extend(held);
        self.send(Command::ClearQueue);
        self.send(Command::Abort);
    }

    #[cfg(test)]
    pub(super) fn detached(folder: &str) -> Self {
        let image_channel = channel();
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
            folder_busy_elsewhere: false,
            waiting: VecDeque::new(),
            orphan_snapshots: 0,
            file_matches: None,
            restoring: false,
            fork_after_restore: None,
            images: vec![],
            files: vec![],
            files_asked: false,
            queued_images: false,
            preparing_images: 0,
            image_tx: image_channel.0.clone(),
            image_rx: image_channel.1,
            canonical_session: None,
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

#[cfg(test)]
mod tests;
