//! A unified diff drawn line by line: added in green, removed in red, hunk headers in the link color.

use eframe::egui::{self, Color32, RichText};
use pier::session::diff::{LineKind, counts, line_kind};

const ADDED: Color32 = Color32::from_rgb(90, 170, 90);

/// `+3 −1`, for a header line or a collapsed section.
pub fn summary(diff: &str) -> String {
    let (added, removed) = counts(diff);
    format!("+{added} −{removed}")
}

/// Scrolls past `max_height`. `id`: distinct per diff on screen, so each keeps its own scroll position.
pub fn show(ui: &mut egui::Ui, id: impl egui::AsIdSalt, diff: &str, max_height: f32) {
    egui::ScrollArea::both().id_salt(id).max_height(max_height).auto_shrink([false, true]).show(ui, |ui| {
        let v = ui.visuals().clone();
        for line in diff.lines() {
            let text = RichText::new(line).monospace();
            let text = match line_kind(line) {
                LineKind::Added => text.color(ADDED),
                LineKind::Removed => text.color(v.error_fg_color),
                LineKind::Hunk => text.color(v.hyperlink_color),
                LineKind::Header => text.strong(),
                LineKind::Note => text.color(v.weak_text_color()).italics(),
                LineKind::Context => text.color(v.text_color()),
            };
            ui.label(text);
        }
    });
}
