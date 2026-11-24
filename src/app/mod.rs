//! The egui window: draws the workspace (tabs, start screen, menus) and asks the user. No session logic here:
//! that lives in `pier::workspace`, so the interface can be reworked without touching what Pier does.

mod approvals;
mod composer;
mod diff_view;
mod status_bar;
mod transcript_view;

use eframe::egui::{self, RichText};
use pier::awake::KeepAwake;
use pier::pi::sessions::SavedSession;
use pier::presets::{self, Preset};
use pier::recent;
use pier::session::state::Attention;
use pier::session::transcript::{Entry, Kind};
use pier::workspace::{Launch, Workspace};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const RESUME_LIST_MAX: usize = 20;

/// Opens a file with the system's default app for its type.
fn open_in_editor(path: &Path) -> std::io::Result<()> {
    let opener = if cfg!(windows) {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener).arg(path).spawn().map(drop)
}

/// Native folder dialog.
// shortcut: blocks the window while open (tabs catch up right after; approval deadlines still apply), move to a thread if that bothers.
fn pick_folder() -> Option<PathBuf> {
    rfd::FileDialog::new().set_title("Choisir le dossier du projet").pick_folder()
}

/// Repaints the window when a tab's Pi sends something.
fn waker(ctx: &egui::Context) -> impl Fn() + Send + Clone + 'static {
    let ctx = ctx.clone();
    move || ctx.request_repaint()
}

/// "il y a 5 min" style age, coarse on purpose.
fn ago(secs: u64) -> String {
    match secs {
        0..60 => "à l'instant".into(),
        60..3600 => format!("il y a {} min", secs / 60),
        3600..86_400 => format!("il y a {} h", secs / 3600),
        _ => format!("il y a {} j", secs / 86_400),
    }
}

pub struct PierApp {
    ws: Workspace,
    /// Saved sessions of the active folder, read when the Reprendre menu opens (not every frame).
    saved: Vec<(SavedSession, bool)>,
    /// presets.json, read when the Presets menu opens; an error is shown, not hidden.
    presets: Result<Vec<Preset>, String>,
    /// Window title last sent, so it is only re-sent when it changes.
    title: String,
    /// Holds off system sleep while a run is going.
    awake: KeepAwake,
    /// Set once Windows refused the hold: reported once, not retried every frame.
    awake_failed: bool,
}

impl PierApp {
    pub fn new(pi_args: Vec<String>) -> Self {
        Self {
            ws: Workspace::new(pi_args, recent::path()),
            saved: vec![],
            presets: Ok(vec![]),
            title: String::new(),
            awake: KeepAwake::default(),
            awake_failed: false,
        }
    }

    /// A new tab in the active tab's folder, or in a folder the user picks when there is none.
    fn open_here(&mut self, launch: Launch, ctx: &egui::Context) {
        if let Some(folder) = self.ws.active_folder().or_else(pick_folder) {
            self.ws.open(&folder, launch, waker(ctx));
        }
    }

    /// Flashes the taskbar when a tab the user is not looking at needs them, and counts pending approvals in the title.
    fn call_attention(&mut self, ctx: &egui::Context) {
        let focused = ctx.input(|i| i.viewport().focused).unwrap_or(true);
        if let Some(why) = self.ws.attention(focused) {
            let kind = match why {
                Attention::Approval => egui::UserAttentionType::Critical,
                Attention::RunEnded => egui::UserAttentionType::Informational,
            };
            ctx.send_viewport_cmd(egui::ViewportCommand::RequestUserAttention(kind));
        }
        let waiting = self.ws.waiting_approvals();
        let title = if waiting == 0 { "Pier".to_owned() } else { format!("Pier · {waiting} en attente d'approbation") };
        if title != self.title {
            ctx.send_viewport_cmd(egui::ViewportCommand::Title(title.clone()));
            self.title = title;
        }
    }

    /// Start screen: open a folder, or one of the recent ones.
    fn start_screen(&mut self, ui: &mut egui::Ui) {
        let mut pick = None;
        egui::CentralPanel::default().show(ui, |ui| {
            ui.add_space(24.0);
            ui.heading("Choisissez le dossier du projet");
            ui.weak("Pi travaillera dans ce dossier. Chaque onglet garde le sien.");
            ui.add_space(12.0);
            if ui.button("Ouvrir un dossier…").clicked() {
                pick = pick_folder();
            }
            if !self.ws.recent.is_empty() {
                ui.add_space(16.0);
                ui.strong("Récents");
                for folder in &self.ws.recent {
                    let name = folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| folder.display().to_string());
                    if ui.button(name).on_hover_text(folder.display().to_string()).clicked() {
                        pick = Some(folder.clone());
                    }
                }
            }
        });
        if let Some(folder) = pick {
            self.ws.open(&folder, Launch::New, waker(ui.ctx()));
        }
    }

    /// Menu of Pi sessions saved for the active folder; one already open in a tab is greyed out.
    fn resume_menu(&mut self, ui: &mut egui::Ui) {
        let mut pick = None;
        let r = ui.menu_button("Reprendre", |ui| {
            if self.saved.is_empty() {
                ui.weak("Aucune session enregistrée pour ce dossier.");
            }
            for (s, is_open) in &self.saved {
                let when = s.modified.elapsed().map(|d| ago(d.as_secs())).unwrap_or_default();
                let label = format!("{}  ·  {when}", s.title);
                let b = ui.add_enabled(!is_open, egui::Button::new(label));
                if b.on_disabled_hover_text("Déjà ouverte dans un onglet").clicked() {
                    pick = Some(s.path.clone());
                    ui.close();
                }
            }
        });
        if r.response.clicked() {
            self.saved = self.ws.saved_sessions(RESUME_LIST_MAX);
        }
        if let Some(path) = pick {
            self.open_here(Launch::Resume(&path), ui.ctx());
        }
    }

    /// One click = a new tab launched with the preset (B.10).
    fn presets_menu(&mut self, ui: &mut egui::Ui) {
        let mut pick = None;
        let r = ui.menu_button("Presets", |ui| {
            match &self.presets {
                Err(e) => {
                    ui.colored_label(ui.visuals().error_fg_color, e);
                }
                Ok(list) if list.is_empty() => {
                    ui.weak("Aucun preset. « Modifier les presets… » crée un fichier d'exemple.");
                }
                Ok(list) => {
                    for (i, p) in list.iter().enumerate() {
                        if ui.button(&p.name).on_hover_text(p.args().join(" ")).clicked() {
                            pick = Some(i);
                            ui.close();
                        }
                    }
                }
            }
            ui.separator();
            if ui.button("Modifier les presets…").clicked() {
                if let Err(e) = presets::ensure_file().and_then(|p| open_in_editor(&p)) {
                    self.presets = Err(format!("ouverture de presets.json impossible : {e}"));
                }
                ui.close();
            }
        });
        if r.response.clicked() {
            self.presets = presets::load(&presets::path());
        }
        if let Some(i) = pick
            && let Ok(list) = &self.presets
        {
            let preset = list[i].clone();
            match preset.cwd.clone() {
                Some(dir) => self.ws.open(&dir, Launch::Preset(&preset), waker(ui.ctx())),
                None => self.open_here(Launch::Preset(&preset), ui.ctx()),
            }
        }
    }

    fn tab_strip(&mut self, ui: &mut egui::Ui) {
        egui::Panel::top("tabs").show(ui, |ui| {
            ui.horizontal_wrapped(|ui| {
                let (mut select, mut close) = (None, None);
                for (i, tab) in self.ws.tabs.iter().enumerate() {
                    let (state, color) = status_bar::state_style(tab.t.state, ui.visuals());
                    ui.label(RichText::new("●").color(color)).on_hover_text(state);
                    if ui.selectable_label(i == self.ws.active, tab.title()).clicked() {
                        select = Some(i);
                    }
                    if ui.small_button("×").on_hover_text("Fermer l'onglet (arrête son Pi)").clicked() {
                        close = Some(i);
                    }
                    ui.separator();
                }
                if ui.button("+").on_hover_text("Nouvel onglet dans le même dossier").clicked() {
                    self.open_here(Launch::New, ui.ctx());
                }
                if ui.button("Ouvrir un dossier…").clicked()
                    && let Some(folder) = pick_folder()
                {
                    self.ws.open(&folder, Launch::New, waker(ui.ctx()));
                }
                self.presets_menu(ui);
                self.resume_menu(ui);
                if self.awake.is_on() {
                    ui.weak("Veille bloquée").on_hover_text("Un run est en cours : Windows ne se met pas en veille avant la fin.");
                }
                if let Some(i) = select {
                    self.ws.active = i;
                }
                if let Some(i) = close {
                    self.ws.close(i);
                }
            });
        });
    }
}

impl eframe::App for PierApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        self.ws.update(Instant::now());
        if self.ws.any_approval_pending() {
            ui.ctx().request_repaint_after(Duration::from_secs(1)); // countdown and expiry without input
        }
        self.call_attention(ui.ctx());
        if !self.awake_failed
            && let Err(e) = self.awake.set(self.ws.any_running())
        {
            self.awake_failed = true;
            if let Some(tab) = self.ws.active_tab() {
                tab.t.entries.push(Entry::new(Kind::Error, format!("Impossible d'empêcher la mise en veille : {e}")));
            }
        }

        self.tab_strip(ui);
        if let Some(tab) = self.ws.active_tab() {
            status_bar::show(tab, ui);
            status_bar::footer(tab, ui);
            composer::show(tab, ui);
            approvals::show(tab, ui);
            transcript_view::show(tab, ui);
        } else {
            self.start_screen(ui);
        }

        // After the panels, so a click's answer leaves in the same frame.
        self.ws.flush();
    }
}
