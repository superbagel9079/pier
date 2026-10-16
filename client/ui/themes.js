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
  { id: "ayu-dark", name: "Ayu Dark", dark: true,
    ui: { bg: "#0b0e14", panel: "#0d1017", fg: "#bfbdb6", dim: "#565b66", line: "#1b1f29", field: "#0d1017", hover: "#131721", accent: "#e6b450" },
    terminal: ansi(["#01060e", "#ea6c73", "#91b362", "#f9af4f", "#53bdfa", "#fae994", "#90e1c6", "#c7c7c7", "#686868", "#f07178", "#c2d94c", "#ffb454", "#59c2ff", "#ffee99", "#95e6cb", "#ffffff"]) },
  { id: "ayu-light", name: "Ayu Light", dark: false,
    ui: { bg: "#fcfcfc", panel: "#f3f4f5", fg: "#5c6166", dim: "#8a9199", line: "#e6e7e9", field: "#ffffff", hover: "#eef0f2", accent: "#ff9940" },
    terminal: ansi(["#000000", "#ea6c6d", "#6cbf43", "#eca944", "#3199e1", "#9e75c7", "#46ba94", "#bababa", "#686868", "#f07171", "#86b300", "#f2ae49", "#399ee6", "#a37acc", "#4cbf99", "#d1d1d1"]) },
  { id: "catppuccin-latte", name: "Catppuccin Latte", dark: false,
    ui: { bg: "#eff1f5", panel: "#e6e9ef", fg: "#4c4f69", dim: "#8c8fa1", line: "#ccd0da", field: "#eff1f5", hover: "#dce0e8", accent: "#8839ef" },
    terminal: ansi(["#5c5f77", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#acb0be", "#6c6f85", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#bcc0cc"]) },
  { id: "catppuccin-mocha", name: "Catppuccin Mocha", dark: true,
    ui: { bg: "#1e1e2e", panel: "#181825", fg: "#cdd6f4", dim: "#7f849c", line: "#313244", field: "#181825", hover: "#313244", accent: "#cba6f7" },
    terminal: ansi(["#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de", "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8"]) },
  { id: "dracula", name: "Dracula", dark: true,
    ui: { bg: "#282a36", panel: "#21222c", fg: "#f8f8f2", dim: "#6272a4", line: "#191a21", field: "#1e1f29", hover: "#44475a", accent: "#bd93f9" },
    terminal: ansi(["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2", "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"]) },
  { id: "everforest-dark", name: "Everforest Dark", dark: true,
    ui: { bg: "#2d353b", panel: "#232a2e", fg: "#d3c6aa", dim: "#859289", line: "#3d484d", field: "#232a2e", hover: "#343f44", accent: "#a7c080" },
    terminal: ansi(["#475258", "#e67e80", "#a7c080", "#dbbc7f", "#7fbbb3", "#d699b6", "#83c092", "#d3c6aa", "#475258", "#e67e80", "#a7c080", "#dbbc7f", "#7fbbb3", "#d699b6", "#83c092", "#d3c6aa"]) },
  { id: "github-dark", name: "GitHub Dark", dark: true,
    ui: { bg: "#0d1117", panel: "#010409", fg: "#e6edf3", dim: "#7d8590", line: "#30363d", field: "#0d1117", hover: "#161b22", accent: "#2f81f7" },
    terminal: ansi(["#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4", "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#ffffff"]) },
  { id: "github-light", name: "GitHub Light", dark: false,
    ui: { bg: "#ffffff", panel: "#f6f8fa", fg: "#24292f", dim: "#6e7781", line: "#d0d7de", field: "#ffffff", hover: "#eaeef2", accent: "#0969da" },
    terminal: ansi(["#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781", "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f"]) },
  { id: "gruvbox-dark", name: "Gruvbox Dark", dark: true,
    ui: { bg: "#282828", panel: "#1d2021", fg: "#ebdbb2", dim: "#928374", line: "#3c3836", field: "#32302f", hover: "#3c3836", accent: "#fabd2f" },
    terminal: ansi(["#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984", "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"]) },
  { id: "gruvbox-light", name: "Gruvbox Light", dark: false,
    ui: { bg: "#fbf1c7", panel: "#f2e5bc", fg: "#3c3836", dim: "#928374", line: "#d5c4a1", field: "#f9f5d7", hover: "#ebdbb2", accent: "#b57614" },
    terminal: ansi(["#fbf1c7", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#7c6f64", "#928374", "#9d0006", "#79740e", "#b57614", "#076678", "#8f3f71", "#427b58", "#3c3836"]) },
  { id: "kanagawa", name: "Kanagawa", dark: true,
    ui: { bg: "#1f1f28", panel: "#16161d", fg: "#dcd7ba", dim: "#727169", line: "#2a2a37", field: "#16161d", hover: "#2a2a37", accent: "#7e9cd8" },
    terminal: ansi(["#090618", "#c34043", "#76946a", "#c0a36e", "#7e9cd8", "#957fb8", "#6a9589", "#c8c093", "#727169", "#e82424", "#98bb6c", "#e6c384", "#7fb4ca", "#938aa9", "#7aa89f", "#dcd7ba"]) },
  { id: "monokai", name: "Monokai", dark: true,
    ui: { bg: "#272822", panel: "#1e1f1c", fg: "#f8f8f2", dim: "#75715e", line: "#3e3d32", field: "#1e1f1c", hover: "#3e3d32", accent: "#a6e22e" },
    terminal: ansi(["#272822", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f8f8f2", "#75715e", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f9f8f5"]) },
  { id: "night-owl", name: "Night Owl", dark: true,
    ui: { bg: "#011627", panel: "#010e1a", fg: "#d6deeb", dim: "#637777", line: "#122d42", field: "#0b2942", hover: "#1d3b53", accent: "#7e57c2" },
    terminal: ansi(["#011627", "#ef5350", "#22da6e", "#addb67", "#82aaff", "#c792ea", "#21c7a8", "#ffffff", "#575656", "#ef5350", "#22da6e", "#ffeb95", "#82aaff", "#c792ea", "#7fdbca", "#ffffff"]) },
  { id: "nord", name: "Nord", dark: true,
    ui: { bg: "#2e3440", panel: "#3b4252", fg: "#d8dee9", dim: "#616e88", line: "#434c5e", field: "#3b4252", hover: "#434c5e", accent: "#88c0d0" },
    terminal: ansi(["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0", "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"]) },
  { id: "one-dark", name: "One Dark", dark: true,
    ui: { bg: "#282c34", panel: "#21252b", fg: "#abb2bf", dim: "#5c6370", line: "#181a1f", field: "#1d1f23", hover: "#2c313a", accent: "#528bff" },
    terminal: ansi(["#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf", "#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff"]) },
  { id: "one-light", name: "One Light", dark: false,
    ui: { bg: "#fafafa", panel: "#f0f0f0", fg: "#383a42", dim: "#a0a1a7", line: "#dbdbdc", field: "#ffffff", hover: "#e5e5e6", accent: "#4078f2" },
    terminal: ansi(["#383a42", "#e45649", "#50a14f", "#c18401", "#4078f2", "#a626a4", "#0184bc", "#a0a1a7", "#696c77", "#e45649", "#50a14f", "#c18401", "#4078f2", "#a626a4", "#0184bc", "#fafafa"]) },
  { id: "rose-pine", name: "Rosé Pine", dark: true,
    ui: { bg: "#191724", panel: "#1f1d2e", fg: "#e0def4", dim: "#6e6a86", line: "#26233a", field: "#1f1d2e", hover: "#26233a", accent: "#c4a7e7" },
    terminal: ansi(["#26233a", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4", "#6e6a86", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4"]) },
  { id: "rose-pine-dawn", name: "Rosé Pine Dawn", dark: false,
    ui: { bg: "#faf4ed", panel: "#fffaf3", fg: "#575279", dim: "#9893a5", line: "#dfdad9", field: "#fffaf3", hover: "#f2e9e1", accent: "#907aa9" },
    terminal: ansi(["#f2e9e1", "#b4637a", "#286983", "#ea9d34", "#56949f", "#907aa9", "#d7827e", "#575279", "#9893a5", "#b4637a", "#286983", "#ea9d34", "#56949f", "#907aa9", "#d7827e", "#575279"]) },
  { id: "solarized-dark", name: "Solarized Dark", dark: true,
    ui: { bg: "#002b36", panel: "#00212b", fg: "#839496", dim: "#586e75", line: "#073642", field: "#073642", hover: "#073642", accent: "#268bd2" },
    terminal: ansi(["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"]) },
  { id: "solarized-light", name: "Solarized Light", dark: false,
    ui: { bg: "#fdf6e3", panel: "#eee8d5", fg: "#586e75", dim: "#93a1a1", line: "#ddd6c1", field: "#fdf6e3", hover: "#e8e2cf", accent: "#268bd2" },
    terminal: ansi(["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"]) },
  { id: "tokyo-night", name: "Tokyo Night", dark: true,
    ui: { bg: "#1a1b26", panel: "#16161e", fg: "#c0caf5", dim: "#565f89", line: "#101014", field: "#14141b", hover: "#292e42", accent: "#7aa2f7" },
    terminal: ansi(["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6", "#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5"]) },
  { id: "tomorrow-night", name: "Tomorrow Night", dark: true,
    ui: { bg: "#1d1f21", panel: "#161719", fg: "#c5c8c6", dim: "#969896", line: "#282a2e", field: "#161719", hover: "#282a2e", accent: "#81a2be" },
    terminal: ansi(["#1d1f21", "#cc6666", "#b5bd68", "#f0c674", "#81a2be", "#b294bb", "#8abeb7", "#c5c8c6", "#969896", "#cc6666", "#b5bd68", "#f0c674", "#81a2be", "#b294bb", "#8abeb7", "#ffffff"]) },
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
