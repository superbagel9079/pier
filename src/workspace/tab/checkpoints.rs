//! The tab's side of checkpoints: saving before each message, restoring, and forking with the files restored.

use super::{BEFORE_MESSAGE, Tab};
use crate::checkpoint::{Done, Job, Saved, Worker};
use crate::pi::protocol::Command;
use crate::session::journal::Record;
use crate::session::transcript::{Entry, Kind, Transcript};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};

/// A tab's line to its folder's checkpoint worker (shared with the other tabs on that folder): answers come back here.
pub(in crate::workspace) struct Checkpoints {
    pub(in crate::workspace) worker: Arc<Worker>,
    reply: Sender<Done>,
    pub(super) done: Receiver<Done>,
}

impl Checkpoints {
    pub(super) fn new(worker: Arc<Worker>) -> Self {
        let (reply, done) = channel();
        Self { worker, reply, done }
    }

    pub(super) fn send(&self, job: Job) -> bool {
        self.worker.send(job, &self.reply)
    }
}

impl Tab {
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

    pub(super) fn checkpoint_done(&mut self, done: Done) {
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
}
