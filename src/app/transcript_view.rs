//! Central panel: the streamed transcript. Only the entries on screen are laid out, so a long session costs no more
//! memory or time per frame than a short one.

use super::diff_view;
use eframe::egui;
use pier::session::transcript::{Entry, Kind};
use pier::workspace::Tab;

/// Height of each entry as last drawn at `width`; entries not drawn yet are estimated.
#[derive(Clone, Default)]
struct Heights {
    width: f32,
    rows: Vec<f32>,
}

/// A first guess from the text length, corrected once the entry is drawn.
fn estimate(e: &Entry, row: f32, chars_per_line: usize) -> f32 {
    let lines: usize = e.text.lines().map(|l| l.chars().count().div_ceil(chars_per_line).max(1)).sum::<usize>().max(1);
    match e.kind {
        Kind::Thinking => row,
        Kind::Tool if e.diff.is_some() => row * 2.0,
        Kind::User => row * lines as f32 + 6.0,
        _ => row * lines as f32,
    }
}

pub fn show(tab: &mut Tab, ui: &mut egui::Ui) {
    egui::CentralPanel::default().show(ui, |ui| {
        // The checkpoint whose Restore was clicked, waiting for the user to confirm.
        let confirm_id = ui.make_persistent_id(("restore_confirm", tab.id));
        let mut confirming: Option<String> = ui.data(|d| d.get_temp(confirm_id));
        let mut restore = None;
        let can_restore = tab.can_restore();

        let heights_id = ui.make_persistent_id(("transcript_heights", tab.id));
        let mut heights: Heights = ui.data_mut(|d| std::mem::take(d.get_temp_mut_or_default::<Heights>(heights_id)));
        let width = ui.available_width();
        if (heights.width - width).abs() > 0.5 {
            heights = Heights { width, rows: Vec::new() }; // wrapping changed: every height is stale
        }
        let entries = &tab.t.entries;
        heights.rows.truncate(entries.len()); // a fork starts the transcript over
        let row = ui.text_style_height(&egui::TextStyle::Body) + ui.spacing().item_spacing.y;
        let chars_per_line = ((width / (row * 0.5)) as usize).max(20);
        let known = heights.rows.len();
        heights.rows.extend(entries[known..].iter().map(|e| estimate(e, row, chars_per_line)));

        // Per tab: its own scroll position and unfolded sections.
        egui::ScrollArea::vertical().id_salt(("transcript", tab.id)).stick_to_bottom(true).auto_shrink(false).show_viewport(
            ui,
            |ui, viewport| {
                let mut y = 0.0;
                let mut i = 0;
                while i < entries.len() && y + heights.rows[i] < viewport.min.y {
                    y += heights.rows[i];
                    i += 1;
                }
                ui.add_space(y);
                while i < entries.len() && y < viewport.max.y {
                    let top = ui.cursor().top();
                    entry(ui, tab.id, i, &entries[i], can_restore, &mut confirming, &mut restore);
                    heights.rows[i] = ui.cursor().top() - top;
                    y += heights.rows[i];
                    i += 1;
                }
                ui.add_space(heights.rows[i..].iter().sum());
            },
        );
        ui.data_mut(|d| {
            d.insert_temp(heights_id, heights);
            match &confirming {
                Some(c) => {
                    d.insert_temp(confirm_id, c.clone());
                }
                None => d.remove::<String>(confirm_id),
            }
        });
        if let Some(id) = restore {
            tab.restore(&id);
        }
    });
}

fn entry(
    ui: &mut egui::Ui,
    tab_id: u64,
    i: usize,
    e: &Entry,
    can_restore: bool,
    confirming: &mut Option<String>,
    restore: &mut Option<String>,
) {
    // Every "Thinking" header has the same title; the index keeps their ids distinct.
    ui.push_id((tab_id, i), |ui| match e.kind {
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
                let (added, removed) = e.diff_counts;
                ui.collapsing(format!("Show diff (+{added} −{removed})"), |ui| {
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
                    *confirming = Some(id.clone());
                }
            });
            if confirming.as_ref() == Some(id) {
                ui.horizontal(|ui| {
                    ui.label("Put the folder's files back as they were here? Files created since are deleted. You can undo.");
                    if ui.add_enabled(can_restore, egui::Button::new("Restore")).clicked() {
                        *restore = Some(id.clone());
                        *confirming = None;
                    }
                    if ui.button("Cancel").clicked() {
                        *confirming = None;
                    }
                });
            }
        }
    });
}
