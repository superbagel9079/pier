//! Hand off, and taking a copy back: the download, the comparison, the files brought back.

use crate::*;

/// Hand off: the live share becomes a copy on the VM, at the same path, so Pi keeps
/// working without this computer. The share is remembered, to take it back later.
#[tauri::command]
pub(crate) async fn hand_off(app: AppHandle, state: State<'_, AppState>, id: u32) -> Result<Value, String> {
    let share = state.shares.lock().await.get(&id).cloned().ok_or_else(|| "this share is not live".to_string())?;
    let root = PathBuf::from(&share.local);
    let started = Instant::now();
    // Up to 500 MB: packed into a temporary file and streamed from it, never held in memory.
    let packed = copy::TempArchive::pack(root, HANDOFF_MAX_BYTES, copy::Pack::HandOff).await.map_err(|e| {
        let text = format!("{}: {}", share.local, message(e));
        log_warn!("handoff.refused", id = id, err = text);
        text
    })?;
    log_info!("handoff.packed", id = id, local = share.local, bytes = packed.bytes, ms = started.elapsed().as_millis());
    let mode = if share.writable { "rw" } else { "ro" };
    let mut result = api_from(&app, &state, &["handoff", &share.mountpoint, mode], packed.open().await?, packed.bytes).await?;
    if let Some(gone) = state.shares.lock().await.remove(&id) {
        gone.revoke();
    }
    if let Some(object) = result.as_object_mut() {
        object.insert("left_out".into(), json!(packed.left)); // said in Pier: rebuilt on the VM
    }
    Ok(result)
}

/// Take back, for a handed-off copy Pi could write to: its current version, saved in a
/// new folder next to the original. Nothing on this computer is overwritten.
#[tauri::command]
pub(crate) async fn download_copy(app: AppHandle, state: State<'_, AppState>, path: String, local: String) -> Result<String, String> {
    let original = given_path(&state, &local)?; // the share's own folder, never another
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
        ssh::run_into(channel, &command, &b""[..], &mut file, TAKEBACK_MAX).await
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
pub(crate) async fn takeback_compare(app: AppHandle, state: State<'_, AppState>, path: String, local: String) -> Result<Value, String> {
    let remote = api(&app, &state, &["copy-manifest", &path], &[]).await?;
    let root = given_path(&state, &local)?;
    let started = Instant::now();
    let (mine, truncated) = tokio::task::spawn_blocking(move || takeback::local_manifest(&root))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{local}: {}", message(e)))?;
    let result = takeback::compare(&mine, &takeback::remote_manifest(&remote));
    log_info!(
        "takeback.compare",
        path = path,
        local = local,
        changed = result.changed.len(),
        added = result.added.len(),
        deleted = result.deleted.len(),
        same = result.same,
        ms = started.elapsed().as_millis()
    );
    Ok(json!({
        "changed": result.changed, "added": result.added, "deleted": result.deleted, "same": result.same,
        "links": remote.get("links").cloned().unwrap_or(Value::Null),
        "truncated": truncated || remote.get("truncated").and_then(Value::as_bool).unwrap_or(false),
    }))
}

/// One file's difference: this computer's version against the copy's (a unified diff).
#[tauri::command]
pub(crate) async fn takeback_diff(app: AppHandle, state: State<'_, AppState>, path: String, local: String, rel: String) -> Result<Value, String> {
    let root = given_path(&state, &local)?;
    let mine = {
        let rel = rel.clone();
        tokio::task::spawn_blocking(move || takeback::read_local(&root, &rel, 1024 * 1024)).await.map_err(|e| e.to_string())?.map_err(message)?
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
pub(crate) async fn takeback_apply(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    local: String,
    take: Vec<String>,
    delete: Vec<String>,
) -> Result<Value, String> {
    let root = given_path(&state, &local)?;
    if !root.is_dir() {
        return Err(format!("{local} is not a folder"));
    }
    if take.iter().chain(delete.iter()).any(|rel| takeback::safe_parts(rel).is_none()) {
        return Err("a file name from the VM is not acceptable here".into());
    }
    let parent = root.parent().ok_or_else(|| format!("{local} has no parent folder"))?.to_path_buf();
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "folder".into());
    // A folder of its own each time, to the second (and numbered): two take backs in
    // the same minute no longer save into the same folder, the second over the first.
    let when = journal::timestamp(std::time::SystemTime::now()).replace('T', " ").replace(':', "-");
    let mut backup = parent.join(format!("{name} (before Pi's changes {})", &when[..19]));
    let mut n = 2;
    while backup.exists() {
        backup = parent.join(format!("{name} (before Pi's changes {} {n})", &when[..19]));
        n += 1;
    }
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
    log_info!(
        "takeback.applied",
        req = request,
        path = path,
        local = local,
        taken = applied.taken.len(),
        deleted = applied.deleted.len(),
        skipped = applied.skipped.len(),
        backup = applied.backup.clone().unwrap_or_default(),
        ms = started.elapsed().as_millis()
    );
    serde_json::to_value(applied).map_err(|e| e.to_string())
}

/// Largest take-back archive, and most bytes it may unpack to.
pub(crate) const TAKEBACK_MAX: u64 = 600 * 1024 * 1024;
pub(crate) const TAKEBACK_UNPACKED_MAX: u64 = 2 * 1024 * 1024 * 1024;

/// Unpacks a take-back into `staging` (a folder of its own), then moves its top folder
/// to `target`. Only folders and plain files whose names mean the same here as on the VM
/// (takeback::safe_parts): links, devices and the like are skipped (a link could point
/// anywhere on this computer), and so are "x.exe:Zone.Identifier" (written as the mark of
/// x.exe, it would take it off) and "NUL". Every file is marked as coming from elsewhere
/// (Mark of the Web), so Windows warns before running or opening it; a mark that cannot
/// be written stops the take back.
pub(crate) fn unpack_takeback(archive: &std::path::Path, staging: &std::path::Path, target: &std::path::Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(staging)?;
    let mut tar = tar::Archive::new(std::fs::File::open(archive)?);
    let (mut total, mut skipped) = (0u64, 0u32);
    for entry in tar.entries()? {
        let mut entry = entry?;
        let kind = entry.header().entry_type();
        let rel = entry.path()?.to_string_lossy().replace('\\', "/");
        let rel = rel.trim_start_matches("./").trim_end_matches('/');
        if !(kind.is_file() || kind.is_dir()) || takeback::safe_parts(rel).is_none() {
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
            mark_from_elsewhere(&path).map_err(|e| anyhow::anyhow!("{}: could not mark it as coming from elsewhere: {e}", path.display()))?;
        }
    }
    if skipped > 0 {
        log_info!("takeback.skipped", entries = skipped, why = "links, special files and names Windows reads otherwise are not taken back");
    }
    let top = std::fs::read_dir(staging)?.flatten().find(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.path());
    match top {
        Some(top) => std::fs::rename(top, target)?,
        None => std::fs::create_dir_all(target)?,
    }
    Ok(())
}

/// Zone.Identifier, as browsers write it for downloads: zone 3, the Internet. On macOS
/// the quarantine attribute, as Safari sets it: Gatekeeper asks before opening the file.
pub(crate) fn mark_from_elsewhere(path: &std::path::Path) -> std::io::Result<()> {
    if cfg!(windows) {
        let mut stream = path.as_os_str().to_owned();
        stream.push(":Zone.Identifier");
        return std::fs::write(std::path::PathBuf::from(stream), "[ZoneTransfer]\r\nZoneId=3\r\n");
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        extern "C" {
            fn setxattr(
                path: *const std::ffi::c_char,
                name: *const std::ffi::c_char,
                value: *const std::ffi::c_void,
                size: usize,
                position: u32,
                options: i32,
            ) -> i32;
        }
        let when = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let value = format!("0081;{when:x};Pier;");
        let file = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(std::io::Error::other)?;
        // SAFETY: both strings are NUL-terminated and live through the call; value is read for its length only.
        let done = unsafe { setxattr(file.as_ptr(), c"com.apple.quarantine".as_ptr(), value.as_ptr().cast(), value.len(), 0, 0) };
        if done != 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}
