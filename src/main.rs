#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")] // no console window in release

//! Pier spike: one tab, one `pi --mode rpc`, streamed transcript, steer and stop.
//! Usage: `pier [pi args…]`, e.g. `pier --model openrouter/deepseek/deepseek-v4.1-flash`.

mod rpc;

use eframe::egui;
use rpc::{Kind, Process, Transcript};
use serde_json::json;

struct PierApp {
    proc: Option<Process>,
    t: Transcript,
    input: String,
}

impl PierApp {
    fn send(&mut self, cmd: serde_json::Value) {
        let err = match self.proc.as_mut() {
            Some(p) => p.send(cmd).err().map(|e| e.to_string()),
            None => Some("pas de process Pi".into()),
        };
        if let Some(e) = err {
            self.t.entries.push(rpc::Entry { kind: Kind::Error, text: format!("Envoi impossible : {e}") });
        }
    }

    fn submit(&mut self) {
        let text = self.input.trim().to_owned();
        if text.is_empty() {
            return;
        }
        // While a run is going, Pi requires a streamingBehavior; steer lands after the current turn.
        let cmd = if self.t.running {
            json!({"type": "prompt", "message": text, "streamingBehavior": "steer"})
        } else {
            json!({"type": "prompt", "message": text})
        };
        self.send(cmd);
        self.input.clear();
    }

    /// Like Pi's Esc: take queued messages back (they return to the editor), then abort.
    fn stop(&mut self) {
        self.send(json!({"type": "clear_queue"}));
        self.send(json!({"type": "abort"}));
    }
}

impl eframe::App for PierApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        if let Some(p) = &self.proc {
            while let Ok(msg) = p.rx.try_recv() {
                self.t.apply(msg);
            }
        }
        for reply in std::mem::take(&mut self.t.outbox) {
            self.send(reply);
        }
        if !self.t.restored.is_empty() {
            let back = std::mem::take(&mut self.t.restored).join("\n");
            self.input = if self.input.is_empty() { back } else { format!("{back}\n{}", self.input) };
        }

        egui::Panel::top("status").show(ui, |ui| {
            ui.horizontal(|ui| {
                let state = match (self.t.exited, self.t.running) {
                    (true, _) => "Arrêté",
                    (false, true) => "En cours",
                    (false, false) => "Prêt",
                };
                ui.strong(state);
                if !self.t.queued.is_empty() {
                    ui.label(format!("· {} en attente de lecture par Pi", self.t.queued.len()))
                        .on_hover_text(self.t.queued.join("\n"));
                }
                for text in self.t.status.values() {
                    ui.label(format!("· {text}"));
                }
                if let Some(last) = self.t.stderr.last() {
                    ui.weak(format!("· {last}")).on_hover_text(self.t.stderr.join("\n"));
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.add_enabled(self.t.running, egui::Button::new("Stop")).clicked() {
                        self.stop();
                    }
                });
            });
        });

        egui::Panel::bottom("input").show(ui, |ui| {
            ui.horizontal(|ui| {
                let label = if self.t.running { "Steer" } else { "Envoyer" };
                let send = ui.add_enabled(!self.t.exited, egui::Button::new(label)).clicked();
                let edit = ui.add_sized(
                    [ui.available_width(), 60.0],
                    egui::TextEdit::multiline(&mut self.input).hint_text("Message à Pi (Ctrl+Entrée pour envoyer)"),
                );
                let ctrl_enter = edit.has_focus() && ui.input(|i| i.modifiers.command && i.key_pressed(egui::Key::Enter));
                if (send || ctrl_enter) && !self.t.exited {
                    self.submit();
                }
            });
        });

        egui::CentralPanel::default().show(ui, |ui| {
            egui::ScrollArea::vertical().stick_to_bottom(true).auto_shrink(false).show(ui, |ui| {
                for (i, e) in self.t.entries.iter().enumerate() {
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
}

fn main() -> eframe::Result {
    let pi_args: Vec<String> = std::env::args().skip(1).collect();
    eframe::run_native(
        "Pier",
        eframe::NativeOptions::default(),
        Box::new(move |cc| {
            let ctx = cc.egui_ctx.clone();
            let mut t = Transcript::default();
            let proc = Process::spawn(&pi_args, move || ctx.request_repaint())
                .map_err(|e| t.entries.push(rpc::Entry { kind: Kind::Error, text: format!("Lancement de Pi impossible : {e}") }))
                .ok();
            if proc.is_none() {
                t.exited = true;
            }
            Ok(Box::new(PierApp { proc, t, input: String::new() }))
        }),
    )
}
