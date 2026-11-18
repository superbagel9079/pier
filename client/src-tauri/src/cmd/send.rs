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

/// An image of this computer the user dropped or picked (granted), for its thumbnail in a
/// message: its bytes as they are, nothing else is read.
#[tauri::command]
pub(crate) fn image_preview(state: State<'_, AppState>, path: String) -> Result<tauri::ipc::Response, String> {
    let file = given_path(&state, &path)?;
    let size = std::fs::metadata(&file).map_err(|e| format!("{path}: {e}"))?.len();
    if size > IMAGE_MAX_BYTES {
        return Err(format!("{path}: larger than 20 MB"));
    }
    let bytes = std::fs::read(&file).map_err(|e| format!("{path}: {e}"))?;
    if !is_image(&bytes) {
        return Err(format!("{path}: not an image"));
    }
    Ok(tauri::ipc::Response::new(bytes))
}

/// Files dropped on the window: images go to .pi-images, anything else to .pi-files.
#[tauri::command]
pub(crate) async fn paste_files(app: AppHandle, state: State<'_, AppState>, paths: Vec<String>, target: String) -> Result<Vec<Value>, String> {
    let mut results = Vec::new();
    for path in paths {
        if let Err(error) = given_path(&state, &path) {
            results.push(json!({ "error": error }));
            continue;
        }
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

/// The paths of files and folders copied in the file manager, for a Ctrl+V in the window.
#[tauri::command]
pub(crate) fn clipboard_paths(state: State<'_, AppState>) -> Vec<String> {
    let paths = clip::clipboard_paths();
    for path in &paths {
        state.grants.grant(std::path::Path::new(path)); // copied by the user, read here
    }
    paths
}

/// A dialog opened by Pier itself, so that what it gives is known to be the user's
/// choice (grants.rs): one folder, or files, or where to save.
async fn picked(builder: tauri_plugin_dialog::FileDialogBuilder<tauri::Wry>, kind: &str) -> Vec<std::path::PathBuf> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    match kind {
        "folder" => builder.pick_folder(move |p| {
            let _ = tx.send(p.into_iter().collect::<Vec<_>>());
        }),
        "files" => builder.pick_files(move |p| {
            let _ = tx.send(p.unwrap_or_default());
        }),
        _ => builder.save_file(move |p| {
            let _ = tx.send(p.into_iter().collect::<Vec<_>>());
        }),
    }
    rx.await.unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()).collect()
}

#[tauri::command]
pub(crate) async fn pick_folder(app: AppHandle, state: State<'_, AppState>, title: Option<String>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let builder = app.dialog().file().set_title(title.unwrap_or_else(|| "Folder to share with the VM".into()));
    let chosen = picked(builder, "folder").await;
    chosen.iter().for_each(|p| state.grants.grant(p));
    Ok(chosen.first().map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
pub(crate) async fn pick_files(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let chosen = picked(app.dialog().file().set_title("Files to send to Pi"), "files").await;
    chosen.iter().for_each(|p| state.grants.grant(p));
    Ok(chosen.iter().map(|p| p.to_string_lossy().into_owned()).collect())
}

#[tauri::command]
pub(crate) async fn pick_save_path(app: AppHandle, state: State<'_, AppState>, name: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let builder = app.dialog().file().set_title("Save the report").set_file_name(&name).add_filter("Text", &["txt"]);
    let chosen = picked(builder, "save").await;
    chosen.iter().for_each(|p| state.grants.grant_save(p));
    Ok(chosen.first().map(|p| p.to_string_lossy().into_owned()))
}

/// Copies a folder of this computer into the project (.pi-files), as a snapshot Pi can
/// change freely: the original is not touched.
#[tauri::command]
pub(crate) async fn copy_folder(app: AppHandle, state: State<'_, AppState>, path: String, target: String) -> Result<Value, String> {
    let root = given_path(&state, &path)?;
    if !root.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "folder".into());
    let started = Instant::now();
    let packed = copy::TempArchive::pack(root, COPY_MAX_BYTES, copy::Pack::Copy).await.map_err(|e| {
        let text = message(e);
        log_warn!("copy.refused", path = path, err = text);
        text
    })?;
    log_info!("copy.packed", path = path, bytes = packed.bytes, ms = started.elapsed().as_millis());
    api_from(&app, &state, &["upload-dir", &name, &target], packed.open().await?, packed.bytes).await
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
