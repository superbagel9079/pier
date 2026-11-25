//! The egui window: draws the workspace (tabs, start screen, menus) and asks the user. No session logic here:
//! that lives in `pier::workspace`, so the interface can be reworked without touching what Pier does.

mod approvals;
mod composer;
mod diff_view;
mod queue_view;
mod resume;
mod status_bar;
mod transcript_view;

use eframe::egui::{self, RichText};
use pier::awake::KeepAwake;
use pier::presets::{self, Preset};
use pier::recent;
use pier::session::state::Attention;
use pier::workspace::{Launch, Workspace};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

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

// shortcut: blocks the window while open (approval deadlines still run), move to a thread if that bothers.
fn pick_folder() -> Option<PathBuf> {
    rfd::FileDialog::new().set_title("Choose the project folder").pick_folder()
}

/// Repaints the window when a tab's Pi sends something.
fn waker(ctx: &egui::Context) -> impl Fn() + Send + Clone + 'static {
    let ctx = ctx.clone();
    move || ctx.request_repaint()
}

/// Windows paints a newly exposed area of the window (while it is being resized, before Pier draws) with the window
/// class brush; winit sets none, so it showed black. Same color as Pier's panels, so the gap does not show.
#[cfg(windows)]
fn window_background(frame: &eframe::Frame, color: egui::Color32) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows_sys::Win32::Graphics::Gdi::CreateSolidBrush;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GCLP_HBRBACKGROUND, SetClassLongPtrW};
    let Ok(handle) = frame.window_handle() else { return };
    let RawWindowHandle::Win32(w) = handle.as_raw() else { return };
    let rgb = u32::from(color.r()) | u32::from(color.g()) << 8 | u32::from(color.b()) << 16; // COLORREF is 0x00BBGGRR
    // SAFETY: plain Win32 calls on Pier's own live window; the brush lives as long as the window class.
    unsafe {
        let brush = CreateSolidBrush(rgb);
        SetClassLongPtrW(w.hwnd.get() as _, GCLP_HBRBACKGROUND, brush as isize);
    }
}

#[cfg(not(windows))]
fn window_background(_frame: &eframe::Frame, _color: egui::Color32) {}

/// The folder's last component, or the whole path for a drive root.
fn folder_name(folder: &Path) -> String {
    folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| folder.display().to_string())
}

/// "5 min ago" style age, coarse on purpose.
fn ago(secs: u64) -> String {
    match secs {
        0..60 => "just now".into(),
        60..3600 => format!("{} min ago", secs / 60),
        3600..86_400 => format!("{} h ago", secs / 3600),
        _ => format!("{} d ago", secs / 86_400),
    }
}

pub struct PierApp {
    ws: Workspace,
    resume: resume::ResumeWindow,
    /// presets.json, read when the Presets menu opens; an error is shown, not hidden.
    presets: Result<Vec<Preset>, String>,
    /// Window title last sent, so it is only re-sent when it changes.
    title: String,
    /// Holds off system sleep while a run is going.
    awake: KeepAwake,
    /// Set once Windows refused the hold: reported once, not retried every frame.
    awake_failed: bool,
    /// The window's own background is set once, on the first frame.
    background_set: bool,
}

impl PierApp {
    pub fn new(pi_args: Vec<String>) -> Self {
        std::thread::spawn(|| pier::checkpoint::prune(&pier::checkpoint::dir(), pier::checkpoint::KEPT_FOR));
        Self {
            ws: Workspace::new(pi_args, recent::path()),
            resume: Default::default(),
            presets: Ok(vec![]),
            title: String::new(),
            awake: KeepAwake::default(),
            awake_failed: false,
            background_set: false,
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
        // While hidden, `focused` keeps its last value: minimized or covered also means "not looking".
        let focused = ctx.input(|i| {
            let v = i.viewport();
            v.focused.unwrap_or(true) && !v.minimized.unwrap_or(false) && !v.occluded.unwrap_or(false)
        });
        if let Some(why) = self.ws.attention(focused) {
            let kind = match why {
                Attention::Approval => egui::UserAttentionType::Critical,
                Attention::RunEnded => egui::UserAttentionType::Informational,
            };
            ctx.send_viewport_cmd(egui::ViewportCommand::RequestUserAttention(kind));
        }
        let waiting = self.ws.waiting_approvals();
        let title = if waiting == 0 { "Pier".to_owned() } else { format!("Pier · {waiting} waiting for approval") };
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
            ui.heading("Choose the project folder");
            ui.weak("Pi will work in this folder. Each tab keeps its own.");
            ui.add_space(12.0);
            if ui.button("Open folder…").clicked() {
                pick = pick_folder();
            }
            if !self.ws.recent.is_empty() {
                ui.add_space(16.0);
                ui.strong("Recent");
                for folder in &self.ws.recent {
                    let name = folder_name(folder);
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

    /// One click opens a new tab launched with the preset.
    fn presets_menu(&mut self, ui: &mut egui::Ui) {
        let mut pick = None;
        let r = ui.menu_button("Presets", |ui| {
            match &self.presets {
                Err(e) => {
                    ui.colored_label(ui.visuals().error_fg_color, e);
                }
                Ok(list) if list.is_empty() => {
                    ui.weak("No presets yet. Edit presets… creates an example file.");
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
            if ui.button("Edit presets…").clicked() {
                if let Err(e) = presets::ensure_file().and_then(|p| open_in_editor(&p)) {
                    self.presets = Err(format!("cannot open presets.json: {e}"));
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
                    let (state, color) = status_bar::state_style(tab.t.state(), ui.visuals());
                    ui.label(RichText::new("●").color(color)).on_hover_text(state);
                    if ui.selectable_label(i == self.ws.active, tab.title()).clicked() {
                        select = Some(i);
                    }
                    if ui.small_button("×").on_hover_text("Close tab (stops its Pi)").clicked() {
                        close = Some(i);
                    }
                    ui.separator();
                }
                if ui.button("+").on_hover_text("New tab in the same folder").clicked() {
                    self.open_here(Launch::New, ui.ctx());
                }
                if ui.button("Open folder…").clicked()
                    && let Some(folder) = pick_folder()
                {
                    self.ws.open(&folder, Launch::New, waker(ui.ctx()));
                }
                self.presets_menu(ui);
                if ui.add_enabled(!self.ws.tabs.is_empty(), egui::Button::new("Resume…")).clicked() {
                    self.resume.open = !self.resume.open;
                    if self.resume.open {
                        self.ws.load_sessions(waker(ui.ctx()));
                    }
                }
                if self.awake.is_on() {
                    ui.weak("Sleep blocked").on_hover_text("A run is in progress: Windows will not sleep until it ends.");
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
    /// Runs before every frame and also while the window is minimized or covered, when `ui` does not run:
    /// Pi's events, deadlines, taskbar alerts, keep-awake and replies to Pi must not wait for the window.
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.ws.update(Instant::now());
        if self.ws.any_approval_pending() {
            ctx.request_repaint_after(Duration::from_secs(1)); // countdown and expiry without input
        }
        self.call_attention(ctx);
        if !self.awake_failed
            && let Err(e) = self.awake.set(self.ws.any_running())
        {
            self.awake_failed = true;
            if let Some(tab) = self.ws.active_tab() {
                tab.t.error(format!("Could not prevent sleep: {e}"));
            }
        }
        self.ws.flush();
    }

    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        if !self.background_set {
            self.background_set = true;
            window_background(frame, ui.visuals().panel_fill);
        }
        self.tab_strip(ui);
        if let Some(tab) = self.ws.active_tab() {
            status_bar::show(tab, ui);
            queue_view::show(tab, ui);
            status_bar::footer(tab, ui);
            composer::show(tab, ui);
            approvals::show(tab, ui);
            transcript_view::show(tab, ui);
        } else {
            self.start_screen(ui);
        }
        if let Some(path) = self.resume.show(&mut self.ws, ui.ctx()) {
            self.open_here(Launch::Resume(&path), ui.ctx());
        }

        // After the panels, so a click's answer leaves in the same frame.
        self.ws.flush();
    }
}
