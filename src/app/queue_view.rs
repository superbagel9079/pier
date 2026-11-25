//! Messages waiting for Pi to read them, under the top bar; Edit queue… takes them back to change, reorder or drop.

use eframe::egui;
use pier::workspace::Tab;

fn kind(after: bool) -> &'static str {
    if after { "after" } else { "steer" }
}

pub fn show(tab: &mut Tab, ui: &mut egui::Ui) {
    if tab.t.queue_draft.is_some() {
        editor(tab, ui);
    } else if !tab.t.queued.is_empty() {
        waiting(tab, ui);
    }
}

fn waiting(tab: &mut Tab, ui: &mut egui::Ui) {
    egui::Panel::top("queue").show(ui, |ui| {
        ui.horizontal(|ui| {
            ui.weak(format!("Waiting for Pi to read ({}):", tab.t.queued.len()));
            let pending = tab.t.queue_edit_pending;
            let mut edit = ui.add_enabled(!pending, egui::Button::new("Edit queue…").small());
            edit = if tab.queued_images {
                edit.on_hover_text("A waiting message has images: editing keeps its text only, the images are lost.")
            } else {
                edit.on_hover_text("Takes them back from Pi: it reads none of them until you send them back.")
            };
            if edit.clicked() {
                tab.edit_queue();
            }
        });
        for item in &tab.t.queued {
            let line = item.text.lines().next().unwrap_or_default();
            ui.add(egui::Label::new(format!("{} · {line}", kind(item.after))).truncate()).on_hover_text(&item.text);
        }
    });
}

fn editor(tab: &mut Tab, ui: &mut egui::Ui) {
    let id = tab.id;
    let (mut send, mut discard) = (false, false);
    egui::Panel::top("queue").show(ui, |ui| {
        ui.weak("Editing the queue: Pi reads none of these until you send them back. Steer: after the current tool calls. After: once Pi is done.");
        let Some(draft) = tab.t.queue_draft.as_mut() else { return };
        let (mut up, mut remove) = (None, None);
        let last = draft.len().saturating_sub(1);
        for (i, item) in draft.iter_mut().enumerate() {
            ui.push_id((id, "queue_item", i), |ui| {
                ui.horizontal(|ui| {
                    if ui.add_enabled(i > 0, egui::Button::new("↑").small()).clicked() {
                        up = Some(i);
                    }
                    if ui.add_enabled(i < last, egui::Button::new("↓").small()).clicked() {
                        up = Some(i + 1);
                    }
                    if ui.small_button("×").on_hover_text("Drop this message").clicked() {
                        remove = Some(i);
                    }
                    ui.selectable_value(&mut item.after, false, "steer");
                    ui.selectable_value(&mut item.after, true, "after");
                    ui.add(egui::TextEdit::multiline(&mut item.text).desired_rows(1).desired_width(f32::INFINITY));
                });
            });
        }
        if let Some(i) = up {
            draft.swap(i - 1, i);
        }
        if let Some(i) = remove {
            draft.remove(i);
        }
        ui.horizontal(|ui| {
            send = ui.button("Send back").clicked();
            discard = ui.button("Discard all").clicked();
        });
    });
    if send {
        tab.send_queue_back();
    } else if discard {
        tab.t.queue_draft = None;
    }
}
