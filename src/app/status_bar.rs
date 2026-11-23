//! Top bar (session state, supervision, queued steers, Stop) and footer (extension statuses, last stderr line).

use super::{PierApp, State};
use eframe::egui::{self, Color32, RichText};
use pier::session::transcript::SUPERVISION_KEY;

const OK_GREEN: Color32 = Color32::from_rgb(110, 180, 110);

pub fn show(app: &mut PierApp, ui: &mut egui::Ui) {
    egui::Panel::top("status").show(ui, |ui| {
        ui.add_space(4.0);
        ui.horizontal(|ui| {
            let v = ui.visuals();
            let (label, color) = match app.t.state {
                State::Ready => ("Prêt", v.weak_text_color()),
                State::Running => ("En cours", v.selection.bg_fill),
                State::Blocked => ("Approbation requise", v.warn_fg_color),
                State::Completed => ("Terminé", OK_GREEN),
                State::Stopped => ("Interrompu", v.weak_text_color()),
                State::Failed => ("Échec", v.error_fg_color),
                State::Crashed => ("Pi arrêté", v.error_fg_color),
            };
            ui.label(RichText::new("●").color(color));
            ui.label(RichText::new(label).strong());

            ui.separator();
            if app.t.supervised() {
                ui.label(RichText::new("Supervisé").color(OK_GREEN))
                    .on_hover_text("Chaque outil qui écrit ou exécute attend votre accord.");
            } else if app.t.state != State::Crashed {
                ui.label(RichText::new("Non supervisé — envoi bloqué").color(ui.visuals().error_fg_color))
                    .on_hover_text("L'extension d'approbation de Pier ne s'est pas encore signalée dans Pi.");
            }

            if !app.t.queued.is_empty() {
                ui.separator();
                ui.label(format!("{} message(s) en attente de lecture par Pi", app.t.queued.len())).on_hover_text(app.t.queued.join("\n"));
            }

            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.add_enabled(app.t.state.is_running(), egui::Button::new("Stop")).clicked() {
                    app.stop();
                }
            });
        });
        ui.add_space(4.0);
    });
}

/// Extension statuses belong to the user's Pi setup, not to Pier: shown small, out of the way.
pub fn footer(app: &PierApp, ui: &mut egui::Ui) {
    let statuses: Vec<&str> = app.t.status.iter().filter(|(k, _)| *k != SUPERVISION_KEY).map(|(_, v)| v.as_str()).collect();
    if statuses.is_empty() && app.t.stderr.is_empty() {
        return;
    }
    egui::Panel::bottom("footer").show(ui, |ui| {
        ui.horizontal(|ui| {
            ui.label(RichText::new(statuses.join("    ")).small().weak());
            if let Some(last) = app.t.stderr.last() {
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.add(egui::Label::new(RichText::new(last).small().weak()).truncate()).on_hover_text(app.t.stderr.join("\n"));
                });
            }
        });
    });
}
