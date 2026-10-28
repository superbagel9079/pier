//! Labs, lab hosts and machines.

use crate::*;

/// Labs on or off, and their limits (JSON, checked by the picker).
#[tauri::command]
pub(crate) async fn labs_settings(app: AppHandle, state: State<'_, AppState>, settings: String) -> Result<Value, String> {
    api(&app, &state, &["labs-settings"], settings.as_bytes()).await
}

/// A lab made (for a project, or none), reset to its clean state, or destroyed.
#[tauri::command]
pub(crate) async fn lab_action(app: AppHandle, state: State<'_, AppState>, action: String, name: String, extra: String) -> Result<Value, String> {
    if !["create", "reset", "destroy"].contains(&action.as_str()) || !["", "vm"].contains(&extra.as_str()) || (action != "create" && !lab_name(&name)) {
        return Err("unsupported lab action".into());
    }
    api(&app, &state, &["lab-action", &action, &name, &extra], &[]).await
}

/// A machine Pi may use over SSH (the picker makes the key), removed, or tried.
#[tauri::command]
pub(crate) async fn machine_add(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    host: String,
    port: u16,
    user: String,
    policy: String,
    description: String,
) -> Result<Value, String> {
    if !lab_name(&name) || !["ask", "auto"].contains(&policy.as_str()) {
        return Err("a machine's name, and ask or auto".into());
    }
    if policy == "auto" && !confirmed(&app, &format!("Let Pi run any command on {user}@{host} without asking you?")).await {
        return Err("not added: keep it set to ask".into());
    }
    api(&app, &state, &["machine-add", &name, &host, &port.to_string(), &user, &policy], description.as_bytes()).await
}

/// A lab of the user's own, named (or "lab-N") and described.
#[tauri::command]
pub(crate) async fn lab_new(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    vm: bool,
    description: String,
    networks: Option<Vec<String>>,
    host: Option<String>,
) -> Result<Value, String> {
    if !name.is_empty() && !lab_name(&name) {
        return Err("a lab's name: lowercase letters, digits and '-', starting with a letter".into());
    }
    // The networks, null for the default, and the host, null for the default one: the picker
    // checks them against the lab hosts and what their Incus allows.
    let wanted = json!({ "description": description, "networks": networks, "host": host }).to_string();
    api(&app, &state, &["lab-new", &name, if vm { "vm" } else { "" }], wanted.as_bytes()).await
}

/// Another VM where labs are made (Incus there, the picker's key authorized).
#[tauri::command]
pub(crate) async fn host_add(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    host: String,
    port: u16,
    user: String,
    description: String,
) -> Result<Value, String> {
    if !lab_name(&name) {
        return Err("a lab host's name: lowercase letters, digits and '-', starting with a letter".into());
    }
    api(&app, &state, &["host-add", &name, &host, &port.to_string(), &user], description.as_bytes()).await
}

/// Pi's own VM used as a lab host, or no longer.
#[tauri::command]
pub(crate) async fn host_local(app: AppHandle, state: State<'_, AppState>, on: bool, description: String) -> Result<Value, String> {
    api(&app, &state, &["host-local", if on { "1" } else { "0" }], description.as_bytes()).await
}

#[tauri::command]
pub(crate) async fn host_remove(app: AppHandle, state: State<'_, AppState>, name: String) -> Result<Value, String> {
    api(&app, &state, &["host-remove", &name], &[]).await
}

#[tauri::command]
pub(crate) async fn host_test(app: AppHandle, state: State<'_, AppState>, name: String) -> Result<Value, String> {
    api(&app, &state, &["host-test", &name], &[]).await
}

/// Before the first connection to a lab host or machine: the key it shows, confirmed by
/// the user in a dialog of Pier's own (the page cannot answer it), then trusted. Already
/// trusted: nothing asked. {"known": fingerprint} or {"refused": true}.
#[tauri::command]
pub(crate) async fn host_trust(app: AppHandle, state: State<'_, AppState>, name: String) -> Result<Value, String> {
    let key = api(&app, &state, &["host-key", &name], &[]).await?;
    if key.get("known").is_some() {
        return Ok(key);
    }
    let fingerprint = key.get("fingerprint").and_then(Value::as_str).ok_or("the host showed no key")?.to_string();
    let host = key.get("host").and_then(Value::as_str).unwrap_or(&name);
    let port = key.get("port").and_then(Value::as_u64).unwrap_or(22);
    let text = format!(
        "First connection to {host}:{port} ({name}). Its key's fingerprint is:\n\n{fingerprint}\n\n\
         Compare it with the host's own (on it: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub). Trust this key?"
    );
    if !confirmed(&app, &text).await {
        return Ok(json!({ "refused": true }));
    }
    api(&app, &state, &["host-trust", &name, &fingerprint], &[]).await
}

/// What a network is for, in the user's words: Pi reads it in lab_list.
#[tauri::command]
pub(crate) async fn lab_network_describe(app: AppHandle, state: State<'_, AppState>, name: String, description: String) -> Result<Value, String> {
    api(&app, &state, &["lab-network-describe", &name], description.as_bytes()).await
}

/// A lab or machine renamed, its description changed.
#[tauri::command]
pub(crate) async fn lab_edit(app: AppHandle, state: State<'_, AppState>, name: String, new_name: String, description: String) -> Result<Value, String> {
    if !lab_name(&name) || !lab_name(&new_name) {
        return Err("a name: lowercase letters, digits and '-', starting with a letter".into());
    }
    api(&app, &state, &["lab-edit", &name, &new_name], description.as_bytes()).await
}

#[tauri::command]
pub(crate) async fn machine_remove(app: AppHandle, state: State<'_, AppState>, name: String) -> Result<Value, String> {
    api(&app, &state, &["machine-remove", &name], &[]).await
}

#[tauri::command]
pub(crate) async fn machine_test(app: AppHandle, state: State<'_, AppState>, name: String) -> Result<Value, String> {
    api(&app, &state, &["machine-test", &name], &[]).await
}
