#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")] // no console window in release

//! Pier: desktop cockpit for Pi. Starts eframe only.
//! Usage: `pier [pi args…]`, e.g. `pier --model openrouter/deepseek/deepseek-v4.1-flash`.

mod app;

use eframe::Renderer;

fn main() -> eframe::Result {
    let pi_args: Vec<String> = std::env::args().skip(1).collect();
    let run = |renderer| {
        // run_and_return: the event loop survives a failed start, so another renderer can be tried.
        let options = eframe::NativeOptions { renderer, run_and_return: true, ..Default::default() };
        let args = pi_args.clone();
        eframe::run_native("Pier", options, Box::new(move |_cc| Ok(Box::new(app::PierApp::new(args)))))
    };
    // OpenGL uses about 90 MB instead of 220, but it froze a whole PC on window resize (Intel Arc driver),
    // so it is only the fallback, or a choice: PIER_RENDERER=glow.
    if std::env::var("PIER_RENDERER").is_ok_and(|r| r.eq_ignore_ascii_case("glow")) {
        return run(Renderer::Glow);
    }
    // wgpu needs DirectX 12, Vulkan or OpenGL 3.3; older graphics get egui's own OpenGL renderer (2.0 and up).
    run(Renderer::Wgpu).or_else(|e| {
        eprintln!("wgpu renderer failed ({e}); falling back to OpenGL");
        run(Renderer::Glow)
    })
}
