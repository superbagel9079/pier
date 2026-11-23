//! Approval panel above the editor: the oldest pending tool call, Autoriser / Refuser, countdown.

use super::Tab;
use eframe::egui;
use std::time::Instant;

pub fn show(tab: &mut Tab, ui: &mut egui::Ui) {
    let Some(a) = tab.t.approvals.front().cloned() else { return };
    let waiting = tab.t.approvals.len() - 1;
    egui::Panel::bottom("approval").show(ui, |ui| {
        ui.add_space(4.0);
        ui.strong(&a.title);
        if !a.message.is_empty() {
            egui::ScrollArea::vertical().max_height(150.0).show(ui, |ui| ui.monospace(&a.message));
        }
        ui.horizontal(|ui| {
            let allow = ui.button("Autoriser").clicked();
            let deny = ui.button("Refuser").clicked();
            if let Some(d) = a.deadline {
                ui.weak(format!("refus automatique dans {} s", d.saturating_duration_since(Instant::now()).as_secs()));
            }
            if waiting > 0 {
                ui.weak(format!("· {waiting} autre(s) en attente"));
            }
            if allow {
                tab.t.answer(true);
            } else if deny {
                tab.t.answer(false);
            }
        });
        ui.add_space(4.0);
    });
}
