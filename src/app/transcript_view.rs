//! Central panel: the streamed transcript.

use eframe::egui;
use pier::session::transcript::Kind;
use pier::workspace::Tab;

pub fn show(tab: &mut Tab, ui: &mut egui::Ui) {
    egui::CentralPanel::default().show(ui, |ui| {
        egui::ScrollArea::vertical().stick_to_bottom(true).auto_shrink(false).show(ui, |ui| {
            for (i, e) in tab.t.entries.iter().enumerate() {
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
    });
}
