//! Top bar (session state, supervision, model, Stop) and footer (extension statuses, last stderr line).

use eframe::egui::containers::menu::{MenuButton, MenuConfig};
use eframe::egui::{self, Color32, PopupCloseBehavior, RichText};
use pier::session::state::State;
use pier::session::transcript::{MODES, SUPERVISION_KEY};
use pier::workspace::{NAME_MAX, Tab};

const OK_GREEN: Color32 = Color32::from_rgb(110, 180, 110);
/// Context-window use (percent) from which the gauge turns orange, then red.
const CONTEXT_WARN: f64 = 80.0;
const CONTEXT_ALERT: f64 = 95.0;
/// Enough to scan; the search box narrows the rest.
const MODEL_LIST_MAX: usize = 200;

/// Label and color of a session state, shared by the top bar and the tab strip.
pub fn state_style(state: State, v: &egui::Visuals) -> (&'static str, Color32) {
    match state {
        State::Ready => ("Ready", v.weak_text_color()),
        State::Running => ("Running", v.selection.bg_fill),
        State::Blocked => ("Approval needed", v.warn_fg_color),
        State::Completed => ("Done", OK_GREEN),
        State::Stopped => ("Stopped", v.weak_text_color()),
        State::Failed => ("Failed", v.error_fg_color),
        State::Crashed => ("Pi exited", v.error_fg_color),
    }
}

pub fn show(tab: &mut Tab, ui: &mut egui::Ui) {
    egui::Panel::top("status").show(ui, |ui| {
        ui.add_space(4.0);
        ui.horizontal(|ui| {
            let (label, color) = state_style(tab.t.state, ui.visuals());
            ui.label(RichText::new("●").color(color));
            ui.label(RichText::new(label).strong());

            ui.separator();
            if let Some(mode) = tab.mode().map(str::to_owned) {
                mode_menu(tab, ui, &mode);
            } else if tab.t.state != State::Crashed {
                ui.label(RichText::new("Not supervised — sending blocked").color(ui.visuals().error_fg_color))
                    .on_hover_text("Pier's approval extension has not reported in yet.");
            }

            ui.separator();
            let name = tab.folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| tab.folder.display().to_string());
            ui.label(format!("Folder: {name}"))
                .on_hover_text(format!("Pi works in {}.\nOutside-folder warnings and the Resume list depend on it.", tab.folder.display()));

            ui.separator();
            name_menu(tab, ui);
            model_menu(tab, ui);
            thinking_menu(tab, ui);
            fork_menu(tab, ui);
            usage(tab, ui);

            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.add_enabled(tab.t.state.is_running(), egui::Button::new("Stop")).clicked() {
                    tab.stop();
                }
            });
        });
        ui.add_space(4.0);
    });
}

/// The permission mode Pier's extension reports, and the menu to switch it (applied at once, even during a run).
fn mode_menu(tab: &mut Tab, ui: &mut egui::Ui, current: &str) {
    let color = if current == MODES[0].1 { OK_GREEN } else { ui.visuals().warn_fg_color };
    let mut pick = None;
    ui.menu_button(RichText::new(current).color(color), |ui| {
        let help = [
            "Every tool that writes or runs waits for your approval.",
            "write and edit inside the folder pass without asking; outside it, and commands, still ask.",
            "Read-only: everything that writes or runs is refused without asking.",
        ];
        for ((key, label), help) in MODES.iter().zip(help) {
            if ui.selectable_label(*label == current, *label).on_hover_text(help).clicked() {
                pick = Some(*key);
                ui.close();
            }
        }
        ui.weak("Back to Supervised in every new tab and after a fork.");
        ui.separator();
        let edit = ui.button("Edit allowed commands…").on_hover_text(
            "Commands that run without asking (except in Plan): a single command starting with an entry, inside the folder, nothing risky.",
        );
        if edit.clicked() {
            let opened =
                pier::allowlist::ensure_file(&pier::allowlist::path()).and_then(|p| super::open_in_editor(&p).map_err(|e| e.to_string()));
            if let Err(e) = opened {
                tab.t.entries.push(pier::session::transcript::Entry::new(
                    pier::session::transcript::Kind::Error,
                    format!("Cannot open the allowlist: {e}"),
                ));
            }
            ui.close();
        }
    })
    .response
    .on_hover_text("Permission mode of this tab");
    if let Some(key) = pick {
        tab.set_mode(key);
    }
}

/// Context-window use and session cost, from Pi's session stats.
fn usage(tab: &Tab, ui: &mut egui::Ui) {
    let Some(stats) = &tab.t.stats else { return };
    ui.separator();
    if let Some(c) = &stats.context_usage {
        let v = ui.visuals();
        let (text, color) = match c.percent {
            Some(p) if p >= CONTEXT_ALERT => (format!("Context: {p:.0}%"), v.error_fg_color),
            Some(p) if p >= CONTEXT_WARN => (format!("Context: {p:.0}%"), v.warn_fg_color),
            Some(p) if p > 0.0 && p < 1.0 => ("Context: < 1%".to_owned(), v.text_color()), // not "0%": it is not empty
            Some(p) => (format!("Context: {p:.0}%"), v.text_color()),
            None => ("Context: ?".to_owned(), v.weak_text_color()), // right after a compaction
        };
        let tokens = c.tokens.map_or_else(|| "?".to_owned(), |t| t.to_string());
        ui.label(RichText::new(text).color(color)).on_hover_text(format!(
            "{tokens} of {} tokens in the model's window.\nPi compacts the session as it nears the limit.",
            c.context_window
        ));
    }
    let cost = if stats.cost >= 0.01 { format!("${:.2}", stats.cost) } else { format!("${:.4}", stats.cost) };
    ui.label(cost).on_hover_text("Session cost, from the model prices Pi knows.");
}

/// Session name: Pi stores it in the session file, so Resume and Pi's own /resume show it.
fn name_menu(tab: &mut Tab, ui: &mut egui::Ui) {
    let current = tab.t.session_name.clone().unwrap_or_default();
    let label = if current.is_empty() { "Name…".to_owned() } else { format!("Name: {current}") };
    let config = MenuConfig::new().close_behavior(PopupCloseBehavior::CloseOnClickOutside);
    let draft_id = ui.make_persistent_id(("name_draft", tab.id));
    let (response, inner) = MenuButton::new(label).config(config).ui(ui, |ui| {
        let mut draft: String = ui.data(|d| d.get_temp(draft_id)).unwrap_or_else(|| current.clone());
        let edit = ui.add(egui::TextEdit::singleline(&mut draft).char_limit(NAME_MAX).hint_text("Session name"));
        if draft == current && !edit.has_focus() {
            edit.request_focus(); // type right away after opening
        }
        let enter = edit.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
        let save = ui.add_enabled(!draft.trim().is_empty(), egui::Button::new("Save")).clicked();
        ui.data_mut(|d| d.insert_temp(draft_id, draft.clone()));
        ((save || enter) && !draft.trim().is_empty()).then(|| {
            ui.close();
            draft
        })
    });
    if response.clicked() {
        ui.data_mut(|d| d.insert_temp(draft_id, current)); // each opening starts from the current name
    }
    if let Some(Some(name)) = inner.map(|r| r.inner) {
        tab.rename(&name);
    }
}

/// Current model; the menu lists Pi's models (asked when it opens) with a search box, since providers can have hundreds.
fn model_menu(tab: &mut Tab, ui: &mut egui::Ui) {
    let current = tab.t.model.as_ref().map(|m| m.name.clone().unwrap_or_else(|| m.id.clone())).unwrap_or_else(|| "?".into());
    // Default menus close on any click inside, which made the search box unusable.
    let config = MenuConfig::new().close_behavior(PopupCloseBehavior::CloseOnClickOutside);
    // The search text is pure UI state: kept in egui's memory, not in the tab.
    let filter_id = ui.make_persistent_id(("model_filter", tab.id));
    let (response, inner) = MenuButton::new(format!("Model: {current}")).config(config).ui(ui, |ui| {
        let mut text: String = ui.data(|d| d.get_temp(filter_id)).unwrap_or_default();
        let search = ui.add(egui::TextEdit::singleline(&mut text).hint_text("Search models"));
        if text.is_empty() && !search.has_focus() {
            search.request_focus(); // type right away after opening
        }
        let filter = text.to_lowercase();
        ui.data_mut(|d| d.insert_temp(filter_id, text));
        let mut pick = None;
        egui::ScrollArea::vertical().max_height(320.0).show(ui, |ui| {
            if tab.t.models.is_empty() {
                ui.weak("Loading the list…");
            }
            let current = tab.t.model.as_ref().map(|m| m.key());
            for m in tab.t.models.iter().filter(|m| m.key().to_lowercase().contains(&filter)).take(MODEL_LIST_MAX) {
                if ui.selectable_label(current.as_deref() == Some(&m.key()), m.key()).clicked() {
                    pick = Some(m.clone());
                    ui.close();
                }
            }
        });
        pick
    });
    if response.clicked() {
        tab.refresh_models();
    }
    if let Some(Some(m)) = inner.map(|r| r.inner) {
        tab.set_model(&m);
    }
}

/// Thinking level, limited to what the current model accepts; hidden for models without reasoning.
fn thinking_menu(tab: &mut Tab, ui: &mut egui::Ui) {
    if tab.t.thinking_levels.len() < 2 {
        return;
    }
    let current = tab.t.thinking.clone().unwrap_or_else(|| "?".into());
    let mut pick = None;
    ui.menu_button(format!("Thinking: {current}"), |ui| {
        for level in &tab.t.thinking_levels {
            if ui.selectable_label(*level == current, level).clicked() {
                pick = Some(level.clone());
                ui.close();
            }
        }
    });
    if let Some(level) = pick {
        tab.set_thinking(&level);
    }
}

/// Your earlier messages (asked from Pi when the menu opens); picking one forks the session from just before it.
fn fork_menu(tab: &mut Tab, ui: &mut egui::Ui) {
    const PREVIEW_CHARS: usize = 60;
    if tab.busy() {
        ui.add_enabled(false, egui::Button::new("Fork from…")).on_disabled_hover_text("Available once the run has ended");
        return;
    }
    let (response, inner) = MenuButton::new("Fork from…").ui(ui, |ui| {
        ui.weak("A new session goes on from just before the message you pick;\nits text comes back to the editor. This session stays in Resume.");
        ui.separator();
        if tab.t.fork_messages.is_empty() {
            ui.weak("No earlier message (or loading…).");
        }
        let mut pick = None;
        let checkpoints = tab.checkpoints_by_message();
        egui::ScrollArea::vertical().max_height(320.0).show(ui, |ui| {
            for m in tab.t.fork_messages.iter().rev() {
                let first_line = m.text.lines().next().unwrap_or_default();
                let mut preview: String = first_line.chars().take(PREVIEW_CHARS).collect();
                if preview.len() < m.text.len() {
                    preview.push('…');
                }
                let checkpoint = checkpoints.get(m.text.trim()).map(|c| c.to_string());
                ui.horizontal(|ui| {
                    if ui.button("Fork").clicked() {
                        pick = Some((m.entry_id.clone(), None));
                    }
                    let restore = ui
                        .add_enabled(checkpoint.is_some(), egui::Button::new("Fork + restore files"))
                        .on_hover_text("Also put the folder's files back as they were before this message (can be undone)")
                        .on_disabled_hover_text("No checkpoint for this message");
                    if restore.clicked() {
                        pick = Some((m.entry_id.clone(), checkpoint.clone()));
                    }
                    ui.label(preview).on_hover_text(&m.text);
                });
            }
        });
        if pick.is_some() {
            ui.close();
        }
        pick
    });
    if response.clicked() {
        tab.refresh_fork_messages();
    }
    if let Some(Some((entry_id, restore))) = inner.map(|r| r.inner) {
        tab.fork(&entry_id, restore);
    }
}

/// Extension statuses belong to the user's Pi setup, not to Pier: shown small, out of the way.
pub fn footer(tab: &Tab, ui: &mut egui::Ui) {
    let statuses: Vec<&str> = tab.t.status.iter().filter(|(k, _)| *k != SUPERVISION_KEY).map(|(_, v)| v.as_str()).collect();
    if statuses.is_empty() && tab.t.stderr.is_empty() {
        return;
    }
    egui::Panel::bottom("footer").show(ui, |ui| {
        ui.horizontal(|ui| {
            ui.label(RichText::new(statuses.join("    ")).small().weak());
            if let Some(last) = tab.t.stderr.last() {
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.add(egui::Label::new(RichText::new(last).small().weak()).truncate()).on_hover_text(tab.t.stderr.join("\n"));
                });
            }
        });
    });
}
