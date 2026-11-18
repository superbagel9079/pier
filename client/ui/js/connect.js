// Logging in: the VM's address, the password, its fingerprint, the picker on the VM;
// then the Pi in use, followed.

// Connection screens: a window over the app (the proposals' 2C). Pier opens on the app,
// not connected: a card at the bottom left offers to connect; without a VM yet, the New
// tab page is a quick start (workspace.js).

let online = false; // connected, the picker answering

/** The app, not connected: its panels as they were, the card to connect (when a VM is
 *  known), no connection window. note: a word to show (after a hand-off, say). */
function showOffline(note = "") {
  online = false;
  document.body.classList.remove("online");
  // Their hints: the name (their label), then this (the words).
  $("#rail-new").title = "Connect to your VM first";
  $("#btn-waiting").title = "Connect to your VM first";
  $("#connect").hidden = true;
  showWorkspace();
  $("#btn-disconnect").hidden = true;
  if (!workspace.tabs().length) workspace.restore();
  if (!$("#prefs").hidden) $("#workspace").hidden = true; // Settings open: they keep the window
  setStatus("not connected");
  // The first page shows the VM itself (loginCard) when nothing is open in the middle.
  $("#connect-card").hidden = !settings || !workspace.docks.center.tabs.length;
  if (settings) $("#connect-card-target").textContent = describe(settings);
  workspace.redrawEmpty();
  drawVmReady(); // not connected: no banner about the VM
  if (note) flashStatus(note);
}

function showConnect(view) {
  if (!online) showOffline();
  $("#prefs").hidden = true;
  $("#connect-card").hidden = true;
  $("#connect").hidden = false;
  for (const name of ["setup", "login", "trust", "picker"]) $(`#view-${name}`).hidden = name !== view;
  $(`#view-${view}`).prepend($("#connect-close"));
  $("#btn-disconnect").hidden = true;
}
// The window closed: back to the app, not connected (the card offers it again).
$("#connect-close").addEventListener("click", () => showOffline());
$("#connect").addEventListener("keydown", (e) => { if (e.key === "Escape" && !online) { e.preventDefault(); showOffline(); } });
$("#connect-card-go").addEventListener("click", () => toLogin());
$("#connect-card-edit").addEventListener("click", () => { fillSetup(settings); showConnect("setup"); });

function showWorkspace() {
  document.body.classList.add("in-workspace");
  $("#connect").hidden = true;
  $("#workspace").hidden = false;
  $("#status").disabled = false;
  $("#btn-prefs").hidden = false;
  $("#btn-palette").hidden = false;
  $("#btn-disconnect").hidden = false;
  $("#btn-waiting").hidden = false;
  renderSessionBadge();
}

function showError(node, message) {
  if (!online && /^(Error: )?Not connected: log in first/.test(String(message || ""))) message = "";
  node.setAttribute("role", "alert"); // read out as it appears, wherever the error is
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

/** The connection's words: in the top bar before connecting, then at the foot of the left
 *  side (or the rail's, the left side closed) with the signal bars; a click opens
 *  Settings > Overview. */
function setStatus(text) {
  $("#status").textContent = text;
  const state = /^connected/.test(text) ? (/attention/.test(text) ? "slow" : "ok")
    : /^(connecting|installing)/.test(text) ? "slow" : "lost";
  $("#status-foot").dataset.state = state;
  $("#prefs-status-row").dataset.state = state;
  // Connected: who and where, as "leo@vm" in the mock-up; otherwise the words that matter.
  $("#status-foot span:last-child").textContent = state === "ok" && settings ? `${settings.user}@${settings.host}` : text;
    // Not connected, no hint: the first page asks for the VM already.
  $("#status-foot").title = online ? `${text}: Settings > Overview` : "";
}
for (const id of ["#status", "#status-foot"]) $(id).addEventListener("click", () => {
  if (!online) { closePrefs(); if (settings) toLogin(); return; } // the first page: its password, or Add your VM
  openPrefs(); showPrefsPage("connection");
});

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
  form.bastion_password.required = on;
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
  } catch (error) {
    showError($("#setup-error"), String(error));
    return;
  }
  // One screen: the address and the password together, then straight on (the
  // fingerprint is still its own step at a first contact).
  password = form.password.value;
  bastionPassword = form.bastion_password.value;
  form.password.value = form.bastion_password.value = "";
  toLogin();
  await connect();
});

function toLogin(message) {
  // The first page in view (nothing open in the middle): the password is asked there.
  if (!online && workspace.docks.center.tabs.length === 0) {
    loginNote = message || "";
    showOffline();
    $(".login-card input[type=password]")?.focus();
    return;
  }
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
  connecting = true;
  loginNote = "";
  workspace.redrawEmpty();
  setStatus("connecting…");
  try {
    uiLog("info", "connect", { to: describe(settings) });
    const outcome = await backend.connect(password, bastionPassword);
    uiLog("info", "connect-outcome", { status: outcome.status });
    if (outcome.status === "connected") {
      forgetPasswords();
      await enterWorkspace("", outcome.version);
    } else if (outcome.status.startsWith("picker_")) {
      forgetPasswords(); // connected: Pier keeps them, to reconnect
      await pickerOutcome(outcome);
    } else if (outcome.status === "unknown_host") {
      pendingTrust = outcome;
      $("#trust-title").textContent = outcome.which === "bastion" ? "Is this your bastion?" : "Is this your VM?";
      $("#trust-text").textContent = `${outcome.host}, a first connection`;
      $("#trust-words").textContent = keyWords(outcome.fingerprint);
      $("#trust-art").replaceChildren(...keyArt(outcome.fingerprint));
      $("#trust-words-note").hidden = false;
      $("#trust-more").open = false;
      const [algo, print] = String(outcome.fingerprint).includes(":") ? String(outcome.fingerprint).split(/:(.*)/s) : ["", outcome.fingerprint];
      $("#trust-algo").textContent = algo;
      $("#trust-fingerprint").textContent = print;
      $("#btn-trust").hidden = false;
      setStatus("not connected");
      showConnect("trust");
    } else if (outcome.status === "changed_host") {
      pendingTrust = null;
      forgetPasswords();
      $("#trust-title").textContent = "Its key changed: connection refused";
      $("#trust-text").textContent = `The key of ${outcome.host} changed since the last connection. Unless the machine was reinstalled, someone may be impersonating it. Nothing was sent, not even the password.`;
      $("#trust-words").textContent = `before: ${keyWords(outcome.known)}\nnow: ${keyWords(outcome.fingerprint)}`;
      $("#trust-art").replaceChildren(...keyArt(outcome.fingerprint));
      $("#trust-words-note").hidden = true;
      $("#trust-more").open = true;
      $("#trust-algo").textContent = "";
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
    connecting = false;
    if (!online) workspace.redrawEmpty();
  }
}

// The first page, not connected (the proposals' G and D): the fields there, not in a window.
let connecting = false; // a connection under way: the first page says so
let loginNote = "";     // why the last one failed, shown on the first page
let vmForm = null;      // the VM known: "edit" (its options) or "new" (another VM) shows the form

/** A field with its name above it. */
function lcField(label, input) {
  return el("label", { className: "lc-field" }, el("span", { textContent: label }), input);
}

/** The VM known (D): the machine large, its password alone; "Another VM" and "Options"
 *  put the form in its place, on the same page. */
function loginCard() {
  const pw = el("input", { type: "password", name: "password", required: true, autocomplete: "current-password", disabled: connecting });
  const bpw = settings.bastion ? el("input", { type: "password", name: "bastion_password", required: true, autocomplete: "off", disabled: connecting }) : null;
  const note = el("p", { className: "lc-error", role: "alert", textContent: loginNote, hidden: !loginNote });
  const go = el("button", { type: "submit", textContent: connecting ? "Connecting…" : "Connect", disabled: connecting });
  const another = el("button", { type: "button", className: "link", textContent: "Another VM" });
  another.addEventListener("click", () => { vmForm = "new"; workspace.redrawEmpty(); });
  const options = el("button", { type: "button", className: "link", textContent: "Options" });
  options.addEventListener("click", () => { vmForm = "edit"; workspace.redrawEmpty(); });
  const form = el("form", { className: "login-card" },
    el("div", { className: "lc-head" }, el("span", { className: "lc-icon" }, svgIcon("server")), el("b", { textContent: "Your VM" }),
      el("small", { textContent: describe(settings).replace(/:22(?= via|$)/g, "") })),
    ...(bpw ? [lcField(`Bastion password (${settings.bastion.user}@${settings.bastion.host})`, bpw)] : []),
    lcField("Password", pw), note, go, el("div", { className: "lc-links" }, another, options));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    password = pw.value;
    bastionPassword = bpw?.value || "";
    await connect();
  });
  if (!connecting) requestAnimationFrame(() => { if (form.isConnected && !document.querySelector("#connect:not([hidden]), .overlay")) (bpw || pw).focus(); });
  return form;
}

/** The VM's form in the quick start's first step (G): the user, the address, the password;
 *  an "Advanced" line unfolds the port, the picker's path and a bastion, in the same frame
 *  (the proposals' A). from: the VM known (Advanced open), or none. form.back: the way back
 *  to "Your VM", for the step's header, when a VM is known. */
function firstVmForm(from = null) {
  const input = (props) => el("input", { spellcheck: false, ...props });
  const user = input({ name: "user", required: true, autocomplete: "username", value: from?.user || "" });
  const host = input({ name: "host", required: true, placeholder: "192.168.1.20 or vm.example.org", value: from?.host || "" });
  const pw = input({ type: "password", name: "password", required: true, autocomplete: "current-password" });
  const port = input({ type: "number", name: "port", min: 1, max: 65535, required: true, value: from?.port || 22 });
  const picker = input({ name: "remote_command", placeholder: "~/bin/pi-pick", value: from?.remote_command || "~/bin/pi-pick" });
  // The bastion in one field, as ssh writes it: user@host, :port if not 22.
  const b = from?.bastion;
  // Only the switch flips it, not its words (as in Settings).
  const viaBastion = el("input", { type: "checkbox", checked: Boolean(b), "aria-labelledby": "qs-bastion-label" });
  const bWhere = input({ name: "bastion", placeholder: "user@bastion.example.org", pattern: "[^@\\s]+@[^:\\s]+(:[0-9]+)?",
    value: b ? `${b.user}@${b.host}${b.port && b.port !== 22 ? `:${b.port}` : ""}` : "" });
  const bPw = input({ type: "password", name: "bastion_password", autocomplete: "off" });
  const bastion = el("div", { className: "lc-row" }, lcField("Bastion", bWhere), lcField("Bastion password", bPw));
  const showBastion = () => {
    bastion.hidden = !viaBastion.checked;
    for (const f of [bWhere, bPw]) f.required = viaBastion.checked;
  };
  viaBastion.addEventListener("change", showBastion);
  showBastion();
  const sub = el("div", { className: "qs-sub", hidden: !from },
    el("div", { className: "lc-row" }, lcField("Port", port), lcField("Pier's picker on the VM", picker)),
    el("div", { className: "qs-switch" }, el("span", { id: "qs-bastion-label", textContent: "Through a bastion (jump host)" }), viaBastion), bastion);
  const advanced = el("button", { type: "button", className: "qs-advanced" }, svgIcon("chevron-right"), el("span", { textContent: "Advanced" }));
  const shown = () => advanced.setAttribute("aria-expanded", String(!sub.hidden));
  advanced.addEventListener("click", () => { sub.hidden = !sub.hidden; shown(); if (!sub.hidden) port.focus(); });
  shown();
  const note = el("p", { className: "lc-error", role: "alert", hidden: true });
  const go = el("button", { type: "submit", textContent: "Connect" });
  const form = el("form", { className: "qs-form" },
    el("div", { className: "lc-row" }, lcField("User", user), lcField("Address", host)),
    el("div", { className: "qs-adv" }, advanced, sub),
    el("div", { className: "lc-row end" }, lcField("Password", pw), go), note);
  if (settings) {
    form.back = el("button", { type: "button", className: "qs-back", title: "Back to your VM" }, svgIcon("arrow-left"), el("span", { textContent: "Your VM" }));
    form.back.addEventListener("click", () => { vmForm = null; workspace.redrawEmpty(); });
  }
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const [, bUser, bHost, bPort] = bWhere.value.trim().match(/^([^@\s]+)@([^:\s]+)(?::(\d+))?$/) || [];
    const next = {
      host: host.value.trim(), port: Number(port.value) || 22, user: user.value.trim(),
      bastion: viaBastion.checked ? { host: bHost, port: Number(bPort) || 22, user: bUser } : null,
      remote_command: picker.value.trim() || "~/bin/pi-pick",
    };
    try { await backend.saveSettings(next); settings = next; } catch (error) { showError(note, String(error)); return; }
    password = pw.value;
    bastionPassword = viaBastion.checked ? bPw.value : "";
    vmForm = null;
    toLogin();
    await connect();
  });
  requestAnimationFrame(() => { if (form.isConnected && !document.querySelector("#connect:not([hidden]), .overlay")) (from ? pw : user).focus(); });
  return form;
}

async function enterWorkspace(note = "", version = null) {
  online = true;
  document.body.classList.add("online");
  $("#rail-new").title = "New conversation";
  $("#btn-waiting").title = "Pi's requests waiting for your approval";
  $("#connect-card").hidden = true;
  setStatus(`connected · ${describe(settings)}`);
  if (note) flashStatus(note);
  showWorkspace();
  workspace.restore();
  await refreshTarget();
  vm.start();
  resumeShares();
  vmReadyAfterConnect(version); // what is missing on the VM, said once (firstuse.js)
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
      await enterWorkspace(`picker ${outcome.bundled} installed on the VM`, outcome.version);
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
  showOffline();
});

function forgetPasswords() {
  password = "";
  bastionPassword = "";
  $("#login-form").reset();
}

$("#btn-trust").addEventListener("click", async () => {
  if (!pendingTrust) return;
  try {
    await backend.trustHost(pendingTrust.host, pendingTrust.fingerprint);
  } catch (error) {
    // Not trusted (known_hosts.json unreadable, a disk full): said, and no connection.
    uiLog("warn", "trust-failed", { msg: String(error) });
    toLogin(`Could not trust that key: ${error}`);
    return;
  }
  pendingTrust = null;
  await connect();
});

$("#btn-untrust").addEventListener("click", () => {
  pendingTrust = null;
  forgetPasswords();
  toLogin();
});

// Folders still shared live: first asked whether to copy them to the VM (context.js).
$("#btn-disconnect").addEventListener("click", async () => {
  if ((await backend.shareList().catch(() => [])).length) { openHandOff(); return; }
  await leave();
  showOffline();
});

async function leave() {
  online = false;
  vm.stop();
  workspace.save();
  workspace.clear();
  wasRunning = null;
  try {
    await backend.disconnect();
  } catch (error) {
    uiLog("warn", "disconnect-failed", { msg: String(error) }); // the connection is let go anyway
  }
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
  if (!online) return; // never connected (Settings asked the VM, say): nothing was lost
  vm.stop();
  workspace.save();
  workspace.clear();
  setStatus("not connected");
  toLogin(message);
});

// Target: the project of the Pi in use, followed automatically

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
  // The project of the tab shown first (the right panel follows the conversation in
  // view), else the one used last.
  const shown = currentTab?.params?.project;
  const current = projects.running.find((p) => p.path === shown) || (shown ? null : projects.running[0]);
  const pi = current?.pis?.[0];
  const next = current ? { path: current.path, label: current.label, slot: pi?.slot, n: pi?.n || 1 }
    : shown ? { path: shown, label: projectLabel(shown), slot: null, n: 1 } : target;
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

// When a project's Pi ends: live shares stop (and are forgotten) unless that setting is off;
// images, files and copies stay unless "clear on end" is on. The × removes them one by one.
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
    const label = projectLabel(project);
    if (prefs.autostop) {
      // A share open for writing must not stay for the next Pi because one call failed
      // (a reconnection meanwhile): the project is tried again at the next answer.
      try {
        for (const share of await backend.shareList()) {
          if (share.project !== project) continue;
          await backend.shareStop(share.id, true);
          notes.push(`stopped sharing ${share.local}`);
        }
        for (const kept of await backend.rememberedShares()) {
          if (kept.project === project) await backend.forgetShare(kept.local, kept.project).catch(() => {});
        }
      } catch (error) {
        uiLog("warn", "autostop-failed", { project, msg: String(error) });
        missing.set(project, 1); // ended again at the next answer without its Pi
        wasRunning.add(project);
        continue;
      }
    }
    if (prefs.clearOnEnd) {
      try { await backend.clearProject(project); notes.push(`deleted what was given to ${label}`); } catch { /* next tick */ }
    }
    if (notes.length) givenToPi()?.onNote?.(`The Pi of ${label} ended: ${notes.join(", ")}.`);
  }
  givenToPi()?.refresh?.();
}

/** After a reconnection: shares that were live come back paused, or resumed if wanted. */
async function resumeShares() {
  if (!prefs.resume) return;
  const live = await backend.shareList();
  for (const kept of await backend.rememberedShares()) {
    if (!running.has(kept.project) || live.some((s) => s.local === kept.local && s.project === kept.project)) continue;
    try { await backend.shareStart(kept.local, kept.writable, kept.project); } catch { /* shown as paused */ }
  }
  givenToPi()?.refresh?.();
}

// The top bar: the session of the tab in use
//
// Only when that tab is a Pi: its project, which Pi (#2...), whether it works. Which Pis
// run and which conversation they hold is in Setup; the bar does not repeat it.

let currentTab = null;

function setCurrentTab(tab) {
  // The tab in use is the middle's: a click in a side panel (Details, the list) leaves it.
  if (currentTab === tab || (tab && !isCenterDock(tab.dock))) return;
  currentTab = tab;
  renderSessionBadge();
  for (const t of workspace.tabs()) t.onShownTab?.();
  // A tab of another project: the right panel turns to it.
  const project = tab?.params?.project;
  if (project && project !== target?.path) {
    target = { path: project, label: projectLabel(project), slot: null, n: 1 };
    for (const t of workspace.tabs()) t.onTargetChange?.();
  }
}

/** The conversation of the tab shown in the middle: its Pi (slot) or its file. */
function shownConversation() {
  const args = currentTab?.params?.args || [];
  // Its file as Pi says it now (a fork moved it to a new one), else as it was opened.
  return { slot: currentTab?.slot || (args[0] === "--slot" ? args[1] : null), file: currentTab?.sessionFile || (args[0] === "--session" ? args[1] : currentTab?.params?.file) || null };
}

function renderSessionBadge() {
  const badge = $("#target");
  const tab = currentTab;
  // The project of the tab shown, as "~/work" after its title (the mock-up's header).
  const project = tab?.params?.project;
  badge.hidden = $("#workspace").hidden || !project;
  if (!badge.hidden) {
    badge.textContent = projectLabel(project);
    badge.title = project;
  }
}

// First contact: the fingerprint and the command to compare it with, copied in one click.
for (const [button, source] of [["#trust-copy", () => [$("#trust-algo").textContent, $("#trust-fingerprint").textContent].filter(Boolean).join(":")], ["#trust-copy-command", () => $("#trust-command").textContent]]) {
  $(button).addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(source()); } catch { return; }
    const use = $("use", $(button));
    use.setAttribute("href", "#i-check");
    setTimeout(() => use.setAttribute("href", "#i-copy"), 1200);
  });
}

// A key in four words (the proposals' D): easier to remember and compare than its letters.
// From the fingerprint's first bytes, 6 bits a word: the same key, the same words.
const KEY_WORDS = ["amber", "anchor", "apple", "arrow", "autumn", "badger", "bamboo", "banjo", "beacon", "birch", "blossom", "breeze",
  "cactus", "canyon", "cedar", "cherry", "cobalt", "comet", "copper", "coral", "cricket", "dawn", "delta", "desert", "dolphin", "ember",
  "falcon", "fern", "fjord", "forest", "galaxy", "garnet", "glacier", "granite", "harbor", "hazel", "heron", "island", "ivory", "jasmine",
  "juniper", "kayak", "lagoon", "lantern", "lemon", "lily", "lotus", "maple", "meadow", "meteor", "mint", "nectar", "oasis", "olive",
  "orbit", "otter", "pebble", "pepper", "pine", "planet", "quartz", "raven", "river", "saffron"];
/** A fingerprint's bytes (SHA256:<base64>, as ssh prints it). */
function keyBytes(fingerprint) {
  const b64 = String(fingerprint || "").replace(/^[A-Z0-9]+:/i, "").replace(/-/g, "+").replace(/_/g, "/");
  try { return [...atob(b64 + "===".slice((b64.length + 3) % 4))].map((c) => c.charCodeAt(0)); } catch { return [...b64].map((c) => c.charCodeAt(0)); }
}
/** The key as a picture: 8 × 4 squares, a colour each from its bytes (some left empty); the
 *  same key, the same picture, to be known again at a glance. */
function keyArt(fingerprint) {
  return keyBytes(fingerprint).slice(0, 32).map((b) => {
    const cell = el("i");
    if (b % 5) cell.style.background = `hsl(${Math.round((b * 360) / 256)} 55% ${42 + (b % 3) * 8}%)`;
    return cell;
  });
}
function keyWords(fingerprint) {
  const bytes = keyBytes(fingerprint);
  let bits = 0, n = 0;
  const words = [];
  for (const byte of bytes) {
    bits = (bits << 8) | byte; n += 8;
    while (n >= 6 && words.length < 4) { n -= 6; words.push(KEY_WORDS[(bits >> n) & 63]); }
    if (words.length === 4) break;
  }
  return words.join(" · ");
}
console.assert(KEY_WORDS.length === 64 && new Set(KEY_WORDS).size === 64, "KEY_WORDS: 64 different words");
