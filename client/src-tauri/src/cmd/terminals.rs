//! Terminals (Pi, the picker, shells) and the watch.

use crate::*;

// --- terminals ----------------------------------------------------------------------

/// The command line of a "pi" terminal: the picker's --attach-control, which opens
/// the Pi (see open_pi there) and attaches to it in tmux's control mode (term.rs).
/// Only what Pier itself asks is accepted: the Pi used last or a new one (nothing),
/// a new Pi (--new), a running one (--slot NAME), or a conversation (--continue,
/// --session FILE): its Pi if one runs it, else a new Pi on it.
pub(crate) fn attach_command(project: &str, args: &[String]) -> Result<String, String> {
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
pub(crate) fn package_source(s: &str) -> bool {
    (s.starts_with("npm:") || s.starts_with("git:") || s.starts_with("https://"))
        && s.len() <= 200
        && s.chars().all(|c| c.is_ascii_alphanumeric() || "@/._:+~-".contains(c))
}

pub(crate) fn update_command(args: &[String]) -> Result<String, String> {
    let source = package_source;
    match args {
        [] => Ok("--pi-update".into()),
        [flag] if flag == "--all" || flag == "--extensions" || source(flag) => Ok(format!("--pi-update {}", sh_quote(flag))),
        _ => Err("unsupported update".into()),
    }
}

/// `pi install` / `pi remove` run by the picker in a terminal, in Pi's sandbox: for the
/// user ("user") or a project (its path, checked to be in home on the VM).
pub(crate) fn package_command(args: &[String]) -> Result<String, String> {
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
pub(crate) fn lab_command(args: &[String]) -> Result<String, String> {
    match args {
        [name] if lab_name(name) => Ok(format!("--lab-shell {}", sh_quote(name))),
        _ => Err("unsupported lab".into()),
    }
}

pub(crate) fn lab_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && name.len() <= 40
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// kind "picker" runs the picker, "shell" the login shell, "pi" Pi itself in `project`
/// (with `args`: nothing, --continue, or --session FILE), "update" `pi update` (see
/// update_command).
#[tauri::command]
pub(crate) async fn term_open(
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
pub(crate) async fn stop_pi(app: AppHandle, state: State<'_, AppState>, project: String, slot: Option<String>) -> Result<Value, String> {
    api(&app, &state, &["stop", &project, slot.as_deref().unwrap_or("")], &[]).await
}

/// Names a conversation and files it under a category, in Pier (Pi's file is not
/// touched). Empty both: the label goes.
#[tauri::command]
pub(crate) async fn session_label(app: AppHandle, state: State<'_, AppState>, project: String, file: String, title: String, category: String) -> Result<Value, String> {
    api(&app, &state, &["label", &project, &file, &title, &category], &[]).await
}

/// Pins a conversation (kept on top) or archives it (out of the lists, still found by a
/// search): `what` is "pinned" or "archived".
#[tauri::command]
pub(crate) async fn session_mark(app: AppHandle, state: State<'_, AppState>, project: String, file: String, what: String, on: bool) -> Result<Value, String> {
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
pub(crate) async fn watch_start(app: AppHandle, state: State<'_, AppState>, want: Value) -> Result<u32, String> {
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
pub(crate) async fn watch_set(state: State<'_, AppState>, want: Value) -> Result<(), String> {
    log_debug!("watch.want", want = want);
    state.watch.send(&want).await.map_err(message)
}

#[tauri::command]
pub(crate) async fn term_write(state: State<'_, AppState>, id: u32, data: String) -> Result<(), String> {
    // What is typed is never logged, not even at debug level.
    state.terminals.write(id, data.as_bytes()).await.map_err(message)
}

/// The tab has written `bytes` more of its output (flow control, see term.rs).
#[tauri::command]
pub(crate) async fn term_read(state: State<'_, AppState>, id: u32, bytes: u64) -> Result<(), String> {
    state.terminals.read(id, bytes).await;
    Ok(())
}

#[tauri::command]
pub(crate) async fn term_resize(state: State<'_, AppState>, id: u32, cols: u32, rows: u32) -> Result<(), String> {
    log_debug!("term.resize", id = id, size = format!("{cols}x{rows}"));
    state.terminals.resize(id, cols, rows).await.map_err(message)
}

#[tauri::command]
pub(crate) async fn term_close(state: State<'_, AppState>, id: u32) -> Result<(), String> {
    log_debug!("term.close", id = id);
    state.terminals.close(id).await;
    Ok(())
}
