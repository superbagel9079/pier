// Terminal tabs: xterm.js on a channel of the SSH connection.

// ============================================================================
// Terminal
// ============================================================================

/** How long the VM takes to answer what is typed: from a key sent to the next output,
 *  as seen here (network, VM, tmux and Pi together). Logged at debug level ("Detailed
 *  logs"), every 30 s while there is something to report. */
function latencyMeter(kind) {
  let waiting = 0;
  let samples = [];
  let last = performance.now();
  const meter = {
    asked() { if (!waiting) waiting = performance.now(); },
    answer() {
      if (!waiting) return;
      samples.push(performance.now() - waiting);
      waiting = 0;
      if (performance.now() - last > 30000) meter.report();
    },
    report() {
      last = performance.now();
      if (!samples.length) return;
      const sorted = samples.sort((a, b) => a - b);
      const at = (q) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
      uiLog("debug", "term-latency", { kind, n: sorted.length, p50: at(0.5), p90: at(0.9), max: at(1) });
      samples = [];
    },
  };
  return meter;
}

// When the window last saw a paste: a terminal falls back to reading the clipboard
// itself when Ctrl+V brought none.
let lastPasteEvent = 0;
document.addEventListener("paste", () => { lastPasteEvent = performance.now(); }, true);

function makeTerminal(tab, kind) {
  if (kind === "pi" && tab.params) tab.title = `pi · ${tab.params.label}`;
  if (kind === "update" && tab.params) tab.title = `pi update · ${tab.params.label}`;
  tab.pane.classList.add("terminal");
  const term = new window.Terminal({
    fontFamily: '"Cascadia Mono", Consolas, ui-monospace, monospace',
    fontSize: prefs.fontSize,
    cursorBlink: true,
    scrollback: 5000,
    theme: terminalTheme(),
    // A link in a program's output (OSC 8) is not opened: its address is copied, to
    // paste in a browser after reading it. A program on the VM opens nothing here.
    linkHandler: {
      activate: (event, uri) => {
        if (!/^https?:\/\//i.test(uri)) return;
        copyText(uri, "link");
        flashStatus(`link copied: ${uri.slice(0, 80)}`, tab.pane);
      },
      allowNonHttpProtocols: false,
    },
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(tab.pane);
  useGpu(term);
  let id = null;
  let ended = false;
  let closed = false;
  let starts = 0;          // which start() is current: a late answer of an older one is dropped
  // The clipboard is set by a program only just after the user acted in this tab: a
  // key pressed or a mouse button released (real DOM events). Not onData: xterm.js
  // also fires it for its own answers (cursor position, device attributes, focus and
  // mouse reports), which the program on the VM can ask for at will. One copy per act.
  let actedAt = 0;
  let ignoredLoggedAt = 0;
  let dropped = false;     // the connection went away under this terminal
  let startedAt = 0;
  const latency = latencyMeter(kind);
  // Pi tabs: tmux interprets no key there (control mode), so its Ctrl-b d is Pier's.
  let prefix = false;      // Ctrl-b was pressed, the next key decides
  let pendingKeys = "";    // a Ctrl-b that turned out to be for Pi, sent with the next key

  const visible = () => !tab.pane.hidden && tab.pane.offsetParent !== null;
  tab.refit = () => { if (visible()) { try { fit.fit(); } catch { /* not laid out yet */ } } };
  tab.applyTheme = () => { term.options.theme = terminalTheme(); };
  tab.applyFont = () => { term.options.fontSize = prefs.fontSize; tab.refit(); };

  async function start() {
    ended = false;
    dropped = false;
    startedAt = performance.now();
    const mine = ++starts;
    tab.termId = null;
    tab.refit();
    try {
      const opened = [term.cols, term.rows];
      const fresh = await backend.termOpen(kind, term.cols, term.rows, (bytes) => { latency.answer(); term.write(bytes); }, tab.params);
      if (closed || mine !== starts) {
        backend.termClose(fresh); // the tab closed or restarted meanwhile: nothing left running
        return;
      }
      id = fresh;
      tab.termId = id;
      const early = exitedEarly.get(id);
      if (early) {           // it ended before its id was known here
        exitedEarly.delete(id);
        tab.onExit(early.clean);
        return;
      }
      if (term.cols !== opened[0] || term.rows !== opened[1]) backend.termResize(id, term.cols, term.rows);
      // A Pi tab joins a Pi that set its terminal modes long ago, on another terminal:
      // bracketed paste is set here, so that a pasted text with line breaks does not
      // send each line as a message. (Only this terminal's state: nothing is sent.)
      if (kind === "pi") term.write("\x1b[?2004h");
    } catch (error) {
      term.write(`\r\n\x1b[1m${String(error)}\x1b[0m\r\n\x1b[2m[press Enter to retry]\x1b[0m\r\n`);
      ended = true;
    }
  }

  // xterm.js sends a plain Enter whatever the modifiers. Pi tells them apart (Shift+Enter
  // is a new line, Enter sends), so modified Enters go out in CSI-u form, which tmux
  // passes on with extended-keys set.
  // Copy and paste. Two ways, a setting (prefs.copyKeys):
  //   "linux"   (default) Ctrl+Shift+C copies, Ctrl+Shift+V pastes; Ctrl+C and Ctrl+V
  //             go to the program, as in a Linux terminal: Ctrl+C always interrupts.
  //   "windows" Ctrl+C copies when text is selected (and interrupts otherwise), Ctrl+V
  //             pastes, as in Windows Terminal; Ctrl+Shift+C/V work too.
  // Shift+Insert pastes either way. Pasting lets the window paste: an image goes to Pi
  // (see context.js), text is typed by xterm.js (as a bracketed paste, so a pasted
  // command does not run by itself).
  //
  // Copying (prefs.copyMode): "key" (default) copies with Ctrl+Shift+C only; "select"
  // copies as soon as text is selected. Pi runs in its regular mode and tmux leaves the
  // mouse alone (see tmux_conf in the picker): selecting is always this terminal's.
  async function copyText(text, how) {
    try {
      await backend.copyText(text);
    } catch (error) {
      uiLog("warn", "term-copy-failed", { msg: String(error), how });
      try { await navigator.clipboard.writeText(text); } catch { flashStatus("could not copy: see the log", tab.pane); return; }
    }
    uiLog("debug", "term-copy", { chars: text.length, how });
    const count = `${text.length} character${text.length === 1 ? "" : "s"}`;
    if (how === "osc52") {
      // Copied by the program, not by Pier: show what, so a surprise is seen.
      const start = text.replace(/\s+/g, " ").trim();
      const preview = start.length > 48 ? `${start.slice(0, 48)}…` : start;
      flashStatus(`the program copied ${count}: “${preview}”`, tab.pane);
    } else {
      flashStatus(`copied ${count}`, tab.pane);
    }
  }

  function copySelection() {
    const text = term.getSelection();
    term.clearSelection();
    if (text) copyText(text, "selection");
    else flashStatus(term.modes.mouseTrackingMode !== "none" ? "nothing selected (this program takes the mouse: Shift+drag)" : "nothing selected", tab.pane);
  }

  // Copy on select, when that is the setting.
  // Captured: xterm.js stops the event when the program takes the mouse.
  tab.pane.addEventListener("pointerup", (event) => {
    if (event.isTrusted) actedAt = performance.now();
  }, true);
  tab.pane.addEventListener("mouseup", () => {
    if (prefs.copyMode === "select" && term.hasSelection()) {
      const text = term.getSelection();
      if (text) copyText(text, "select");
    }
  });

  // OSC 52: a program sets the clipboard ("ESC ] 52 ; c ; <base64> BEL"), as Pi's copy
  // commands do (tmux passes them on). Only setting is accepted, never reading it back:
  // a program on the VM must not read this computer's clipboard.
  const decoder = new TextDecoder();
  term.parser.registerOscHandler(52, (data) => {
    const payload = data.slice(data.indexOf(";") + 1);
    if (!payload || payload === "?" || payload.length > 2 * 1024 * 1024) return true;
    // Only right after a key typed or a click in this tab (Pi's copy command, a yank in
    // vim, tmux's copy on mouse release), and once per act: a program on the VM cannot
    // change this computer's clipboard behind your back.
    const now = performance.now();
    if (now - actedAt > 2000) {
      if (now - ignoredLoggedAt > 10000) {
        ignoredLoggedAt = now;
        uiLog("info", "term-osc52-ignored", { kind, why: "no key typed or click just before" });
      }
      return true;
    }
    actedAt = 0;
    try {
      const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
      const text = decoder.decode(bytes);
      if (text) copyText(text, "osc52");
    } catch (error) {
      uiLog("warn", "term-osc52-bad", { msg: String(error) });
    }
    return true;
  });

  // OSC 7770: Pier's own requests. The picker, run in this tab, asks for Pi to open
  // in a Pi tab ("open-pi;{project, label, slot, n}") instead of attaching to tmux in
  // here (see pi_in_tmux in the picker). Only the picker's tabs act on it.
  term.parser.registerOscHandler(7770, (data) => {
    // In a Pi tab, Pier's Rust side names the tmux session shown (see term.rs).
    if (kind === "pi" && data.startsWith("session;")) {
      tab.slot = data.slice("session;".length);
      renderSessionBadge();
      return true;
    }
    if (kind !== "picker" || !data.startsWith("open-pi;")) return true;
    try {
      const request = JSON.parse(data.slice("open-pi;".length));
      if (typeof request.project === "string" && /^pi-[A-Za-z0-9_-]+$/.test(request.slot || "")) {
        uiLog("info", "open-pi-from-picker", { project: request.project, slot: request.slot });
        openPiTerminal(request.project, request.label || request.project, ["--slot", request.slot], Number(request.n) || 1);
      }
    } catch (error) {
      uiLog("warn", "open-pi-bad-request", { msg: String(error) });
    }
    return true;
  });

  /** The window pastes on its own (images go to Pi, text to xterm.js). Should no paste
   *  event come, the clipboard's text is read and pasted here instead. */
  function pasteFallback() {
    const asked = performance.now();
    setTimeout(async () => {
      if (lastPasteEvent >= asked) return;
      try {
        const text = await backend.clipboardText();
        if (text) term.paste(text);
        uiLog("info", "term-paste-fallback", { chars: text.length });
      } catch (error) {
        uiLog("warn", "term-paste-failed", { msg: String(error) });
        flashStatus("nothing to paste as text (an image? use Ctrl+Alt+V)", tab.pane);
      }
    }, 150);
  }

  /** true when the key is a copy, a paste or a text size, handled here; false: the
   *  program gets it. */
  function clipboardKey(event) {
    if (fontKey(event)) return true;
    const ctrl = (event.ctrlKey || event.metaKey) && !event.altKey;
    const letter = event.code === "KeyC" ? "c" : event.code === "KeyV" ? "v" : event.key.toLowerCase();
    const windows = prefs.copyKeys === "windows";
    if (ctrl && letter === "c" && (event.shiftKey || (windows && term.hasSelection()))) {
      copySelection();
      event.preventDefault();
      return true;
    }
    if ((ctrl && letter === "v" && (event.shiftKey || windows)) || (event.shiftKey && event.key === "Insert")) {
      pasteFallback();
      return true;
    }
    return false;
  }

  async function pasteText() {
    try {
      const text = await backend.clipboardText();
      if (text) term.paste(text);
    } catch {
      flashStatus("nothing to paste as text (an image? Ctrl+Shift+V)", tab.pane);
    }
    term.focus();
  }

  // Right click: Pier's menu, in every terminal (Pi's tmux leaves the button to it).
  tab.pane.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const selected = term.hasSelection();
    showMenu(null, [
      ["Copy", copySelection, !selected],
      ["Paste", pasteText],
      ["Select all", () => term.selectAll()],
      null,
      ["Clear scrollback", () => term.clear()],
      ["Restart", () => tab.restart()],
      [`New ${kind === "picker" ? "picker" : "shell"} terminal`, () => workspace.add(kind === "picker" ? "picker" : "shell", tab.dock)],
    ], { x: event.clientX, y: event.clientY });
  });

  /** Ctrl-b then d detaches, as in tmux: the tab closes, Pi keeps running. Ctrl-b then
   *  anything else reaches Pi as typed. Pi tabs only. */
  function tmuxKeys(event) {
    if (kind !== "pi" || event.type !== "keydown") return false;
    if (prefix) {
      if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return true;
      prefix = false;
      if (event.key === "d" && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        flashStatus("detached: Pi keeps running", tab.pane);
        workspace.close(tab);
        return true;
      }
      pendingKeys = "\x02";
      return false;
    }
    if (event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey && event.code === "KeyB") {
      prefix = true;
      event.preventDefault();
      return true;
    }
    return false;
  }

  term.attachCustomKeyEventHandler((event) => {
    if (event.type === "keydown" && event.isTrusted && !["Control", "Shift", "Alt", "Meta"].includes(event.key)) {
      actedAt = performance.now();
    }
    // Ctrl+Shift+K opens the palette (see palette.js): not a key for the program.
    if (event.ctrlKey && event.shiftKey && event.code === "KeyK") return false;
    if (tmuxKeys(event)) return false;
    if (event.type === "keydown" && clipboardKey(event)) return false;
    if (event.type !== "keydown" || event.key !== "Enter" || ended || id === null) return true;
    const mod = 1 + (event.shiftKey ? 1 : 0) + (event.altKey ? 2 : 0) + (event.ctrlKey ? 4 : 0);
    if (mod === 1) return true;
    backend.termWrite(id, `\x1b[13;${mod}u`);
    event.preventDefault();
    return false;
  });

  term.onData((data) => {
    if (ended) {
      if (data === "\r") tab.restart();
      return;
    }
    if (id !== null) {
      latency.asked();
      backend.termWrite(id, pendingKeys + data);
      pendingKeys = "";
    }
  });
  // While a divider is dragged the size changes every frame: the VM hears only the last
  // one (each size makes Pi redraw its whole screen), and the fit runs once per frame.
  let resizeTimer = null;
  term.onResize(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (id !== null && !ended) backend.termResize(id, term.cols, term.rows); }, 120);
  });

  // Refitting reflows the whole scrollback: during a drag it is done once the size
  // rests a moment, not at every frame.
  let fitFrame = 0;
  const observer = new ResizeObserver(() => {
    clearTimeout(fitFrame);
    fitFrame = setTimeout(() => { fitFrame = 0; tab.refit(); }, 60);
  });
  observer.observe(tab.pane);
  tab.onShow = () => { tab.refit(); term.focus(); };
  tab.focus = () => term.focus();
  tab.term = term; // for the Logs and the checks: the xterm.js instance
  tab.onClose = () => {
    closed = true;
    latency.report();
    observer.disconnect();
    clearTimeout(resizeTimer);
    clearTimeout(fitFrame);
    if (id !== null && !ended) backend.termClose(id);
    term.dispose();
  };
  tab.onExit = (clean = true) => {
    ended = true;
    id = null;
    tab.termId = null;
    if (!clean) {
      // The connection dropped: Pi goes on in tmux on the VM. The tab stays, and comes
      // back by itself once Pier is reconnected (or with Enter).
      dropped = true;
      term.write("\r\n\x1b[2m[connection lost · this tab comes back when Pier reconnects, or press Enter]\x1b[0m\r\n");
      return;
    }
    // Pi quit (Ctrl+D, /exit): its tab goes with it, as the terminal did under tmux. A Pi
    // that ends right away keeps its tab, to read why.
    if (kind === "pi" && performance.now() - startedAt > 5000) {
      flashStatus("Pi ended: its tab is closed", tab.pane);
      workspace.close(tab);
      return;
    }
    if (kind === "update") {
      workspace.close(tab);
      return;
    }
    term.write("\r\n\x1b[2m[ended · press Enter to restart]\x1b[0m\r\n");
  };
  tab.restart = () => {
    if (id !== null && !ended) backend.termClose(id);
    id = null;
    // A Pi tab comes back to the same Pi (the one it showed), not a new one.
    if (kind === "pi" && tab.slot && tab.params) tab.params = { ...tab.params, args: ["--slot", tab.slot] };
    term.reset();
    start();
  };
  tab.reattach = () => { if (dropped) tab.restart(); };
  tab.clearScreen = () => term.clear();
  requestAnimationFrame(start);
}

// Terminals that ended before their tab knew their id (see start).
const exitedEarly = new Map();
backend.onTermExit((payload) => {
  const { id, clean } = typeof payload === "object" && payload ? payload : { id: payload, clean: true };
  const tab = workspace.tabs().find((t) => t.termId === id);
  if (tab) {
    tab.onExit?.(clean !== false);
    return;
  }
  exitedEarly.set(id, { clean: clean !== false });
  if (exitedEarly.size > 50) exitedEarly.delete(exitedEarly.keys().next().value);
});

/** The WebGL renderer: the terminal is drawn by the graphics card, so scrolling a long
 *  history stays smooth. Without WebGL, or when the graphics card loses its context
 *  (driver reset, sleep), the terminal falls back to xterm.js's own DOM renderer. */
function useGpu(term) {
  if (!prefs.gpuTerminal || !window.WebglAddon) return;
  try {
    const gl = new window.WebglAddon.WebglAddon();
    gl.onContextLoss(() => {
      uiLog("warn", "gpu-context-lost");
      gl.dispose();
    });
    term.loadAddon(gl);
  } catch (error) {
    uiLog("warn", "gpu-unavailable", { msg: String(error) });
  }
}
