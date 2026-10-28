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
pub(crate) async fn repo_create(
    app: AppHandle,
    state: State<'_, AppState>,
    project: String,
    forge: String,
    name: String,
    private: bool,
    description: String,
) -> Result<Value, String> {
    api(&app, &state, &["repo-create", &project, &forge, &name, if private { "1" } else { "0" }, &description], &[]).await
}

/// What Pi may do alone with the project's repository (local, ask, auto), and how it merges.
#[tauri::command]
pub(crate) async fn repo_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    project: String,
    mode: String,
    method: String,
    agents: String,
) -> Result<Value, String> {
    if !["local", "ask", "auto"].contains(&mode.as_str())
        || !["merge", "squash", "rebase"].contains(&method.as_str())
        || !["", "off", "ask", "auto"].contains(&agents.as_str())
    {
        return Err(format!("unknown repository setting: {mode}, {method}, {agents}"));
    }
    // Pi merging by itself, or Pis starting by themselves: confirmed when newly asked.
    if mode == "auto" || agents == "auto" {
        let now = api(&app, &state, &["repo", &project], &[]).await.unwrap_or(Value::Null);
        let link = now.get("link").cloned().unwrap_or(Value::Null);
        let was = |key: &str| link.get(key).and_then(Value::as_str).unwrap_or("").to_string();
        if mode == "auto" && was("mode") != "auto" && !confirmed(&app, "Let Pi merge its own pull requests by itself, once their checks pass?").await {
            return Err("not changed: merges still wait for you".into());
        }
        if agents == "auto" && was("agents") != "auto" && !confirmed(&app, "Let Pier start a Pi by itself on each new task or review asked of you?").await {
            return Err("not changed".into());
        }
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

/// What a colleague's handoff holds, read before taking it (nothing is copied).
#[tauri::command]
pub(crate) async fn handoff_peek(app: AppHandle, state: State<'_, AppState>, project: String, branch: String) -> Result<Value, String> {
    if !branch.starts_with("pi-handoff/") {
        return Err("not a handoff".into());
    }
    api(&app, &state, &["handoff-peek", &project, &branch], &[]).await
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
    if approve {
        // Asked again in Pier's own dialog, with the request as the picker holds it (not
        // as the page drew it): a script in the page cannot approve on its own.
        let pending = api(&app, &state, &["approvals"], &[]).await?;
        let request = pending
            .get("approvals")
            .and_then(Value::as_array)
            .and_then(|all| all.iter().find(|a| a.get("id").and_then(Value::as_str) == Some(id.as_str())))
            .cloned()
            .ok_or("that request is no longer waiting")?;
        if !confirmed(&app, &format!("Approve what Pi asks?\n\n{}", approval_text(&request))).await {
            return Err("not approved: the request still waits".into());
        }
    }
    api(&app, &state, &["approval-answer", &id, if approve { "yes" } else { "no" }], &[]).await
}

/// A request of Pi in plain words, for the confirmation: what will be done, whole enough
/// to be checked (a command up to 1,500 characters; invisible characters shown).
fn approval_text(request: &Value) -> String {
    let args = request.get("args").cloned().unwrap_or(Value::Null);
    let text = |key: &str| args.get(key).map(|v| v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string())).unwrap_or_default();
    let kind = request.get("kind").and_then(Value::as_str).unwrap_or("?");
    let said = match kind {
        "merge" => format!("Merge pull request #{} \"{}\" of {}, at commit {}.", text("number"), text("title"), text("repo"), text("sha")),
        "review" => format!("Post a review of #{} ({}) on {}.", text("number"), text("verdict"), text("repo")),
        "create_repo" => format!("Create the repository {} on {}.", text("name"), text("account")),
        "lab" if text("op") == "lab_run" => format!("Run on {}:\n\n{}", text("machine"), text("command").chars().take(1500).collect::<String>()),
        "lab" => format!("{} on {}: {}", text("op"), text("machine"), text("path")),
        other => format!("{other}: {}", args.to_string().chars().take(1500).collect::<String>()),
    };
    shown(&said)
}

/// Characters that could hide or turn text around (bidi marks, zero-width ones) written
/// as their code, as the page does (visibleText).
fn shown(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{061C}' | '\u{FEFF}' => format!("<U+{:04X}>", c as u32),
            c if c.is_control() && c != '\n' && c != '\t' => format!("<U+{:04X}>", c as u32),
            c => c.to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_in_plain_words() {
        let run = json!({"kind": "lab", "args": {"op": "lab_run", "machine": "box", "command": "ls\u{202E}txt.exe"}});
        assert_eq!(approval_text(&run), "Run on box:\n\nls<U+202E>txt.exe");
        let merge = json!({"kind": "merge", "args": {"number": 4, "title": "Fix", "repo": "a/b", "sha": "abc"}});
        assert_eq!(approval_text(&merge), "Merge pull request #4 \"Fix\" of a/b, at commit abc.");
    }
}
