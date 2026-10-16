// The settings dialog: layout, themes, behavior, the picker, diagnostics.

// ============================================================================
// Preferences dialog
// ============================================================================

const PLACEABLE = [
  ["main", "picker (main terminal)", false],
  ["context", "Context", true],
  ["project", "Activity (what Pi does)", true],
  ["setup", "Setup", true],
  ["conversations", "Conversations", true],
  ["logs", "Logs", true],
];

function openPrefs() {
  const grid = $("#prefs-layout");
  grid.innerHTML = "";
  for (const [key, label, hideable] of PLACEABLE) {
    const select = el("select");
    select.id = `prefs-place-${key}`;
    for (const name of DOCKS) select.add(new Option(name, name));
    if (hideable) select.add(new Option("hidden", "hidden"));
    select.value = workspace.find(key)?.dock || "hidden";
    select.addEventListener("change", () => {
      const tab = workspace.find(key);
      if (select.value === "hidden") { if (tab) workspace.close(tab); }
      else if (tab) workspace.move(tab, select.value);
      else workspace.add(key, select.value);
    });
    grid.append(el("label", { htmlFor: select.id, textContent: label }), select);
  }
  fillThemes();
  $("#prefs-font").value = prefs.fontSize;
  $("#prefs-padding").value = prefs.termPadding;
  fillTermFonts();
  fillUiFonts();
  $("#prefs-shortcut").checked = prefs.shortcut;
  $("#prefs-autostop").checked = prefs.autostop;
  $("#prefs-notify").checked = prefs.notify;
  $("#prefs-clear").checked = prefs.clearOnEnd;
  $("#prefs-resume").checked = prefs.resume;
  $("#prefs-focus").checked = prefs.focusFollowsMouse;
  $("#prefs-gpu").checked = prefs.gpuTerminal;
  $("#prefs-copykeys").value = prefs.copyKeys;
  $("#prefs-copymode").value = prefs.copyMode;
  $("#prefs-connection").textContent = settings ? describe(settings) : "";
  $("#prefs-autoupdate").checked = prefs.autoUpdatePicker;
  $("#prefs-debug").checked = prefs.debugLogs;
  $("#prefs-logtab").checked = Boolean(workspace.find("logs"));
  $("#prefs-side").value = prefs.panelSide === "left" ? "left" : "right";
  $("#prefs-picker-note").hidden = true;
  $("#prefs-diag-note").hidden = true;
  fillPickerInfo();
  backend.logInfo().then((info) => { $("#prefs-logpath").textContent = info.path || "?"; }).catch(() => {});
  $("#prefs-shortcut-note").hidden = true;
  backend.shortcutStatus?.().then((ours) => { $("#prefs-shortcut-note").hidden = ours || !prefs.shortcut; }).catch(() => {});
  $("#prefs").hidden = false;
  $("#prefs-close").focus();
}

function closePrefs() {
  closeThemeEditor(); // an unsaved theme is not kept
  $("#prefs").hidden = true;
}

/** One page of the settings at a time; the one last shown comes back next time. */
let prefsPage = "layout";
function showPrefsPage(page) {
  prefsPage = page;
  for (const tab of document.querySelectorAll("#prefs .prefs-tabs button")) tab.setAttribute("aria-selected", String(tab.dataset.page === page));
  for (const section of document.querySelectorAll("#prefs .prefs-page")) section.hidden = section.dataset.page !== page;
}
for (const tab of document.querySelectorAll("#prefs .prefs-tabs button")) tab.addEventListener("click", () => showPrefsPage(tab.dataset.page));
showPrefsPage(prefsPage);

$("#btn-prefs").addEventListener("click", openPrefs);
$("#prefs-close").addEventListener("click", closePrefs);
$("#prefs").addEventListener("pointerdown", (e) => { if (e.target.id === "prefs") closePrefs(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#prefs").hidden) closePrefs(); });
/** Every panel to the side chosen, the terminals in the middle. */
function placePanels() {
  workspace.arrange(defaultLayout()); // moves tabs, never restarts a terminal
  const logs = workspace.find("logs");
  if (logs) workspace.move(logs, prefs.panelSide === "left" ? "left" : "right");
}
$("#prefs-reset").addEventListener("click", () => {
  placePanels();
  openPrefs();
});
$("#prefs-side").addEventListener("change", (e) => {
  prefs.panelSide = e.target.value;
  savePrefs();
  placePanels();
  openPrefs();
});
$("#prefs-logtab").addEventListener("change", (e) => {
  const logs = workspace.find("logs");
  if (e.target.checked && !logs) workspace.add("logs", prefs.panelSide === "left" ? "left" : "right");
  if (!e.target.checked && logs) workspace.close(logs);
});
$("#prefs-theme").addEventListener("change", (e) => {
  closeThemeEditor();
  prefs.theme = e.target.value;
  savePrefs();
  applyTheme();
  fillThemes();
});

/** The theme list (built in, then yours), and swatches of the chosen one. */
function fillThemes() {
  const select = $("#prefs-theme");
  select.innerHTML = "";
  const builtIn = el("optgroup", { label: "Built in" });
  builtIn.append(new Option("follow the system (Pier dark / light)", "system"));
  for (const t of BUILTIN_THEMES) builtIn.append(new Option(t.name, t.id));
  select.append(builtIn);
  if (prefs.customThemes.length) {
    const yours = el("optgroup", { label: "Yours" });
    for (const t of prefs.customThemes) yours.append(new Option(t.imported ? `${t.name} (imported)` : t.name, t.id));
    select.append(yours);
  }
  select.value = allThemes().some((t) => t.id === prefs.theme) ? prefs.theme : "system";
  $("#theme-delete").hidden = !prefs.customThemes.some((t) => t.id === prefs.theme);
  const theme = currentTheme();
  const box = $("#theme-swatches");
  box.innerHTML = "";
  const colors = [theme.ui.bg, theme.ui.panel, theme.ui.fg, theme.ui.dim, theme.ui.accent,
    ...ANSI_KEYS.slice(1, 7).map((k) => theme.terminal[k]).filter(Boolean)];
  for (const color of colors) box.append(el("span", { style: `background:${color}` }));
}

$("#theme-import").addEventListener("click", () => $("#theme-file").click());
$("#theme-file").addEventListener("change", async (e) => {
  const added = [];
  const problems = [];
  for (const file of e.target.files) {
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error(`${file.name} is larger than 2 MB: not a theme file`);
      for (const theme of themesFromFile(await file.text(), file.name)) {
        const taken = new Set(allThemes().map((t) => t.name));
        let name = theme.name;
        for (let n = 2; taken.has(name); n++) name = `${theme.name} (${n})`;
        added.push({ ...theme, name });
      }
    } catch (error) {
      problems.push(String(error.message || error));
    }
  }
  e.target.value = "";
  if (added.length > 1) problems.push(`${added.length} themes added: pick them in the list.`);
  showError($("#theme-error"), problems.join("\n"));
  if (!added.length) return;
  prefs.customThemes.push(...added);
  prefs.theme = added[0].id;
  savePrefs();
  applyTheme();
  fillThemes();
});

$("#theme-delete").addEventListener("click", async () => {
  const theme = prefs.customThemes.find((t) => t.id === prefs.theme);
  if (!theme || !(await ask(`Delete the theme "${theme.name}"?`))) return;
  prefs.customThemes = prefs.customThemes.filter((t) => t.id !== theme.id);
  prefs.theme = "system";
  savePrefs();
  applyTheme();
  fillThemes();
});

// --- the theme editor: every color, previewed live ---

const UI_LABELS = { bg: "Background", panel: "Panels", fg: "Text", dim: "Secondary text", line: "Lines",
  field: "Fields", hover: "Hover", accent: "Accent", green: "Added (diffs)", red: "Removed (diffs)" };
const TERMINAL_LABELS = { background: "Background", foreground: "Text", cursor: "Cursor",
  ...Object.fromEntries(ANSI_KEYS.map((k) => [k, k.replace(/^bright(.)/, (_, c) => `bright ${c.toLowerCase()}`)])) };

function colorInput(group, key, label, value) {
  const id = `theme-${group}-${key}`;
  const input = el("input", { type: "color", id, value: toHex(parseHex(value) || [128, 128, 128]) });
  input.addEventListener("input", () => {
    previewTheme[group][key] = input.value;
    applyTheme();
  });
  const wrap = el("label");
  wrap.htmlFor = id;
  wrap.append(input, el("span", { textContent: label }));
  return wrap;
}

function openThemeEditor() {
  const base = currentTheme();
  const editing = prefs.customThemes.find((t) => t.id === prefs.theme && !t.imported); // an imported theme is copied, not changed
  previewTheme = structuredClone({ ...base, id: editing ? base.id : null, name: editing ? base.name : `${base.name} (custom)` });
  const terminal = terminalTheme();
  for (const key of Object.keys(TERMINAL_LABELS)) previewTheme.terminal[key] ||= terminal[key];
  $("#theme-name").value = previewTheme.name;
  const ui = $("#theme-colors");
  ui.innerHTML = "";
  for (const [key, label] of Object.entries(UI_LABELS)) ui.append(colorInput("ui", key, label, previewTheme.ui[key]));
  const term = $("#theme-terminal");
  term.innerHTML = "";
  for (const [key, label] of Object.entries(TERMINAL_LABELS)) term.append(colorInput("terminal", key, label, previewTheme.terminal[key]));
  $("#theme-editor").hidden = false;
  $("#theme-customize").hidden = true;
  $("#theme-name").focus();
}

function closeThemeEditor() {
  if (!previewTheme) return;
  previewTheme = null;
  $("#theme-editor").hidden = true;
  $("#theme-customize").hidden = false;
  applyTheme();
}

$("#theme-customize").addEventListener("click", openThemeEditor);
$("#theme-cancel").addEventListener("click", closeThemeEditor);
$("#theme-save").addEventListener("click", () => {
  const theme = { ...previewTheme, name: $("#theme-name").value.trim() || "My theme" };
  delete theme.imported;
  if (theme.id && prefs.customThemes.some((t) => t.id === theme.id)) {
    prefs.customThemes = prefs.customThemes.map((t) => (t.id === theme.id ? theme : t));
  } else {
    theme.id = `custom-${Date.now().toString(36)}`;
    prefs.customThemes.push(theme);
  }
  prefs.theme = theme.id;
  savePrefs();
  closeThemeEditor();
  fillThemes();
});
$("#prefs-font").addEventListener("change", (e) => {
  prefs.fontSize = Math.min(28, Math.max(8, Number(e.target.value) || PREFS_DEFAULT.fontSize));
  e.target.value = prefs.fontSize;
  savePrefs();
  for (const tab of workspace.tabs()) tab.applyFont?.();
});
// Monospaced fonts often installed: offered in the list, and only those found here.
const TERM_FONT_CHOICES = ["Cascadia Mono", "Cascadia Code", "Consolas", "JetBrains Mono", "Fira Code", "Fira Mono",
  "Source Code Pro", "Hack", "Iosevka", "IBM Plex Mono", "Roboto Mono", "Ubuntu Mono", "DejaVu Sans Mono",
  "Liberation Mono", "Noto Sans Mono", "Menlo", "SF Mono", "Monaco", "Courier New"];

function fontInstalled(name) {
  // A font the system lacks measures as the fallback does: compared with two of them.
  const probe = (family) => {
    const span = el("span", { textContent: "mmmmmmmmmmlli10OO" });
    span.style.cssText = `position:absolute;visibility:hidden;font-size:40px;font-family:${family}`;
    document.body.append(span);
    const width = span.getBoundingClientRect().width;
    span.remove();
    return width;
  };
  const safe = name.replace(/["'`;\\{}<>]/g, "");
  return ["monospace", "serif"].some((base) => probe(`"${safe}", ${base}`) !== probe(base));
}

const OTHER_FONT = "__other__"; // the "Other font…" entry: a name typed below

let installedFonts = null; // measured once: it takes a moment
/** The font list: the default, the usual fonts found here, the one chosen if typed by
 *  hand, and "Other font…". A plain select, as the theme's. */
function fillTermFonts() {
  installedFonts ||= TERM_FONT_CHOICES.filter(fontInstalled);
  const select = $("#prefs-termfont");
  const chosen = prefs.termFont || "";
  select.innerHTML = "";
  select.add(new Option("Cascadia Mono (default)", ""));
  for (const name of installedFonts) if (name !== "Cascadia Mono") select.add(new Option(name, name));
  if (chosen && !installedFonts.includes(chosen)) select.add(new Option(chosen, chosen));
  select.add(new Option("Other font…", OTHER_FONT));
  select.value = chosen;
  $("#prefs-termfont-other").hidden = true;
}

function setTermFont(raw) {
  const name = String(raw).replace(/["'`;\\{}<>]/g, "").trim().slice(0, 60);
  prefs.termFont = name === "Cascadia Mono" ? "" : name;
  savePrefs();
  const note = $("#prefs-termfont-note");
  note.hidden = !name || fontInstalled(name);
  note.textContent = `"${name}" is not installed on this computer: the terminals use Cascadia Mono meanwhile.`;
  for (const tab of workspace.tabs()) tab.applyFont?.();
  applyFonts();
  fillTermFonts();
  fillUiFonts();
}

$("#prefs-termfont").addEventListener("change", (e) => {
  if (e.target.value !== OTHER_FONT) { setTermFont(e.target.value); return; }
  const other = $("#prefs-termfont-other");
  other.hidden = false;
  other.value = "";
  other.focus();
});
$("#prefs-termfont-other").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.value.trim()) setTermFont(e.target.value);
  if (e.key === "Escape") { e.stopPropagation(); fillTermFonts(); }
});
$("#prefs-termfont-other").addEventListener("change", (e) => { if (e.target.value.trim()) setTermFont(e.target.value); });
/** Pier's own font: the same list, after "the terminals'" and the system's sans. */
function fillUiFonts() {
  installedFonts ||= TERM_FONT_CHOICES.filter(fontInstalled);
  const select = $("#prefs-uifont");
  const chosen = prefs.uiFont || "";
  select.innerHTML = "";
  select.add(new Option("Same as the terminals (default)", ""));
  for (const name of installedFonts) select.add(new Option(name, name));
  if (chosen && chosen !== UI_SANS && !installedFonts.includes(chosen)) select.add(new Option(chosen, chosen));
  select.add(new Option("The system's sans (Segoe UI)", UI_SANS));
  select.add(new Option("Other font…", OTHER_FONT));
  select.value = chosen;
  $("#prefs-uifont-other").hidden = true;
}

function setUiFont(raw) {
  const name = raw === UI_SANS ? UI_SANS : String(raw).replace(/["'`;\{}<>]/g, "").trim().slice(0, 60);
  prefs.uiFont = name;
  savePrefs();
  applyFonts();
  fillUiFonts();
}

$("#prefs-uifont").addEventListener("change", (e) => {
  if (e.target.value !== OTHER_FONT) { setUiFont(e.target.value); return; }
  const other = $("#prefs-uifont-other");
  other.hidden = false;
  other.value = "";
  other.focus();
});
$("#prefs-uifont-other").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.value.trim()) setUiFont(e.target.value);
  if (e.key === "Escape") { e.stopPropagation(); fillUiFonts(); }
});
$("#prefs-uifont-other").addEventListener("change", (e) => { if (e.target.value.trim()) setUiFont(e.target.value); });
$("#prefs-padding").addEventListener("change", (e) => {
  prefs.termPadding = Math.min(40, Math.max(0, Math.round(Number(e.target.value) || 0)));
  e.target.value = prefs.termPadding;
  savePrefs();
  applyTermPadding();
  for (const tab of workspace.tabs()) tab.refit?.();
});
$("#prefs-shortcut").addEventListener("change", async (e) => {
  prefs.shortcut = e.target.checked;
  savePrefs();
  try { await backend.setShortcut(prefs.shortcut); } catch (error) { alert(String(error)); }
});
$("#prefs-autostop").addEventListener("change", (e) => { prefs.autostop = e.target.checked; savePrefs(); });
$("#prefs-notify").addEventListener("change", (e) => { prefs.notify = e.target.checked; savePrefs(); });
$("#prefs-clear").addEventListener("change", (e) => { prefs.clearOnEnd = e.target.checked; savePrefs(); });
$("#prefs-resume").addEventListener("change", (e) => { prefs.resume = e.target.checked; savePrefs(); });
$("#prefs-focus").addEventListener("change", (e) => { prefs.focusFollowsMouse = e.target.checked; savePrefs(); });
$("#prefs-gpu").addEventListener("change", (e) => { prefs.gpuTerminal = e.target.checked; savePrefs(); });
$("#prefs-copykeys").addEventListener("change", (e) => { prefs.copyKeys = e.target.value; savePrefs(); });
$("#prefs-copymode").addEventListener("change", (e) => { prefs.copyMode = e.target.value; savePrefs(); });

async function fillPickerInfo() {
  try {
    const info = await backend.pickerInfo();
    const remote = info.remote ? `version ${info.remote.version} (API ${info.remote.api})` : "not checked yet";
    $("#prefs-picker").textContent = `On the VM, at ${info.command}: ${remote}. This Pier carries ${info.bundled}.`;
    $("#prefs-reinstall").hidden = !info.installable;
  } catch (error) {
    $("#prefs-picker").textContent = String(error);
  }
}

function prefsNote(node, text) {
  node.textContent = text;
  node.hidden = !text;
}

$("#prefs-autoupdate").addEventListener("change", (e) => { prefs.autoUpdatePicker = e.target.checked; savePrefs(); });
$("#prefs-reinstall").addEventListener("click", async (e) => {
  if (!(await ask("Install this Pier's picker on the VM again? The current one is kept next to it, as .previous."))) return;
  e.target.disabled = true;
  prefsNote($("#prefs-picker-note"), "installing…");
  try {
    const outcome = await backend.installPicker();
    prefsNote($("#prefs-picker-note"), outcome.status === "connected" ? `Installed: the picker ${outcome.bundled} is on the VM.` : `Installed, but the VM still answers: ${outcome.status}. See the logs.`);
  } catch (error) {
    prefsNote($("#prefs-picker-note"), `Not installed: ${error}`);
  } finally {
    e.target.disabled = false;
    fillPickerInfo();
  }
});
$("#prefs-debug").addEventListener("change", (e) => {
  prefs.debugLogs = e.target.checked;
  savePrefs();
  backend.setLogLevel(prefs.debugLogs).catch(() => {});
  for (const tab of workspace.tabs()) tab.onLogLevel?.();
});

$("#prefs-logfolder").addEventListener("click", () => backend.openLogFolder().catch((error) => prefsNote($("#prefs-diag-note"), String(error))));

/** The report: what Pier knows (Rust side), and what only the interface knows. */
async function makeReport() {
  const layout = Object.fromEntries(DOCKS.map((d) => [d, workspace.docks[d].tabs.map((t) => t.kind)]));
  const kept = { ...prefs, customThemes: prefs.customThemes.length };
  const extra = [
    `interface: ${navigator.userAgent}`,
    `local time: ${new Date().toString()}`,
    `screen: ${innerWidth}x${innerHeight} at ${devicePixelRatio}x`,
    `tabs: ${JSON.stringify(layout)}`,
    `preferences: ${JSON.stringify(kept)}`,
    `pi in use: ${target ? target.label : "none"}; running: ${[...running].length}`,
  ].join("\n");
  return backend.report(extra);
}

async function copyReport(note) {
  try {
    const text = await makeReport();
    await backend.copyText(text);
    note?.(`Report copied (${Math.round(text.length / 1024)} KB): paste it where you report the problem.`);
    return true;
  } catch (error) {
    note?.(`No report: ${error}`);
    return false;
  }
}

$("#prefs-report").addEventListener("click", () => copyReport((text) => prefsNote($("#prefs-diag-note"), text)));
$("#prefs-report-save").addEventListener("click", async () => {
  try {
    const file = await backend.pickSavePath(`pier-report-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.txt`);
    if (!file) return;
    await backend.saveText(file, await makeReport());
    prefsNote($("#prefs-diag-note"), `Report saved: ${file}`);
  } catch (error) {
    prefsNote($("#prefs-diag-note"), `No report: ${error}`);
  }
});
