// Starting up: loaded last, once every part is defined.

// ============================================================================
// Start
// ============================================================================

applyTheme();
// Right click: Pier's own menu where it has one (terminals, tabs), the system's in a text
// field or on selected text (copy, paste), and nothing elsewhere: never the browser's
// (Back, Refresh, Print…), which only makes sense in a browser.
document.addEventListener("contextmenu", (event) => {
  if (event.defaultPrevented) return;
  const field = event.target.closest?.("input:not([type=checkbox]):not([type=radio]):not([type=button]), textarea, [contenteditable]");
  if (field || String(window.getSelection?.() || "").trim()) return;
  event.preventDefault();
});
// Over a text box's scrollbar, the arrow as on every other scrollbar: Chromium keeps the
// box's text cursor there once scrollbars are styled (style.css), and no CSS reaches it.
document.addEventListener("mousemove", (event) => {
  const box = event.target;
  if (box.tagName !== "TEXTAREA") return;
  const onBar = event.offsetX >= box.clientWidth || event.offsetY >= box.clientHeight;
  const want = onBar ? "default" : "";
  if (box.style.cursor !== want) box.style.cursor = want;
}, { passive: true });

// Windows: no system title bar (tauri.windows.conf.json), Pier's top bar is it. Pressed
// where nothing is to click, it moves the window; twice, it maximizes or restores it.
(() => {
  const win = tauri?.window?.getCurrentWindow?.();
  if (!win || !/Windows/.test(navigator.userAgent)) return;
  document.body.classList.add("own-titlebar");
  const ns = "http://www.w3.org/2000/svg";
  const glyph = (button, paths) => {
    const svg = document.createElementNS(ns, "svg");
    for (const [k, v] of Object.entries({ viewBox: "0 0 10 10", width: "10", height: "10", fill: "none", stroke: "currentColor",
      "stroke-width": "1", "shape-rendering": "crispEdges", "aria-hidden": "true" })) svg.setAttribute(k, v);
    for (const d of paths) {
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    button.replaceChildren(svg);
  };
  const max = $("#win-max");
  const showMaximized = (maximized) => {
    glyph(max, maximized ? ["M2.5 .5h7v7", "M.5 2.5h7v7h-7z"] : ["M.5 .5h9v9h-9z"]);
    max.title = maximized ? "Restore" : "Maximize";
    max.setAttribute("aria-label", max.title);
  };
  glyph($("#win-min"), ["M0 5.5h10"]);
  glyph($("#win-close"), ["M.5 .5l9 9", "M9.5 .5l-9 9"]);
  $("#win-close svg").setAttribute("shape-rendering", "geometricPrecision"); // diagonals: smoothed
  showMaximized(false);
  win.isMaximized().then(showMaximized).catch(() => {});
  win.onResized(() => win.isMaximized().then(showMaximized).catch(() => {})).catch(() => {});
  $("#win-min").addEventListener("click", () => win.minimize());
  max.addEventListener("click", () => win.toggleMaximize());
  $("#win-close").addEventListener("click", () => win.close());
  $("#topbar").addEventListener("mousedown", (event) => {
    if (event.button !== 0 || event.target.closest("button, a, input, select, textarea")) return;
    if (event.detail === 2) win.toggleMaximize();
    else win.startDragging();
  });
  $("#window-buttons").hidden = false;
})();
backend.setLogLevel(prefs.debugLogs).catch(() => {});
(async () => {
  settings = await backend.loadSettings();
  if (settings) toLogin();
  else {
    fillSetup(null);
    showConnect("setup");
  }
})();
