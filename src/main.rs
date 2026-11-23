#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")] // no console window in release

//! Pier: desktop cockpit for Pi. Starts eframe only.
//! Usage: `pier [pi args…]`, e.g. `pier --model openrouter/deepseek/deepseek-v4.1-flash`.

mod app;

fn main() -> eframe::Result {
    let pi_args: Vec<String> = std::env::args().skip(1).collect();
    eframe::run_native("Pier", eframe::NativeOptions::default(), Box::new(move |cc| Ok(Box::new(app::PierApp::new(pi_args, &cc.egui_ctx)))))
}
