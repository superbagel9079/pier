//! Bottom editor: send a prompt, or steer while a run is going.

use eframe::egui;
use pier::session::state::State;
use pier::workspace::Tab;

pub fn show(tab: &mut Tab, ui: &mut egui::Ui) {
    egui::Panel::bottom("input").show(ui, |ui| {
        ui.horizontal(|ui| {
            // Fail closed: no prompt reaches Pi before Pier's approval extension has reported in.
            let alive = tab.t.state != State::Crashed && tab.t.supervised();
            let label = if tab.t.state.is_running() { "Steer" } else { "Envoyer" };
            let send = ui.add_enabled(alive, egui::Button::new(label)).clicked();
            let edit = ui.add_sized(
                [ui.available_width(), 60.0],
                egui::TextEdit::multiline(&mut tab.input).hint_text("Message à Pi (Ctrl+Entrée pour envoyer)"),
            );
            let ctrl_enter = edit.has_focus() && ui.input(|i| i.modifiers.command && i.key_pressed(egui::Key::Enter));
            if (send || ctrl_enter) && alive {
                tab.submit();
            }
        });
    });
}
