//! Top bar (session state, supervision, queued steers, Stop) and footer (extension statuses, last stderr line).

use super::{State, Tab};
use eframe::egui::containers::menu::{MenuButton, MenuConfig};
use eframe::egui::{self, Color32, PopupCloseBehavior, RichText};
use pier::pi::protocol::Command;
use pier::session::transcript::SUPERVISION_KEY;

const OK_GREEN: Color32 = Color32::from_rgb(110, 180, 110);
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
            model_menu(tab, ui);
            thinking_menu(tab, ui);

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

/// Current model; the menu lists Pi's models (asked when it opens) with a search box, since providers can have hundreds.
fn model_menu(tab: &mut Tab, ui: &mut egui::Ui) {
    let current = tab.t.model.as_ref().map(|m| m.name.clone().unwrap_or_else(|| m.id.clone())).unwrap_or_else(|| "?".into());
    // Default menus close on any click inside, which made the search box unusable.
    let config = MenuConfig::new().close_behavior(PopupCloseBehavior::CloseOnClickOutside);
    let (response, inner) = MenuButton::new(format!("Modèle : {current}")).config(config).ui(ui, |ui| {
        let search = ui.add(egui::TextEdit::singleline(&mut tab.model_filter).hint_text("Chercher un modèle"));
        if tab.model_filter.is_empty() && !search.has_focus() {
            search.request_focus(); // type right away after opening
        }
        let filter = tab.model_filter.to_lowercase();
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
        tab.send(Command::GetAvailableModels);
    }
    if let Some(Some(m)) = inner.map(|r| r.inner) {
        tab.send(Command::SetModel { provider: m.provider, model_id: m.id });
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
        tab.send(Command::SetThinkingLevel { level });
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
