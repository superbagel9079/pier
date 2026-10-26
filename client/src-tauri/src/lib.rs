//! Pier: desktop companion for a development VM.
//!
//! It talks to the VM over one SSH connection: terminals are channels of it, and the
//! picker's API ("pi-pick --api ...", JSON replies) does the rest. No port is opened
//! on the VM. The picker itself is built into Pier and installed by it (picker.rs).
//! Everything that happens is logged (journal.rs), next to the picker's own log.

#[macro_use]
mod journal;
mod clip;
mod copy;
mod picker;
mod share;
mod ssh;
mod store;
mod takeback;
mod term;
mod watch;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::ipc::{Channel as Output, InvokeResponseBody};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex as AsyncMutex;

use journal::Level;
use ssh::{posix_line, sh_quote, Connection, Endpoint, Outcome};
use store::{Settings, Store};

/// The picker's API version this client speaks.
const API_VERSION: u64 = 22;
const IMAGE_MAX_BYTES: u64 = 20 * 1024 * 1024;
const FILE_MAX_BYTES: u64 = 50 * 1024 * 1024;
/// API commands the interface may call directly: they only read, or type into Pi.
/// Everything that changes on its own (projects, activity, setup, contexts, restore
/// points, the VM's log) comes through the watch instead (watch.rs).
const PASSTHROUGH: &[&str] = &["projects", "ls", "type", "diff", "log", "checkpoints", "checkpoint-diff", "resources", "skill-read", "gallery", "forges", "repo", "approvals", "worktrees", "team", "collaborators", "labs", "lab-journal"];
/// Calls frequent enough to log at debug level only (the shares are also polled here,
/// while a share mounts).
const POLLED: &[&str] = &["projects", "ls", "shares", "log", "checkpoints"];

#[derive(Clone)]
struct Passwords {
    target: String,
    bastion: Option<String>,
}

#[derive(Clone, serde::Serialize)]
struct Share {
    id: u32,
    local: String,
    mountpoint: String,
    relative: String,
    project: String,
    label: String,
    writable: bool,
}

/// Largest folder copied into a project; bigger ones are better shared live.
const COPY_MAX_BYTES: u64 = 200 * 1024 * 1024;
/// Largest share handed off; the VM refuses more than 500 MB too.
const HANDOFF_MAX_BYTES: u64 = 500 * 1024 * 1024;
/// Lines the interface may log per minute; beyond, they are counted, not written.
const UI_LINES_PER_MINUTE: u32 = 300;

/// The longest a login (TCP, keys, password, bastion) may take.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(20);
/// The longest opening a channel may take: a connection dead since the laptop slept
/// answers nothing, and would otherwise hold everything up until TCP gives up.
const CHANNEL_TIMEOUT: Duration = Duration::from_secs(12);
/// How long silent reconnection goes on before asking to log in again.
const RECONNECT_FOR: Duration = Duration::from_secs(15 * 60);

struct AppState {
    store: Store,
    connection: AsyncMutex<Option<Arc<Connection>>>,
    /// More connections, opened when the first refuses channels (see vm_channel).
    extra: AsyncMutex<Vec<Arc<Connection>>>,
    /// The server key seen on a first contact, the only one "trust" may then accept.
    pending_host: std::sync::Mutex<Option<(String, String)>>,
    /// Since when silent reconnection has been failing.
    failing_since: std::sync::Mutex<Option<Instant>>,
    /// Kept in memory only, to reconnect silently after the laptop slept.
    passwords: std::sync::Mutex<Option<Passwords>>,
    terminals: term::Terminals,
    shares: AsyncMutex<HashMap<u32, Share>>,
    next_share: AtomicU32,
    /// The picker's last "version" answer, for the settings and the report.
    picker: std::sync::Mutex<Option<Value>>,
    ui_budget: std::sync::Mutex<(Instant, u32, u32)>,
    watch: watch::Watch,
}

fn message(err: anyhow::Error) -> String {
    format!("{err:#}")
}

// --- request ids: one per call to the VM, written in both logs -------------------------

static RUN_TAG: OnceLock<String> = OnceLock::new();
static NEXT_REQUEST: AtomicU32 = AtomicU32::new(0);

fn next_request() -> String {
    let tag = RUN_TAG.get_or_init(|| {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().subsec_nanos();
        format!("{:04x}", (nanos ^ std::process::id().rotate_left(16)) & 0xffff)
    });
    format!("{tag}-{}", NEXT_REQUEST.fetch_add(1, Ordering::Relaxed) + 1)
}

/// The command line running the picker on the VM with `rest`, carrying the request id
/// (and detailed logging when it is on). `env` rather than VAR=x: fish has no such prefix.
fn remote(settings: &Settings, request: &str, rest: &str) -> String {
    let debug = if journal::debug_enabled() { " DEVBOX_LOG=debug" } else { "" };
    posix_line(&format!("env DEVBOX_REQUEST={request}{debug} {} {rest}", settings.remote_command))
}

/// What a call's arguments look like in the log: text typed into Pi as its length only.
fn args_for_log(args: &[&str]) -> String {
    match args {
        ["type", text, rest @ ..] => format!("type <{} chars> {}", text.chars().count(), rest.join(" ")),
        _ => args.iter().map(|a| a.chars().take(200).collect::<String>()).collect::<Vec<_>>().join(" "),
    }
}

async fn establish(state: &AppState, settings: &Settings, passwords: &Passwords) -> anyhow::Result<Outcome> {
    match tokio::time::timeout(LOGIN_TIMEOUT, establish_now(state, settings, passwords)).await {
        Ok(outcome) => outcome,
        Err(_) => Err(anyhow::anyhow!("no answer within {} s", LOGIN_TIMEOUT.as_secs())),
    }
}

async fn establish_now(state: &AppState, settings: &Settings, passwords: &Passwords) -> anyhow::Result<Outcome> {
    let target = Endpoint {
        host: settings.host.clone(),
        port: settings.port,
        user: settings.user.clone(),
        password: passwords.target.clone(),
    };
    let jump = settings.bastion.as_ref().map(|b| Endpoint {
        host: b.host.clone(),
        port: b.port,
        user: b.user.clone(),
        password: passwords.bastion.clone().unwrap_or_default(),
    });
    ssh::open(&target, jump.as_ref(), |id| state.store.trusted(id)).await
}

fn settings(state: &AppState) -> Result<Settings, String> {
    state.store.settings().ok_or_else(|| "No VM configured yet.".to_string())
}

/// The live connection, reopened silently if it dropped. The lock is held only while
/// checking or reconnecting, never while a channel opens. A refused password or a
/// changed key sends the interface back to the login screen at once; a network that
/// is not back yet (the laptop just woke up) is tried again at the next call, for
/// RECONNECT_FOR, while the interface says it is reconnecting.
async fn connected(app: &AppHandle, state: &AppState, settings: &Settings) -> Result<Arc<Connection>, String> {
    let mut connection = state.connection.lock().await;
    if let Some(live) = connection.as_ref().filter(|c| !c.is_closed()) {
        return Ok(live.clone());
    }
    let remembered = state.passwords.lock().unwrap().clone();
    let Some(passwords) = remembered else {
        return Err(lost(app, "Not connected: log in first."));
    };
    log_info!("ssh.reconnect", host = format!("{}:{}", settings.host, settings.port), why = "the connection dropped");
    let _ = app.emit("connection-retrying", ());
    let started = Instant::now();
    match establish(state, settings, &passwords).await {
        Ok(Outcome::Connected(fresh)) => {
            log_info!("ssh.reconnected", ms = started.elapsed().as_millis());
            let fresh = Arc::new(fresh);
            *connection = Some(fresh.clone());
            *state.failing_since.lock().unwrap() = None;
            drop(connection);
            reconnected(app, state).await;
            Ok(fresh)
        }
        Ok(_) => Err(lost(app, "The server's key changed: log in again to check it.")),
        Err(err) => {
            let text = message(err);
            let since = *state.failing_since.lock().unwrap().get_or_insert_with(Instant::now);
            if text.contains("password refused") || since.elapsed() > RECONNECT_FOR {
                *state.failing_since.lock().unwrap() = None;
                return Err(lost(app, &format!("Connection lost: {text}")));
            }
            log_warn!("ssh.reconnect-failed", err = text, failing_for = since.elapsed().as_secs());
            Err(format!("Reconnecting to the VM… ({text})"))
        }
    }
}

/// After a silent reconnection: the shares ran over the old connection and are gone
/// with it. They are forgotten here (the VM's dead mounts cleaned) and the interface is
/// told, to start them again.
async fn reconnected(app: &AppHandle, state: &AppState) {
    let dropped: Vec<Share> = state.shares.lock().await.drain().map(|(_, s)| s).collect();
    for old in state.extra.lock().await.drain(..) {
        old.close().await;
    }
    if !dropped.is_empty() {
        log_info!("share.dropped", count = dropped.len(), why = "the connection was reopened");
    }
    // The interface cleans the VM's dead mounts (shares_cleanup) and starts them again.
    let _ = app.emit("connection-back", dropped.len());
}

/// After a reconnection: unmounts on the VM what the shares of the old connection left.
#[tauri::command]
async fn shares_cleanup(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    cleanup_stale_shares(&app, &state).await;
    Ok(())
}

/// Runs a command on the VM through the connection (reopened if it dropped).
async fn vm_exec(app: &AppHandle, state: &AppState, command: &str, stdin: &[u8]) -> Result<ssh::Output, String> {
    let channel = vm_channel(app, state).await?;
    ssh::run(channel, command, stdin).await.map_err(message)
}

/// A new channel for a command, a terminal, a share or the watch. Every one of them
/// is a channel of an SSH connection, and OpenSSH allows a limited number per
/// connection (MaxSessions, 10 by default): past it, the VM refuses. Pier then opens
/// another connection, with the password kept in memory, and goes on there.
async fn vm_channel(app: &AppHandle, state: &AppState) -> Result<russh::Channel<russh::client::Msg>, String> {
    let settings = settings(state)?;
    let mut tries = 0;
    let refused = loop {
        tries += 1;
        let connection = connected(app, state, &settings).await?;
        match tokio::time::timeout(CHANNEL_TIMEOUT, connection.channel()).await {
            Ok(Ok(channel)) => return Ok(channel),
            Ok(Err(err)) => match ssh::refusal(&err) {
                Some(reason) => break reason,
                None if tries < 2 => {
                    // Not a refusal: the connection is broken. Closed, it is reopened.
                    log_warn!("ssh.channel-failed", err = message(err));
                    connection.close().await;
                }
                None => return Err(message(err)),
            },
            Err(_) if tries < 2 => {
                log_warn!("ssh.channel-timeout", secs = CHANNEL_TIMEOUT.as_secs());
                connection.close().await;
            }
            Err(_) => return Err("The VM does not answer.".into()),
        }
    };
    let mut extra = state.extra.lock().await;
    extra.retain(|c| !c.is_closed());
    for connection in extra.iter() {
        if let Ok(Ok(channel)) = tokio::time::timeout(CHANNEL_TIMEOUT, connection.channel()).await {
            return Ok(channel);
        }
    }
    let passwords = state.passwords.lock().unwrap().clone().ok_or_else(|| "Not connected: log in first.".to_string())?;
    log_info!("ssh.extra-connection", why = format!("the VM refused a channel ({refused}): sshd's MaxSessions reached"), count = extra.len() + 1);
    match establish(state, &settings, &passwords).await {
        Ok(Outcome::Connected(fresh)) => {
            let channel = fresh.channel().await.map_err(message)?;
            extra.push(Arc::new(fresh));
            Ok(channel)
        }
        Ok(_) => Err("The server's key changed: log in again to check it.".into()),
        Err(err) => {
            let text = message(err);
            log_warn!("ssh.extra-connection-failed", err = text);
            Err(format!("The VM refuses more channels ({refused}) and another connection failed: {text}"))
        }
    }
}

/// Runs "<picker> --api ARGS" on the VM and returns its JSON reply.
async fn api(app: &AppHandle, state: &AppState, args: &[&str], stdin: &[u8]) -> Result<Value, String> {
    let settings = settings(state)?;
    let request = next_request();
    let quoted: Vec<String> = args.iter().map(|a| sh_quote(a)).collect();
    let command = remote(&settings, &request, &format!("--api {}", quoted.join(" ")));
    let started = Instant::now();
    let name = args.first().copied().unwrap_or("?");
    let output = vm_exec(app, state, &command, stdin).await.map_err(|text| {
        log_warn!(format!("vm.{name}"), req = request, ms = started.elapsed().as_millis(), args = args_for_log(args), err = text);
        text
    })?;
    let status = output.status;
    let stderr = String::from_utf8_lossy(&output.stderr).chars().take(2000).collect::<String>();
    let result = reply(output);
    let ms = started.elapsed().as_millis();
    match &result {
        Ok(_) => {
            let level = if POLLED.contains(&name) { Level::Debug } else { Level::Info };
            let sent = if stdin.is_empty() { String::new() } else { stdin.len().to_string() };
            log_at!(level, format!("vm.{name}"), req = request, ms = ms, args = args_for_log(args), sent = sent);
        }
        Err(error) => {
            log_warn!(format!("vm.{name}"), req = request, ms = ms, args = args_for_log(args), status = status.map_or("none".into(), |s| s.to_string()), err = error, stderr = stderr);
        }
    }
    result
}

fn reply(output: ssh::Output) -> Result<Value, String> {
    if let Ok(value) = serde_json::from_slice::<Value>(&output.stdout) {
        return match value.get("error").and_then(Value::as_str) {
            Some(error) => Err(error.to_string()),
            None => Ok(value),
        };
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status == Some(127) {
        return Err(format!("Picker not found on the VM: check the command in the settings. {stderr}"));
    }
    if output.status == Some(126) {
        return Err(format!("The picker on the VM cannot be run (not executable?). {stderr}"));
    }
    let shown = if stderr.is_empty() { String::from_utf8_lossy(&output.stdout).trim().to_string() } else { stderr };
    Err(format!("Unexpected answer from the VM: {}", shown.chars().take(300).collect::<String>()))
}

/// Sends the interface back to the login screen.
fn lost(app: &AppHandle, text: &str) -> String {
    log_warn!("ssh.lost", why = text);
    let _ = app.emit("connection-lost", text);
    text.to_string()
}

fn header(request: &tauri::ipc::Request<'_>, name: &str) -> String {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .unwrap_or_default()
}

// --- connection ------------------------------------------------------------------

#[tauri::command]
fn load_settings(state: State<'_, AppState>) -> Option<Settings> {
    state.store.settings()
}

#[tauri::command]
fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    let endpoint = |s: &Settings| (s.host.clone(), s.port, s.user.clone(), s.bastion.as_ref().map(|b| (b.host.clone(), b.port, b.user.clone())));
    if state.store.settings().map(|old| endpoint(&old)) != Some(endpoint(&settings)) {
        // The password kept for reconnecting belongs to the old VM: never sent elsewhere.
        *state.passwords.lock().unwrap() = None;
    }
    let result = state.store.save_settings(&settings).map_err(message);
    match &result {
        Ok(()) => log_info!("settings.saved", host = format!("{}:{}", settings.host, settings.port), user = settings.user,
            bastion = settings.bastion.as_ref().map_or("none".into(), |b| format!("{}@{}:{}", b.user, b.host, b.port)),
            picker = settings.remote_command),
        Err(err) => log_warn!("settings.refused", err = err),
    }
    result
}

#[tauri::command]
fn trust_host(state: State<'_, AppState>, host: String, fingerprint: String) -> Result<(), String> {
    // Only the key this Pier just met on a first contact can be trusted: the page
    // cannot make up a pair.
    let seen = state.pending_host.lock().unwrap().take();
    if seen.as_ref() != Some(&(host.clone(), fingerprint.clone())) {
        log_warn!("ssh.trust-refused", host = host, why = "not the key just seen");
        return Err("That key was not the one just seen: connect again.".into());
    }
    log_info!("ssh.trusted", host = host, fingerprint = fingerprint);
    state.store.trust(&host, &fingerprint).map_err(message)
}

#[tauri::command]
async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    password: String,
    bastion_password: Option<String>,
) -> Result<Value, String> {
    let settings = settings(&state)?;
    let passwords = Passwords { target: password, bastion: bastion_password };
    let started = Instant::now();
    log_info!("ssh.login", host = format!("{}:{}", settings.host, settings.port), user = settings.user,
        bastion = settings.bastion.as_ref().map_or("none".into(), |b| format!("{}:{}", b.host, b.port)));
    let outcome = establish(&state, &settings, &passwords).await.map_err(|err| {
        let text = message(err);
        log_warn!("ssh.login-failed", ms = started.elapsed().as_millis(), err = text);
        text
    })?;
    match outcome {
        Outcome::Connected(fresh) => {
            log_info!("ssh.connected", ms = started.elapsed().as_millis());
            if let Some(old) = state.connection.lock().await.replace(Arc::new(fresh)) {
                old.close().await;
            }
            *state.failing_since.lock().unwrap() = None;
            *state.passwords.lock().unwrap() = Some(passwords);
            finish_connect(&app, &state).await
        }
        Outcome::Unknown { which, host, fingerprint } => {
            *state.pending_host.lock().unwrap() = Some((host.clone(), fingerprint.clone()));
            Ok(json!({ "status": "unknown_host", "which": which, "host": host, "fingerprint": fingerprint }))
        }
        Outcome::Changed { which, host, fingerprint, known } => {
            Ok(json!({ "status": "changed_host", "which": which, "host": host, "fingerprint": fingerprint, "known": known }))
        }
    }
}

/// Connected: checks the picker on the VM against the one Pier carries. The
/// interface installs or updates it when told it is missing or older.
async fn finish_connect(app: &AppHandle, state: &AppState) -> Result<Value, String> {
    let settings = settings(state)?;
    let bundled = picker::bundled_version();
    let installable = picker::install_script(&settings.remote_command, bundled).is_ok();
    let request = next_request();
    let output = vm_exec(app, state, &remote(&settings, &request, "--api version"), &[]).await?;
    let base = json!({ "bundled": bundled, "command": settings.remote_command, "installable": installable });
    let with = |status: &str, extra: Value| {
        let mut value = base.clone();
        value["status"] = json!(status);
        if let (Some(target), Some(fields)) = (value.as_object_mut(), extra.as_object()) {
            target.extend(fields.clone());
        }
        value
    };
    if matches!(output.status, Some(126 | 127)) {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        log_warn!("picker.missing", req = request, command = settings.remote_command, status = output.status.unwrap_or(0), stderr = stderr);
        *state.picker.lock().unwrap() = None;
        return Ok(with("picker_missing", json!({ "detail": stderr })));
    }
    let version: Value = match reply(output) {
        Ok(version) => version,
        Err(err) => {
            // A picker from before the API prints its usage, or garbage: replace it.
            log_warn!("picker.no-api", req = request, err = err);
            *state.picker.lock().unwrap() = None;
            return Ok(with("picker_outdated", json!({ "remote": "unknown", "remote_api": 0, "detail": err })));
        }
    };
    *state.picker.lock().unwrap() = Some(version.clone());
    let remote_version = version.get("version").and_then(Value::as_str).unwrap_or("?").to_string();
    let remote_api = version.get("api").and_then(Value::as_u64).unwrap_or(0);
    let newer = picker::compare_versions(&remote_version, bundled);
    log_info!("picker.version", req = request, remote = remote_version, api = remote_api, bundled = bundled,
        tmux = version.get("tmux").map_or("?".into(), Value::to_string), pi = version.get("pi").map_or("?".into(), Value::to_string));
    if remote_api == API_VERSION && newer != std::cmp::Ordering::Less {
        cleanup_stale_shares(app, state).await;
        return Ok(json!({ "status": "connected", "version": version, "bundled": bundled }));
    }
    let status = if newer == std::cmp::Ordering::Greater { "picker_newer" } else { "picker_outdated" };
    Ok(with(status, json!({ "remote": remote_version, "remote_api": remote_api })))
}

/// Installs the picker Pier carries on the VM, then checks it again.
#[tauri::command]
async fn install_picker(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let settings = settings(&state)?;
    let version = picker::bundled_version();
    let script = picker::install_script(&settings.remote_command, version)?;
    let request = next_request();
    let started = Instant::now();
    let output = vm_exec(&app, &state, &format!("sh -c {}", sh_quote(&script)), &picker::script_for_vm()).await?;
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status != Some(0) {
        log_error!("picker.install-failed", req = request, status = output.status.map_or("none".into(), |s| s.to_string()), err = stderr);
        return Err(format!("Installing the picker failed: {}", if stderr.is_empty() { "no detail" } else { &stderr }));
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    log_info!("picker.installed", req = request, version = version, path = path, ms = started.elapsed().as_millis());
    finish_connect(&app, &state).await
}

/// The picker on the VM and the one Pier carries, for the settings.
#[tauri::command]
fn picker_info(state: State<'_, AppState>) -> Value {
    let settings = state.store.settings();
    let command = settings.as_ref().map(|s| s.remote_command.clone()).unwrap_or_default();
    json!({
        "remote": state.picker.lock().unwrap().clone(),
        "bundled": picker::bundled_version(),
        "api": picker::bundled_api(),
        "command": command,
        "installable": picker::install_script(&command, picker::bundled_version()).is_ok(),
    })
}

#[tauri::command]
async fn disconnect(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    log_info!("ssh.disconnect", shares = state.shares.lock().await.len());
    *state.passwords.lock().unwrap() = None; // nothing reconnects just to log out
    state.watch.stop().await;
    stop_all_shares(&app, &state).await;
    state.terminals.close_all().await;
    if let Some(old) = state.connection.lock().await.take() {
        old.close().await;
    }
    for old in state.extra.lock().await.drain(..) {
        old.close().await;
    }
    Ok(())
}

/// Read-only API calls, and typing into Pi, straight from the interface.
#[tauri::command]
async fn api_call(app: AppHandle, state: State<'_, AppState>, args: Vec<String>) -> Result<Value, String> {
    let Some(command) = args.first() else { return Err("missing command".into()) };
    if !PASSTHROUGH.contains(&command.as_str()) {
        log_warn!("ui.refused", command = command);
        return Err(format!("command not allowed: {command}"));
    }
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    // What is typed into Pi goes on stdin ("-"): on the command line, any user of the VM
    // could read it (ps), and a line holds 128 KB at most.
    if let ["type", text, rest @ ..] = args.as_slice() {
        let mut moved = vec!["type", "-"];
        moved.extend_from_slice(rest);
        return api(&app, &state, &moved, text.as_bytes()).await;
    }
    api(&app, &state, &args, &[]).await
}

// --- sending to Pi -----------------------------------------------------------------

/// Image pasted in the window: raw bytes in the body, target project in a header.
#[tauri::command]
async fn paste_image(app: AppHandle, state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("missing image".into());
    };
    send_image(&app, &state, bytes, &header(&request, "x-target")).await
}

/// Files dropped on the window: images go to .pi-images, anything else to .pi-files.
#[tauri::command]
async fn paste_files(app: AppHandle, state: State<'_, AppState>, paths: Vec<String>, target: String) -> Result<Vec<Value>, String> {
    let mut results = Vec::new();
    for path in paths {
        let result = send_path(&app, &state, &path, &target).await;
        results.push(result.unwrap_or_else(|error| json!({ "error": error })));
    }
    Ok(results)
}

async fn send_path(app: &AppHandle, state: &AppState, path: &str, target: &str) -> Result<Value, String> {
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

fn is_image(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(b"\xff\xd8\xff")
        || bytes.starts_with(b"GIF87a")
        || bytes.starts_with(b"GIF89a")
        || (bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP")
}

async fn send_image(app: &AppHandle, state: &AppState, bytes: &[u8], target: &str) -> Result<Value, String> {
    let mut args = vec!["paste-image"];
    if !target.is_empty() {
        args.push(target);
    }
    api(app, state, &args, bytes).await
}

/// Ctrl+Alt+V anywhere: the clipboard's image, or the files copied in the file
/// manager, go to the Pi in use. Copied folders are handed to the window, which asks.
async fn send_clipboard(app: AppHandle) {
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
fn clipboard_paths() -> Vec<String> {
    clip::clipboard_paths()
}

/// Copies a folder of this computer into the project (.pi-files), as a snapshot Pi can
/// change freely: the original is not touched.
#[tauri::command]
async fn copy_folder(app: AppHandle, state: State<'_, AppState>, path: String, target: String) -> Result<Value, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "folder".into());
    let started = Instant::now();
    let packed = tokio::task::spawn_blocking(move || copy::tar_folder(&root, COPY_MAX_BYTES))
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
async fn clear_project(app: AppHandle, state: State<'_, AppState>, project: String) -> Result<Value, String> {
    api(&app, &state, &["clear", &project], &[]).await
}

/// Deletes a file sent earlier. The picker only allows files in .pi-images and .pi-files.
#[tauri::command]
async fn remove_upload(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<Value, String> {
    api(&app, &state, &["remove", &path], &[]).await
}

/// Turns Ctrl+Alt+V on or off, from the preferences.
#[tauri::command]
fn set_paste_shortcut(app: AppHandle, enabled: bool) -> Result<(), String> {
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
fn shortcut_status(app: AppHandle) -> bool {
    app.global_shortcut().is_registered(paste_shortcut())
}

fn paste_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyV)
}

// --- restore points -----------------------------------------------------------------

/// Saves the project now, as a restore point named by the user.
#[tauri::command]
async fn checkpoint_create(app: AppHandle, state: State<'_, AppState>, project: String, label: String) -> Result<Value, String> {
    api(&app, &state, &["checkpoint", &project, &label], &[]).await
}

/// Puts the project back as it was at a restore point: all of it, or `files`.
#[tauri::command]
async fn checkpoint_restore(app: AppHandle, state: State<'_, AppState>, project: String, id: String, files: Vec<String>) -> Result<Value, String> {
    // The files, one per line on stdin: hundreds of them would not fit on a command line.
    if files.iter().any(|f| f.contains('\n')) {
        return Err("a file name with a line break cannot be restored one by one".into());
    }
    let list = files.join("\n");
    let args = if files.is_empty() { vec!["restore", project.as_str(), id.as_str()] } else { vec!["restore", project.as_str(), id.as_str(), "-"] };
    api(&app, &state, &args, list.as_bytes()).await
}

// --- terminals ----------------------------------------------------------------------

/// The command line of a "pi" terminal: the picker's --attach-control, which opens
/// the Pi (see open_pi there) and attaches to it in tmux's control mode (term.rs).
/// Only what Pier itself asks is accepted: the Pi used last or a new one (nothing),
/// a new Pi (--new), a running one (--slot NAME), or a conversation (--continue,
/// --session FILE): its Pi if one runs it, else a new Pi on it.
fn attach_command(project: &str, args: &[String]) -> Result<String, String> {
    let slot_name = |name: &str| name.starts_with("pi-") && name.len() < 100 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    let allowed = match args {
        [] => true,
        [flag] => flag == "--continue" || flag == "--new",
        [flag, file] if flag == "--session" => file.ends_with(".jsonl") && file.contains("/.pi/") && !file.contains('\n'),
        [flag, name] if flag == "--slot" => slot_name(name),
        // A new Pi asked to take a task or review a pull request: the picker writes the
        // prompt itself, from fixed words and this number (see AGENT_PROMPTS there).
        [flag, kind, n] if flag == "--agent-task" => (kind == "task" || kind == "review") && !n.is_empty() && n.len() < 8 && n.chars().all(|c| c.is_ascii_digit()),
        _ => false,
    };
    if !allowed || project.is_empty() {
        return Err("unsupported Pi arguments".into());
    }
    let mut line = format!("--attach-control {}", sh_quote(project));
    for arg in args {
        line.push(' ');
        line.push_str(&sh_quote(arg));
    }
    Ok(line)
}

/// `pi update` run by the picker in a terminal: Pi itself, --all, --extensions, or one
/// package (npm:…, git:…, https://…). Nothing else reaches the command line.
/// A package source Pier passes to `pi update`, `pi install` or `pi remove`.
fn package_source(s: &str) -> bool {
    (s.starts_with("npm:") || s.starts_with("git:") || s.starts_with("https://"))
        && s.len() <= 200
        && s.chars().all(|c| c.is_ascii_alphanumeric() || "@/._:+~-".contains(c))
}

fn update_command(args: &[String]) -> Result<String, String> {
    let source = package_source;
    match args {
        [] => Ok("--pi-update".into()),
        [flag] if flag == "--all" || flag == "--extensions" || source(flag) => Ok(format!("--pi-update {}", sh_quote(flag))),
        _ => Err("unsupported update".into()),
    }
}

/// `pi install` / `pi remove` run by the picker in a terminal, in Pi's sandbox: for the
/// user ("user") or a project (its path, checked to be in home on the VM).
fn package_command(args: &[String]) -> Result<String, String> {
    match args {
        [action, scope, source]
            if (action == "install" || action == "remove")
                && (scope == "user" || (scope.starts_with('/') && scope.len() < 4096 && !scope.chars().any(char::is_control)))
                && package_source(source) =>
        {
            Ok(format!("--pi-package {} {} {}", sh_quote(action), sh_quote(scope), sh_quote(source)))
        }
        _ => Err("unsupported package command".into()),
    }
}

/// A terminal in a lab or on a machine (the picker's --lab-shell): only a name.
fn lab_command(args: &[String]) -> Result<String, String> {
    match args {
        [name] if lab_name(name) => Ok(format!("--lab-shell {}", sh_quote(name))),
        _ => Err("unsupported lab".into()),
    }
}

fn lab_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && name.len() <= 40
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// kind "picker" runs the picker, "shell" the login shell, "pi" Pi itself in `project`
/// (with `args`: nothing, --continue, or --session FILE), "update" `pi update` (see
/// update_command).
#[tauri::command]
async fn term_open(
    app: AppHandle,
    state: State<'_, AppState>,
    kind: String,
    cols: u32,
    rows: u32,
    output: Output<InvokeResponseBody>,
    project: Option<String>,
    args: Option<Vec<String>>,
) -> Result<u32, String> {
    let settings = settings(&state)?;
    let channel = vm_channel(&app, &state).await.map_err(|text| {
        log_warn!("term.channel-failed", kind = kind, err = text);
        text
    })?;
    let request = next_request();
    let command = match kind.as_str() {
        "picker" => Some(remote(&settings, &request, "")),
        "shell" => None,
        "pi" => Some(remote(&settings, &request, &attach_command(project.as_deref().unwrap_or(""), args.as_deref().unwrap_or(&[]))?)),
        "update" => Some(remote(&settings, &request, &update_command(args.as_deref().unwrap_or(&[]))?)),
        "package" => Some(remote(&settings, &request, &package_command(args.as_deref().unwrap_or(&[]))?)),
        "lab" => Some(remote(&settings, &request, &lab_command(args.as_deref().unwrap_or(&[]))?)),
        other => return Err(format!("unknown terminal: {other}")),
    };
    let exit_app = app.clone();
    let opened = Instant::now();
    let exit_kind = kind.clone();
    let on_exit = move |id: u32, status: Option<u32>| {
        let app = exit_app.clone();
        log_info!("term.exit", id = id, kind = exit_kind, status = status.map_or("none".into(), |s| s.to_string()), secs = opened.elapsed().as_secs());
        tauri::async_runtime::spawn(async move {
            app.state::<AppState>().terminals.forget(id).await;
            // clean: the program ended; otherwise the connection dropped under it.
            let _ = app.emit("term-exit", json!({ "id": id, "clean": status.is_some() }));
        });
    };
    let opening = match (kind.as_str(), command.as_deref()) {
        // Pi: tmux in control mode, Pi's own output (see term.rs).
        ("pi", Some(command)) => state.terminals.open_control(channel, command, cols, rows, output, on_exit).await,
        _ => state.terminals.open(channel, command.as_deref().map(str::trim_end), cols, rows, output, on_exit).await,
    };
    let id = opening
        .map_err(|e| {
            let text = message(e);
            log_warn!("term.open-failed", kind = kind, err = text);
            text
        })?;
    log_info!("term.open", id = id, kind = kind, req = request, size = format!("{cols}x{rows}"),
        project = project.unwrap_or_default(), args = args.unwrap_or_default().join(" "));
    Ok(id)
}

/// Stops the Pis of a project, or one (`slot`). Their conversations stay saved.
#[tauri::command]
async fn stop_pi(app: AppHandle, state: State<'_, AppState>, project: String, slot: Option<String>) -> Result<Value, String> {
    api(&app, &state, &["stop", &project, slot.as_deref().unwrap_or("")], &[]).await
}

/// Names a conversation and files it under a category, in Pier (Pi's file is not
/// touched). Empty both: the label goes.
#[tauri::command]
async fn session_label(app: AppHandle, state: State<'_, AppState>, project: String, file: String, title: String, category: String) -> Result<Value, String> {
    api(&app, &state, &["label", &project, &file, &title, &category], &[]).await
}

/// Pins a conversation (kept on top) or archives it (out of the lists, still found by a
/// search): `what` is "pinned" or "archived".
#[tauri::command]
async fn session_mark(app: AppHandle, state: State<'_, AppState>, project: String, file: String, what: String, on: bool) -> Result<Value, String> {
    if what != "pinned" && what != "archived" {
        return Err(format!("cannot mark a conversation {what}"));
    }
    api(&app, &state, &["mark", &project, &file, &what, if on { "1" } else { "0" }], &[]).await
}

// --- the watch -------------------------------------------------------------------------

/// Opens the watch (closing one already open) and says what to follow. What it sends
/// comes as "vm-update" events; "watch-ended" when it stops (the connection dropped):
/// the interface opens it again.
#[tauri::command]
async fn watch_start(app: AppHandle, state: State<'_, AppState>, want: Value) -> Result<u32, String> {
    let settings = settings(&state)?;
    let channel = vm_channel(&app, &state).await?;
    let request = next_request();
    let command = remote(&settings, &request, "--api watch");
    let updates = app.clone();
    let ends = app.clone();
    let started = Instant::now();
    let id = state
        .watch
        .start(
            channel,
            &command,
            move |message| {
                let _ = updates.emit("vm-update", message);
            },
            move |id, why| {
                log_info!("watch.end", id = id, why = why, secs = started.elapsed().as_secs());
                let app = ends.clone();
                tauri::async_runtime::spawn(async move {
                    app.state::<AppState>().watch.ended(id).await;
                    let _ = app.emit("watch-ended", id);
                });
            },
        )
        .await
        .map_err(|e| {
            let text = message(e);
            log_warn!("watch.failed", err = text);
            text
        })?;
    log_info!("watch.start", id = id, req = request);
    state.watch.send(&want).await.map_err(message)?;
    Ok(id)
}

/// Changes what the watch follows (only the keys given), or {"poke": true}.
#[tauri::command]
async fn watch_set(state: State<'_, AppState>, want: Value) -> Result<(), String> {
    log_debug!("watch.want", want = want);
    state.watch.send(&want).await.map_err(message)
}

#[tauri::command]
async fn term_write(state: State<'_, AppState>, id: u32, data: String) -> Result<(), String> {
    // What is typed is never logged, not even at debug level.
    state.terminals.write(id, data.as_bytes()).await.map_err(message)
}

#[tauri::command]
async fn term_resize(state: State<'_, AppState>, id: u32, cols: u32, rows: u32) -> Result<(), String> {
    log_debug!("term.resize", id = id, size = format!("{cols}x{rows}"));
    state.terminals.resize(id, cols, rows).await.map_err(message)
}

#[tauri::command]
async fn term_close(state: State<'_, AppState>, id: u32) -> Result<(), String> {
    log_debug!("term.close", id = id);
    state.terminals.close(id).await;
    Ok(())
}

// --- shares -------------------------------------------------------------------------

/// Lends a local folder to the VM, mounted live in the project's .pi-shared.
#[tauri::command]
async fn share_start(app: AppHandle, state: State<'_, AppState>, path: String, writable: bool, target: String) -> Result<Share, String> {
    let local = PathBuf::from(&path);
    if !local.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    let fs = share::ShareFs::new(&local, writable).map_err(|e| format!("{path}: {e}"))?;
    let name = local.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "share".into());
    let prepared = api(&app, &state, &["share-prepare", &name, &target], &[]).await?;
    let field = |key: &str| prepared.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    let mountpoint = field("mountpoint");

    let settings = settings(&state)?;
    let channel = vm_channel(&app, &state).await?;
    let mode = if writable { "rw" } else { "ro" };
    let request = next_request();
    let command = remote(&settings, &request, &format!("--share-serve {} {mode}", sh_quote(&mountpoint)));
    channel.exec(true, command).await.map_err(|e| message(e.into()))?;
    russh_sftp::server::run(channel.into_stream(), fs).await;

    // sshfs mounts within a moment; if it is not there, it failed (FUSE unavailable...).
    let started = Instant::now();
    let mut mounted = false;
    for _ in 0..20 {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        let shares = api(&app, &state, &["shares"], &[]).await?;
        mounted = shares["shares"].as_array().is_some_and(|list| list.iter().any(|s| s["mountpoint"] == mountpoint.as_str()));
        if mounted {
            break;
        }
    }
    if !mounted {
        log_error!("share.mount-failed", req = request, local = path, mountpoint = mountpoint, waited_ms = started.elapsed().as_millis());
        let _ = api(&app, &state, &["share-stop", &mountpoint], &[]).await;
        return Err("Mounting failed on the VM: check that sshfs is installed and FUSE is available (/dev/fuse).".into());
    }
    let share = Share {
        id: state.next_share.fetch_add(1, Ordering::Relaxed) + 1,
        local: path,
        mountpoint,
        relative: field("relative"),
        project: field("project"),
        label: field("label"),
        writable,
    };
    log_info!("share.start", id = share.id, req = request, local = share.local, mountpoint = share.mountpoint, mode = mode, ms = started.elapsed().as_millis());
    state.shares.lock().await.insert(share.id, share.clone());
    // Remembered on this computer: after a disconnection the mount is gone, and the
    // share can be resumed from here.
    let _ = state.store.remember_share(store::RememberedShare {
        local: share.local.clone(),
        project: share.project.clone(),
        label: share.label.clone(),
        relative: share.relative.clone(),
        writable,
    });
    Ok(share)
}

/// Unmounts a share. `forget` also drops it from the remembered shares; otherwise it
/// stays listed as paused, ready to resume.
#[tauri::command]
async fn share_stop(app: AppHandle, state: State<'_, AppState>, id: u32, forget: Option<bool>) -> Result<(), String> {
    let share = state.shares.lock().await.remove(&id);
    if let Some(share) = share {
        log_info!("share.stop", id = id, local = share.local, forget = forget.unwrap_or(true));
        if forget.unwrap_or(true) {
            let _ = state.store.forget_share(&share.local, &share.project);
        }
        api(&app, &state, &["share-stop", &share.mountpoint], &[]).await?;
    }
    Ok(())
}

// --- skills, extensions, prompts (Setup) -----------------------------------------------

fn resource_scope(scope: &str) -> Result<(), String> {
    if scope == "user" || scope == "project" { Ok(()) } else { Err(format!("unknown scope: {scope}")) }
}

/// Turns a skill, an extension or a prompt on or off, as `pi config` does.
#[tauri::command]
async fn resource_toggle(app: AppHandle, state: State<'_, AppState>, scope: String, project: String, kind: String, source: String, rel: String, on: bool) -> Result<Value, String> {
    resource_scope(&scope)?;
    if !["skills", "extensions", "prompts"].contains(&kind.as_str()) {
        return Err(format!("unknown kind: {kind}"));
    }
    api(&app, &state, &["toggle-resource", &scope, &project, &kind, &source, &rel, if on { "1" } else { "0" }], &[]).await
}

/// A new local skill, from a template.
#[tauri::command]
async fn skill_create(app: AppHandle, state: State<'_, AppState>, scope: String, project: String, name: String, description: String) -> Result<Value, String> {
    resource_scope(&scope)?;
    api(&app, &state, &["skill-new", &scope, &project, &name, &description], &[]).await
}

/// A local skill's SKILL.md, saved.
#[tauri::command]
async fn skill_save(app: AppHandle, state: State<'_, AppState>, scope: String, project: String, name: String, text: String) -> Result<Value, String> {
    resource_scope(&scope)?;
    api(&app, &state, &["skill-write", &scope, &project, &name], text.as_bytes()).await
}

/// A local skill, moved to the picker's bin on the VM.
#[tauri::command]
async fn skill_delete(app: AppHandle, state: State<'_, AppState>, scope: String, project: String, name: String) -> Result<Value, String> {
    resource_scope(&scope)?;
    api(&app, &state, &["skill-delete", &scope, &project, &name], &[]).await
}

// --- git forges (Setup > Git) ------------------------------------------------------------

/// Connects a forge account: the token goes on stdin, never on a command line or in a log.
#[tauri::command]
async fn forge_add(app: AppHandle, state: State<'_, AppState>, kind: String, url: String, token: String) -> Result<Value, String> {
    if !["github", "gitlab", "gitea"].contains(&kind.as_str()) {
        return Err(format!("unknown forge: {kind}"));
    }
    api(&app, &state, &["forge-add", &kind, &url], token.trim().as_bytes()).await
}

#[tauri::command]
async fn forge_remove(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<Value, String> {
    api(&app, &state, &["forge-remove", &id], &[]).await
}

/// Connects the project to a repository (owner/name) of a forge account.
#[tauri::command]
async fn repo_link(app: AppHandle, state: State<'_, AppState>, project: String, forge: String, repo: String) -> Result<Value, String> {
    api(&app, &state, &["repo-link", &project, &forge, &repo], &[]).await
}

#[tauri::command]
async fn repo_unlink(app: AppHandle, state: State<'_, AppState>, project: String) -> Result<Value, String> {
    api(&app, &state, &["repo-unlink", &project], &[]).await
}

/// A new repository on the forge, connected to the project (the user's own action).
#[tauri::command]
async fn repo_create(app: AppHandle, state: State<'_, AppState>, project: String, forge: String, name: String, private: bool, description: String) -> Result<Value, String> {
    api(&app, &state, &["repo-create", &project, &forge, &name, if private { "1" } else { "0" }, &description], &[]).await
}

/// What Pi may do alone with the project's repository (local, ask, auto), and how it merges.
#[tauri::command]
async fn repo_settings(app: AppHandle, state: State<'_, AppState>, project: String, mode: String, method: String, agents: String) -> Result<Value, String> {
    if !["local", "ask", "auto"].contains(&mode.as_str()) || !["merge", "squash", "rebase"].contains(&method.as_str())
        || !["", "off", "ask", "auto"].contains(&agents.as_str()) {
        return Err(format!("unknown repository setting: {mode}, {method}, {agents}"));
    }
    api(&app, &state, &["repo-settings", &project, &mode, &method, &agents], &[]).await
}

/// Labs on or off, and their limits (JSON, checked by the picker).
#[tauri::command]
async fn labs_settings(app: AppHandle, state: State<'_, AppState>, settings: String) -> Result<Value, String> {
    api(&app, &state, &["labs-settings"], settings.as_bytes()).await
}

/// A lab made (for a project, or none), reset to its clean state, or destroyed.
#[tauri::command]
async fn lab_action(app: AppHandle, state: State<'_, AppState>, action: String, name: String, extra: String) -> Result<Value, String> {
    if !["create", "reset", "destroy"].contains(&action.as_str()) || !["", "vm"].contains(&extra.as_str())
        || (action != "create" && !lab_name(&name)) {
        return Err("unsupported lab action".into());
    }
    api(&app, &state, &["lab-action", &action, &name, &extra], &[]).await
}

/// A machine Pi may use over SSH (the picker makes the key), removed, or tried.
#[tauri::command]
async fn machine_add(app: AppHandle, state: State<'_, AppState>, name: String, host: String, port: u16, user: String, policy: String, description: String) -> Result<Value, String> {
    if !lab_name(&name) || !["ask", "auto"].contains(&policy.as_str()) {
        return Err("a machine's name, and ask or auto".into());
    }
    api(&app, &state, &["machine-add", &name, &host, &port.to_string(), &user, &policy], description.as_bytes()).await
}

/// A lab of the user's own, named (or "lab-N") and described.
#[tauri::command]
async fn lab_new(app: AppHandle, state: State<'_, AppState>, name: String, vm: bool, description: String, networks: Option<Vec<String>>, host: Option<String>) -> Result<Value, String> {
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
async fn host_add(app: AppHandle, state: State<'_, AppState>, name: String, host: String, port: u16, user: String, description: String) -> Result<Value, String> {
    if !lab_name(&name) {
        return Err("a lab host's name: lowercase letters, digits and '-', starting with a letter".into());
    }
    api(&app, &state, &["host-add", &name, &host, &port.to_string(), &user], description.as_bytes()).await
}

/// Pi's own VM used as a lab host, or no longer.
#[tauri::command]
async fn host_local(app: AppHandle, state: State<'_, AppState>, on: bool, description: String) -> Result<Value, String> {
    api(&app, &state, &["host-local", if on { "1" } else { "0" }], description.as_bytes()).await
}

#[tauri::command]
async fn host_remove(app: AppHandle, state: State<'_, AppState>, name: String) -> Result<Value, String> {
    api(&app, &state, &["host-remove", &name], &[]).await
}

#[tauri::command]
async fn host_test(app: AppHandle, state: State<'_, AppState>, name: String) -> Result<Value, String> {
    api(&app, &state, &["host-test", &name], &[]).await
}

/// What a network is for, in the user's words: Pi reads it in lab_list.
#[tauri::command]
async fn lab_network_describe(app: AppHandle, state: State<'_, AppState>, name: String, description: String) -> Result<Value, String> {
    api(&app, &state, &["lab-network-describe", &name], description.as_bytes()).await
}

/// A lab or machine renamed, its description changed.
#[tauri::command]
async fn lab_edit(app: AppHandle, state: State<'_, AppState>, name: String, new_name: String, description: String) -> Result<Value, String> {
    if !lab_name(&name) || !lab_name(&new_name) {
        return Err("a name: lowercase letters, digits and '-', starting with a letter".into());
    }
    api(&app, &state, &["lab-edit", &name, &new_name], description.as_bytes()).await
}

#[tauri::command]
async fn machine_remove(app: AppHandle, state: State<'_, AppState>, name: String) -> Result<Value, String> {
    api(&app, &state, &["machine-remove", &name], &[]).await
}

#[tauri::command]
async fn machine_test(app: AppHandle, state: State<'_, AppState>, name: String) -> Result<Value, String> {
    api(&app, &state, &["machine-test", &name], &[]).await
}

/// A task for the team's Pis: an issue labelled pi-task (its description on stdin).
#[tauri::command]
async fn task_create(app: AppHandle, state: State<'_, AppState>, project: String, title: String, body: String) -> Result<Value, String> {
    api(&app, &state, &["task-create", &project, &title], body.as_bytes()).await
}

/// A conversation given to a colleague (the user's own act; the note on stdin).
#[tauri::command]
async fn handoff_give(app: AppHandle, state: State<'_, AppState>, project: String, file: String, to: String, note: String) -> Result<Value, String> {
    if !file.ends_with(".jsonl") || to.is_empty() || to.len() > 64 || !to.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
        return Err("a conversation and a colleague's login".into());
    }
    api(&app, &state, &["handoff-give", &project, &file, &to], note.as_bytes()).await
}

/// A colleague's conversation taken over: it lands among this project's conversations.
#[tauri::command]
async fn handoff_take(app: AppHandle, state: State<'_, AppState>, project: String, branch: String) -> Result<Value, String> {
    if !branch.starts_with("pi-handoff/") {
        return Err("not a handoff".into());
    }
    api(&app, &state, &["handoff-take", &project, &branch], &[]).await
}

/// Merges a pull request, from Pier.
#[tauri::command]
async fn pr_merge(app: AppHandle, state: State<'_, AppState>, project: String, number: u64, method: String) -> Result<Value, String> {
    if !["merge", "squash", "rebase"].contains(&method.as_str()) {
        return Err(format!("unknown merge method: {method}"));
    }
    api(&app, &state, &["pr-merge", &project, &number.to_string(), &method], &[]).await
}

/// A Pi's worktree removed (its branch stays).
#[tauri::command]
async fn worktree_remove(app: AppHandle, state: State<'_, AppState>, project: String, name: String) -> Result<Value, String> {
    if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
        return Err(format!("not a worktree: {name}"));
    }
    api(&app, &state, &["worktree-remove", &project, &name], &[]).await
}

/// The user's answer to a request of Pi (merge, create a repository).
#[tauri::command]
async fn approval_answer(app: AppHandle, state: State<'_, AppState>, id: String, approve: bool) -> Result<Value, String> {
    api(&app, &state, &["approval-answer", &id, if approve { "yes" } else { "no" }], &[]).await
}

/// Largest skill folder sent from this computer.
const SKILL_MAX_BYTES: u64 = 20 * 1024 * 1024;

/// A skill folder of this computer (it holds a SKILL.md), copied into the skills.
#[tauri::command]
async fn skill_import(app: AppHandle, state: State<'_, AppState>, scope: String, project: String, path: String) -> Result<Value, String> {
    resource_scope(&scope)?;
    let root = PathBuf::from(&path);
    if !root.join("SKILL.md").is_file() {
        return Err(format!("{path} holds no SKILL.md: it is not a skill folder"));
    }
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "skill".into());
    let packed = tokio::task::spawn_blocking(move || copy::tar_folder(&root, SKILL_MAX_BYTES))
        .await
        .map_err(|e| e.to_string())?
        .map_err(message)?;
    api(&app, &state, &["skill-import", &scope, &project, &name], &packed.0).await
}

/// Saves one of the project's texts for Pi: "instructions" (AGENTS.md), "append"
/// (.pi/APPEND_SYSTEM.md) or "system" (.pi/SYSTEM.md). The picker keeps the previous
/// version in the project's history.
#[tauri::command]
async fn write_text(app: AppHandle, state: State<'_, AppState>, project: String, which: String, text: String) -> Result<Value, String> {
    api(&app, &state, &["write-text", &project, &which], text.as_bytes()).await
}

/// Hand off: the live share becomes a copy on the VM, at the same path, so Pi keeps
/// working without this computer. The share is remembered, to take it back later.
#[tauri::command]
async fn hand_off(app: AppHandle, state: State<'_, AppState>, id: u32) -> Result<Value, String> {
    let share = state.shares.lock().await.get(&id).cloned().ok_or_else(|| "this share is not live".to_string())?;
    let root = PathBuf::from(&share.local);
    let started = Instant::now();
    let packed = tokio::task::spawn_blocking(move || copy::tar_folder(&root, HANDOFF_MAX_BYTES))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| {
            let text = format!("{}: {}", share.local, message(e));
            log_warn!("handoff.refused", id = id, err = text);
            text
        })?;
    log_info!("handoff.packed", id = id, local = share.local, bytes = packed.0.len(), ms = started.elapsed().as_millis());
    let mode = if share.writable { "rw" } else { "ro" };
    let result = api(&app, &state, &["handoff", &share.mountpoint, mode], &packed.0).await?;
    state.shares.lock().await.remove(&id);
    Ok(result)
}

/// Take back, for a handed-off copy Pi could write to: its current version, saved in a
/// new folder next to the original. Nothing on this computer is overwritten.
#[tauri::command]
async fn download_copy(app: AppHandle, state: State<'_, AppState>, path: String, local: String) -> Result<String, String> {
    let original = PathBuf::from(&local);
    let parent = original.parent().ok_or_else(|| format!("{local} has no parent folder"))?.to_path_buf();
    let name = original.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "copy".into());
    let mut dest = parent.join(format!("{name} (from Pi)"));
    let mut n = 2;
    while dest.exists() {
        dest = parent.join(format!("{name} (from Pi {n})"));
        n += 1;
    }
    let settings = settings(&state)?;
    let request = next_request();
    let command = remote(&settings, &request, &format!("--download {}", sh_quote(&path)));
    let started = Instant::now();
    let unique = format!("{}-{}", std::process::id(), NEXT_REQUEST.fetch_add(1, Ordering::Relaxed));
    let archive = std::env::temp_dir().join(format!("pier-takeback-{unique}.tar"));
    let channel = vm_channel(&app, &state).await?;
    let ran = {
        let mut file = std::fs::File::create(&archive).map_err(|e| e.to_string())?;
        ssh::run_into(channel, &command, &[], &mut file, TAKEBACK_MAX).await
    };
    let (status, stderr) = match ran {
        Ok(done) => done,
        Err(err) => {
            let _ = std::fs::remove_file(&archive);
            return Err(message(err));
        }
    };
    if status != Some(0) {
        let _ = std::fs::remove_file(&archive);
        let stderr = String::from_utf8_lossy(&stderr).trim().to_string();
        log_warn!("takeback.failed", req = request, path = path, status = status.map_or("none".into(), |s| s.to_string()), err = stderr);
        return Err(format!("download failed: {stderr}"));
    }
    let bytes = std::fs::metadata(&archive).map(|m| m.len()).unwrap_or(0);
    let target = dest.clone();
    let staging = parent.join(format!(".pier-takeback-{unique}"));
    let unpacked = tokio::task::spawn_blocking({
        let (archive, staging) = (archive.clone(), staging.clone());
        move || unpack_takeback(&archive, &staging, &target)
    })
    .await
    .map_err(|e| e.to_string());
    let _ = std::fs::remove_file(&archive);
    let _ = std::fs::remove_dir_all(&staging);
    unpacked?.map_err(|e| {
        let text = message(e);
        log_warn!("takeback.unpack-failed", req = request, err = text);
        text
    })?;
    log_info!("takeback.saved", req = request, path = path, dest = dest.display(), bytes = bytes, ms = started.elapsed().as_millis());
    Ok(dest.to_string_lossy().into_owned())
}

/// Take back, file by file (takeback.rs): what differs between a handed-off copy on the
/// VM and its original folder here.
#[tauri::command]
async fn takeback_compare(app: AppHandle, state: State<'_, AppState>, path: String, local: String) -> Result<Value, String> {
    let remote = api(&app, &state, &["copy-manifest", &path], &[]).await?;
    let root = PathBuf::from(&local);
    let started = Instant::now();
    let (mine, truncated) = tokio::task::spawn_blocking(move || takeback::local_manifest(&root))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{local}: {}", message(e)))?;
    let result = takeback::compare(&mine, &takeback::remote_manifest(&remote));
    log_info!("takeback.compare", path = path, local = local, changed = result.changed.len(), added = result.added.len(),
        deleted = result.deleted.len(), same = result.same, ms = started.elapsed().as_millis());
    Ok(json!({
        "changed": result.changed, "added": result.added, "deleted": result.deleted, "same": result.same,
        "links": remote.get("links").cloned().unwrap_or(Value::Null),
        "truncated": truncated || remote.get("truncated").and_then(Value::as_bool).unwrap_or(false),
    }))
}

/// One file's difference: this computer's version against the copy's (a unified diff).
#[tauri::command]
async fn takeback_diff(app: AppHandle, state: State<'_, AppState>, path: String, local: String, rel: String) -> Result<Value, String> {
    let root = PathBuf::from(&local);
    let mine = {
        let rel = rel.clone();
        tokio::task::spawn_blocking(move || takeback::read_local(&root, &rel, 1024 * 1024))
            .await
            .map_err(|e| e.to_string())?
            .map_err(message)?
    };
    if mine.len() > 1024 * 1024 {
        return Ok(json!({ "rel": rel, "too_big": true }));
    }
    api(&app, &state, &["copy-diff", &path, &rel], &mine).await
}

/// Brings the files chosen from the copy into the original folder, and deletes there
/// the ones chosen among those Pi deleted. What is replaced or deleted is moved first to
/// "NAME (before Pi's changes DATE)", next to the original.
#[tauri::command]
async fn takeback_apply(app: AppHandle, state: State<'_, AppState>, path: String, local: String, take: Vec<String>, delete: Vec<String>) -> Result<Value, String> {
    let root = PathBuf::from(&local);
    if !root.is_dir() {
        return Err(format!("{local} is not a folder"));
    }
    if take.iter().chain(delete.iter()).any(|rel| takeback::safe_parts(rel).is_none()) {
        return Err("a file name from the VM is not acceptable here".into());
    }
    let parent = root.parent().ok_or_else(|| format!("{local} has no parent folder"))?.to_path_buf();
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "folder".into());
    let when = journal::timestamp(std::time::SystemTime::now()).replace('T', " ").replace(':', "-");
    let backup = parent.join(format!("{name} (before Pi's changes {})", &when[..16]));
    let request = next_request();
    let started = Instant::now();
    let unique = format!("{}-{}", std::process::id(), NEXT_REQUEST.fetch_add(1, Ordering::Relaxed));
    let archive = std::env::temp_dir().join(format!("pier-takeback-files-{unique}.tar"));
    let mut fetched = None;
    if !take.is_empty() {
        let settings = settings(&state)?;
        let command = remote(&settings, &request, &format!("--download-files {}", sh_quote(&path)));
        let channel = vm_channel(&app, &state).await?;
        let list = take.join("\n");
        let ran = {
            let mut file = std::fs::File::create(&archive).map_err(|e| e.to_string())?;
            ssh::run_into(channel, &command, list.as_bytes(), &mut file, TAKEBACK_MAX).await
        };
        match ran {
            Ok((Some(0), _)) => fetched = Some(archive.clone()),
            Ok((status, stderr)) => {
                let _ = std::fs::remove_file(&archive);
                let stderr = String::from_utf8_lossy(&stderr).trim().to_string();
                log_warn!("takeback.fetch-failed", req = request, path = path, status = status.map_or("none".into(), |s| s.to_string()), err = stderr);
                return Err(format!("download failed: {stderr}"));
            }
            Err(err) => {
                let _ = std::fs::remove_file(&archive);
                return Err(message(err));
            }
        }
    }
    let wanted: std::collections::HashSet<String> = take.into_iter().collect();
    let applied = tokio::task::spawn_blocking({
        let (root, backup) = (root.clone(), backup.clone());
        move || takeback::apply(&root, &backup, fetched.as_deref(), &wanted, &delete)
    })
    .await
    .map_err(|e| e.to_string());
    let _ = std::fs::remove_file(&archive);
    let applied = applied?.map_err(|e| {
        let text = message(e);
        log_warn!("takeback.apply-failed", req = request, local = local, err = text);
        text
    })?;
    log_info!("takeback.applied", req = request, path = path, local = local, taken = applied.taken.len(), deleted = applied.deleted.len(),
        skipped = applied.skipped.len(), backup = applied.backup.clone().unwrap_or_default(), ms = started.elapsed().as_millis());
    serde_json::to_value(applied).map_err(|e| e.to_string())
}

/// Largest take-back archive, and most bytes it may unpack to.
const TAKEBACK_MAX: u64 = 600 * 1024 * 1024;
const TAKEBACK_UNPACKED_MAX: u64 = 2 * 1024 * 1024 * 1024;

/// Unpacks a take-back into `staging` (a folder of its own), then moves its top folder
/// to `target`. Only folders and plain files: links, devices and the like are skipped
/// (a link could point anywhere on this computer). Every file is marked as coming from
/// elsewhere (Mark of the Web), so Windows warns before running or opening it.
fn unpack_takeback(archive: &std::path::Path, staging: &std::path::Path, target: &std::path::Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(staging)?;
    let mut tar = tar::Archive::new(std::fs::File::open(archive)?);
    let (mut total, mut skipped) = (0u64, 0u32);
    for entry in tar.entries()? {
        let mut entry = entry?;
        let kind = entry.header().entry_type();
        if !(kind.is_file() || kind.is_dir()) {
            skipped += 1;
            continue;
        }
        total += entry.header().size().unwrap_or(0);
        if total > TAKEBACK_UNPACKED_MAX {
            anyhow::bail!("the copy unpacks to more than {} GB: stopped", TAKEBACK_UNPACKED_MAX >> 30);
        }
        // unpack_in refuses entries escaping the folder.
        if entry.unpack_in(staging)? && kind.is_file() {
            let path = staging.join(entry.path()?);
            mark_from_elsewhere(&path);
        }
    }
    if skipped > 0 {
        log_info!("takeback.skipped", entries = skipped, why = "links and special files are not taken back");
    }
    let top = std::fs::read_dir(staging)?
        .flatten()
        .find(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path());
    match top {
        Some(top) => std::fs::rename(top, target)?,
        None => std::fs::create_dir_all(target)?,
    }
    Ok(())
}

/// Zone.Identifier, as browsers write it for downloads: zone 3, the Internet.
fn mark_from_elsewhere(path: &std::path::Path) {
    if cfg!(windows) {
        let mut stream = path.as_os_str().to_owned();
        stream.push(":Zone.Identifier");
        let _ = std::fs::write(std::path::PathBuf::from(stream), "[ZoneTransfer]\r\nZoneId=3\r\n");
    }
}

#[tauri::command]
fn remembered_shares(state: State<'_, AppState>) -> Vec<store::RememberedShare> {
    state.store.remembered_shares()
}

#[tauri::command]
fn forget_share(state: State<'_, AppState>, local: String, project: String) -> Result<(), String> {
    log_info!("share.forget", local = local, project = project);
    state.store.forget_share(&local, &project).map_err(message)
}

#[tauri::command]
async fn share_list(state: State<'_, AppState>) -> Result<Vec<Share>, String> {
    let mut shares: Vec<Share> = state.shares.lock().await.values().cloned().collect();
    shares.sort_by_key(|s| s.id);
    Ok(shares)
}

/// Unmounts every share on the VM, when the connection is up, within 8 s in all:
/// quitting while offline does not hang (the VM cleans dead mounts at the next login).
async fn stop_all_shares(app: &AppHandle, state: &AppState) {
    let shares: Vec<Share> = state.shares.lock().await.drain().map(|(_, s)| s).collect();
    let live = state.connection.lock().await.as_ref().is_some_and(|c| !c.is_closed());
    if shares.is_empty() || !live {
        return;
    }
    let stop = async {
        for share in &shares {
            log_info!("share.stop", id = share.id, local = share.local, why = "disconnecting");
            let _ = api(app, state, &["share-stop", &share.mountpoint], &[]).await;
        }
    };
    if tokio::time::timeout(Duration::from_secs(8), stop).await.is_err() {
        log_warn!("share.stop-timeout", count = shares.len());
    }
}

/// Mounts left behind by a Pier that crashed or lost its connection.
async fn cleanup_stale_shares(app: &AppHandle, state: &AppState) {
    if !state.shares.lock().await.is_empty() {
        return;
    }
    if let Ok(shares) = api(app, state, &["shares"], &[]).await {
        for stale in shares["shares"].as_array().cloned().unwrap_or_default() {
            if let Some(mount) = stale["mountpoint"].as_str() {
                log_info!("share.stale", mountpoint = mount);
                let _ = api(app, state, &["share-stop", mount], &[]).await;
            }
        }
    }
}

// --- logs and diagnostics --------------------------------------------------------

/// A line from the interface: its errors, and what it shows the user going wrong.
#[tauri::command]
fn log_ui(state: State<'_, AppState>, level: String, event: String, fields: Option<serde_json::Map<String, Value>>) {
    let level = Level::parse(&level).unwrap_or(Level::Info);
    if !journal::enabled(level) {
        return;
    }
    {
        let mut budget = state.ui_budget.lock().unwrap();
        if budget.0.elapsed().as_secs() >= 60 {
            if budget.2 > 0 {
                log_warn!("ui.flood", dropped = budget.2, why = "more than 300 lines in a minute");
            }
            *budget = (Instant::now(), 0, 0);
        }
        budget.1 += 1;
        if budget.1 > UI_LINES_PER_MINUTE {
            budget.2 += 1;
            return;
        }
    }
    let event: String = event.chars().filter(|c| c.is_ascii_alphanumeric() || "._-".contains(*c)).take(60).collect();
    let fields: Vec<(String, String)> = fields
        .unwrap_or_default()
        .into_iter()
        .take(12)
        .map(|(key, value)| {
            let key: String = key.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(30).collect();
            let text = match value {
                Value::String(s) => s,
                other => other.to_string(),
            };
            (key, text.chars().take(4000).collect())
        })
        .collect();
    let borrowed: Vec<(&str, String)> = fields.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
    journal::write(level, &format!("ui.{event}"), &borrowed);
}

/// The end of Pier's log, for the Logs tab.
#[tauri::command]
fn log_tail(lines: Option<usize>) -> Vec<String> {
    journal::tail(lines.unwrap_or(1000))
}

/// "Detailed logs": debug lines here, and on the VM.
#[tauri::command]
fn set_log_level(debug: bool) {
    if debug != journal::debug_enabled() {
        log_info!("log.level", detailed = debug);
    }
    journal::set_debug(debug);
}

#[tauri::command]
fn log_info() -> Value {
    let path = journal::path();
    json!({
        "path": path.as_ref().map(|p| p.display().to_string()),
        "dir": path.as_ref().and_then(|p| p.parent()).map(|p| p.display().to_string()),
        "debug": journal::debug_enabled(),
    })
}

/// Opens the folder of the log in the system's file manager.
#[tauri::command]
fn open_log_folder() -> Result<(), String> {
    let dir = journal::path().and_then(|p| p.parent().map(PathBuf::from)).ok_or("no log folder")?;
    let opener = if cfg!(windows) { "explorer" } else if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    std::process::Command::new(opener).arg(&dir).spawn().map_err(|e| format!("{opener}: {e}"))?;
    Ok(())
}

/// A report to send when something goes wrong: versions, the connection (never a
/// password), what runs, and the end of both logs. `extra` comes from the interface.
#[tauri::command]
async fn diagnostics_report(app: AppHandle, state: State<'_, AppState>, extra: Option<String>) -> Result<String, String> {
    let mut out = String::new();
    let now = journal::timestamp(std::time::SystemTime::now());
    out.push_str(&format!("Pier diagnostic report, {now} (UTC)\n"));
    out.push_str("It holds host names, paths and user names; never a password, nor what was typed.\n\n");
    out.push_str(&format!("Pier {} on {} {}\n", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH));
    out.push_str(&format!("log: {}\n", journal::path().map(|p| p.display().to_string()).unwrap_or_default()));
    match state.store.settings() {
        Some(s) => out.push_str(&format!(
            "VM: {}@{}:{}, bastion: {}, picker command: {}\n",
            s.user,
            s.host,
            s.port,
            s.bastion.as_ref().map_or("none".into(), |b| format!("{}@{}:{}", b.user, b.host, b.port)),
            s.remote_command
        )),
        None => out.push_str("VM: not configured\n"),
    }
    let live = state.connection.lock().await.as_ref().is_some_and(|c| !c.is_closed());
    out.push_str(&format!("connected: {live}\n"));
    let remote = state.picker.lock().unwrap().clone();
    out.push_str(&format!(
        "picker: on the VM {}, carried by Pier {} (API {})\n",
        remote.as_ref().map_or("unknown".into(), |v| v.to_string()),
        picker::bundled_version(),
        API_VERSION
    ));
    out.push_str(&format!("live shares: {}\n", state.shares.lock().await.len()));
    if let Some(extra) = extra {
        out.push_str(&extra);
        out.push('\n');
    }
    out.push_str("\n--- Pier log, last 600 lines ---\n");
    for line in journal::tail(600) {
        out.push_str(&line);
        out.push('\n');
    }
    out.push_str("\n--- picker log on the VM, last 400 lines ---\n");
    if live {
        match api(&app, &state, &["log", "400"], &[]).await {
            Ok(log) => {
                for line in log["lines"].as_array().cloned().unwrap_or_default() {
                    out.push_str(line.as_str().unwrap_or_default());
                    out.push('\n');
                }
            }
            Err(err) => out.push_str(&format!("(could not read it: {err})\n")),
        }
    } else {
        out.push_str("(not connected: log in, then make the report again to include it)\n");
    }
    log_info!("report.made", bytes = out.len());
    Ok(out)
}

/// Puts text on the clipboard (the report).
#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    arboard::Clipboard::new().and_then(|mut c| c.set_text(text)).map_err(|e| format!("clipboard: {e}"))
}

/// The text on the clipboard: a right click in a terminal pastes it.
#[tauri::command]
fn clipboard_text() -> Result<String, String> {
    arboard::Clipboard::new().and_then(|mut c| c.get_text()).map_err(|e| format!("clipboard: {e}"))
}

/// Writes text where the user chose to save it (the report).
#[tauri::command]
fn save_text(path: String, text: String) -> Result<(), String> {
    let lower = path.to_ascii_lowercase();
    if !(lower.ends_with(".txt") || lower.ends_with(".log")) {
        return Err("the report is saved as a .txt or .log file".into());
    }
    std::fs::write(&path, text).map_err(|e| format!("{path}: {e}"))?;
    log_info!("report.saved", path = path);
    Ok(())
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let hex = |b: u8| (b as char).to_digit(16);
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((high * 16 + low) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// --- window and tray -----------------------------------------------------------

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn set_tooltip(app: &AppHandle, text: &str) {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(text));
    }
}

// --- updating Pier itself -------------------------------------------------------------
//
// Pier reads latest.json in the project's latest GitHub release (tauri.conf.json, plugins >
// updater). An update is installed only if it was signed with the project's key, whose
// public half is in tauri.conf.json: a file changed on the way, or from elsewhere, is
// refused.

/// Whether a newer Pier is out: {current, version?, notes?, date?}.
#[tauri::command]
async fn update_check(app: AppHandle) -> Result<Value, String> {
    let current = app.package_info().version.to_string();
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => {
            log_info!("update.available", current = current, version = update.version);
            Ok(json!({ "current": current, "version": update.version, "notes": update.body, "date": update.date.map(|d| d.to_string()) }))
        }
        Ok(None) => Ok(json!({ "current": current })),
        Err(e) => {
            log_warn!("update.check-failed", err = e);
            Err(format!("could not check for a new Pier: {e}"))
        }
    }
}

/// Downloads the update, checks its signature, installs it, and starts the new Pier.
/// The download's progress goes to the window as "update-progress" ({done, total}).
#[tauri::command]
async fn update_install(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?
        .ok_or("Pier is already up to date")?;
    log_info!("update.install", version = update.version);
    let progress = app.clone();
    let mut done = 0usize;
    let bytes = update.download(move |chunk, total| {
        done += chunk;
        let _ = progress.emit("update-progress", json!({ "done": done, "total": total }));
    }, || {}).await.map_err(|e| format!("the download failed: {e}"))?;
    // As on Quit: the shares are unmounted first, so the VM keeps no dead mount.
    stop_all_shares(&app, &state).await;
    update.install(bytes).map_err(|e| format!("the installation failed: {e}"))?;
    log_info!("update.installed", version = update.version);
    app.restart();
}

pub fn run() {
    let paste = paste_shortcut();
    tauri::Builder::default()
        // One Pier at a time: starting it again brings the running one forward (two would
        // fight over the shortcut, the connection and the shares).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            log_info!("app.second-start");
            show_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &paste && event.state() == ShortcutState::Pressed {
                        tauri::async_runtime::spawn(send_clipboard(app.clone()));
                    }
                })
                .build(),
        )
        .setup(move |app| {
            let logs = app.path().app_log_dir().unwrap_or_else(|_| std::env::temp_dir().join("pier-logs"));
            let log_file = journal::init(&logs);
            log_info!("app.start", version = env!("CARGO_PKG_VERSION"), os = std::env::consts::OS, arch = std::env::consts::ARCH,
                pid = std::process::id(), picker = picker::bundled_version(), log = log_file.display());
            let handle = app.handle().clone();
            journal::set_listener(move |line| {
                let _ = handle.emit("log-line", line);
            });
            let dir = app.path().app_config_dir()?;
            app.manage(AppState {
                store: Store::new(dir),
                connection: AsyncMutex::new(None),
                extra: AsyncMutex::new(Vec::new()),
                pending_host: std::sync::Mutex::new(None),
                failing_since: std::sync::Mutex::new(None),
                passwords: std::sync::Mutex::new(None),
                terminals: term::Terminals::default(),
                shares: AsyncMutex::new(HashMap::new()),
                next_share: AtomicU32::new(0),
                picker: std::sync::Mutex::new(None),
                ui_budget: std::sync::Mutex::new((Instant::now(), 0, 0)),
                watch: watch::Watch::default(),
            });
            // Another program may own the shortcut: Pier still works from its window.
            if let Err(err) = app.global_shortcut().register(paste) {
                log_warn!("shortcut.unavailable", err = err);
            }
            let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("Pier")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_window(app),
                    "quit" => {
                        // Unmount shares before leaving, so the VM keeps no dead mount.
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let state = app.state::<AppState>();
                            log_info!("app.quit", shares = state.shares.lock().await.len());
                            stop_all_shares(&app, &state).await;
                            app.exit(0);
                        });
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps Pier in the tray, so Ctrl+Alt+V and the shares
            // keep working.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                log_debug!("window.hidden");
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            trust_host,
            connect,
            install_picker,
            picker_info,
            disconnect,
            api_call,
            paste_image,
            paste_files,
            term_open,
            term_write,
            term_resize,
            term_close,
            share_start,
            share_stop,
            share_list,
            remove_upload,
            set_paste_shortcut,
            clipboard_paths,
            copy_folder,
            clear_project,
            remembered_shares,
            forget_share,
            hand_off,
            download_copy,
            takeback_compare,
            takeback_diff,
            takeback_apply,
            write_text,
            resource_toggle,
            skill_create,
            skill_save,
            skill_delete,
            skill_import,
            forge_add,
            forge_remove,
            repo_link,
            repo_unlink,
            repo_create,
            repo_settings,
            task_create,
            labs_settings,
            lab_action,
            machine_add,
            lab_new,
            lab_edit,
            lab_network_describe,
            host_add,
            host_local,
            host_remove,
            host_test,
            machine_remove,
            machine_test,
            handoff_give,
            handoff_take,
            pr_merge,
            update_check,
            update_install,
            approval_answer,
            worktree_remove,
            checkpoint_create,
            checkpoint_restore,
            stop_pi,
            session_label,
            session_mark,
            shares_cleanup,
            shortcut_status,
            watch_start,
            watch_set,
            log_ui,
            log_tail,
            set_log_level,
            log_info,
            open_log_folder,
            diagnostics_report,
            copy_text,
            clipboard_text,
            save_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pier");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("%2Fhome%2Fleo%2Fprojet%20%C3%A9t%C3%A9"), "/home/leo/projet été");
        assert_eq!(percent_decode(""), "");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    #[test]
    fn replies() {
        let ok = ssh::Output { status: Some(0), stdout: br#"{"api":2,"label":"~/a"}"#.to_vec(), stderr: vec![] };
        assert_eq!(reply(ok).unwrap()["label"], "~/a");
        let err = ssh::Output { status: Some(1), stdout: br#"{"api":2,"error":"no pi is running"}"#.to_vec(), stderr: vec![] };
        assert_eq!(reply(err).unwrap_err(), "no pi is running");
        let missing = ssh::Output { status: Some(127), stdout: vec![], stderr: b"sh: pi-pick: not found".to_vec() };
        assert!(reply(missing).unwrap_err().contains("Picker not found"));
        let denied = ssh::Output { status: Some(126), stdout: vec![], stderr: b"env: permission denied".to_vec() };
        assert!(reply(denied).unwrap_err().contains("cannot be run"));
    }

    #[test]
    fn image_sniffing() {
        assert!(is_image(b"\x89PNG\r\n\x1a\nrest"));
        assert!(is_image(b"RIFF\0\0\0\0WEBPVP8 "));
        assert!(!is_image(b"%PDF-1.7"));
        assert!(!is_image(b"RIFF"));
    }

    #[test]
    fn attach_only_takes_known_pi_arguments() {
        let line = attach_command("/home/leo/my blog", &[]).unwrap();
        assert_eq!(line, "--attach-control '/home/leo/my blog'");
        let resume = attach_command("/x", &["--session".into(), "/home/leo/.pi/agent/sessions/--x--/a.jsonl".into()]).unwrap();
        assert!(resume.ends_with("'--session' '/home/leo/.pi/agent/sessions/--x--/a.jsonl'"), "{resume}");
        assert!(attach_command("/x", &["--continue".into()]).is_ok());
        assert!(attach_command("/x", &["--new".into()]).is_ok());
        assert!(attach_command("/x", &["--agent-task".into(), "review".into(), "14".into()]).is_ok());
        assert_eq!(lab_command(&["db-tests".into()]).unwrap(), "--lab-shell 'db-tests'");
        assert!(lab_command(&["x; rm -rf ~".into()]).is_err());
        assert!(lab_command(&["Lab".into()]).is_err());
        assert!(attach_command("/x", &["--agent-task".into(), "shell".into(), "14".into()]).is_err());
        assert!(attach_command("/x", &["--agent-task".into(), "task".into(), "1; rm -rf ~".into()]).is_err());
        assert_eq!(attach_command("/x", &["--slot".into(), "pi-work-a1b2c3-2".into()]).unwrap(), "--attach-control '/x' '--slot' 'pi-work-a1b2c3-2'");
        for bad in [
            vec!["--model".to_string(), "x".into()],
            vec!["--session".into(), "/etc/passwd".into()],
            vec!["; rm -rf ~".into()],
            vec!["--slot".into(), "pi-x; rm -rf ~".into()],
            vec!["--slot".into(), "other".into()],
            vec!["--new".into(), "--continue".into()],
        ] {
            assert!(attach_command("/x", &bad).is_err(), "{bad:?}");
        }
        assert!(attach_command("", &[]).is_err());
    }

    #[test]
    fn package_arguments() {
        assert_eq!(package_command(&["install".into(), "user".into(), "npm:pi-tools".into()]).unwrap(), "--pi-package 'install' 'user' 'npm:pi-tools'");
        assert!(package_command(&["remove".into(), "/home/leo/work".into(), "git:github.com/u/r@v1".into()]).is_ok());
        for bad in [
            vec!["exec".to_string(), "user".into(), "npm:x".into()],
            vec!["install".into(), "home".into(), "npm:x".into()],
            vec!["install".into(), "user".into(), "npm:x; rm -rf ~".into()],
            vec!["install".into(), "user".into(), "/tmp/evil".into()],
            vec!["install".into(), "/a\nb".into(), "npm:x".into()],
        ] {
            assert!(package_command(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn update_arguments() {
        assert_eq!(update_command(&[]).unwrap(), "--pi-update");
        assert_eq!(update_command(&["--all".into()]).unwrap(), "--pi-update '--all'");
        assert_eq!(update_command(&["npm:@scope/pi-x".into()]).unwrap(), "--pi-update 'npm:@scope/pi-x'");
        for bad in [vec!["; rm -rf ~".to_string()], vec!["npm:a b".into()], vec!["--force".into()], vec!["--all".into(), "--all".into()], vec!["npm:x'y".into()]] {
            assert!(update_command(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn passthrough_is_read_only() {
        for command in ["paste-image", "paste-file", "share-prepare", "share-stop", "remove", "write-text", "handoff", "clear", "upload-dir", "checkpoint", "restore", "stop", "watch", "label", "mark"] {
            assert!(!PASSTHROUGH.contains(&command), "{command} must go through its own command");
        }
        for polled in POLLED {
            assert!(PASSTHROUGH.contains(polled) || *polled == "shares", "{polled}");
        }
    }

    #[test]
    fn remote_commands_carry_the_request() {
        let settings = Settings { host: "h".into(), port: 22, user: "u".into(), bastion: None, remote_command: "~/bin/pi-pick".into() };
        journal::set_debug(false);
        let line = remote(&settings, "ab12-3", "--api version");
        assert_eq!(line, posix_line("env DEVBOX_REQUEST=ab12-3 ~/bin/pi-pick --api version"));
        // Whatever the login shell (fish reads backslashes inside quotes): nothing in the
        // line but the fixed wrapper and base64.
        assert!(!line.contains('\\') && line.matches('\'').count() == 2, "{line}");
        let id = next_request();
        assert!(id.len() > 5 && id.contains('-'), "{id}");
        assert_ne!(next_request(), id);
    }

    #[test]
    fn typed_text_is_not_logged() {
        assert_eq!(args_for_log(&["type", "my secret plan", "~/work"]), "type <14 chars> ~/work");
        assert_eq!(args_for_log(&["ls", "/home/leo"]), "ls /home/leo");
    }
}
