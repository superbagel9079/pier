//! The egui window: tabs, each with its own Pi process and transcript.

mod approvals;
mod composer;
mod status_bar;
mod transcript_view;

use eframe::egui::{self, RichText};
use pier::pi::process::Process;
use pier::pi::protocol::{Command, StreamingBehavior};
use pier::session::state::State;
use pier::session::transcript::{Entry, Kind, Transcript};
use std::time::{Duration, Instant};

const TITLE_CHARS: usize = 24;

/// One session: a `pi --mode rpc` process, its transcript and its editor.
pub struct Tab {
    proc: Option<Process>,
    t: Transcript,
    input: String,
}

impl Tab {
    fn new(pi_args: &[String], ctx: &egui::Context) -> Self {
        let mut t = Transcript::default();
        let ctx = ctx.clone();
        let proc = Process::spawn(pi_args, move || ctx.request_repaint())
            .map_err(|e| t.entries.push(Entry { kind: Kind::Error, text: format!("Lancement de Pi impossible : {e}") }))
            .ok();
        if proc.is_none() {
            t.state = State::Crashed;
        }
        Self { proc, t, input: String::new() }
    }

    /// The first prompt, so tabs can be told apart.
    fn title(&self) -> String {
        let Some(first) = self.t.entries.iter().find(|e| e.kind == Kind::User) else { return "Nouvelle session".into() };
        let line = first.text.lines().next().unwrap_or_default();
        if line.chars().count() > TITLE_CHARS { format!("{}…", line.chars().take(TITLE_CHARS).collect::<String>()) } else { line.into() }
    }

    /// Runs every frame for every tab, visible or not: background sessions keep streaming, answering and expiring.
    fn update(&mut self, now: Instant) {
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

    fn flush(&mut self) {
        for reply in std::mem::take(&mut self.t.outbox) {
            self.send(reply);
        }
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

pub struct PierApp {
    pi_args: Vec<String>,
    tabs: Vec<Tab>,
    active: usize,
}

impl PierApp {
    pub fn new(pi_args: Vec<String>, ctx: &egui::Context) -> Self {
        let tabs = vec![Tab::new(&pi_args, ctx)];
        Self { pi_args, tabs, active: 0 }
    }

    fn open(&mut self, ctx: &egui::Context) {
        self.tabs.push(Tab::new(&self.pi_args, ctx));
        self.active = self.tabs.len() - 1;
    }

    /// Closing stops the tab's Pi. Pi keeps the conversation in its own session dir (unless `--no-session`).
    // shortcut: no confirmation when closing a running tab, add one if runs get lost by mistake.
    fn close(&mut self, i: usize) {
        let tab = self.tabs.remove(i);
        // Process::drop waits up to 3 s for Pi to exit; keep that off the UI thread.
        std::thread::spawn(move || drop(tab));
        if i < self.active || self.active >= self.tabs.len() {
            self.active = self.active.saturating_sub(1);
        }
    }

    fn tab_strip(&mut self, ui: &mut egui::Ui) {
        egui::Panel::top("tabs").show(ui, |ui| {
            ui.horizontal_wrapped(|ui| {
                let (mut select, mut close) = (None, None);
                for (i, tab) in self.tabs.iter().enumerate() {
                    let (state, color) = status_bar::state_style(tab.t.state, ui.visuals());
                    ui.label(RichText::new("●").color(color)).on_hover_text(state);
                    if ui.selectable_label(i == self.active, tab.title()).clicked() {
                        select = Some(i);
                    }
                    if ui.small_button("×").on_hover_text("Fermer l'onglet (arrête son Pi)").clicked() {
                        close = Some(i);
                    }
                    ui.separator();
                }
                if ui.button("+").on_hover_text("Nouvel onglet").clicked() {
                    self.open(ui.ctx());
                }
                if let Some(i) = select {
                    self.active = i;
                }
                if let Some(i) = close {
                    self.close(i);
                }
            });
        });
    }
}

impl eframe::App for PierApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let now = Instant::now();
        for tab in &mut self.tabs {
            tab.update(now);
        }
        if self.tabs.iter().any(|t| !t.t.approvals.is_empty()) {
            ui.ctx().request_repaint_after(Duration::from_secs(1)); // countdown and expiry without input
        }

        self.tab_strip(ui);
        if let Some(tab) = self.tabs.get_mut(self.active) {
            status_bar::show(tab, ui);
            status_bar::footer(tab, ui);
            composer::show(tab, ui);
            approvals::show(tab, ui);
            transcript_view::show(tab, ui);
        } else {
            egui::CentralPanel::default().show(ui, |ui| {
                if ui.button("Nouvel onglet").clicked() {
                    self.open(ui.ctx());
                }
            });
        }

        // After the panels, so a click's answer leaves in the same frame.
        for tab in &mut self.tabs {
            tab.flush();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(n: usize, active: usize) -> PierApp {
        let tabs = (0..n).map(|i| Tab { proc: None, t: Transcript::default(), input: i.to_string() }).collect();
        PierApp { pi_args: vec![], tabs, active }
    }

    fn active_input(a: &PierApp) -> Option<&str> {
        a.tabs.get(a.active).map(|t| t.input.as_str())
    }

    #[test]
    fn closing_keeps_a_sensible_active_tab() {
        let mut a = app(3, 2);
        a.close(0); // before the active one: same tab stays active
        assert_eq!(active_input(&a), Some("2"));
        a.close(1); // the active one, last: previous becomes active
        assert_eq!(active_input(&a), Some("1"));
        let mut b = app(3, 1);
        b.close(1); // the active one, not last: next becomes active
        assert_eq!(active_input(&b), Some("2"));
        let mut c = app(1, 0);
        c.close(0);
        assert_eq!(active_input(&c), None);
    }
}
