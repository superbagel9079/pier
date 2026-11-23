//! Top bar (session state, supervision, queued steers, Stop) and footer (extension statuses, last stderr line).

use super::{State, Tab};
use eframe::egui::{self, Color32, RichText};
use pier::session::transcript::SUPERVISION_KEY;

const OK_GREEN: Color32 = Color32::from_rgb(110, 180, 110);

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
