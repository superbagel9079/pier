//! Pier: desktop companion for a development VM.
//!
//! It talks to the VM over one SSH connection: terminals are channels of it, and the
//! picker's API ("pi-pick --api ...", JSON replies) does the rest. No port is opened
//! on the VM. The picker itself is built into Pier and installed by it (picker.rs).
//! Everything that happens is logged (journal.rs), next to the picker's own log.

#[macro_use]
mod journal;
mod lines;
mod clip;
mod copy;
mod picker;
mod share;
mod ssh;
mod store;
mod takeback;
mod term;
mod watch;
mod cmd;
mod grants;

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
use cmd::send::*;
use cmd::terminals::*;
use cmd::shares::*;
use cmd::setup::*;
use cmd::forge::*;
use cmd::labs::*;
use cmd::take_back::*;

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
    /// The SFTP server's (share::ShareFs::revoker).
    #[serde(skip)]
    revoked: Arc<std::sync::atomic::AtomicBool>,
}

impl Share {
    /// Nothing more is served: called whenever the share leaves the list (stopped, handed
    /// off, the connection lost), as the VM's lazy unmount leaves a way in to whoever
    /// is still inside it.
    fn revoke(&self) {
        self.revoked.store(true, Ordering::Relaxed);
    }
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
    /// The local paths the user handed over (grants.rs).
    grants: grants::Grants,
}

/// Yes or no, asked by Rust in a window of the system: what lets Pi do more than it
/// could is confirmed there, where a script in the page could neither answer nor skip
/// it (S13 of the audit of 2026-10-26).
pub(crate) async fn confirmed(app: &AppHandle, text: &str) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(text)
        .title("Pier")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Yes".into(), "Cancel".into()))
        .show(move |yes| {
            let _ = tx.send(yes);
        });
    let yes = rx.await.unwrap_or(false);
    log_info!("confirm", asked = text.chars().take(120).collect::<String>(), answer = if yes { "yes" } else { "no" });
    yes
}

/// A local path from the page, accepted only when the user gave it (grants.rs): picked,
/// dropped, pasted, or a folder already shared.
fn given_path(state: &AppState, path: &str) -> Result<PathBuf, String> {
    let shared: Vec<String> = state.store.remembered_shares().into_iter().map(|s| s.local).collect();
    state.grants.check(path, &shared)
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
    // A known_hosts.json that cannot be read would make the VM's key look new (first
    // contact) instead of changed: no connection then, the user is told.
    state.store.check_known()?;
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
    dropped.iter().for_each(Share::revoke);
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
/// The longest a command of the picker may take before Pier stops waiting for it (a
/// picker stuck on a stalled sshfs would hold the interface's promise, and a channel
/// counted in MaxSessions, for good). Not for what sends a lot (an upload, a hand off).
const VM_EXEC_TIMEOUT: Duration = Duration::from_secs(300);
const VM_EXEC_UNTIMED_FROM: usize = 1024 * 1024;

async fn vm_exec(app: &AppHandle, state: &AppState, command: &str, stdin: &[u8]) -> Result<ssh::Output, String> {
    vm_exec_from(app, state, command, stdin, stdin.len() as u64).await
}

/// The same, with `len` bytes read from `stdin` as they are sent.
async fn vm_exec_from(
    app: &AppHandle,
    state: &AppState,
    command: &str,
    stdin: impl tokio::io::AsyncRead + Unpin,
    len: u64,
) -> Result<ssh::Output, String> {
    let channel = vm_channel(app, state).await?;
    if len >= VM_EXEC_UNTIMED_FROM as u64 {
        return ssh::run(channel, command, stdin).await.map_err(message);
    }
    match tokio::time::timeout(VM_EXEC_TIMEOUT, ssh::run(channel, command, stdin)).await {
        Ok(done) => done.map_err(message),
        Err(_) => Err(format!("the VM did not answer within {} s", VM_EXEC_TIMEOUT.as_secs())),
    }
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
    api_from(app, state, args, stdin, stdin.len() as u64).await
}

/// The same, with `len` bytes of input read from `stdin` as they are sent (a file).
async fn api_from(
    app: &AppHandle,
    state: &AppState,
    args: &[&str],
    stdin: impl tokio::io::AsyncRead + Unpin,
    len: u64,
) -> Result<Value, String> {
    let settings = settings(state)?;
    let request = next_request();
    let quoted: Vec<String> = args.iter().map(|a| sh_quote(a)).collect();
    let command = remote(&settings, &request, &format!("--api {}", quoted.join(" ")));
    let started = Instant::now();
    let name = args.first().copied().unwrap_or("?");
    let output = vm_exec_from(app, state, &command, stdin, len).await.map_err(|text| {
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
            let sent = if len == 0 { String::new() } else { len.to_string() };
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
async fn save_settings(app: AppHandle, state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    // The picker command runs on the VM at every call: a change is confirmed.
    if let Some(old) = state.store.settings() {
        if old.remote_command != settings.remote_command
            && !confirmed(&app, &format!("Run \"{}\" on the VM as Pier's picker, instead of \"{}\"?", settings.remote_command, old.remote_command)).await
        {
            return Err("the picker command was not changed".into());
        }
    }
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
fn save_text(state: State<'_, AppState>, path: String, text: String) -> Result<(), String> {
    if !state.grants.take_save(&path) {
        return Err("choose where to save it first".into());
    }
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
        // The window shows Pier's own pages and nothing else: a link or a script that
        // would take it elsewhere is refused (links are copied, never opened).
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("navigation-guard")
                .on_navigation(|_, url| {
                    let own = matches!(url.scheme(), "tauri" | "asset")
                        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"));
                    if !own {
                        log_warn!("window.navigation-refused", url = url.as_str().chars().take(200).collect::<String>());
                    }
                    own
                })
                .build(),
        )
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
                grants: grants::Grants::default(),
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
            // What is dropped on the window is given to Pier (grants.rs).
            if let WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let state = window.state::<AppState>();
                for path in paths {
                    state.grants.grant(path);
                }
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
            term_read,
            term_resize,
            term_close,
            share_start,
            share_stop,
            share_list,
            remove_upload,
            set_paste_shortcut,
            clipboard_paths,
            pick_folder,
            pick_files,
            pick_save_path,
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

    #[test]
    fn a_download_keeps_its_marks() {
        let dir = std::env::temp_dir().join(format!("pier-download-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("copy.tar");
        {
            let mut builder = tar::Builder::new(std::fs::File::create(&archive).unwrap());
            // Written by hand: the tar crate refuses some of these names itself.
            let entry = |builder: &mut tar::Builder<std::fs::File>, name: &str, kind: tar::EntryType, body: &[u8]| {
                let mut header = tar::Header::new_gnu();
                header.set_size(body.len() as u64);
                header.set_mode(0o755);
                header.set_entry_type(kind);
                header.as_old_mut().name[..name.len()].copy_from_slice(name.as_bytes());
                header.set_cksum();
                builder.append(&header, body).unwrap();
            };
            entry(&mut builder, "top/", tar::EntryType::Directory, b"");
            entry(&mut builder, "top/payload.exe", tar::EntryType::Regular, b"MZ");
            entry(&mut builder, "top/payload.exe:Zone.Identifier", tar::EntryType::Regular, b"[ZoneTransfer]\r\nZoneId=0\r\n");
            entry(&mut builder, "top/NUL", tar::EntryType::Regular, b"x");
            builder.finish().unwrap();
        }
        let target = dir.join("top (from Pi)");
        unpack_takeback(&archive, &dir.join("staging"), &target).expect("NUL no longer stops it");
        assert_eq!(std::fs::read(target.join("payload.exe")).unwrap(), b"MZ");
        if cfg!(windows) {
            let mark = std::fs::read_to_string(target.join("payload.exe:Zone.Identifier")).unwrap();
            assert!(mark.contains("ZoneId=3"), "still from the Internet: {mark}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
