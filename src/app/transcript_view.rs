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
        let shown_id = ui.make_persistent_id("transcript_shown");
        let mut shown: usize = ui.data(|d| d.get_temp(shown_id)).unwrap_or(VISIBLE_STEP);
        let total = tab.t.entries.len();
        let first = total.saturating_sub(shown);
        egui::ScrollArea::vertical().stick_to_bottom(true).auto_shrink(false).show(ui, |ui| {
            if first > 0 && ui.button(format!("Afficher les messages précédents ({first} masqués)")).clicked() {
                shown += VISIBLE_STEP;
            }
            for (i, e) in tab.t.entries.iter().enumerate().skip(first) {
                // Every "Réflexion" header has the same title; the index keeps their ids distinct.
                ui.push_id(i, |ui| match e.kind {
                    Kind::User => {
                        ui.add_space(6.0);
                        ui.strong(format!("Vous : {}", e.text));
                    }
                    Kind::Assistant => {
                        ui.label(&e.text);
                    }
                    Kind::Thinking => {
                        ui.collapsing("Réflexion", |ui| ui.weak(&e.text));
                    }
                    Kind::Tool => {
                        ui.monospace(&e.text);
                        if let Some(diff) = &e.diff {
                            ui.collapsing(format!("Voir le diff ({})", diff_view::summary(diff)), |ui| {
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
                });
            }
        });
        ui.data_mut(|d| d.insert_temp(shown_id, shown));
    });
}
