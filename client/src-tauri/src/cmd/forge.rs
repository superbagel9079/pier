//! Git forges, the team and Pi's requests: accounts, repositories, tasks, handoffs, merges.

use crate::*;

// --- git forges (Setup > Git) ------------------------------------------------------------

/// Connects a forge account: the token goes on stdin, never on a command line or in a log.
#[tauri::command]
pub(crate) async fn forge_add(app: AppHandle, state: State<'_, AppState>, kind: String, url: String, token: String) -> Result<Value, String> {
    if !["github", "gitlab", "gitea"].contains(&kind.as_str()) {
        return Err(format!("unknown forge: {kind}"));
    }
    api(&app, &state, &["forge-add", &kind, &url], token.trim().as_bytes()).await
}

#[tauri::command]
pub(crate) async fn forge_remove(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<Value, String> {
    api(&app, &state, &["forge-remove", &id], &[]).await
}

/// Connects the project to a repository (owner/name) of a forge account.
#[tauri::command]
pub(crate) async fn repo_link(app: AppHandle, state: State<'_, AppState>, project: String, forge: String, repo: String) -> Result<Value, String> {
    api(&app, &state, &["repo-link", &project, &forge, &repo], &[]).await
}

#[tauri::command]
pub(crate) async fn repo_unlink(app: AppHandle, state: State<'_, AppState>, project: String) -> Result<Value, String> {
    api(&app, &state, &["repo-unlink", &project], &[]).await
}

/// A new repository on the forge, connected to the project (the user's own action).
#[tauri::command]
pub(crate) async fn repo_create(app: AppHandle, state: State<'_, AppState>, project: String, forge: String, name: String, private: bool, description: String) -> Result<Value, String> {
    api(&app, &state, &["repo-create", &project, &forge, &name, if private { "1" } else { "0" }, &description], &[]).await
}

/// What Pi may do alone with the project's repository (local, ask, auto), and how it merges.
#[tauri::command]
pub(crate) async fn repo_settings(app: AppHandle, state: State<'_, AppState>, project: String, mode: String, method: String, agents: String) -> Result<Value, String> {
    if !["local", "ask", "auto"].contains(&mode.as_str()) || !["merge", "squash", "rebase"].contains(&method.as_str())
        || !["", "off", "ask", "auto"].contains(&agents.as_str()) {
        return Err(format!("unknown repository setting: {mode}, {method}, {agents}"));
    }
    api(&app, &state, &["repo-settings", &project, &mode, &method, &agents], &[]).await
}

/// A task for the team's Pis: an issue labelled pi-task (its description on stdin).
#[tauri::command]
pub(crate) async fn task_create(app: AppHandle, state: State<'_, AppState>, project: String, title: String, body: String) -> Result<Value, String> {
    api(&app, &state, &["task-create", &project, &title], body.as_bytes()).await
}

/// A conversation given to a colleague (the user's own act; the note on stdin).
#[tauri::command]
pub(crate) async fn handoff_give(app: AppHandle, state: State<'_, AppState>, project: String, file: String, to: String, note: String) -> Result<Value, String> {
    if !file.ends_with(".jsonl") || to.is_empty() || to.len() > 64 || !to.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
        return Err("a conversation and a colleague's login".into());
    }
    api(&app, &state, &["handoff-give", &project, &file, &to], note.as_bytes()).await
}

/// A colleague's conversation taken over: it lands among this project's conversations.
#[tauri::command]
pub(crate) async fn handoff_take(app: AppHandle, state: State<'_, AppState>, project: String, branch: String) -> Result<Value, String> {
    if !branch.starts_with("pi-handoff/") {
        return Err("not a handoff".into());
    }
    api(&app, &state, &["handoff-take", &project, &branch], &[]).await
}

/// Merges a pull request, from Pier.
#[tauri::command]
pub(crate) async fn pr_merge(app: AppHandle, state: State<'_, AppState>, project: String, number: u64, method: String) -> Result<Value, String> {
    if !["merge", "squash", "rebase"].contains(&method.as_str()) {
        return Err(format!("unknown merge method: {method}"));
    }
    api(&app, &state, &["pr-merge", &project, &number.to_string(), &method], &[]).await
}

/// A Pi's worktree removed (its branch stays).
#[tauri::command]
pub(crate) async fn worktree_remove(app: AppHandle, state: State<'_, AppState>, project: String, name: String) -> Result<Value, String> {
    if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
        return Err(format!("not a worktree: {name}"));
    }
    api(&app, &state, &["worktree-remove", &project, &name], &[]).await
}

/// The user's answer to a request of Pi (merge, create a repository).
#[tauri::command]
pub(crate) async fn approval_answer(app: AppHandle, state: State<'_, AppState>, id: String, approve: bool) -> Result<Value, String> {
    api(&app, &state, &["approval-answer", &id, if approve { "yes" } else { "no" }], &[]).await
}
