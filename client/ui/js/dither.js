// Pier's 1-bit motif: ordered (Bayer) dithering, and the Pier mark drawn with it in text.
//
// The mark is the icon's own drawing (client/icon-source.png, a 16×16 grid of 64 px
// cells): nothing new is invented, it is shown the way a 1-bit screen shows tone. Text,
// not an image: it takes the theme's colour and the console font by itself, costs no
// download, and goes in through textContent (the CSP allows no HTML parsing).

/** The 4×4 Bayer matrix: the order in which an ordered dither lights its dots. */
const BAYER_4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** The Pier mark ("pi") as icon-source.png draws it: rows 3 to 12 and columns 3 to 12
 *  of its 16×16 grid, "#" for the glyph. */
const PIER_MARK = [
  "........#.",
  "..........",
  "######..#.",
  "#....#..#.",
  "#....#..#.",
  "######..#.",
  "#......###",
  "#.........",
  "#.........",
  "#.........",
];

/** The tones text can draw, from empty to full. */
const MARK_RAMP = " .:+#";
/** The one-time reveal: long enough to be seen, short enough never to hold anyone up. */
const MARK_REVEAL_MS = 600;

/** The Bayer threshold of cell (x, y): strictly between 0 and 1, repeating every 4 cells. */
function bayerThreshold(x, y) {
  return (BAYER_4[y & 3][x & 3] + 0.5) / 16;
}

/** tone (0 to 1, clamped) as one of levels steps at cell (x, y). Between two steps the
 *  cell's threshold decides, so a flat tone comes out as its exact share of brighter
 *  cells: 0.25 lights 4 cells of every 16.
 *  ditherLevel(0.5, 0, 0, 2) → 1; ditherLevel(0.5, 1, 0, 2) → 0. */
function ditherLevel(tone, x, y, levels) {
  const scaled = Math.min(1, Math.max(0, tone)) * (levels - 1);
  const base = Math.floor(scaled);
  return Math.min(levels - 1, base + (scaled - base > bayerThreshold(x, y) ? 1 : 0));
}

/** The mark as lines of text, one string. Each cell of the icon becomes cols characters
 *  by rows lines; a character is about twice as tall as it is wide, so cols = 2 × rows
 *  keeps the cells square. The light falls from the top left: the glyph's tone is
 *  dithered across ramp, so the shading reads as a 1-bit screen's while the edges stay
 *  exactly the icon's. progress (0 to 1) draws only the cells whose threshold it has
 *  passed, in Bayer order: the reveal. Every call returns as many lines, whatever progress.
 *  markText({ cols: 2, rows: 1 }) → 10 lines, the widest 20 characters. */
function markText({ cols = 2, rows = 1, ramp = MARK_RAMP, progress = 1 } = {}) {
  const width = PIER_MARK[0].length * cols;
  const height = PIER_MARK.length * rows;
  const lines = [];
  for (let y = 0; y < height; y++) {
    let line = "";
    for (let x = 0; x < width; x++) {
      const on = PIER_MARK[Math.floor(y / rows)][Math.floor(x / cols)] === "#";
      if (!on || progress <= bayerThreshold(x, y)) {
        line += " ";
        continue;
      }
      // 1 at the top left down to 0.45 at the bottom right; never the ramp's empty
      // first step, so the glyph always stays whole.
      const tone = 1 - (0.55 * (x / (width - 1) + y / (height - 1))) / 2;
      line += ramp[Math.max(1, ditherLevel(tone, x, y, ramp.length))];
    }
    lines.push(line.trimEnd());
  }
  return lines.join("\n");
}

/** Draws the mark into pre, once per element. reveal: the cells come in Bayer order over
 *  MARK_REVEAL_MS (the way a 1-bit screen fades in), easing out, and not at all when the
 *  system asks for less motion. Every frame has the same number of lines, so nothing
 *  around the mark moves while it appears. */
function showMark(pre, { cols = 2, rows = 1, reveal = false } = {}) {
  if (!pre || pre.dataset.drawn) return;
  pre.dataset.drawn = "1";
  const finished = markText({ cols, rows });
  if (!reveal || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    pre.textContent = finished;
    return;
  }
  const start = performance.now();
  const frame = (now) => {
    const t = Math.min(1, (now - start) / MARK_REVEAL_MS);
    pre.textContent = t < 1 ? markText({ cols, rows, progress: 1 - (1 - t) ** 2 }) : finished;
    if (t < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// Node (client/test) reads this same file; in the page there is no module and this is skipped.
if (typeof module === "object" && module.exports) {
  module.exports = { BAYER_4, PIER_MARK, MARK_RAMP, MARK_REVEAL_MS, bayerThreshold, ditherLevel, markText };
}
