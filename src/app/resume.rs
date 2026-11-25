//! Resume window: every session saved for the active folder, searchable, with archiving.

use super::ago;
use eframe::egui;
use pier::workspace::Workspace;
use std::path::PathBuf;

#[derive(Default)]
pub struct ResumeWindow {
    pub open: bool,
    query: String,
    in_messages: bool,
    show_archived: bool,
}

impl ResumeWindow {
    /// Draws the window if open; returns the session the user chose to open.
    pub fn show(&mut self, ws: &mut Workspace, ctx: &egui::Context) -> Option<PathBuf> {
        if !self.open {
            return None;
        }
        // The active tab changed folder: list the new one.
        if ws.browser.folder != ws.active_folder() {
            ws.load_sessions(super::waker(ctx));
        }
        let mut chosen = None;
        let mut open = self.open;
        egui::Window::new("Resume").open(&mut open).default_width(640.0).collapsible(false).show(ctx, |ui| {
            chosen = self.contents(ws, ui);
        });
        self.open = open && chosen.is_none();
        if !self.open {
            ws.browser = Default::default(); // listed again at the next opening
        }
        chosen
    }

    fn contents(&mut self, ws: &mut Workspace, ui: &mut egui::Ui) -> Option<PathBuf> {
        let folder = ws.browser.folder.as_ref().map(|f| f.display().to_string()).unwrap_or_default();
        ui.weak(format!("Sessions saved for {folder}"));
        let mut search_now = false;
        ui.horizontal(|ui| {
            let edit = ui.add(egui::TextEdit::singleline(&mut self.query).hint_text("Search titles").desired_width(260.0));
            search_now |= self.in_messages && edit.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
            search_now |= ui.checkbox(&mut self.in_messages, "Search in messages").changed() && self.in_messages;
            let archived = ws.archive.len();
            ui.checkbox(&mut self.show_archived, format!("Show archived ({archived})"));
        });
        if search_now {
            ws.search_sessions(&self.query, super::waker(ui.ctx()));
        }
        let query = self.query.trim().to_lowercase();
        let found = ws.browser.found.as_ref().filter(|(q, _)| self.in_messages && q.to_lowercase() == query).map(|(_, f)| f);
        if self.in_messages && !query.is_empty() {
            if ws.browser.searching {
                ui.weak("Searching messages…");
            } else if found.is_none() {
                ui.weak("Press Enter to search the messages too.");
            }
        }
        if let Some(e) = &ws.browser.error {
            ui.colored_label(ui.visuals().error_fg_color, e);
        }
        if ws.browser.loading {
            ui.weak("Loading…");
            return None;
        }

        let open_now = ws.open_files();
        let rows: Vec<usize> = (0..ws.browser.sessions.len())
            .filter(|&i| {
                let (s, title) = (&ws.browser.sessions[i].session, &ws.browser.sessions[i].title_lower);
                (self.show_archived || !ws.archive.contains(&s.path))
                    && (query.is_empty() || title.contains(&query) || found.is_some_and(|f| f.contains_key(&s.path)))
            })
            .collect();
        if rows.is_empty() {
            ui.weak(if ws.browser.sessions.is_empty() { "No saved session for this folder." } else { "Nothing matches." });
        }
        let (mut chosen, mut archive) = (None, None);
        let row_height = ui.spacing().interact_size.y + ui.spacing().item_spacing.y;
        egui::ScrollArea::vertical().max_height(420.0).auto_shrink([false, true]).show_rows(ui, row_height, rows.len(), |ui, range| {
            for &i in &rows[range] {
                let (s, canonical) = (&ws.browser.sessions[i].session, &ws.browser.sessions[i].canonical);
                let is_open = canonical.as_ref().is_some_and(|c| open_now.contains(c));
                let archived = ws.archive.contains(&s.path);
                ui.horizontal(|ui| {
                    let b = ui.add_enabled(!is_open, egui::Button::new("Open"));
                    if b.on_disabled_hover_text("Already open in a tab").clicked() {
                        chosen = Some(s.path.clone());
                    }
                    let label = if archived { "Unarchive" } else { "Archive" };
                    if ui.button(label).on_hover_text("Hides it from this list only; Pi's file stays as it is").clicked() {
                        archive = Some((s.path.clone(), !archived));
                    }
                    let when = s.modified.elapsed().map(|d| ago(d.as_secs())).unwrap_or_default();
                    let mut text = format!("{}  ·  {when}  ·  {} KB", s.title, s.bytes.div_ceil(1024));
                    if let Some(excerpt) = found.and_then(|f| f.get(&s.path)) {
                        text.push_str(&format!("  ·  {excerpt}"));
                    }
                    let label = egui::Label::new(if archived { egui::RichText::new(text).weak() } else { text.into() }).truncate();
                    ui.add(label).on_hover_text(s.path.display().to_string());
                });
            }
        });
        if let Some((path, on)) = archive {
            ws.set_archived(&path, on);
        }
        chosen
    }
}
