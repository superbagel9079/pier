// Color themes for Pier: the built-in ones, and readers for VS Code and Zed theme
// files, so their thousands of themes can be used as they are.
//
// A theme has the interface's colors (ui) and the terminal's (terminal: background,
// foreground, cursor, selection and the 16 ANSI colors). Missing colors are derived
// from the others, so a partial theme still looks whole.

const UI_KEYS = ["bg", "panel", "fg", "dim", "line", "field", "hover", "accent", "green", "red"];
const ANSI_KEYS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"];

/** 16 ANSI colors from a compact list of hex values, in ANSI_KEYS order. */
const ansi = (list) => Object.fromEntries(ANSI_KEYS.map((k, i) => [k, list[i]]));

// Palettes of well-known public themes (colors only).
const BUILTIN_THEMES = [
  { id: "devbox-dark", name: "Pier dark", dark: true,
    ui: { bg: "#0c0c0c", panel: "#111111", fg: "#f2f2f2", dim: "#8a8a8a", line: "#2c2c2c", field: "#161616", hover: "#1c1c1c" },
    terminal: {} },
  { id: "devbox-light", name: "Pier light", dark: false,
    ui: { bg: "#fafafa", panel: "#f3f3f3", fg: "#111111", dim: "#6a6a6a", line: "#d4d4d4", field: "#ffffff", hover: "#e9e9e9" },
    terminal: {} },
  { id: "one-dark", name: "One Dark", dark: true,
    ui: { bg: "#282c34", panel: "#21252b", fg: "#abb2bf", dim: "#5c6370", line: "#181a1f", field: "#1d1f23", hover: "#2c313a", accent: "#528bff" },
    terminal: ansi(["#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf", "#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff"]) },
  { id: "dracula", name: "Dracula", dark: true,
    ui: { bg: "#282a36", panel: "#21222c", fg: "#f8f8f2", dim: "#6272a4", line: "#191a21", field: "#1e1f29", hover: "#44475a", accent: "#bd93f9" },
    terminal: ansi(["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2", "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"]) },
  { id: "nord", name: "Nord", dark: true,
    ui: { bg: "#2e3440", panel: "#3b4252", fg: "#d8dee9", dim: "#616e88", line: "#434c5e", field: "#3b4252", hover: "#434c5e", accent: "#88c0d0" },
    terminal: ansi(["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0", "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"]) },
  { id: "gruvbox-dark", name: "Gruvbox Dark", dark: true,
    ui: { bg: "#282828", panel: "#1d2021", fg: "#ebdbb2", dim: "#928374", line: "#3c3836", field: "#32302f", hover: "#3c3836", accent: "#fabd2f" },
    terminal: ansi(["#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984", "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"]) },
  { id: "tokyo-night", name: "Tokyo Night", dark: true,
    ui: { bg: "#1a1b26", panel: "#16161e", fg: "#c0caf5", dim: "#565f89", line: "#101014", field: "#14141b", hover: "#292e42", accent: "#7aa2f7" },
    terminal: ansi(["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6", "#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5"]) },
  { id: "catppuccin-mocha", name: "Catppuccin Mocha", dark: true,
    ui: { bg: "#1e1e2e", panel: "#181825", fg: "#cdd6f4", dim: "#7f849c", line: "#313244", field: "#181825", hover: "#313244", accent: "#cba6f7" },
    terminal: ansi(["#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de", "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8"]) },
  { id: "solarized-dark", name: "Solarized Dark", dark: true,
    ui: { bg: "#002b36", panel: "#00212b", fg: "#839496", dim: "#586e75", line: "#073642", field: "#073642", hover: "#073642", accent: "#268bd2" },
    terminal: ansi(["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"]) },
  { id: "solarized-light", name: "Solarized Light", dark: false,
    ui: { bg: "#fdf6e3", panel: "#eee8d5", fg: "#586e75", dim: "#93a1a1", line: "#ddd6c1", field: "#fdf6e3", hover: "#e8e2cf", accent: "#268bd2" },
    terminal: ansi(["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"]) },
  { id: "github-light", name: "GitHub Light", dark: false,
    ui: { bg: "#ffffff", panel: "#f6f8fa", fg: "#24292f", dim: "#6e7781", line: "#d0d7de", field: "#ffffff", hover: "#eaeef2", accent: "#0969da" },
    terminal: ansi(["#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781", "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f"]) },
];

// --- colors ---------------------------------------------------------------------

/** "#rgb", "#rrggbb" or "#rrggbbaa" as [r, g, b, a], or null. */
function parseHex(value) {
  if (typeof value !== "string") return null;
  let hex = value.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3,4}$/i.test(hex)) hex = hex.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) return null;
  const n = (i) => parseInt(hex.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), hex.length === 8 ? n(6) / 255 : 1];
}

const toHex = ([r, g, b]) => "#" + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");

/** a mixed into b: 0 gives a, 1 gives b. */
function mix(a, b, amount) {
  const x = parseHex(a), y = parseHex(b);
  if (!x || !y) return a || b;
  return toHex(x.map((c, i) => c + (y[i] - c) * amount));
}

/** A color drawn over a background, its transparency resolved: themes often give
 *  "#ffffff10" for a hover, which only means something on top of the background. */
function flatten(color, background) {
  const c = parseHex(color), bg = parseHex(background);
  if (!c) return null;
  if (c[3] >= 1 || !bg) return toHex(c);
  return toHex(c.slice(0, 3).map((v, i) => bg[i] + (v - bg[i]) * c[3]));
}

function luminance(color) {
  const c = parseHex(color);
  return c ? (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 : 0;
}

/** Fills what a theme leaves out, from its own colors. */
function completeTheme(theme) {
  const ui = { ...theme.ui };
  ui.bg = flatten(ui.bg, "#000000") || (theme.dark ? "#0c0c0c" : "#fafafa");
  ui.fg = flatten(ui.fg, ui.bg) || (luminance(ui.bg) < 0.5 ? "#f2f2f2" : "#111111");
  for (const key of ["panel", "dim", "line", "field", "hover", "accent"]) ui[key] = flatten(ui[key], ui.bg);
  ui.panel ||= mix(ui.bg, ui.fg, 0.03);
  ui.dim ||= mix(ui.fg, ui.bg, 0.45);
  ui.line ||= mix(ui.bg, ui.fg, 0.16);
  ui.field ||= mix(ui.bg, ui.fg, 0.05);
  ui.hover ||= mix(ui.bg, ui.fg, 0.09);
  ui.accent ||= ui.fg;
  const terminal = { ...theme.terminal };
  ui.green = flatten(ui.green || terminal.green, ui.bg) || "#3fb950";
  ui.red = flatten(ui.red || terminal.red, ui.bg) || "#f85149";
  return { ...theme, dark: theme.dark ?? luminance(ui.bg) < 0.5, ui, terminal };
}

// --- reading VS Code and Zed theme files -------------------------------------------

/** JSON with comments and trailing commas, as VS Code theme files often are. */
function parseJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") { out += next ?? ""; i++; } else if (c === '"') inString = false;
    } else if (c === '"') { inString = true; out += c; }
    else if (c === "/" && next === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; }
    else if (c === "/" && next === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; }
    else out += c;
  }
  return JSON.parse(out.replace(/^﻿/, "").replace(/,(\s*[}\]])/g, "$1"));
}

/** A VS Code color theme ("colors" and "type"). */
function fromVsCode(data, fallbackName) {
  const c = data.colors || {};
  const pick = (...keys) => keys.map((k) => c[k]).find((v) => typeof v === "string");
  const terminal = {
    background: pick("terminal.background", "editor.background"),
    foreground: pick("terminal.foreground", "editor.foreground"),
    cursor: pick("terminalCursor.foreground", "editorCursor.foreground"),
    selectionBackground: pick("terminal.selectionBackground", "editor.selectionBackground"),
  };
  for (const key of ANSI_KEYS) terminal[key] = c[`terminal.ansi${key[0].toUpperCase()}${key.slice(1)}`];
  return {
    name: data.name || fallbackName,
    dark: data.type ? data.type !== "light" && data.type !== "hcLight" : undefined,
    ui: {
      bg: pick("editor.background", "sideBar.background"),
      panel: pick("sideBar.background", "panel.background", "editorGroupHeader.tabsBackground"),
      fg: pick("editor.foreground", "foreground"),
      dim: pick("descriptionForeground", "editorLineNumber.foreground", "tab.inactiveForeground"),
      line: pick("panel.border", "editorGroup.border", "sideBar.border", "tab.border", "contrastBorder"),
      field: pick("input.background", "dropdown.background"),
      hover: pick("list.hoverBackground", "toolbar.hoverBackground"),
      accent: pick("focusBorder", "button.background", "activityBarBadge.background"),
    },
    terminal,
  };
}

/** One theme of a Zed theme family ("themes": [{ appearance, style }]). */
function fromZed(theme, family) {
  const s = theme.style || {};
  const pick = (...keys) => keys.map((k) => s[k]).find((v) => typeof v === "string");
  const terminal = {
    background: pick("terminal.background", "editor.background"),
    foreground: pick("terminal.foreground", "text"),
    cursor: s.players?.[0]?.cursor,
    selectionBackground: s.players?.[0]?.selection,
  };
  for (const key of ANSI_KEYS) {
    const zedKey = key.startsWith("bright") ? `bright_${key.slice(6).toLowerCase()}` : key;
    terminal[key] = s[`terminal.ansi.${zedKey}`];
  }
  return {
    name: theme.name || family,
    dark: theme.appearance ? theme.appearance !== "light" : undefined,
    ui: {
      bg: pick("editor.background", "background"),
      panel: pick("panel.background", "surface.background", "background"),
      fg: pick("text", "editor.foreground"),
      dim: pick("text.muted", "text.placeholder"),
      line: pick("border", "border.variant"),
      field: pick("element.background", "editor.background"),
      hover: pick("element.hover", "ghost_element.hover"),
      accent: pick("border.focused", "text.accent"),
    },
    terminal,
  };
}

/** The themes a VS Code or Zed theme file holds (a Zed family can hold several). */
function themesFromFile(text, fileName) {
  let data;
  try { data = parseJsonc(text); } catch (e) { throw new Error(`${fileName} is not valid JSON: ${e.message}`); }
  const base = fileName.replace(/\.json$/i, "");
  let themes;
  if (Array.isArray(data.themes)) themes = data.themes.map((t) => fromZed(t, data.name || base));
  else if (data.colors && typeof data.colors === "object") themes = [fromVsCode(data, base)];
  else throw new Error(`${fileName} is neither a VS Code color theme (with "colors") nor a Zed theme (with "themes").`);
  return themes.filter((t) => parseHex(t.ui.bg)).map((t) => completeTheme({
    ...t,
    id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    imported: fileName,
    ui: Object.fromEntries(Object.entries(t.ui).filter(([, v]) => v)),
    terminal: Object.fromEntries(Object.entries(t.terminal).filter(([, v]) => v)),
  }));
}
