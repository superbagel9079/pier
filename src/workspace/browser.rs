//! The Resume window's sessions for one folder, listed and searched off the UI thread: there can be hundreds.

use super::lock;
use crate::pi::sessions::{self, SavedSession, TitleCache};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};

/// A saved session as the Resume window lists it, with what it needs prepared once.
pub struct Listed {
    pub session: SavedSession,
    /// To tell whether a tab has it open.
    pub canonical: Option<PathBuf>,
    /// For the title filter.
    pub title_lower: String,
}

impl Listed {
    fn new(session: SavedSession) -> Self {
        Self { canonical: std::fs::canonicalize(&session.path).ok(), title_lower: session.title.to_lowercase(), session }
    }
}

enum Browsed {
    Listed(PathBuf, Vec<Listed>),
    Found(u64, String, HashMap<PathBuf, String>),
}

pub struct Browser {
    pub folder: Option<PathBuf>,
    /// Newest first.
    pub sessions: Vec<Listed>,
    pub loading: bool,
    /// The last message search: its query, and the matching sessions with an excerpt.
    pub found: Option<(String, HashMap<PathBuf, String>)>,
    pub searching: bool,
    pub error: Option<String>,
    /// Titles already read, kept across openings so unchanged files are not read again.
    titles: Arc<Mutex<TitleCache>>,
    /// Bumped by each search; only the latest one's results are kept.
    generation: u64,
    tx: Sender<Browsed>,
    rx: Receiver<Browsed>,
}

impl Default for Browser {
    fn default() -> Self {
        let (tx, rx) = channel();
        Self {
            folder: None,
            sessions: Vec::new(),
            loading: false,
            found: None,
            searching: false,
            error: None,
            titles: Arc::default(),
            generation: 0,
            tx,
            rx,
        }
    }
}

impl Browser {
    /// Lists every session saved for `folder`, in the background; `wake` repaints when done.
    pub fn load(&mut self, folder: PathBuf, wake: impl Fn() + Send + 'static) {
        self.clear();
        self.folder = Some(folder.clone());
        self.loading = true;
        let (titles, tx) = (Arc::clone(&self.titles), self.tx.clone());
        std::thread::spawn(move || {
            let list = sessions::list_cached(&folder, usize::MAX, &mut lock(&titles));
            let _ = tx.send(Browsed::Listed(folder, list.into_iter().map(Listed::new).collect()));
            wake();
        });
    }

    /// Searches the listed sessions' messages for `query`, in the background; `wake` repaints when done.
    pub fn search(&mut self, query: &str, wake: impl Fn() + Send + 'static) {
        let query = query.trim().to_owned();
        if query.is_empty() {
            self.found = None;
            return;
        }
        self.searching = true;
        self.generation += 1;
        let generation = self.generation;
        let paths: Vec<PathBuf> = self.sessions.iter().map(|l| l.session.path.clone()).collect();
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let found = paths.into_iter().filter_map(|p| sessions::search(&p, &query).map(|s| (p, s))).collect();
            let _ = tx.send(Browsed::Found(generation, query, found));
            wake();
        });
    }

    /// The window closed: the list is dropped (the title cache stays).
    pub fn clear(&mut self) {
        self.folder = None;
        self.sessions = Vec::new();
        self.loading = false;
        self.found = None;
        self.searching = false;
        self.error = None;
        self.generation += 1; // a search still running is now stale
    }

    /// Takes in what the background threads finished.
    pub(super) fn poll(&mut self) {
        while let Ok(msg) = self.rx.try_recv() {
            match msg {
                // A listing for a folder the window no longer shows is dropped.
                Browsed::Listed(folder, list) if self.folder.as_ref() == Some(&folder) => {
                    self.sessions = list;
                    self.loading = false;
                }
                Browsed::Listed(..) => {}
                Browsed::Found(generation, query, found) if generation == self.generation => {
                    self.found = Some((query, found));
                    self.searching = false;
                }
                Browsed::Found(..) => {}
            }
        }
    }
}
