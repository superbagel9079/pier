//! Top bar: session state, queued steers, extension statuses, last stderr line, Stop.

use super::{PierApp, State};
use eframe::egui;

pub fn show(app: &mut PierApp, ui: &mut egui::Ui) {
    egui::Panel::top("status").show(ui, |ui| {
        ui.horizontal(|ui| {
            let state = match app.t.state {
                State::Ready => "Prêt",
                State::Running => "En cours",
                State::Blocked => "Approbation requise",
                State::Completed => "Terminé",
                State::Stopped => "Interrompu",
                State::Failed => "Échec",
                State::Crashed => "Pi arrêté",
            };
            ui.strong(state);
            if !app.t.supervised() && app.t.state != State::Crashed {
                ui.colored_label(ui.visuals().error_fg_color, "· Non supervisé (envoi bloqué)")
                    .on_hover_text("L'extension d'approbation de Pier ne s'est pas encore signalée dans Pi.");
            }
            if !app.t.queued.is_empty() {
                ui.label(format!("· {} en attente de lecture par Pi", app.t.queued.len())).on_hover_text(app.t.queued.join("\n"));
            }
            for text in app.t.status.values() {
                ui.label(format!("· {text}"));
            }
            if let Some(last) = app.t.stderr.last() {
                ui.weak(format!("· {last}")).on_hover_text(app.t.stderr.join("\n"));
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.add_enabled(app.t.state.is_running(), egui::Button::new("Stop")).clicked() {
                    app.stop();
                }
            });
        });
    });
}
