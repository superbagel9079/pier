// The Rust side, through Tauri's invoke and events.

// ============================================================================
// Backends
// ============================================================================

function realBackend() {
  const { invoke, Channel } = tauri.core;
  const { listen } = tauri.event;
  return {
    loadSettings: () => invoke("load_settings"),
    saveSettings: (s) => invoke("save_settings", { settings: s }),
    connect: (pw, bastionPw) => invoke("connect", { password: pw, bastionPassword: bastionPw || null }),
    installPicker: () => invoke("install_picker"),
    pickerInfo: () => invoke("picker_info"),
    log: (level, event, fields) => invoke("log_ui", { level, event, fields }),
    logTail: (lines) => invoke("log_tail", { lines }),
    logInfo: () => invoke("log_info"),
    setLogLevel: (debug) => invoke("set_log_level", { debug }),
    openLogFolder: () => invoke("open_log_folder"),
    report: (extra) => invoke("diagnostics_report", { extra }),
    copyText: (text) => invoke("copy_text", { text }),
    clipboardText: () => invoke("clipboard_text"),
    saveText: (path, text) => invoke("save_text", { path, text }),
    // The dialogs are opened by Rust, which keeps what they give (only those paths are accepted after).
    pickSavePath: (name) => invoke("pick_save_path", { name }),
    onLogLine: (handler) => listen("log-line", (event) => handler(event.payload)),
    checkpointCreate: (project, label) => invoke("checkpoint_create", { project, label }),
    stopPi: (project, slot) => invoke("stop_pi", { project, slot }),
    sessionLabel: (project, file, title, category) => invoke("session_label", { project, file, title, category }),
    shortcutStatus: () => invoke("shortcut_status"),
    sessionMark: (project, file, what, on) => invoke("session_mark", { project, file, what, on }),
    watchStart: (want) => invoke("watch_start", { want }),
    watchSet: (want) => invoke("watch_set", { want }),
    onVmUpdate: (handler) => listen("vm-update", (event) => handler(event.payload)),
    onWatchEnded: (handler) => listen("watch-ended", (event) => handler(event.payload)),
    checkpointRestore: (project, id, files) => invoke("checkpoint_restore", { project, id, files }),
    trustHost: (host, fingerprint) => invoke("trust_host", { host, fingerprint }),
    disconnect: () => invoke("disconnect"),
    api: (args) => invoke("api_call", { args }),
    async pasteImage(file, project) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Raw body: no JSON encoding of the image. Header values must be ASCII.
      return invoke("paste_image", bytes, { headers: { "x-target": encodeURIComponent(project) } });
    },
    pasteFiles: (paths, project) => invoke("paste_files", { paths, target: project }),
    removeUpload: (path) => invoke("remove_upload", { path }),
    async notify(title, body) {
      const n = tauri.notification;
      if (!(await n.isPermissionGranted()) && (await n.requestPermission()) !== "granted") return;
      n.sendNotification({ title, body });
    },
    setShortcut: (enabled) => invoke("set_paste_shortcut", { enabled }),
    async termOpen(kind, cols, rows, onBytes, params) {
      const output = new Channel();
      output.onmessage = (message) => {
        onBytes(message instanceof ArrayBuffer ? new Uint8Array(message) : Uint8Array.from(message));
      };
      // An "update" tab can run pi install / pi remove instead (params.termKind "package").
      return invoke("term_open", { kind: params?.termKind ?? kind, cols, rows, output, project: params?.project ?? null, args: params?.args ?? null });
    },
    writeText: (project, which, text) => invoke("write_text", { project, which, text }),
    resourceToggle: (scope, project, kind, source, rel, on) => invoke("resource_toggle", { scope, project, kind, source, rel, on }),
    skillCreate: (scope, project, name, description) => invoke("skill_create", { scope, project, name, description }),
    skillSave: (scope, project, name, text) => invoke("skill_save", { scope, project, name, text }),
    skillDelete: (scope, project, name) => invoke("skill_delete", { scope, project, name }),
    skillImport: (scope, project, path) => invoke("skill_import", { scope, project, path }),
    forgeAdd: (kind, url, token) => invoke("forge_add", { kind, url, token }),
    forgeRemove: (id) => invoke("forge_remove", { id }),
    repoLink: (project, forge, repo) => invoke("repo_link", { project, forge, repo }),
    repoUnlink: (project) => invoke("repo_unlink", { project }),
    repoCreate: (project, forge, name, priv, description) => invoke("repo_create", { project, forge, name, private: priv, description }),
    repoSettings: (project, mode, method, agents = "") => invoke("repo_settings", { project, mode, method, agents }),
    labsSettings: (settings) => invoke("labs_settings", { settings }),
    labAction: (action, name, extra) => invoke("lab_action", { action, name, extra }),
    machineAdd: (name, host, port, user, policy, description = "") => invoke("machine_add", { name, host, port, user, policy, description }),
    labNew: (name, vm, description, networks = null, host = null) => invoke("lab_new", { name, vm, description, networks, host }),
    hostAdd: (name, host, port, user, description) => invoke("host_add", { name, host, port, user, description }),
    hostLocal: (on, description) => invoke("host_local", { on, description }),
    hostRemove: (name) => invoke("host_remove", { name }),
    hostTest: (name) => invoke("host_test", { name }),
    labNetworkDescribe: (name, description) => invoke("lab_network_describe", { name, description }),
    labEdit: (name, newName, description) => invoke("lab_edit", { name, newName, description }),
    machineRemove: (name) => invoke("machine_remove", { name }),
    machineTest: (name) => invoke("machine_test", { name }),
    taskCreate: (project, title, body) => invoke("task_create", { project, title, body }),
    handoffGive: (project, file, to, note) => invoke("handoff_give", { project, file, to, note }),
    handoffTake: (project, branch) => invoke("handoff_take", { project, branch }),
    prMerge: (project, number, method) => invoke("pr_merge", { project, number, method }),
    approvalAnswer: (id, approve) => invoke("approval_answer", { id, approve }),
    worktreeRemove: (project, name) => invoke("worktree_remove", { project, name }),
    termWrite: (id, data) => invoke("term_write", { id, data }).catch(() => {}),
    termResize: (id, cols, rows) => invoke("term_resize", { id, cols, rows }).catch(() => {}),
    termClose: (id) => invoke("term_close", { id }).catch(() => {}),
    shareStart: (path, writable, project) => invoke("share_start", { path, writable, target: project }),
    shareStop: (id, forget = true) => invoke("share_stop", { id, forget }),
    rememberedShares: () => invoke("remembered_shares"),
    forgetShare: (local, project) => invoke("forget_share", { local, project }),
    copyFolder: (path, project) => invoke("copy_folder", { path, target: project }),
    clearProject: (project) => invoke("clear_project", { project }),
    clipboardPaths: () => invoke("clipboard_paths"),
    handOff: (id) => invoke("hand_off", { id }),
    downloadCopy: (path, local) => invoke("download_copy", { path, local }),
    takebackCompare: (path, local) => invoke("takeback_compare", { path, local }),
    takebackDiff: (path, local, rel) => invoke("takeback_diff", { path, local, rel }),
    takebackApply: (path, local, take, remove) => invoke("takeback_apply", { path, local, take, delete: remove }),
    shareList: () => invoke("share_list"),
    pickFolder: (title) => invoke("pick_folder", { title: title || null }),
    pickFiles: () => invoke("pick_files"),
    onDragDrop(handler) {
      tauri.webview.getCurrentWebview().onDragDropEvent((event) => {
        const p = event.payload;
        handler(p.type === "enter" || p.type === "over" ? "over" : p.type, p.paths || [], p.position);
      });
    },
    updateCheck: () => invoke("update_check"),
    updateInstall: () => invoke("update_install"),
    onUpdateProgress: (handler) => listen("update-progress", (event) => handler(event.payload)),
    onClipboardSent: (handler) => listen("clipboard-sent", (event) => handler(event.payload)),
    onConnectionLost: (handler) => listen("connection-lost", (event) => handler(event.payload)),
    onConnectionRetrying: (handler) => listen("connection-retrying", () => handler()),
    onConnectionBack: (handler) => listen("connection-back", (event) => handler(event.payload)),
    sharesCleanup: () => invoke("shares_cleanup"),
    onTermExit: (handler) => listen("term-exit", (event) => handler(event.payload)),
  };
}
