// Pier interface. Plain script, no bundler: Tauri injects window.__TAURI__
// (app.withGlobalTauri), xterm.js comes from vendor/. Outside Tauri, a mock backend
// stands in, so the page can be checked in a browser.

const tauri = window.__TAURI__ || null;
const backend = tauri ? realBackend() : mockBackend();
const $ = (selector, root = document) => root.querySelector(selector);

/** A new element: el("span", { className: "x", textContent: "y" }, child, "text"). */
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

let settings = null;
let password = "";          // kept for the trust round trip only, then dropped
let bastionPassword = "";
let pendingTrust = null;    // {host, fingerprint} awaiting a decision
let target = null;          // the Pi in use: {path, label, slot, n} or null
let running = new Set();    // projects where a Pi runs
let lastProjects = null;    // the last "projects" answer, shared by the tabs

// ============================================================================
// Preferences (this computer only)
// ============================================================================

const PREFS_DEFAULT = { theme: "system", fontSize: 13, shortcut: true, autostop: true, notify: true, clearOnEnd: false, resume: false, customThemes: [],
  autoUpdatePicker: true, updateCheck: true, debugLogs: false, focusFollowsMouse: false, gpuTerminal: true, copyKeys: "linux", copyMode: "key",
  panelSide: "right", termFont: "", termPadding: 8, uiFont: "" };
const prefs = (() => {
  try { return { ...PREFS_DEFAULT, ...JSON.parse(localStorage.getItem("devbox.prefs")) }; } catch { return { ...PREFS_DEFAULT }; }
})();
// 6 px was the default padding: the saved one moves to the new default, once.
if (!prefs.paddingDefault8) {
  if (prefs.termPadding === 6) prefs.termPadding = 8;
  prefs.paddingDefault8 = true;
}
// Before themes, the choice was "dark" or "light".
prefs.theme = { dark: "devbox-dark", light: "devbox-light" }[prefs.theme] || prefs.theme;
if (!Array.isArray(prefs.customThemes)) prefs.customThemes = [];

// The terminals' font: the one chosen first, then the usual ones, so that a font not
// installed here falls back quietly. Only a font name passes: no quote, no CSS.
const TERM_FONTS_DEFAULT = '"Cascadia Mono", Consolas, ui-monospace, monospace';
function termFontFamily() {
  const name = String(prefs.termFont || "").replace(/["'`;\\{}<>]/g, "").trim().slice(0, 60);
  return name ? `"${name}", ${TERM_FONTS_DEFAULT}` : TERM_FONTS_DEFAULT;
}

/** The space around the text of every terminal, in pixels (a CSS variable, see style.css). */
function applyTermPadding() {
  const px = Math.min(40, Math.max(0, Math.round(Number(prefs.termPadding) || 0)));
  document.documentElement.style.setProperty("--term-pad", `${px}px`);
}
applyTermPadding();

/** Pier's own font (Settings > Appearance): the terminals' by default, a console font
 *  chosen apart, or the system's sans. */
const UI_SANS = "__sans__";
const UI_SANS_FAMILY = '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif';
function uiFontFamily() {
  if (prefs.uiFont === UI_SANS) return UI_SANS_FAMILY;
  const name = String(prefs.uiFont || "").replace(/["'`;\{}<>]/g, "").trim().slice(0, 60);
  return name ? `"${name}", ${termFontFamily()}` : termFontFamily();
}

/** The two faces of the panels, as CSS variables: the interface, and what is code
 *  (paths, branches, logs, diffs) in the terminals' font. Set again when either changes. */
function applyFonts() {
  document.documentElement.style.setProperty("--ui", uiFontFamily());
  document.documentElement.style.setProperty("--code", termFontFamily());
}
applyFonts();

function savePrefs() {
  try { localStorage.setItem("devbox.prefs", JSON.stringify(prefs)); } catch { /* storage off */ }
}

// ============================================================================
// Logging: the interface writes into Pier's log (see journal.rs)
// ============================================================================
//
// What goes there: the interface's own errors (exceptions, failed promises), every
// error it shows the user, and the main steps (connecting, installing the picker,
// restoring). Never a password or what is typed.

function uiLog(level, event, fields = {}) {
  try { backend.log(level, event, fields)?.catch?.(() => {}); } catch { /* the log is best effort */ }
}

window.addEventListener("error", (e) => {
  uiLog("error", "js-error", { msg: e.message, at: `${e.filename}:${e.lineno}:${e.colno}`, trace: e.error?.stack?.slice(0, 3000) });
});
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason;
  uiLog("error", "js-rejection", { msg: String(reason?.message || reason), trace: reason?.stack?.slice(0, 3000) });
});

/** Which part of the interface a node belongs to, for the log: its tab, or its id. */
function whereOf(node) {
  try {
    const pane = node.closest(".pane");
    const tab = pane && workspace.tabs().find((t) => t.pane === pane);
    if (tab) return tab.kind;
  } catch { /* before the workspace exists */ }
  return node.id || node.closest("[id]")?.id || node.className || "?";
}

// ============================================================================
// Themes (see themes.js): built-in, imported from VS Code or Zed, or customized
// ============================================================================

function allThemes() {
  return [...BUILTIN_THEMES, ...prefs.customThemes];
}

/** The theme in use; "system" follows the system's dark or light mode. */
function currentTheme() {
  const id = prefs.theme === "system"
    ? (matchMedia("(prefers-color-scheme: light)").matches ? "devbox-light" : "devbox-dark")
    : prefs.theme;
  return completeTheme(allThemes().find((t) => t.id === id) || BUILTIN_THEMES[0]);
}

let previewTheme = null; // a theme being edited, shown before it is saved

function applyTheme() {
  const theme = previewTheme ? completeTheme(previewTheme) : currentTheme();
  const root = document.documentElement;
  root.dataset.theme = theme.dark ? "dark" : "light";
  for (const key of UI_KEYS) root.style.setProperty(`--${key}`, theme.ui[key]);
  for (const tab of workspace.tabs()) tab.applyTheme?.();
}

/** "#rrggbb" at an opacity, as "#rrggbbaa"; other colors as they are. */
function alpha(color, opacity) {
  return /^#[0-9a-f]{6}$/i.test(color || "") ? color + Math.round(opacity * 255).toString(16).padStart(2, "0") : color;
}

function terminalTheme() {
  const theme = previewTheme ? completeTheme(previewTheme) : currentTheme();
  const t = theme.terminal;
  const background = flatten(t.background, theme.ui.bg) || theme.ui.bg;
  const foreground = flatten(t.foreground, background) || theme.ui.fg;
  const colors = Object.fromEntries(ANSI_KEYS.filter((k) => t[k]).map((k) => [k, t[k]]));
  return {
    ...colors,
    background,
    foreground,
    cursor: t.cursor || foreground,
    cursorAccent: background,
    selectionBackground: t.selectionBackground || mix(background, foreground, 0.25),
    // xterm draws its own scrollbar: in the theme's dim color, like the others.
    scrollbarSliderBackground: alpha(theme.ui.fg, 0.14),
    scrollbarSliderHoverBackground: alpha(theme.ui.fg, 0.28),
    scrollbarSliderActiveBackground: alpha(theme.ui.fg, 0.4),
  };
}

matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => { if (prefs.theme === "system") applyTheme(); });

/** Yes or no, asked to the user. Inside Pier, window.confirm is Tauri's dialog and
 *  answers with a promise (a plain `if (!confirm(...))` would never stop anything). */
async function ask(text) {
  try {
    return Boolean(await window.confirm(text));
  } catch (error) {
    uiLog("warn", "ask-failed", { msg: String(error) });
    return false;
  }
}

/** A short message for two seconds, at the bottom of the window ("copied 12 characters"). */
let flashTimer = null;
function flashStatus(text, near) {
  const toast = $("#toast") || document.body.appendChild(el("div", { id: "toast", className: "toast", role: "status" }));
  toast.textContent = text;
  // In the top right corner of the terminal (or panel) it is about, else of the window.
  const pane = near || document.activeElement?.closest?.(".pane");
  const box = pane && pane.offsetParent !== null ? pane.getBoundingClientRect() : { top: 36, right: innerWidth };
  toast.style.top = `${Math.round(box.top + 8)}px`;
  toast.style.right = `${Math.round(innerWidth - box.right + 14)}px`;
  toast.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { toast.hidden = true; }, 2000);
}

/** Ctrl+= (or Ctrl++) and Ctrl+- change the terminals' text size, Ctrl+0 resets it.
 *  true when the key was one of them. */
function fontKey(event) {
  if (event.type !== "keydown" || !(event.ctrlKey || event.metaKey) || event.altKey) return false;
  const bigger = event.key === "+" || event.key === "=" || event.code === "NumpadAdd";
  const smaller = event.key === "-" || event.code === "NumpadSubtract";
  const reset = event.key === "0" || event.code === "Numpad0";
  if (!bigger && !smaller && !reset) return false;
  event.preventDefault();
  const size = reset ? PREFS_DEFAULT.fontSize : prefs.fontSize + (bigger ? 1 : -1);
  prefs.fontSize = Math.min(28, Math.max(8, size));
  savePrefs();
  for (const tab of workspace.tabs()) tab.applyFont?.();
  flashStatus(`terminal text ${prefs.fontSize} px`);
  return true;
}

// The same keys outside the terminals (a terminal handles them itself first).
document.addEventListener("keydown", (event) => {
  if (!event.defaultPrevented && !$("#workspace").hidden && !event.target.closest?.(".xterm")) fontKey(event);
});
