// Logging in: the VM's address, the password, its fingerprint, the picker on the VM;
// then the Pi in use, followed.

// ============================================================================
// Connection screens
// ============================================================================

function showConnect(view) {
  $("#workspace").hidden = true;
  $("#prefs").hidden = true;
  $("#connect").hidden = false;
  for (const name of ["setup", "login", "trust", "picker"]) $(`#view-${name}`).hidden = name !== view;
  $("#btn-prefs").hidden = true;
  $("#btn-palette").hidden = true;
  $("#btn-handoff").hidden = true;
  $("#btn-disconnect").hidden = true;
  $("#target").hidden = true;
}

function showWorkspace() {
  $("#connect").hidden = true;
  $("#workspace").hidden = false;
  $("#btn-prefs").hidden = false;
  $("#btn-palette").hidden = false;
  $("#btn-handoff").hidden = false;
  $("#btn-disconnect").hidden = false;
  renderSessionBadge();
}

function showError(node, message) {
  node.textContent = message || "";
  node.hidden = !message;
  // Logged once per message: a panel that polls would repeat the same error.
  if (message && node.dataset.logged !== String(message)) uiLog("warn", "shown-error", { where: whereOf(node), msg: String(message) });
  node.dataset.logged = message ? String(message) : "";
}

function describe(s) {
  const vm = `${s.user}@${s.host}:${s.port}`;
  return s.bastion ? `${vm} via ${s.bastion.user}@${s.bastion.host}:${s.bastion.port}` : vm;
}

function setStatus(text) {
  $("#status").textContent = text;
}

function fillSetup(s) {
  const form = $("#setup-form");
  form.host.value = s?.host ?? "";
  form.port.value = s?.port ?? 22;
  form.user.value = s?.user ?? "";
  form.use_bastion.checked = Boolean(s?.bastion);
  form.bastion_host.value = s?.bastion?.host ?? "";
  form.bastion_port.value = s?.bastion?.port ?? 22;
  form.bastion_user.value = s?.bastion?.user ?? "";
  form.remote_command.value = s?.remote_command ?? "~/bin/pi-pick";
  toggleBastion();
}

function toggleBastion() {
  const form = $("#setup-form");
  const on = form.use_bastion.checked;
  $("#bastion-fields").hidden = !on;
  $("#bastion-fields").disabled = !on;
  form.bastion_host.required = on;
  form.bastion_user.required = on;
}

$("#setup-form").use_bastion.addEventListener("change", toggleBastion);

$("#setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const next = {
    host: form.host.value.trim(),
    port: Number(form.port.value),
    user: form.user.value.trim(),
    bastion: form.use_bastion.checked
      ? { host: form.bastion_host.value.trim(), port: Number(form.bastion_port.value), user: form.bastion_user.value.trim() }
      : null,
    remote_command: form.remote_command.value.trim() || "~/bin/pi-pick",
  };
  try {
    await backend.saveSettings(next);
    settings = next;
    showError($("#setup-error"), "");
    toLogin();
  } catch (error) {
    showError($("#setup-error"), String(error));
  }
});

function toLogin(message) {
  $("#login-target").textContent = describe(settings);
  $("#bastion-password-label").hidden = !settings.bastion;
  $("#login-form").bastion_password.required = Boolean(settings.bastion);
  showError($("#login-error"), message || "");
  showConnect("login");
  (settings.bastion ? $("#login-form").bastion_password : $("#login-form").password).focus();
}

$("#btn-edit-connection").addEventListener("click", () => {
  fillSetup(settings);
  showConnect("setup");
});

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  password = event.target.password.value;
  bastionPassword = event.target.bastion_password.value;
  await connect();
});

async function connect() {
  const button = $("#btn-connect");
  button.disabled = true;
  button.textContent = "Connecting…";
  setStatus("connecting…");
  try {
    uiLog("info", "connect", { to: describe(settings) });
    const outcome = await backend.connect(password, bastionPassword);
    uiLog("info", "connect-outcome", { status: outcome.status });
    if (outcome.status === "connected") {
      forgetPasswords();
      await enterWorkspace();
    } else if (outcome.status.startsWith("picker_")) {
      forgetPasswords(); // connected: Pier keeps them, to reconnect
      await pickerOutcome(outcome);
    } else if (outcome.status === "unknown_host") {
      pendingTrust = outcome;
      $("#trust-title").textContent = "First contact";
      $("#trust-text").textContent = `This is the first connection to ${outcome.host} (${outcome.which === "bastion" ? "the bastion" : "the VM"}). Check that its fingerprint is this one:`;
      $("#trust-fingerprint").textContent = outcome.fingerprint;
      $("#btn-trust").hidden = false;
      setStatus("not connected");
      showConnect("trust");
    } else if (outcome.status === "changed_host") {
      pendingTrust = null;
      forgetPasswords();
      $("#trust-title").textContent = "Different fingerprint: connection refused";
      $("#trust-text").textContent = `The fingerprint of ${outcome.host} changed since the last connection. Unless the machine was reinstalled, someone may be impersonating it. Nothing was sent, not even the password.`;
      $("#trust-fingerprint").textContent = `known     ${outcome.known}\npresented ${outcome.fingerprint}`;
      $("#btn-trust").hidden = true;
      setStatus("not connected");
      showConnect("trust");
    }
  } catch (error) {
    forgetPasswords();
    setStatus("not connected");
    toLogin(String(error));
  } finally {
    button.disabled = false;
    button.textContent = "Connect";
  }
}

async function enterWorkspace(note = "") {
  setStatus(`connected · ${describe(settings)}`);
  if (note) flashStatus(note);
  showWorkspace();
  backend.setShortcut(prefs.shortcut).catch(() => {});
  workspace.restore();
  await refreshTarget();
  vm.start();
  resumeShares();
}

// The picker Pier carries, against the one on the VM: installed when missing (after
// asking), updated by itself when older (unless that setting is off).
let pendingPicker = null;

async function pickerOutcome(outcome, { tried = false } = {}) {
  pendingPicker = outcome;
  const older = outcome.status === "picker_outdated";
  if (older && prefs.autoUpdatePicker && outcome.installable && !tried) {
    await installPicker(`updating the picker on the VM (${outcome.remote} → ${outcome.bundled})…`);
    return;
  }
  const title = { picker_missing: "Install the picker on the VM", picker_outdated: "Update the picker on the VM",
    picker_newer: "The picker on the VM is newer than this Pier" }[outcome.status];
  const text = {
    picker_missing: `Pier works through its picker on the VM, expected at ${outcome.command}, and it is not there yet. Pier carries it (version ${outcome.bundled}) and can install it: one file, Python 3 is all it needs.`,
    picker_outdated: `The picker on the VM is version ${outcome.remote}, this Pier carries ${outcome.bundled}. Update it to use this Pier; the old one is kept next to it, as ${outcome.command}.previous.`,
    picker_newer: `The picker on the VM is version ${outcome.remote}, this Pier carries ${outcome.bundled}: update Pier. Or put this Pier's version on the VM (the newer one is kept as ${outcome.command}.previous).`,
  }[outcome.status];
  $("#picker-title").textContent = title;
  $("#picker-text").textContent = text;
  $("#picker-detail").textContent = outcome.installable ? (outcome.detail ? `The VM said: ${outcome.detail}` : "")
    : `Pier cannot install it there: the picker command (${outcome.command}) is not a plain path like ~/bin/pi-pick. Change it with "change connection" > Advanced, or install pier-picker.py there by hand.`;
  const button = $("#btn-picker-install");
  button.hidden = !outcome.installable;
  button.textContent = { picker_missing: "Install it", picker_outdated: "Update it", picker_newer: "Use this Pier's version" }[outcome.status];
  showError($("#picker-error"), tried ? "The picker on the VM still does not match after installing it: see the log (Settings, Diagnostics)." : "");
  setStatus(`connected · ${describe(settings)} · the picker needs attention`);
  showConnect("picker");
}

async function installPicker(status) {
  const button = $("#btn-picker-install");
  button.disabled = true;
  setStatus(status || "installing the picker on the VM…");
  uiLog("info", "picker-install", { from: pendingPicker?.remote || "none", to: pendingPicker?.bundled });
  try {
    const outcome = await backend.installPicker();
    if (outcome.status === "connected") {
      await enterWorkspace(`picker ${outcome.bundled} installed on the VM`);
    } else {
      await pickerOutcome(outcome, { tried: true });
    }
  } catch (error) {
    await pickerOutcome(pendingPicker, { tried: true });
    showError($("#picker-error"), String(error));
  } finally {
    button.disabled = false;
  }
}

$("#btn-picker-install").addEventListener("click", () => installPicker());
$("#btn-picker-cancel").addEventListener("click", async () => {
  await leave();
  toLogin();
});

function forgetPasswords() {
  password = "";
  bastionPassword = "";
  $("#login-form").reset();
}

$("#btn-trust").addEventListener("click", async () => {
  if (!pendingTrust) return;
  await backend.trustHost(pendingTrust.host, pendingTrust.fingerprint);
  pendingTrust = null;
  await connect();
});

$("#btn-untrust").addEventListener("click", () => {
  pendingTrust = null;
  forgetPasswords();
  toLogin();
});

$("#btn-disconnect").addEventListener("click", async () => {
  await leave();
  toLogin();
});

async function leave() {
  vm.stop();
  workspace.save();
  workspace.clear();
  wasRunning = null;
  await backend.disconnect();
  setStatus("not connected");
}

// Silent reconnection: the bar says so; the panels keep what they showed.
backend.onConnectionRetrying(() => setStatus("reconnecting…"));
backend.onConnectionBack(async () => {
  setStatus(settings ? `connected · ${describe(settings)}` : "connected");
  uiLog("info", "reconnected");
  for (const tab of workspace.tabs()) tab.reattach?.();  // terminals the drop ended
  try { await backend.sharesCleanup(); } catch { /* next time */ }
  await resumeShares();
  vm.poke();
});

backend.onConnectionLost((message) => {
  vm.stop();
  workspace.save();
  workspace.clear();
  setStatus("not connected");
  toLogin(message);
});

// ============================================================================
// Target: the project of the Pi in use, followed automatically
// ============================================================================

/** The projects, asked once even when several tabs want them at the same moment. */
let projectsAsked = null;
function fetchProjects() {
  projectsAsked ||= backend.api(["projects"]).finally(() => { projectsAsked = null; });
  return projectsAsked;
}

/** Once, right after connecting; then the watch sends the projects when they change. */
async function refreshTarget() {
  try {
    await applyProjects(await fetchProjects());
  } catch {
    /* connection trouble is reported elsewhere */
  }
}

vm.on("projects", (message) => { if (message.data) applyProjects(message.data); });

/** "#2" for the second Pi of a project; nothing for the first. */
function piNumber(pi) {
  return pi && pi.n > 1 ? ` #${pi.n}` : "";
}

/** The projects and their Pis, from the VM: one list for every tab, so that none shows
 *  a Pi that has ended. */
async function applyProjects(projects) {
  const wasRunningNow = [...running].sort().join("|");
  running = new Set(projects.running.map((p) => p.path));
  lastProjects = projects;
  noticeFinishedWork(projects.running);
  const current = projects.running[0];
  const pi = current?.pis?.[0];
  const next = current ? { path: current.path, label: current.label, slot: pi?.slot, n: pi?.n || 1 } : null;
  const changed = next?.path !== target?.path;
  target = next;
  renderSessionBadge();
  if (changed) for (const tab of workspace.tabs()) tab.onTargetChange?.();
  const runningChanged = [...running].sort().join("|") !== wasRunningNow;
  for (const tab of workspace.tabs()) tab.onProjects?.(projects, runningChanged);
  await projectsEnded();
}

// A Pi that was working and is now idle has finished: tell the user, unless Pier
// is in front of them already.
const wasWorking = new Map();

function noticeFinishedWork(runningProjects) {
  const seen = new Set();
  for (const project of runningProjects) {
    for (const pi of project.pis || [{ slot: "", working: project.working }]) {
      const key = `${project.path}|${pi.slot}`;
      seen.add(key);
      if (wasWorking.get(key) && !pi.working && prefs.notify && !document.hasFocus()) {
        backend.notify("Pi finished", `${project.label}${piNumber(pi)} is waiting for you`).catch(() => {});
      }
      wasWorking.set(key, Boolean(pi.working));
    }
  }
  for (const key of [...wasWorking.keys()]) if (!seen.has(key)) wasWorking.delete(key);
}

// What happens to what was given to a project when its Pi ends: live shares stop
// (and are forgotten) unless that setting is off; images, files and copies stay,
// unless "clear on end" is on. Either way, the × removes them one by one.
let wasRunning = null;

// A project counts as ended after two answers in a row without its Pi: one odd answer
// (tmux slow to reply) never stops shares or deletes files.
const missing = new Map();
async function projectsEnded() {
  if (wasRunning === null) { wasRunning = new Set(running); return; }
  for (const p of running) missing.delete(p);
  const ended = [];
  for (const p of wasRunning) {
    if (running.has(p)) continue;
    const n = (missing.get(p) || 0) + 1;
    missing.set(p, n);
    if (n === 2) ended.push(p);
  }
  wasRunning = new Set([...running, ...[...missing.keys()].filter((p) => missing.get(p) < 2)]);
  for (const p of ended) missing.delete(p);
  if (!ended.length) return;
  const notes = [];
  for (const project of ended) {
    const label = project.replace(/^\/home\/[^/]+/, "~");
    if (prefs.autostop) {
      for (const share of await backend.shareList()) {
        if (share.project !== project) continue;
        try { await backend.shareStop(share.id, true); notes.push(`stopped sharing ${share.local}`); } catch { /* next tick */ }
      }
      for (const kept of await backend.rememberedShares()) {
        if (kept.project === project) await backend.forgetShare(kept.local, kept.project).catch(() => {});
      }
    }
    if (prefs.clearOnEnd) {
      try { await backend.clearProject(project); notes.push(`deleted what was given to ${label}`); } catch { /* next tick */ }
    }
    if (notes.length) workspace.find("context")?.onNote?.(`The Pi of ${label} ended: ${notes.join(", ")}.`);
  }
  workspace.find("context")?.refresh?.();
}

/** After a reconnection: shares that were live come back paused, or resumed if wanted. */
async function resumeShares() {
  if (!prefs.resume) return;
  const live = await backend.shareList();
  for (const kept of await backend.rememberedShares()) {
    if (!running.has(kept.project) || live.some((s) => s.local === kept.local && s.project === kept.project)) continue;
    try { await backend.shareStart(kept.local, kept.writable, kept.project); } catch { /* shown as paused */ }
  }
  workspace.find("context")?.refresh?.();
}

// ============================================================================
// The top bar: the session of the tab in use
// ============================================================================
//
// Only when that tab is a Pi: its project, which Pi (#2...), whether it works. Which Pis
// run and which conversation they hold is in Setup; the bar does not repeat it.

let currentTab = null;

function setCurrentTab(tab) {
  if (currentTab === tab) return;
  currentTab = tab;
  renderSessionBadge();
}

function renderSessionBadge() {
  const badge = $("#target");
  const tab = currentTab;
  if ($("#workspace").hidden || !tab || tab.kind !== "pi" || !tab.params?.project) {
    badge.hidden = true;
    return;
  }
  const project = lastProjects?.running.find((p) => p.path === tab.params.project);
  const slot = tab.slot || (tab.params.args?.[0] === "--slot" ? tab.params.args[1] : null);
  const pi = project?.pis?.find((p) => p.slot === slot) || project?.pis?.[0];
  const label = project?.label || tab.params.label;
  badge.hidden = false;
  badge.textContent = pi ? `session · ${label}${piNumber(pi)} · ${pi.working ? "working" : "waiting for you"}` : `session · ${label} · ended`;
  badge.title = "The Pi of the tab in use";
  badge.classList.toggle("live", Boolean(pi));
}
