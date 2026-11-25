//! Bottom editor: send a prompt, or steer while a run is going. Typing `/` opens a palette of Pi's commands, `@` one
//! of the project's files. Images come by pasting (Ctrl+V), dropping a file on the window, or Attach image….

use eframe::egui;
use pier::attach::Image;
use pier::session::state::State;
use pier::session::transcript::PALETTE_MAX;
use pier::workspace::Tab;

/// What a palette line puts in the editor.
enum Pick {
    Command(String),
    File(String),
}

pub fn show(tab: &mut Tab, ui: &mut egui::Ui) {
    take_images(tab, ui);
    let editor_id = ui.make_persistent_id(("composer_editor", tab.id));

    // One palette at a time: commands while the editor starts with `/`, files while it ends with `@partial`.
    let commands = tab.t.matching_commands(&tab.input);
    let (header, lines): (String, Vec<(String, Option<String>, Pick)>) = if !commands.is_empty() {
        let total = commands.len();
        let lines: Vec<_> = commands
            .iter()
            .take(PALETTE_MAX)
            .map(|c| (format!("/{}", c.name), c.description.clone(), Pick::Command(c.name.clone())))
            .collect();
        let header = if total > lines.len() {
            format!("Pi commands: {} of {total}, type to filter (Tab takes the first)", lines.len())
        } else {
            "Pi commands (Tab takes the first)".to_owned()
        };
        (header, lines)
    } else if let Some((files, total)) = tab.file_suggestions(PALETTE_MAX) {
        let header = match total {
            0 => "No matching file (ignored files are not listed)".to_owned(),
            t if t > files.len() => format!("Files: {} of {t}, type to filter (Tab takes the first)", files.len()),
            _ => "Files (Tab takes the first)".to_owned(),
        };
        (header, files.into_iter().map(|f| (f.clone(), None, Pick::File(f))).collect())
    } else {
        (String::new(), vec![])
    };

    let mut pick: Option<Pick> = None;
    // Tab completes the first suggestion; taken before the editor would use the key to move focus.
    if let Some((_, _, first)) = lines.first()
        && ui.memory(|m| m.has_focus(editor_id))
        && ui.input_mut(|i| i.consume_key(egui::Modifiers::NONE, egui::Key::Tab))
    {
        pick = Some(match first {
            Pick::Command(n) => Pick::Command(n.clone()),
            Pick::File(f) => Pick::File(f.clone()),
        });
    }

    egui::Panel::bottom("input").show(ui, |ui| {
        attachments(tab, ui);
        ui.horizontal(|ui| {
            // Fail closed: no prompt reaches Pi before Pier's approval extension has reported in.
            let alive = tab.t.state != State::Crashed && tab.t.supervised();
            let label = if tab.t.state.is_running() { "Steer" } else { "Send" };
            let send =
                ui.add_enabled(alive, egui::Button::new(label)).on_hover_text("Steer: Pi reads it after the current tool calls").clicked();
            let after = tab.t.state.is_running()
                && ui
                    .add_enabled(alive, egui::Button::new("Queue for after"))
                    .on_hover_text("Pi reads it once it is done with everything else")
                    .clicked();
            let edit = ui.add_sized(
                [ui.available_width(), 60.0],
                egui::TextEdit::multiline(&mut tab.input)
                    .id(editor_id)
                    .hint_text("Message to Pi (Ctrl+Enter to send, / for commands, @ for files, Ctrl+V or drop for images)"),
            );
            let ctrl_enter = edit.has_focus() && ui.input(|i| i.modifiers.command && i.key_pressed(egui::Key::Enter));
            if (send || ctrl_enter) && alive {
                tab.submit();
            } else if after && alive {
                tab.queue_after();
            }
        });
    });

    // Drawn after the editor panel, so it sits just above it.
    if !header.is_empty() {
        egui::Panel::bottom("palette").show(ui, |ui| {
            ui.weak(&header);
            for (label, description, p) in &lines {
                ui.horizontal(|ui| {
                    if ui.button(label).clicked() {
                        pick = Some(match p {
                            Pick::Command(n) => Pick::Command(n.clone()),
                            Pick::File(f) => Pick::File(f.clone()),
                        });
                    }
                    if let Some(d) = description {
                        ui.weak(d);
                    }
                });
            }
        });
    }

    if let Some(p) = pick {
        match p {
            Pick::Command(name) => tab.input = format!("/{name} "),
            Pick::File(path) => tab.mention(&path),
        }
        // Back to the editor, cursor at the end, ready to go on typing.
        if let Some(mut state) = egui::TextEdit::load_state(ui.ctx(), editor_id) {
            let end = egui::text::CCursor::new(tab.input.chars().count());
            state.cursor.set_char_range(Some(egui::text::CCursorRange::one(end)));
            state.store(ui.ctx(), editor_id);
        }
        ui.memory_mut(|m| m.request_focus(editor_id));
    }
}

/// Images pasted (Ctrl+V of a screenshot) or files dropped on the window go to the active tab's next message.
fn take_images(tab: &mut Tab, ui: &egui::Ui) {
    let (pasted, dropped) = ui.input(|i| {
        let pasted: Vec<_> = i
            .events
            .iter()
            .filter_map(|e| match e {
                egui::Event::PasteImage(img) => Some(img.clone()),
                _ => None,
            })
            .collect();
        (pasted, i.raw.dropped_files.iter().map(|f| f.path().to_path_buf()).collect::<Vec<_>>())
    });
    for img in pasted {
        // egui keeps premultiplied colors; PNG wants them straight.
        let rgba: Vec<u8> = img.pixels.iter().flat_map(|c| c.to_srgba_unmultiplied()).collect();
        tab.attach(Image::from_rgba(img.size[0] as u32, img.size[1] as u32, &rgba));
    }
    for path in dropped {
        tab.attach(Image::from_file(&path));
    }
}

/// The images waiting to be sent, each removable, and a button to add one from a file.
fn attachments(tab: &mut Tab, ui: &mut egui::Ui) {
    ui.horizontal_wrapped(|ui| {
        let mut remove = None;
        for (i, img) in tab.images.iter().enumerate() {
            let kb = img.data.len().div_ceil(1024);
            ui.label(format!("🖼 {} ({kb} KB)", img.name));
            if ui.small_button("×").on_hover_text("Remove this image").clicked() {
                remove = Some(i);
            }
            ui.separator();
        }
        if let Some(i) = remove {
            tab.images.remove(i);
        }
        if ui.small_button("Attach image…").clicked() {
            // shortcut: blocks the window while open, like the folder picker.
            let picked = rfd::FileDialog::new().add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp"]).pick_files();
            for path in picked.unwrap_or_default() {
                tab.attach(Image::from_file(&path));
            }
        }
    });
}
