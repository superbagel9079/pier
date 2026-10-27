//! Sending to Pi: pasted images and files, text typed in, folders copied.

use crate::*;

// --- sending to Pi -----------------------------------------------------------------

/// Image pasted in the window: raw bytes in the body, target project in a header.
#[tauri::command]
pub(crate) async fn paste_image(app: AppHandle, state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("missing image".into());
    };
    send_image(&app, &state, bytes, &header(&request, "x-target")).await
}

/// Files dropped on the window: images go to .pi-images, anything else to .pi-files.
#[tauri::command]
pub(crate) async fn paste_files(app: AppHandle, state: State<'_, AppState>, paths: Vec<String>, target: String) -> Result<Vec<Value>, String> {
    let mut results = Vec::new();
    for path in paths {
        let result = send_path(&app, &state, &path, &target).await;
        results.push(result.unwrap_or_else(|error| json!({ "error": error })));
    }
    Ok(results)
}

pub(crate) async fn send_path(app: &AppHandle, state: &AppState, path: &str, target: &str) -> Result<Value, String> {
    let meta = std::fs::metadata(path).map_err(|e| {
        log_warn!("send.unreadable", path = path, err = e);
        format!("{path}: {e}")
    })?;
    if meta.is_dir() {
        // Folders are not sent without asking: the interface offers to share or copy.
        return Ok(json!({ "folder": path }));
    }
    if meta.len() > FILE_MAX_BYTES {
        log_info!("send.too-big", path = path, bytes = meta.len());
        return Err(format!("{path}: larger than 50 MB"));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    if is_image(&bytes) && meta.len() <= IMAGE_MAX_BYTES {
        return send_image(app, state, &bytes, target).await;
    }
    let name = PathBuf::from(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    api(app, state, &["paste-file", &name, target], &bytes).await
}

pub(crate) fn is_image(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(b"\xff\xd8\xff")
        || bytes.starts_with(b"GIF87a")
        || bytes.starts_with(b"GIF89a")
        || (bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP")
}

pub(crate) async fn send_image(app: &AppHandle, state: &AppState, bytes: &[u8], target: &str) -> Result<Value, String> {
    let mut args = vec!["paste-image"];
    if !target.is_empty() {
        args.push(target);
    }
    api(app, state, &args, bytes).await
}

/// Ctrl+Alt+V anywhere: the clipboard's image, or the files copied in the file
/// manager, go to the Pi in use. Copied folders are handed to the window, which asks.
pub(crate) async fn send_clipboard(app: AppHandle) {
    let state = app.state::<AppState>();
    let results: Vec<Value> = match clip::clipboard_png() {
        Ok(png) => {
            log_info!("clipboard.image", bytes = png.len());
            vec![send_image(&app, &state, &png, "").await.unwrap_or_else(|e| json!({ "error": e }))]
        }
        Err(_) => {
            let paths = clip::clipboard_paths();
            log_info!("clipboard.paths", count = paths.len());
            if paths.is_empty() {
                vec![json!({ "error": "The clipboard holds no image, file or folder." })]
            } else {
                let mut results = Vec::new();
                for path in paths {
                    results.push(send_path(&app, &state, &path, "").await.unwrap_or_else(|e| json!({ "error": e })));
                }
                results
            }
        }
    };
    let sent = results.iter().filter(|r| r.get("reference").is_some()).count();
    if sent > 0 {
        let label = results.iter().find_map(|r| r.get("label").and_then(Value::as_str)).unwrap_or("?");
        set_tooltip(&app, &format!("Pier · {sent} item(s) sent to {label}"));
    }
    if results.iter().any(|r| r.get("error").is_some() || r.get("folder").is_some()) {
        show_window(&app);
    }
    let _ = app.emit("clipboard-sent", results);
}

/// The paths of files and folders copied in the file manager, for a Ctrl+V in the window.
#[tauri::command]
pub(crate) fn clipboard_paths() -> Vec<String> {
    clip::clipboard_paths()
}

/// Copies a folder of this computer into the project (.pi-files), as a snapshot Pi can
/// change freely: the original is not touched.
#[tauri::command]
pub(crate) async fn copy_folder(app: AppHandle, state: State<'_, AppState>, path: String, target: String) -> Result<Value, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "folder".into());
    let started = Instant::now();
    let packed = tokio::task::spawn_blocking(move || copy::tar_folder(&root, COPY_MAX_BYTES, copy::Pack::Copy))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| {
            let text = message(e);
            log_warn!("copy.refused", path = path, err = text);
            text
        })?;
    log_info!("copy.packed", path = path, bytes = packed.0.len(), ms = started.elapsed().as_millis());
    api(&app, &state, &["upload-dir", &name, &target], &packed.0).await
}

/// Deletes every image, file and folder copy given to a project.
#[tauri::command]
pub(crate) async fn clear_project(app: AppHandle, state: State<'_, AppState>, project: String) -> Result<Value, String> {
    api(&app, &state, &["clear", &project], &[]).await
}

/// Deletes a file sent earlier. The picker only allows files in .pi-images and .pi-files.
#[tauri::command]
pub(crate) async fn remove_upload(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<Value, String> {
    api(&app, &state, &["remove", &path], &[]).await
}

/// Turns Ctrl+Alt+V on or off, from the preferences.
#[tauri::command]
pub(crate) fn set_paste_shortcut(app: AppHandle, enabled: bool) -> Result<(), String> {
    let shortcut = paste_shortcut();
    let shortcuts = app.global_shortcut();
    let registered = shortcuts.is_registered(shortcut);
    let outcome = match (enabled, registered) {
        (true, false) => shortcuts.register(shortcut),
        (false, true) => shortcuts.unregister(shortcut),
        _ => Ok(()),
    };
    match &outcome {
        Ok(()) => log_debug!("shortcut.set", enabled = enabled),
        Err(err) => log_warn!("shortcut.unavailable", enabled = enabled, err = err),
    }
    outcome.map_err(|e| format!("Ctrl+Alt+V: {e}"))
}

/// Whether Ctrl+Alt+V is Pier's right now: false when off, or taken by another program.
#[tauri::command]
pub(crate) fn shortcut_status(app: AppHandle) -> bool {
    app.global_shortcut().is_registered(paste_shortcut())
}

pub(crate) fn paste_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyV)
}
