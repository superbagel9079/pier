// Starting up: loaded last, once every part is defined.

// Start

applyTheme();
applyMica();
// Right click: Pier's own menu where it has one (terminals, tabs), the system's in text
// fields and on selected text, nothing elsewhere: never the browser's (Back, Print).
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
  // Windows' own caption glyphs (Segoe Fluent Icons, MDL2 on Windows 10), as Explorer draws
  // them: minimize, maximize, restore, close.
  const glyph = (button, char) => button.replaceChildren(el("span", { className: "caption-glyph", textContent: char, "aria-hidden": "true" }));
  const max = $("#win-max");
  const showMaximized = (maximized) => {
    glyph(max, maximized ? "\uE923" : "\uE922");
    max.title = maximized ? "Restore" : "Maximize";
    max.setAttribute("aria-label", max.title);
  };
  glyph($("#win-min"), "\uE921");
  glyph($("#win-close"), "\uE8BB");
  showMaximized(false);
  win.isMaximized().then(showMaximized).catch(() => {});
  win.onResized(() => win.isMaximized().then(showMaximized).catch(() => {})).catch(() => {});
  $("#win-min").addEventListener("click", () => win.minimize());
  max.addEventListener("click", () => win.toggleMaximize());
  $("#win-close").addEventListener("click", () => win.close());
  // The top bar while not connected; then the rail and the docks' bars, where nothing is
  // (not on a tab: a tab is dragged to another dock).
  document.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || !event.target.closest("#topbar, #rail, .dock-head, .center-head, .pane-project > .toolbar .switch, .settings-nav")) return;
    if (event.target.closest("button, a, input, select, textarea, [role=tab], .tab, .menu, .prefs-tabs")) return;
    if (event.detail === 2) win.toggleMaximize();
    else win.startDragging();
  });
  $("#window-buttons").hidden = false;
})();
backend.setLogLevel(prefs.debugLogs).catch(() => {});
// Straight on the app: the card offers to connect, or the New tab page starts the setup.
(async () => {
  settings = await backend.loadSettings();
  showOffline();
})();
