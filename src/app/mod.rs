//! The egui window: one tab, its Pi process and transcript.

mod composer;
mod status_bar;
mod transcript_view;

use eframe::egui;
use pier::pi::process::Process;
use pier::pi::protocol::{Command, StreamingBehavior};
use pier::session::state::State;
use pier::session::transcript::{Entry, Kind, Transcript};

pub struct PierApp {
    proc: Option<Process>,
    t: Transcript,
    input: String,
}

impl PierApp {
    pub fn new(pi_args: &[String], ctx: egui::Context) -> Self {
        let mut t = Transcript::default();
        let proc = Process::spawn(pi_args, move || ctx.request_repaint())
            .map_err(|e| t.entries.push(Entry { kind: Kind::Error, text: format!("Lancement de Pi impossible : {e}") }))
            .ok();
        if proc.is_none() {
            t.state = State::Crashed;
        }
        Self { proc, t, input: String::new() }
    }

    fn send(&mut self, cmd: Command) {
        let err = match self.proc.as_mut() {
            Some(p) => p.send(&cmd).err().map(|e| e.to_string()),
            None => Some("pas de process Pi".into()),
        };
        if let Some(e) = err {
            self.t.entries.push(Entry { kind: Kind::Error, text: format!("Envoi impossible : {e}") });
        }
    }

    fn submit(&mut self) {
        let text = self.input.trim().to_owned();
        if text.is_empty() {
            return;
        }
        // While a run is going, Pi requires a streamingBehavior; steer lands after the current turn.
        let streaming_behavior = self.t.state.is_running().then_some(StreamingBehavior::Steer);
        self.send(Command::Prompt { message: text, streaming_behavior });
        self.input.clear();
    }

    /// Like Pi's Esc: take queued messages back (they return to the editor), then abort.
    fn stop(&mut self) {
        self.send(Command::ClearQueue);
        self.send(Command::Abort);
    }
}

impl eframe::App for PierApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        if let Some(p) = &self.proc {
            while let Ok(msg) = p.rx.try_recv() {
                self.t.apply(msg);
            }
        }
        for reply in std::mem::take(&mut self.t.outbox) {
            self.send(reply);
        }
        if !self.t.restored.is_empty() {
            let back = std::mem::take(&mut self.t.restored).join("\n");
            self.input = if self.input.is_empty() { back } else { format!("{back}\n{}", self.input) };
        }

        status_bar::show(self, ui);
        composer::show(self, ui);
        transcript_view::show(self, ui);
    }
}
