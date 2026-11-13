// Tests for client/ui/js/dither.js: the Bayer matrix, the dither, the mark's shape and its reveal.
// Run from the repository root: node --test client/test/dither.test.js client/test/themes.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { BAYER_4, PIER_MARK, MARK_RAMP, bayerThreshold, ditherLevel, markText } = require("../ui/js/dither.js");

/** The characters of a drawn mark, row by row, padded to the full width. */
function grid(text, cols) {
  const width = PIER_MARK[0].length * cols;
  return text.split("\n").map((line) => [...line.padEnd(width)]);
}

test("the Bayer matrix holds each value from 0 to 15 exactly once", () => {
  assert.deepEqual(BAYER_4.flat().sort((a, b) => a - b), [...Array(16).keys()]);
});

test("thresholds stay strictly between 0 and 1 and repeat every 4 cells", () => {
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const t = bayerThreshold(x, y);
      assert.ok(t > 0 && t < 1, `threshold ${t} at ${x},${y}`);
      assert.equal(t, bayerThreshold(x + 4, y + 4));
    }
  }
});

test("a flat tone lights exactly its share of a 4×4 tile", () => {
  for (const tone of [0, 1 / 16, 0.25, 0.5, 0.75, 15 / 16, 1]) {
    let lit = 0;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) lit += ditherLevel(tone, x, y, 2);
    assert.equal(lit, Math.round(tone * 16), `tone ${tone}`);
  }
});

test("tones out of range are clamped, never wrapped or out of the ramp", () => {
  assert.equal(ditherLevel(-3, 0, 0, 5), 0);
  assert.equal(ditherLevel(7, 3, 3, 5), 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const level = ditherLevel(0.999, x, y, 5);
      assert.ok(level >= 0 && level <= 4);
    }
  }
});

test("the mark's grid is the icon's: ten rows of ten cells, glyph or empty", () => {
  assert.equal(PIER_MARK.length, 10);
  for (const row of PIER_MARK) assert.match(row, /^[#.]{10}$/);
});

test("the drawn mark keeps the icon's shape exactly, at every size", () => {
  for (const [cols, rows] of [[1, 1], [2, 1], [4, 2], [6, 3]]) {
    const cells = grid(markText({ cols, rows }), cols);
    assert.equal(cells.length, PIER_MARK.length * rows);
    cells.forEach((line, y) => line.forEach((ch, x) => {
      const on = PIER_MARK[Math.floor(y / rows)][Math.floor(x / cols)] === "#";
      assert.equal(ch !== " ", on, `cell ${x},${y} at ${cols}×${rows}`);
    }));
  }
});

test("the drawn mark uses only the ramp's characters, and is lighter where the light falls", () => {
  const text = markText({ cols: 4, rows: 2 });
  for (const ch of text.replace(/[ \n]/g, "")) assert.ok(MARK_RAMP.includes(ch), `unexpected ${ch}`);
  const weight = (ch) => MARK_RAMP.indexOf(ch);
  const cells = grid(text, 4);
  // The p's stem: its top is lit more than its foot.
  const stem = (from, to) => cells.slice(from, to).flatMap((line) => line.slice(0, 4)).reduce((sum, ch) => sum + weight(ch), 0);
  assert.ok(stem(4, 8) > stem(16, 20));
});

test("the reveal starts empty, ends whole, only ever adds cells and keeps its height", () => {
  assert.equal(markText({ progress: 0 }).replace(/\s/g, ""), "");
  assert.equal(markText({ progress: 1 }), markText());
  let before = 0;
  for (const progress of [0.05, 0.2, 0.4, 0.6, 0.8, 0.95, 1]) {
    const text = markText({ progress });
    assert.equal(text.split("\n").length, PIER_MARK.length);
    const count = text.replace(/\s/g, "").length;
    assert.ok(count >= before, `progress ${progress}: ${count} < ${before}`);
    before = count;
  }
});
