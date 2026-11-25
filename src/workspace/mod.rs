//! The open tabs and what they share, without any UI: launching Pi in a folder, closing, recent folders, the
//! Resume list, and which state changes need the user. The egui layer only draws this and asks the user.

mod browser;
mod tab;

pub use browser::{Browser, Listed};
pub use tab::{Launch, NAME_MAX, Tab};

use crate::archive::Archive;
use crate::checkpoint::{self, Repo, Worker};
use crate::recent;
use crate::session::state::Attention;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Instant;

/// All open tabs, the active one, and the recent project folders.
pub struct Workspace {
    pi_args: Vec<String>,
    pub tabs: Vec<Tab>,
    pub active: usize,
    /// Project folders opened before, newest first.
    pub recent: Vec<PathBuf>,
    recent_file: PathBuf,
    /// Session files of closed tabs whose Pi is still shutting down: still "open" for Resume.
    closing: Arc<Mutex<Vec<PathBuf>>>,
    /// What the Resume window shows.
    pub browser: Browser,
    /// Sessions hidden from Resume.
    pub archive: Archive,
    /// The checkpoint worker of each folder, by shadow repository, while a tab uses it.
    workers: HashMap<PathBuf, Weak<Worker>>,
}

/// The checkpoint worker of `folder`, shared with the tabs already on it, or a new one.
fn worker_for(workers: &mut HashMap<PathBuf, Weak<Worker>>, folder: &Path, wake: impl Fn() + Send + 'static) -> Arc<Worker> {
    let repo = Repo::new(&checkpoint::dir(), folder);
    let key = repo.git_dir().to_path_buf();
    if let Some(w) = workers.get(&key).and_then(Weak::upgrade) {
        return w;
    }
    workers.retain(|_, w| w.strong_count() > 0);
    let w = Worker::start(repo, wake);
    workers.insert(key, Arc::downgrade(&w));
    w
}

impl Workspace {
    /// Starts with no tab: the user picks the project folder first. Pier's other lists (archived sessions) live
    /// next to `recent_file`.
    pub fn new(pi_args: Vec<String>, recent_file: PathBuf) -> Self {
        let recent = recent::load(&recent_file);
        let archive = Archive::load(recent_file.with_file_name("archived.json"));
        Self {
            pi_args,
            tabs: vec![],
            active: 0,
            recent,
            recent_file,
            closing: Arc::default(),
            browser: Browser::default(),
            archive,
            workers: HashMap::new(),
        }
    }

    /// Lists every session saved for the active folder, in the background; `wake` repaints when done.
    pub fn load_sessions(&mut self, wake: impl Fn() + Send + 'static) {
        if let Some(folder) = self.active_folder() {
            self.browser.load(folder, wake);
        }
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
        let workers = &mut self.workers;
        let worker_wake = wake.clone();
        let tab = Tab::new(&self.pi_args, folder, launch, wake, |f| worker_for(workers, f, worker_wake));
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
        // Tabs on one folder share its checkpoint worker: a restore in one waits for the others to be idle.
        let busy: Vec<(Option<*const Worker>, bool)> =
            self.tabs.iter().map(|t| (t.checkpoints.as_ref().map(|c| Arc::as_ptr(&c.worker)), t.busy())).collect();
        for (i, tab) in self.tabs.iter_mut().enumerate() {
            let mine = busy[i].0;
            tab.folder_busy_elsewhere = mine.is_some() && busy.iter().enumerate().any(|(j, (w, b))| j != i && *w == mine && *b);
        }
        self.browser.poll();
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
        let mut open: Vec<PathBuf> = self.tabs.iter().filter_map(|t| t.canonical_session.as_ref().map(|(_, c)| c.clone())).collect();
        open.extend(lock(&self.closing).iter().cloned());
        open
    }
}

/// A poisoned lock only means a thread panicked while holding it; the data itself is still usable.
pub(crate) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
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
    use crate::pi::sessions;
    use crate::session::state::State;

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
    fn any_running_counts_blocked_runs() {
        let mut w = ws(&["a", "b"], 0);
        assert!(!w.any_running());
        w.tabs[1].t.state = State::Blocked;
        assert!(w.any_running(), "waiting on an approval is still a run");
        w.tabs[1].t.state = State::Completed;
        assert!(!w.any_running());
    }

    #[test]
    fn a_closing_tab_still_holds_its_session_file() {
        let file = std::env::temp_dir().join(format!("pier-ws-closing-{}.jsonl", std::process::id()));
        std::fs::write(&file, "").unwrap();
        let mut w = ws(&["a"], 0);
        w.tabs[0].t.session_file = Some(file.clone());
        w.update(Instant::now()); // where the tab resolves its canonical path
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
        assert_eq!(w.browser.sessions[0].session.title, "find the zebra");
        w.browser.search("ZEBRA", || {});
        settle(&mut w);
        assert!(w.browser.found.as_ref().is_some_and(|(_, f)| f.contains_key(&file)));
        w.set_archived(&file, true);
        assert!(Archive::load(root.join("archived.json")).contains(&file), "saved next to recent.json");
        drop(w);
        std::fs::remove_dir_all(&sessions_dir).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    }
}
