// Pier interface. Plain script, no bundler: Tauri injects window.__TAURI__; xterm.js: vendor/.
// Outside Tauri a mock backend stands in, so the page can be checked in a browser.

const tauri = window.__TAURI__ || null;
const backend = tauri ? realBackend() : mockBackend();
const $ = (selector, root = document) => root.querySelector(selector);

/** A new element: el("span", { className: "x", textContent: "y" }, child, "text"). */
/** An icon from the sprite in index.html (Lucide), in the text's colour, hidden from readers. */
function svgIcon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "i");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  // "aria-…" and "data-…" are attributes, not properties: assigned, they did nothing.
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith("aria-") || key.startsWith("data-")) node.setAttribute(key, value);
    else node[key] = value;
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  // A button that is a glyph (×, ⋯, ‹, ▸): a screen reader says its title, not
  // "multiplication sign".
  if (tag === "button" && props.title && !props.ariaLabel && isGlyph(node.textContent)) node.setAttribute("aria-label", props.title);
  return node;
}

/** A cost in dollars, or "" for none: two significant digits, at least two decimals ($0.0034).
 *  Cheap models spend fractions of a cent a request; a fixed $0.000 would show nothing. */
function dollars(cost) {
  if (!(cost > 0)) return "";
  if (cost < 0.00001) return "<$0.00001";
  const decimals = Math.max(2, Math.min(5, Math.ceil(-Math.log10(cost)) + 1));
  return `$${cost.toFixed(decimals).replace(/(\.\d\d\d*?)0+$/, "$1")}`; // $0.06, not $0.060
}

/** Text with no letter nor digit in it, short: a glyph standing for an action. */
function isGlyph(text) {
  const value = String(text || "").trim();
  return value.length > 0 && value.length <= 3 && !/[\p{L}\p{N}]/u.test(value);
}

/** Pier's dialogs made modal: named by their title, focus kept inside, Escape closes,
 *  focus goes back where it was. Returns what undoes it. */
function trapDialog(box, close) {
  const before = document.activeElement;
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  const title = box.querySelector("h1");
  if (title) {
    title.id ||= `dialog-${Math.random().toString(36).slice(2, 9)}`;
    box.setAttribute("aria-labelledby", title.id);
  }
  const onKey = (e) => {
    // Gone from the page some other way: the trap lets go, and keys go on as before.
    if (!document.contains(box)) { document.removeEventListener("keydown", onKey, true); return; }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== "Tab") return;
    const items = [...box.querySelectorAll("button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])")]
      .filter((n) => !n.disabled && !n.hidden && n.offsetParent !== null);
    if (!items.length) return;
    const [first, last] = [items[0], items[items.length - 1]];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener("keydown", onKey, true);
  return () => {
    document.removeEventListener("keydown", onKey, true);
    if (before && document.contains(before)) before.focus?.();
  };
}

/** Text from the VM or a forge as it is, for what the user decides on: hidden characters show
 *  as ⟨U+202E⟩. lines: keep newlines and tabs (a command, a review), else show ⏎ and ⇥. */
function visibleText(text, { lines = false } = {}) {
  let value = String(text ?? "");
  if (lines) value = value.replace(/\r\n/g, "\n");
  return value.replace(/[\p{C}\p{Z}]/gu, (c) => {
    if (c === " " || (lines && (c === "\n" || c === "\t"))) return c;
    if (c === "\n") return "⏎";
    if (c === "\t") return "⇥";
    return `⟨U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}⟩`;
  });
}

let settings = null;
let password = "";          // kept for the trust round trip only, then dropped
let bastionPassword = "";
let pendingTrust = null;    // {host, fingerprint} awaiting a decision
let target = null;          // the Pi in use: {path, label, slot, n} or null
let running = new Set();    // projects where a Pi runs
let lastProjects = null;    // the last "projects" answer, shared by the tabs

// Preferences (this computer only)

const PREFS_DEFAULT = { theme: "system", fontSize: 13, shortcut: true, autostop: true, notify: true, clearOnEnd: false, resume: false, customThemes: [],
  autoUpdatePicker: true, updateCheck: true, debugLogs: false, focusFollowsMouse: false, gpuTerminal: true, copyKeys: "linux", copyMode: "key",
  termFont: "", termPadding: 8, uiFont: "", corners: 0, piTerminal: false, menuBlur: false, accent: "", mica: false,
  gradStyle: "aurora", gradIntensity: 22, gradCustom: false, gradC1: "#4c8dff", gradC2: "#a371f7", gradGrain: false,
  gradNewTab: true, gradWorking: true, gradEmpty: false, gradButtons: false, gradSides: true };
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

/** Pier's own font (Settings > Appearance): the system's sans by default, the terminals'
 *  font, or any font chosen apart. "__sans__" was the sans when the terminals' was the default. */
const UI_TERM = "__term__";
const UI_SANS_FAMILY = '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif';
if (prefs.uiFont === "__sans__") prefs.uiFont = "";
function uiFontFamily() {
  if (prefs.uiFont === UI_TERM) return termFontFamily();
  const name = String(prefs.uiFont || "").replace(/["'`;\{}<>]/g, "").trim().slice(0, 60);
  return name ? `"${name}", ${UI_SANS_FAMILY}` : UI_SANS_FAMILY;
}

/** Corners (Settings > Appearance): 0 (square), 4 or 8 px, on every box. */
function applyCorners() {
  const px = [0, 4, 8].includes(Number(prefs.corners)) ? Number(prefs.corners) : 0;
  document.documentElement.style.setProperty("--r", `${px}px`);
}
applyCorners();

/** Ctrl+Alt+V types the clipboard image's reference into Pi's prompt in tmux: taken from
 *  Windows only when Pi runs there (Settings > Terminals), not for the conversation view. */
const shortcutOn = () => Boolean(prefs.shortcut && prefs.piTerminal);

/** Mica (Appearance, Windows 11): the window takes a tint of the wallpaper, as the
 *  Explorer's; the window is transparent (tauri.windows.conf.json), the panels let it
 *  through. Elsewhere (Windows 10, the browser preview) the effect is refused: in the
 *  preview a wallpaper is drawn behind the page instead, to see it. */
function applyMica() {
  const on = Boolean(prefs.mica);
  const root = document.documentElement;
  root.classList.toggle("mica", on);
  applyTheme(); // the surfaces' colours, solid or not
  const win = tauri?.window?.getCurrentWindow?.();
  root.classList.toggle("mica-preview", on && !win);
  if (!win?.setEffects) return;
  (on ? win.setEffects({ effects: ["mica"] }) : win.clearEffects()).catch((error) => uiLog("warn", "mica-failed", { msg: String(error) }));
}

/** The gradient (Appearance): its style, its strength, its colours (the accent's or two
 *  chosen), its grain, and where it goes, as classes and variables on the root
 *  (style.css draws it). */
const GRAD_STYLES = ["off", "aurora", "mesh", "linear", "glow", "dusk"];
function applyGradient() {
  const root = document.documentElement;
  const style = GRAD_STYLES.includes(prefs.gradStyle) ? prefs.gradStyle : "aurora";
  for (const s of GRAD_STYLES) root.classList.toggle(`grad-${s}`, s === style);
  root.classList.toggle("grad-grain", Boolean(prefs.gradGrain) && style !== "off");
  const on = style !== "off";
  root.classList.toggle("grad-in-newtab", on && prefs.gradNewTab);
  root.classList.toggle("grad-in-working", on && prefs.gradWorking);
  root.classList.toggle("grad-in-empty", on && prefs.gradEmpty);
  root.classList.toggle("grad-in-buttons", on && prefs.gradButtons);
  root.classList.toggle("grad-in-sides", on && prefs.gradSides);
  root.style.setProperty("--gi", `${Math.min(60, Math.max(5, Number(prefs.gradIntensity) || 22))}%`);
  if (prefs.gradCustom) {
    root.style.setProperty("--g1", prefs.gradC1);
    root.style.setProperty("--g2", prefs.gradC2);
  } else {
    root.style.removeProperty("--g1");
    root.style.removeProperty("--g2");
  }
}
applyGradient();

/** Translucent menus (Appearance): what is behind them shows through, blurred. */
function applyMenuBlur() {
  document.documentElement.classList.toggle("menus-blur", Boolean(prefs.menuBlur));
}
applyMenuBlur();

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

// Logging: the interface writes into Pier's log (see journal.rs)
//
// What goes there: its own errors, every error shown to the user, the main steps (connecting,
// installing the picker, restoring). Never a password or what is typed.

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

// Themes (see themes.js): built-in, imported from VS Code or Zed, or customized

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
  // Mica (Appearance): the wallpaper's tint as much on the sides as in the middle (more
  // there made the left a different colour); the panel's own colour tells them apart.
  root.style.setProperty("--mica-side", alpha(theme.ui.panel, 0.8));
  root.style.setProperty("--mica-mid", alpha(theme.ui.bg, 0.8));
  // With Mica, the cards, fields and hovers let it through too (else they stay solid).
  root.style.setProperty("--field", prefs.mica ? alpha(theme.ui.field, 0.55) : theme.ui.field);
  root.style.setProperty("--hover", prefs.mica ? alpha(theme.ui.hover, 0.6) : theme.ui.hover);
  // An accent chosen in Appearance stays over every theme's ("" follows the theme).
  const own = /^#[0-9a-f]{6}$/i.test(prefs.accent || "") ? prefs.accent : "";
  if (own) root.style.setProperty("--accent", own);
  // Links and file names: the accent, unless it is only the text's colour (Pier's own
  // themes): then a blue that reads on the theme.
  const neutral = !own && String(theme.ui.accent).toLowerCase() === String(theme.ui.fg).toLowerCase();
  root.style.setProperty("--link", own || (neutral ? (theme.dark ? "#8cc4ff" : "#0b5cad") : theme.ui.accent));
  // The file viewer's syntax colors: the terminal's, when the theme has them.
  for (const key of ["magenta", "green", "yellow", "blue", "cyan"]) {
    if (theme.terminal?.[key]) root.style.setProperty(`--ansi-${key}`, theme.terminal[key]);
    else root.style.removeProperty(`--ansi-${key}`);
  }
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
// The toast is there from the start, as a live region: one made with its first message
// would not have it read out.
document.body.appendChild(el("div", { id: "toast", className: "toast", role: "status", hidden: true }));
function flashStatus(text, near) {
  const toast = $("#toast");
  toast.textContent = "";
  requestAnimationFrame(() => { toast.textContent = text; }); // shown, then filled: read out
  // In the top right corner of the terminal (or panel) it is about; else at the bottom
  // right of the window, where it covers no tab bar ("picker installed" at a connection).
  const pane = near || document.activeElement?.closest?.(".pane");
  const box = pane && pane.offsetParent !== null ? pane.getBoundingClientRect() : { top: innerHeight - 64, right: innerWidth };
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

// Pier's mark: π in braille, made into characters by asciify-engine (braille mode, 20
// columns) from a drawn π. Shown on the first page, above the VM.
const PIER_ART = [
  "⣿⢿⣿⣿⣿⣿⣿⣿⣿⠿",
  "⠀⢸⣿⣿⠀⢨⣿⣿⠂",
  "⠀⢘⣿⣿⠀⠨⣿⣿⣅⡀",
  "⠀⠸⠿⠻⠀⠀⠛⠿⠿⠃",
].join("\n");
// The empty braille cell (U+2800) is drawn as faint dots by some fonts: a plain space instead.
function pierMark() { return el("pre", { className: "pier-mark", textContent: PIER_ART.replace(/⠀/g, " "), "aria-hidden": "true" }); }
