//! One tab: a Pi process, its transcript, and what goes through it (messages, checkpoints, forks, approvals).

use crate::attach::Image;
use crate::checkpoint::{Done, Job, Saved, Worker};
use crate::complete;
use crate::pi::process::Process;
use crate::pi::protocol::{Command, ModelInfo, StreamingBehavior};
use crate::presets::Preset;
use crate::session::journal::{self, Journal, Record};
use crate::session::state::State;
use crate::session::transcript::{Entry, Kind, Transcript};
use crate::text;
use std::collections::{HashMap, VecDeque};
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

/// A tab's line to its folder's checkpoint worker (shared with the other tabs on that folder): answers come back here.
pub(super) struct Checkpoints {
    pub(super) worker: Arc<Worker>,
    reply: Sender<Done>,
    done: Receiver<Done>,
}

impl Checkpoints {
    fn new(worker: Arc<Worker>) -> Self {
        let (reply, done) = channel();
        Self { worker, reply, done }
    }

    fn send(&self, job: Job) -> bool {
        self.worker.send(job, &self.reply)
    }
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
        if let Some(m) = self.t.model.as_ref().filter(|m| !self.images.is_empty() && !m.takes_images()) {
            let msg = format!("Not sent: {} does not read images. Remove them or pick another model.", m.key());
            self.t.error(msg);
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

    /// A run is going, or a message, a restore or a fork is on its way.
    pub fn busy(&self) -> bool {
        self.t.state.is_running() || !self.waiting.is_empty() || self.restoring || self.fork_after_restore.is_some()
    }

    /// Restorable only while nothing touches the files: no run or send in this tab or any tab on the same folder.
    pub fn can_restore(&self) -> bool {
        self.checkpoints.is_some() && !self.busy() && !self.folder_busy_elsewhere
    }

    /// A message waits for its files to be saved before it goes to Pi.
    pub fn saving(&self) -> bool {
        !self.waiting.is_empty()
    }

    /// Asks Pi which messages a fork can start from (the Fork menu shows them).
    pub fn refresh_fork_messages(&mut self) {
        self.send(Command::GetForkMessages);
    }

    /// For each message sent in this tab, the checkpoint taken just before it (the last, if sent twice), paired by
    /// message text so a steer taken back by Stop cannot shift the pairs. Build once per Fork menu, not per message.
    pub fn checkpoints_by_message(&self) -> HashMap<&str, &str> {
        self.t
            .entries
            .iter()
            .filter(|e| e.kind == Kind::Checkpoint)
            .filter_map(|e| Some((e.before.as_deref()?.trim(), e.checkpoint.as_deref()?)))
            .collect()
    }

    /// Switches the tab to a new session going on from just before the user message `entry_id` (the original stays
    /// in Resume); its text comes back to the editor. `restore`: first put the files back as they were before it.
    pub fn fork(&mut self, entry_id: &str, restore: Option<String>) {
        if self.busy() {
            self.t.error("Not forked: wait until the run ends.");
            return;
        }
        match (restore, &self.checkpoints) {
            (Some(_), _) if self.folder_busy_elsewhere => {
                self.t.error("Not forked: another tab on this folder is running.");
            }
            (Some(checkpoint), Some(w)) => {
                if w.send(Job::Restore(checkpoint)) {
                    self.restoring = true;
                    self.fork_after_restore = Some(entry_id.to_owned());
                }
            }
            _ => self.send(Command::Fork { entry_id: entry_id.to_owned() }),
        }
    }

    /// Restores the files to checkpoint `id`, checkpointing the current files first so the restore can be undone.
    pub fn restore(&mut self, id: &str) {
        if !self.can_restore() {
            let why = if self.folder_busy_elsewhere { "another tab on this folder is running" } else { "wait until the run ends" };
            self.t.error(format!("Not restored: {why}."));
            return;
        }
        if let Some(w) = &self.checkpoints
            && w.send(Job::Restore(id.to_owned()))
        {
            self.restoring = true;
        }
    }

    fn checkpoint_done(&mut self, done: Done) {
        let saved = |t: &mut Transcript, saved: &Saved, text: &str, before: Option<String>| {
            t.journal.push(Record::Checkpoint { id: saved.id.clone() });
            t.entries.push(Entry { checkpoint: Some(saved.id.clone()), before, ..Entry::new(Kind::Checkpoint, text) });
            if !saved.locked.is_empty() {
                let msg = format!("Not in this checkpoint (locked by another program): {}", saved.locked.join(", "));
                t.notice(msg);
            }
        };
        match done {
            Done::Files(Ok(files)) => {
                self.files = files;
                self.file_matches = None;
            }
            Done::Files(Err(e)) => self.t.notice(format!("File list unavailable for @: {e}")),
            Done::Snapshot(result) => {
                // Stop may have taken the message back meanwhile: the checkpoint then belongs to no message.
                let prompt = if self.orphan_snapshots > 0 {
                    self.orphan_snapshots -= 1;
                    None
                } else {
                    self.waiting.pop_front()
                };
                let text = match &prompt {
                    Some(Command::Prompt { message, .. }) => Some(message.clone()),
                    _ => None,
                };
                match &result {
                    Ok(s) => saved(&mut self.t, s, if text.is_some() { BEFORE_MESSAGE } else { "Files saved (message not sent)" }, text),
                    Err(e) => self.t.notice(format!("No checkpoint: {e}")),
                }
                // Sent even without a checkpoint: the notice says so, and holding the message back would lose it.
                if let Some(prompt) = prompt {
                    self.send(prompt);
                }
            }
            Done::Restored { to, undo, result } => {
                self.restoring = false;
                if let Ok(undo) = &undo {
                    saved(&mut self.t, undo, "Files before the restore", None);
                }
                let fork = self.fork_after_restore.take();
                match (result, undo) {
                    (Ok(kept), Ok(undo)) => {
                        self.t.journal.push(Record::CheckpointRestored { to, undo: undo.id });
                        if !kept.is_empty() {
                            self.t.notice(format!("Left as they are: {}", kept.join("; ")));
                        }
                        match fork {
                            Some(entry_id) => {
                                self.t.notice("Files restored; forking…");
                                self.send(Command::Fork { entry_id });
                            }
                            None => self.t.notice("Files restored. Pi was not told; say so if it matters."),
                        }
                    }
                    (Err(e), _) | (Ok(_), Err(e)) => {
                        let what = if fork.is_some() { "Not forked: the files could not be restored" } else { "Restore failed" };
                        self.t.error(format!("{what}: {e}"));
                    }
                }
            }
        }
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
mod tests {
    use super::*;
    use crate::checkpoint::Repo;

    #[test]
    fn the_session_name_titles_the_tab() {
        use crate::pi::process::parse_line;
        let mut tab = Tab::detached("a");
        let feed = |tab: &mut Tab, line: &str| tab.t.apply_event(&parse_line(line.as_bytes()).unwrap().unwrap());
        feed(&mut tab, r#"{"type":"message_start","message":{"role":"user","content":"run the tests"}}"#);
        assert_eq!(tab.title(), "run the tests");
        feed(&mut tab, r#"{"type":"response","command":"get_state","success":true,"data":{"sessionName":"Parser tests"}}"#);
        assert_eq!(tab.title(), "Parser tests", "a name beats the first prompt");
        feed(&mut tab, r#"{"type":"session_info_changed","name":"A name that is far too long for a tab"}"#);
        assert_eq!(tab.title(), "A name that is far too l…");
        feed(&mut tab, r#"{"type":"session_info_changed"}"#);
        assert_eq!(tab.title(), "run the tests", "cleared name: back to the prompt");
        feed(&mut tab, r#"{"type":"response","command":"set_session_name","success":true}"#);
        assert_eq!(tab.t.outbox, [Command::GetState], "the name is read back from Pi");
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
        tab.checkpoints = Some(Checkpoints::new(Worker::start(Repo::new(&root.join("shadow"), &work), || {})));
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
        tab.checkpoints = Some(Checkpoints::new(Worker::start(Repo::new(&root.join("shadow"), &work), || {})));
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
    fn checkpoints_pair_with_their_message_by_text_even_after_stop() {
        let root = std::env::temp_dir().join(format!("pier-ws-pairing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let work = root.join("project");
        std::fs::create_dir_all(&work).unwrap();
        let mut tab = Tab::detached(work.to_str().unwrap());
        tab.checkpoints = Some(Checkpoints::new(Worker::start(Repo::new(&root.join("shadow"), &work), || {})));
        tab.t.status.insert(crate::session::transcript::SUPERVISION_KEY.into(), "Supervised".into());
        let settle = |tab: &mut Tab| {
            for _ in 0..300 {
                tab.update(Instant::now());
                if tab.waiting.is_empty() && tab.orphan_snapshots == 0 {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            panic!("checkpoints never came back");
        };
        tab.t.state = State::Running;
        tab.input = "X".into();
        tab.submit(); // a steer…
        tab.stop(); // …taken back before it reached Pi
        assert!(tab.waiting.is_empty() && tab.t.restored == ["X"], "back to the editor, not sent after the Stop");
        tab.t.state = State::Stopped;
        tab.t.restored.clear();
        for text in ["A", "B"] {
            tab.input = text.into();
            tab.submit();
            settle(&mut tab);
        }
        let pairs = tab.checkpoints_by_message();
        let a = pairs.get("A").copied().expect("A has its checkpoint");
        let b = pairs.get("B").copied().expect("B has its checkpoint");
        assert_ne!(a, b, "B is not paired with A's checkpoint");
        assert!(!pairs.contains_key("X"), "the message taken back owns no checkpoint");
        let orphan = tab.t.entries.iter().filter(|e| e.text == "Files saved (message not sent)").count();
        assert_eq!(orphan, 1);
        drop(tab);
        let _ = std::fs::remove_dir_all(&root);
    }
}
