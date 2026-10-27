//! Setup: restore points, skills, extensions and prompts, Pi's texts.

use crate::*;

// --- restore points -----------------------------------------------------------------

/// Saves the project now, as a restore point named by the user.
#[tauri::command]
pub(crate) async fn checkpoint_create(app: AppHandle, state: State<'_, AppState>, project: String, label: String) -> Result<Value, String> {
    api(&app, &state, &["checkpoint", &project, &label], &[]).await
}

/// Puts the project back as it was at a restore point: all of it, or `files`.
#[tauri::command]
pub(crate) async fn checkpoint_restore(app: AppHandle, state: State<'_, AppState>, project: String, id: String, files: Vec<String>) -> Result<Value, String> {
    // The files, one per line on stdin: hundreds of them would not fit on a command line.
    if files.iter().any(|f| f.contains('\n')) {
        return Err("a file name with a line break cannot be restored one by one".into());
    }
    let list = files.join("\n");
    let args = if files.is_empty() { vec!["restore", project.as_str(), id.as_str()] } else { vec!["restore", project.as_str(), id.as_str(), "-"] };
    api(&app, &state, &args, list.as_bytes()).await
}

// --- skills, extensions, prompts (Setup) -----------------------------------------------

pub(crate) fn resource_scope(scope: &str) -> Result<(), String> {
    if scope == "user" || scope == "project" { Ok(()) } else { Err(format!("unknown scope: {scope}")) }
}

/// Turns a skill, an extension or a prompt on or off, as `pi config` does.
#[tauri::command]
pub(crate) async fn resource_toggle(app: AppHandle, state: State<'_, AppState>, scope: String, project: String, kind: String, source: String, rel: String, on: bool) -> Result<Value, String> {
    resource_scope(&scope)?;
    if !["skills", "extensions", "prompts"].contains(&kind.as_str()) {
        return Err(format!("unknown kind: {kind}"));
    }
    api(&app, &state, &["toggle-resource", &scope, &project, &kind, &source, &rel, if on { "1" } else { "0" }], &[]).await
}

/// A new local skill, from a template.
#[tauri::command]
pub(crate) async fn skill_create(app: AppHandle, state: State<'_, AppState>, scope: String, project: String, name: String, description: String) -> Result<Value, String> {
    resource_scope(&scope)?;
    api(&app, &state, &["skill-new", &scope, &project, &name, &description], &[]).await
}

/// A local skill's SKILL.md, saved.
#[tauri::command]
pub(crate) async fn skill_save(app: AppHandle, state: State<'_, AppState>, scope: String, project: String, name: String, text: String) -> Result<Value, String> {
    resource_scope(&scope)?;
    api(&app, &state, &["skill-write", &scope, &project, &name], text.as_bytes()).await
}

/// A local skill, moved to the picker's bin on the VM.
#[tauri::command]
pub(crate) async fn skill_delete(app: AppHandle, state: State<'_, AppState>, scope: String, project: String, name: String) -> Result<Value, String> {
    resource_scope(&scope)?;
    api(&app, &state, &["skill-delete", &scope, &project, &name], &[]).await
}

/// Largest skill folder sent from this computer.
pub(crate) const SKILL_MAX_BYTES: u64 = 20 * 1024 * 1024;

/// A skill folder of this computer (it holds a SKILL.md), copied into the skills.
#[tauri::command]
pub(crate) async fn skill_import(app: AppHandle, state: State<'_, AppState>, scope: String, project: String, path: String) -> Result<Value, String> {
    resource_scope(&scope)?;
    let root = PathBuf::from(&path);
    if !root.join("SKILL.md").is_file() {
        return Err(format!("{path} holds no SKILL.md: it is not a skill folder"));
    }
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "skill".into());
    let packed = tokio::task::spawn_blocking(move || copy::tar_folder(&root, SKILL_MAX_BYTES, copy::Pack::Copy))
        .await
        .map_err(|e| e.to_string())?
        .map_err(message)?;
    api(&app, &state, &["skill-import", &scope, &project, &name], &packed.0).await
}

/// Saves one of the project's texts for Pi: "instructions" (AGENTS.md), "append"
/// (.pi/APPEND_SYSTEM.md) or "system" (.pi/SYSTEM.md). The picker keeps the previous
/// version in the project's history.
#[tauri::command]
pub(crate) async fn write_text(app: AppHandle, state: State<'_, AppState>, project: String, which: String, text: String) -> Result<Value, String> {
    api(&app, &state, &["write-text", &project, &which], text.as_bytes()).await
}
