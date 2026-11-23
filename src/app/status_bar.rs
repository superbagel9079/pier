//! Top bar: session state, queued steers, extension statuses, last stderr line, Stop.

use super::PierApp;
use eframe::egui;

pub fn show(app: &mut PierApp, ui: &mut egui::Ui) {
    egui::Panel::top("status").show(ui, |ui| {
        ui.horizontal(|ui| {
            let state = match (app.t.exited, app.t.running) {
                (true, _) => "Arrêté",
                (false, true) => "En cours",
                (false, false) => "Prêt",
            };
            ui.strong(state);
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
                if ui.add_enabled(app.t.running, egui::Button::new("Stop")).clicked() {
                    app.stop();
                }
            });
        });
    });
}
