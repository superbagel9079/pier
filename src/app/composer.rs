//! Bottom editor: send a prompt, or steer while a run is going. Typing `/` opens a palette of Pi's commands.

use eframe::egui;
use pier::session::state::State;
use pier::session::transcript::PALETTE_MAX;
use pier::workspace::Tab;

pub fn show(tab: &mut Tab, ui: &mut egui::Ui) {
    let editor_id = ui.make_persistent_id(("composer_editor", tab.id));
    let matches = tab.t.matching_commands(&tab.input);
    let total = matches.len();
    let suggestions: Vec<(String, Option<String>)> =
        matches.iter().take(PALETTE_MAX).map(|c| (c.name.clone(), c.description.clone())).collect();
    let mut pick: Option<String> = None;
    // Tab completes the first suggestion; taken before the editor would use the key to move focus.
    if !suggestions.is_empty()
        && ui.memory(|m| m.has_focus(editor_id))
        && ui.input_mut(|i| i.consume_key(egui::Modifiers::NONE, egui::Key::Tab))
    {
        pick = Some(suggestions[0].0.clone());
    }

    egui::Panel::bottom("input").show(ui, |ui| {
        ui.horizontal(|ui| {
            // Fail closed: no prompt reaches Pi before Pier's approval extension has reported in.
            let alive = tab.t.state != State::Crashed && tab.t.supervised();
            let label = if tab.t.state.is_running() { "Steer" } else { "Send" };
            let send = ui.add_enabled(alive, egui::Button::new(label)).clicked();
            let edit = ui.add_sized(
                [ui.available_width(), 60.0],
                egui::TextEdit::multiline(&mut tab.input).id(editor_id).hint_text("Message to Pi (Ctrl+Enter to send, / for commands)"),
            );
            let ctrl_enter = edit.has_focus() && ui.input(|i| i.modifiers.command && i.key_pressed(egui::Key::Enter));
            if (send || ctrl_enter) && alive {
                tab.submit();
            }
        });
    });

    // Drawn after the editor panel, so it sits just above it.
    if !suggestions.is_empty() {
        egui::Panel::bottom("palette").show(ui, |ui| {
            let header = if total > suggestions.len() {
                format!("Pi commands: {} of {total}, type to filter (Tab takes the first)", suggestions.len())
            } else {
                "Pi commands (Tab takes the first)".to_owned()
            };
            ui.weak(header);
            for (name, description) in &suggestions {
                ui.horizontal(|ui| {
                    if ui.button(format!("/{name}")).clicked() {
                        pick = Some(name.clone());
                    }
                    if let Some(d) = description {
                        ui.weak(d);
                    }
                });
            }
        });
    }

    if let Some(name) = pick {
        tab.input = format!("/{name} ");
        // Back to the editor, cursor after the name, ready for arguments.
        if let Some(mut state) = egui::TextEdit::load_state(ui.ctx(), editor_id) {
            let end = egui::text::CCursor::new(tab.input.chars().count());
            state.cursor.set_char_range(Some(egui::text::CCursorRange::one(end)));
            state.store(ui.ctx(), editor_id);
        }
        ui.memory_mut(|m| m.request_focus(editor_id));
    }
}
