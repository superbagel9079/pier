// themes.test.js: completeTheme keeps every theme readable (WCAG AA) on every surface Pier draws.
const test = require("node:test");
const assert = require("node:assert/strict");
const { UI_KEYS, BUILTIN_THEMES, completeTheme, mix, contrast } = require("../ui/themes.js");

/** Where dim text is drawn, from style.css: the theme's own surfaces, the ones mixed from
 *  bg and fg (--surface 5%, --raise 10%, --strong 16%) and a removed diff line (--del-bg). */
function dimSurfaces(ui) {
  return {
    bg: ui.bg,
    panel: ui.panel,
    field: ui.field,
    hover: ui.hover,
    surface: mix(ui.bg, ui.fg, 0.05),
    raise: mix(ui.bg, ui.fg, 0.1),
    strong: mix(ui.bg, ui.fg, 0.16),
    delBg: mix(ui.bg, ui.red, 0.18),
  };
}

function assertReadable(ui) {
  for (const [name, bg] of Object.entries(dimSurfaces(ui))) {
    const ratio = contrast(ui.dim, bg);
    assert.ok(ratio >= 4.5, `dim ${ui.dim} on ${name} ${bg}: ${ratio.toFixed(2)}:1`);
  }
  for (const bg of [ui.bg, ui.panel, ui.field, mix(ui.bg, ui.fg, 0.05), mix(ui.bg, ui.green, 0.18), mix(ui.bg, ui.red, 0.18)]) {
    const ratio = contrast(ui.fg, bg);
    assert.ok(ratio >= 4.5, `fg ${ui.fg} on ${bg}: ${ratio.toFixed(2)}:1`);
  }
  for (const bg of [ui.bg, ui.panel, ui.field, ui.hover]) {
    assert.ok(contrast(ui.accent, bg) >= 3, `accent ${ui.accent} on ${bg}`);
  }
  for (const bg of [ui.bg, ui.panel, ui.field]) {
    assert.ok(contrast(ui.edge, bg) >= 3, `edge ${ui.edge} on ${bg}`);
  }
}

test("contrast is WCAG's ratio", () => {
  assert.equal(Math.round(contrast("#000000", "#ffffff") * 100) / 100, 21);
  assert.equal(contrast("#777777", "#777777"), 1);
  assert.equal(contrast("#ffffff", "#000000"), contrast("#000000", "#ffffff"));
});

for (const theme of BUILTIN_THEMES) {
  test(`${theme.id}: text and dim 4.5:1 everywhere, the diff lines included; accent and edges 3:1`, () => {
    assertReadable(completeTheme(theme).ui);
  });
}

test("a theme that gives only bg and fg gets every key, readable", () => {
  const { ui, dark } = completeTheme({ id: "bare", name: "Bare", ui: { bg: "#1e1e1e", fg: "#d4d4d4" }, terminal: {} });
  for (const key of UI_KEYS) assert.match(ui[key], /^#[0-9a-f]{6}$/, key);
  assert.equal(dark, true);
  assertReadable(ui);
});

test("a theme whose own text is barely readable still gets readable dim text", () => {
  // fg on bg is about 1.4:1 here: dim goes past fg, toward black, until it reads.
  const { ui } = completeTheme({ id: "grey", name: "Grey", ui: { bg: "#808080", fg: "#9a9a9a" }, terminal: {} });
  assertReadable(ui);
});

test("a translucent colour is flattened over the background", () => {
  const { ui } = completeTheme({ id: "glass", name: "Glass", ui: { bg: "#000000", fg: "#ffffff", hover: "#ffffff10" }, terminal: {} });
  assert.equal(ui.hover, "#101010");
});

test("the terminal's red is the diff's red when the theme has no ui red", () => {
  const { ui } = completeTheme({ id: "term", name: "Term", ui: { bg: "#ffffff", fg: "#000000" }, terminal: { red: "#cc0000" } });
  assert.equal(ui.red, "#cc0000");
  assertReadable(ui);
});
