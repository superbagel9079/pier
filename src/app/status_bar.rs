//! Top bar (session state, supervision, queued steers, Stop) and footer (extension statuses, last stderr line).

use eframe::egui::containers::menu::{MenuButton, MenuConfig};
use eframe::egui::{self, Color32, PopupCloseBehavior, RichText};
use pier::session::state::State;
use pier::session::transcript::SUPERVISION_KEY;
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
        State::Ready => ("Prêt", v.weak_text_color()),
        State::Running => ("En cours", v.selection.bg_fill),
        State::Blocked => ("Approbation requise", v.warn_fg_color),
        State::Completed => ("Terminé", OK_GREEN),
        State::Stopped => ("Interrompu", v.weak_text_color()),
        State::Failed => ("Échec", v.error_fg_color),
        State::Crashed => ("Pi arrêté", v.error_fg_color),
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
            if tab.t.supervised() {
                ui.label(RichText::new("Supervisé").color(OK_GREEN))
                    .on_hover_text("Chaque outil qui écrit ou exécute attend votre accord.");
            } else if tab.t.state != State::Crashed {
                ui.label(RichText::new("Non supervisé — envoi bloqué").color(ui.visuals().error_fg_color))
                    .on_hover_text("L'extension d'approbation de Pier ne s'est pas encore signalée dans Pi.");
            }

            ui.separator();
            let name = tab.folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| tab.folder.display().to_string());
            ui.label(format!("Dossier : {name}")).on_hover_text(format!(
                "Pi travaille dans {}.\nLes avertissements « hors du dossier » et la liste Reprendre en dépendent.",
                tab.folder.display()
            ));

            ui.separator();
            name_menu(tab, ui);
            model_menu(tab, ui);
            thinking_menu(tab, ui);
            usage(tab, ui);

            if !tab.t.queued.is_empty() {
                ui.separator();
                ui.label(format!("{} message(s) en attente de lecture par Pi", tab.t.queued.len())).on_hover_text(tab.t.queued.join("\n"));
            }

            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.add_enabled(tab.t.state.is_running(), egui::Button::new("Stop")).clicked() {
                    tab.stop();
                }
            });
        });
        ui.add_space(4.0);
    });
}

/// Context-window use and session cost, from Pi's session stats.
fn usage(tab: &Tab, ui: &mut egui::Ui) {
    let Some(stats) = &tab.t.stats else { return };
    ui.separator();
    if let Some(c) = &stats.context_usage {
        let v = ui.visuals();
        let (text, color) = match c.percent {
            Some(p) if p >= CONTEXT_ALERT => (format!("Contexte : {p:.0} %"), v.error_fg_color),
            Some(p) if p >= CONTEXT_WARN => (format!("Contexte : {p:.0} %"), v.warn_fg_color),
            Some(p) if p > 0.0 && p < 1.0 => ("Contexte : < 1 %".to_owned(), v.text_color()), // not "0 %": it is not empty
            Some(p) => (format!("Contexte : {p:.0} %"), v.text_color()),
            None => ("Contexte : ?".to_owned(), v.weak_text_color()), // right after a compaction
        };
        let tokens = c.tokens.map_or_else(|| "?".to_owned(), |t| t.to_string());
        ui.label(RichText::new(text).color(color)).on_hover_text(format!(
            "{tokens} jetons sur {} dans la fenêtre du modèle.\nPi compacte la session quand elle approche de la limite.",
            c.context_window
        ));
    }
    let cost = if stats.cost >= 0.01 { format!("${:.2}", stats.cost) } else { format!("${:.4}", stats.cost) };
    ui.label(cost).on_hover_text("Coût de la session, d'après les tarifs du modèle connus de Pi.");
}

/// Session name: Pi stores it in the session file, so Reprendre and Pi's own /resume show it.
fn name_menu(tab: &mut Tab, ui: &mut egui::Ui) {
    let current = tab.t.session_name.clone().unwrap_or_default();
    let label = if current.is_empty() { "Nommer…".to_owned() } else { format!("Nom : {current}") };
    let config = MenuConfig::new().close_behavior(PopupCloseBehavior::CloseOnClickOutside);
    let draft_id = ui.make_persistent_id("name_draft");
    let (response, inner) = MenuButton::new(label).config(config).ui(ui, |ui| {
        let mut draft: String = ui.data(|d| d.get_temp(draft_id)).unwrap_or_else(|| current.clone());
        let edit = ui.add(egui::TextEdit::singleline(&mut draft).char_limit(NAME_MAX).hint_text("Nom de la session"));
        if draft == current && !edit.has_focus() {
            edit.request_focus(); // type right away after opening
        }
        let enter = edit.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
        let save = ui.add_enabled(!draft.trim().is_empty(), egui::Button::new("Enregistrer")).clicked();
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
    let filter_id = ui.make_persistent_id("model_filter");
    let (response, inner) = MenuButton::new(format!("Modèle : {current}")).config(config).ui(ui, |ui| {
        let mut text: String = ui.data(|d| d.get_temp(filter_id)).unwrap_or_default();
        let search = ui.add(egui::TextEdit::singleline(&mut text).hint_text("Chercher un modèle"));
        if text.is_empty() && !search.has_focus() {
            search.request_focus(); // type right away after opening
        }
        let filter = text.to_lowercase();
        ui.data_mut(|d| d.insert_temp(filter_id, text));
        let mut pick = None;
        egui::ScrollArea::vertical().max_height(320.0).show(ui, |ui| {
            if tab.t.models.is_empty() {
                ui.weak("Chargement de la liste…");
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
    ui.menu_button(format!("Réflexion : {current}"), |ui| {
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
