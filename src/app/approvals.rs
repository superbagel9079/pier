//! Approval panel above the editor: the oldest pending tool call, Allow / Deny, countdown.

use super::diff_view;
use eframe::egui;
use pier::session::transcript::ARM_DELAY;
use pier::workspace::Tab;
use std::time::Instant;

pub fn show(tab: &mut Tab, ui: &mut egui::Ui) {
    let Some(a) = tab.t.approvals.front().cloned() else { return };
    let waiting = tab.t.approvals.len() - 1;
    egui::Panel::bottom("approval").show(ui, |ui| {
        ui.add_space(4.0);
        ui.strong(&a.title);
        if let Some(warning) = &a.outside {
            ui.colored_label(ui.visuals().error_fg_color, warning);
        }
        if a.unchecked {
            ui.weak("ℹ Folder not checked for this tool");
        }
        if !a.message.is_empty() {
            // Keyed by the approval: each one opens at its first line, not where the previous one was scrolled.
            egui::ScrollArea::vertical().id_salt(("approval_message", &a.id)).max_height(150.0).show(ui, |ui| ui.monospace(&a.message));
        }
        if let Some(diff) = &a.diff {
            ui.add_space(2.0);
            ui.weak(format!("Planned changes ({}), against the file as it was when asked", diff_view::summary(diff)));
            if a.same_file_pending {
                ui.colored_label(ui.visuals().warn_fg_color, "Another pending change targets this file; this preview does not include it.");
            }
            diff_view::show(ui, ("approval_diff", &a.id), diff, 300.0);
        }
        ui.horizontal(|ui| {
            // Disabled for a moment after a new approval appears, so a click meant for the previous one cannot land here.
            let armed = tab.t.can_answer(Instant::now());
            if !armed {
                ui.ctx().request_repaint_after(ARM_DELAY);
            }
            let allow = ui.add_enabled(armed, egui::Button::new("Allow")).clicked();
            let deny = ui.add_enabled(armed, egui::Button::new("Deny")).clicked();
            if let Some(d) = a.deadline {
                ui.weak(format!("auto-deny in {} s", d.saturating_duration_since(Instant::now()).as_secs()));
            }
            if waiting > 0 {
                ui.weak(format!("· {waiting} more waiting"));
            }
            if allow || deny {
                tab.approve(&a.id, allow);
            }
        });
        ui.add_space(4.0);
    });
}
