//! Bottom editor: send a prompt, or steer while a run is going.

use super::PierApp;
use eframe::egui;

pub fn show(app: &mut PierApp, ui: &mut egui::Ui) {
    egui::Panel::bottom("input").show(ui, |ui| {
        ui.horizontal(|ui| {
            let label = if app.t.running { "Steer" } else { "Envoyer" };
            let send = ui.add_enabled(!app.t.exited, egui::Button::new(label)).clicked();
            let edit = ui.add_sized(
                [ui.available_width(), 60.0],
                egui::TextEdit::multiline(&mut app.input).hint_text("Message à Pi (Ctrl+Entrée pour envoyer)"),
            );
            let ctrl_enter = edit.has_focus() && ui.input(|i| i.modifiers.command && i.key_pressed(egui::Key::Enter));
            if (send || ctrl_enter) && !app.t.exited {
                app.submit();
            }
        });
    });
}
