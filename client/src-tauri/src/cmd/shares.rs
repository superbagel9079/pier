//! Shares: a folder of this computer lent to the VM live, and those remembered.

use crate::*;

// --- shares -------------------------------------------------------------------------

/// Lends a local folder to the VM, mounted live in the project's .pi-shared.
#[tauri::command]
pub(crate) async fn share_start(app: AppHandle, state: State<'_, AppState>, path: String, writable: bool, target: String) -> Result<Share, String> {
    let local = given_path(&state, &path)?;
    if writable
        && !confirmed(&app, &format!("Lend {path} to the VM for writing? Pi will be able to change and delete the files in it, on this computer.")).await
    {
        return Err("not shared".into());
    }
    if !local.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    let fs = share::ShareFs::new(&local, writable).map_err(|e| format!("{path}: {e}"))?;
    let revoked = fs.revoker();
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
        revoked.store(true, Ordering::Relaxed);
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
        revoked,
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
pub(crate) async fn share_stop(app: AppHandle, state: State<'_, AppState>, id: u32, forget: Option<bool>) -> Result<(), String> {
    let share = state.shares.lock().await.remove(&id);
    if let Some(share) = share {
        share.revoke();
        log_info!("share.stop", id = id, local = share.local, forget = forget.unwrap_or(true));
        if forget.unwrap_or(true) {
            let _ = state.store.forget_share(&share.local, &share.project);
        }
        api(&app, &state, &["share-stop", &share.mountpoint], &[]).await?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn remembered_shares(state: State<'_, AppState>) -> Vec<store::RememberedShare> {
    state.store.remembered_shares()
}

#[tauri::command]
pub(crate) fn forget_share(state: State<'_, AppState>, local: String, project: String) -> Result<(), String> {
    log_info!("share.forget", local = local, project = project);
    state.store.forget_share(&local, &project).map_err(message)
}

#[tauri::command]
pub(crate) async fn share_list(state: State<'_, AppState>) -> Result<Vec<Share>, String> {
    let mut shares: Vec<Share> = state.shares.lock().await.values().cloned().collect();
    shares.sort_by_key(|s| s.id);
    Ok(shares)
}

/// Unmounts every share on the VM, when the connection is up, within 8 s in all:
/// quitting while offline does not hang (the VM cleans dead mounts at the next login).
pub(crate) async fn stop_all_shares(app: &AppHandle, state: &AppState) {
    let shares: Vec<Share> = state.shares.lock().await.drain().map(|(_, s)| s).collect();
    shares.iter().for_each(Share::revoke);
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
pub(crate) async fn cleanup_stale_shares(app: &AppHandle, state: &AppState) {
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
