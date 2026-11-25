//! A unified diff drawn line by line: added in green, removed in red, hunk headers in the link color.

use eframe::egui::{self, Color32, RichText};
use pier::session::diff::{LineKind, classify};

const ADDED: Color32 = Color32::from_rgb(90, 170, 90);

/// Scrolls past `max_height`; only the visible lines are laid out, so a long diff costs little per frame.
/// `id`: distinct per diff on screen, so each keeps its own scroll position.
pub fn show(ui: &mut egui::Ui, id: impl egui::AsIdSalt, diff: &str, max_height: f32) {
    let lines = classify(diff);
    let row_height = ui.text_style_height(&egui::TextStyle::Monospace);
    egui::ScrollArea::both().id_salt(id).max_height(max_height).auto_shrink([false, true]).show_rows(
        ui,
        row_height,
        lines.len(),
        |ui, range| {
            let v = ui.visuals().clone();
            for (kind, line) in &lines[range] {
                let text = RichText::new(*line).monospace();
                let text = match kind {
                    LineKind::Added => text.color(ADDED),
                    LineKind::Removed => text.color(v.error_fg_color),
                    LineKind::Hunk => text.color(v.hyperlink_color),
                    LineKind::Header => text.strong(),
                    LineKind::Note => text.color(v.weak_text_color()).italics(),
                    LineKind::Context => text.color(v.text_color()),
                };
                ui.label(text);
            }
        },
    );
}
