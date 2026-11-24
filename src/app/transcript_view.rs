//! Central panel: the streamed transcript.

use super::diff_view;
use eframe::egui;
use pier::session::transcript::Kind;
use pier::workspace::Tab;

/// Entries laid out per frame; older ones are behind a button, so a long session does not slow every repaint.
const VISIBLE_STEP: usize = 300;

pub fn show(tab: &mut Tab, ui: &mut egui::Ui) {
    egui::CentralPanel::default().show(ui, |ui| {
        // How many recent entries to show: pure UI state, kept in egui's memory.
        let shown_id = ui.make_persistent_id(("transcript_shown", tab.id));
        let mut shown: usize = ui.data(|d| d.get_temp(shown_id)).unwrap_or(VISIBLE_STEP);
        let total = tab.t.entries.len();
        let first = total.saturating_sub(shown);
        // The checkpoint whose Restore was clicked, waiting for the user to confirm.
        let confirm_id = ui.make_persistent_id(("restore_confirm", tab.id));
        let mut confirming: Option<String> = ui.data(|d| d.get_temp(confirm_id));
        let mut restore = None;
        let can_restore = tab.can_restore();
        // Per tab: its own scroll position and unfolded sections.
        egui::ScrollArea::vertical().id_salt(("transcript", tab.id)).stick_to_bottom(true).auto_shrink(false).show(ui, |ui| {
            if first > 0 && ui.button(format!("Show earlier messages ({first} hidden)")).clicked() {
                shown += VISIBLE_STEP;
            }
            for (i, e) in tab.t.entries.iter().enumerate().skip(first) {
                // Every "Thinking" header has the same title; the index keeps their ids distinct.
                ui.push_id((tab.id, i), |ui| match e.kind {
                    Kind::User => {
                        ui.add_space(6.0);
                        ui.strong(format!("You: {}", e.text));
                    }
                    Kind::Assistant => {
                        ui.label(&e.text);
                    }
                    Kind::Thinking => {
                        ui.collapsing("Thinking", |ui| ui.weak(&e.text));
                    }
                    Kind::Tool => {
                        ui.monospace(&e.text);
                        if let Some(diff) = &e.diff {
                            ui.collapsing(format!("Show diff ({})", diff_view::summary(diff)), |ui| {
                                diff_view::show(ui, ("entry_diff", i), diff, 400.0);
                            });
                        }
                    }
                    Kind::Notice => {
                        ui.weak(&e.text);
                    }
                    Kind::Error => {
                        ui.colored_label(ui.visuals().error_fg_color, &e.text);
                    }
                    Kind::Checkpoint => {
                        let Some(id) = &e.checkpoint else { return };
                        ui.horizontal(|ui| {
                            ui.weak(format!("⟲ {}", e.text));
                            let button = ui.add_enabled(can_restore, egui::Button::new("Restore files…").small());
                            if button.on_disabled_hover_text("Available once the run has ended").clicked() {
                                confirming = Some(id.clone());
                            }
                        });
                        if confirming.as_ref() == Some(id) {
                            ui.horizontal(|ui| {
                                ui.label("Put the folder's files back as they were here? Files created since are deleted. You can undo.");
                                if ui.add_enabled(can_restore, egui::Button::new("Restore")).clicked() {
                                    restore = Some(id.clone());
                                    confirming = None;
                                }
                                if ui.button("Cancel").clicked() {
                                    confirming = None;
                                }
                            });
                        }
                    }
                });
            }
        });
        ui.data_mut(|d| d.insert_temp(shown_id, shown));
        ui.data_mut(|d| match &confirming {
            Some(c) => {
                d.insert_temp(confirm_id, c.clone());
            }
            None => d.remove::<String>(confirm_id),
        });
        if let Some(id) = restore {
            tab.restore(&id);
        }
    });
}
