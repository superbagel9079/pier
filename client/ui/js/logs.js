// The Logs tab.

// ============================================================================
// Logs: Pier's own, and the picker's on the VM, as they happen
// ============================================================================

const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const LOG_KEPT = 5000;
// A traceback, or anything indented under a line, is kept to this much: the VM's log
// is written by the VM, and one entry must not grow without end.
const TRACE_LINES = 200;
const TRACE_CHARS = 64 * 1024;

/** "2026-10-12T14:32:01.123Z INFO  vm.ls req=… ms=41" to its parts; null for a
 *  continuation line (a traceback, indented). */
function parseLogLine(raw) {
  if (/^\s/.test(raw)) return null;
  const m = /^(\S+)\s+(ERROR|WARN|INFO|DEBUG)\s+(\S+)\s?(.*)$/.exec(raw);
  if (!m) return { raw, at: null, level: "INFO", event: "", fields: raw };
  return { raw, at: m[1], level: m[2], event: m[3], fields: m[4] };
}

function makeLogs(tab) {
  tab.pane.append($("#tpl-logs").content.cloneNode(true));
  const view = $(".log-lines", tab.pane);
  const error = $(".error", tab.pane);
  const level = $(".level", tab.pane);
  const search = $(".search", tab.pane);
  const follow = $(".follow", tab.pane);
  const debugHint = $(".debug-hint", tab.pane);
  const entries = { devbox: [], vm: [] };
  let source = "devbox";

  const visible = () => !tab.pane.hidden && tab.pane.offsetParent !== null;

  // The row shown for each entry, to redraw only it when a continuation line arrives.
  const rows = new WeakMap();

  /** Raw lines to entries: a continuation line joins the entry before it. Returns the
   *  new entries, and the earlier entry that got continuation lines, if any. */
  function add(list, raws) {
    const added = [];
    let continued = null;
    for (const raw of raws) {
      const entry = parseLogLine(raw);
      if (entry) {
        list.push(entry);
        added.push(entry);
        continue;
      }
      const last = list.at(-1);
      if (!last) continue;
      const trace = (last.trace ||= []);
      last.traceChars ||= 0;
      if (trace.length < TRACE_LINES && last.traceChars < TRACE_CHARS) {
        const text = raw.replace(/^ {4}/, "").slice(0, TRACE_CHARS - last.traceChars);
        trace.push(text);
        last.traceChars += text.length;
      } else if (!last.traceCut) {
        last.traceCut = true;
        trace.push("… (cut: too long)");
      }
      if (!added.includes(last)) continued = last;
    }
    // Trimmed by chunks, not at every line: splicing 5000 entries each time is a copy.
    if (list.length > LOG_KEPT + 500) list.splice(0, list.length - LOG_KEPT);
    return { added, continued };
  }

  function shown(entry) {
    if (LOG_LEVELS[entry.level] > Number(level.value)) return false;
    const needle = search.value.trim().toLowerCase();
    return !needle || entry.raw.toLowerCase().includes(needle) || entry.trace?.some((t) => t.toLowerCase().includes(needle));
  }

  function row(entry) {
    const div = el("div", { className: `entry ${entry.level}` });
    const at = entry.at ? new Date(entry.at) : null;
    const time = at && !Number.isNaN(at.getTime())
      ? `${at.toLocaleTimeString([], { hour12: false })}.${String(at.getMilliseconds()).padStart(3, "0")}` : entry.at || "";
    div.append(
      el("span", { className: "time", textContent: `${time} `, title: entry.at || "" }),
      el("span", { className: "lvl", textContent: entry.level }),
      el("span", { className: "event", textContent: entry.event }),
      el("span", { className: "fields", textContent: entry.fields ? ` ${entry.fields}` : "" }),
    );
    if (entry.trace) div.append(el("div", { className: "trace", textContent: entry.trace.join("\n") }));
    rows.set(entry, div);
    return div;
  }

  function render() {
    const list = entries[source].filter(shown).slice(-2000).reverse(); // newest first
    view.innerHTML = "";
    const fragment = document.createDocumentFragment();
    for (const entry of list) fragment.append(row(entry));
    view.append(fragment);
    if (!list.length) view.append(el("div", { className: "entry dim", textContent: entries[source].length ? "Nothing matches." : "Nothing logged yet." }));
    if (follow.checked) view.scrollTop = 0;
    debugHint.hidden = Number(level.value) < 3 || prefs.debugLogs;
  }

  // Lines that arrive live while the history is being read: put after it once it is
  // there (before, they came first and the order was wrong), those it has already left out.
  const arriving = { devbox: null, vm: null };

  async function fill(which, read) {
    arriving[which] = [];
    let tail;
    try {
      tail = await read();
    } finally {
      const during = arriving[which] || []; // null when another load (onShow) ended first
      arriving[which] = null;
      if (tail) {
        const seen = new Set(tail.slice(-500));
        entries[which] = [];
        add(entries[which], tail);
        add(entries[which], during.filter((line) => !seen.has(line)));
      }
    }
  }

  async function load() {
    showError(error, "");
    try {
      if (source === "devbox") {
        await fill("devbox", () => backend.logTail(3000));
      } else {
        await fill("vm", async () => (await backend.api(["log", "2000"])).lines);
        vm.follow({ log: true }); // then new lines as they are written
      }
    } catch (e) {
      showError(error, String(e));
    }
    render();
  }

  // Pier's own lines arrive as they are written.
  /** New lines of the log shown: new entries go on top, a continued one is redrawn in
   *  place. Never the whole list (it was, at every line, once 5000 were kept). */
  // Gathered, then drawn once per frame: a burst of lines touches the page once.
  const pending = { added: [], continued: new Set(), frame: 0 };

  function show(change) {
    for (const entry of change.added) pending.added.push(entry);
    // Frames wait while the window is hidden: only what the list would show is kept.
    if (pending.added.length > 4000) pending.added.splice(0, pending.added.length - 2000);
    if (change.continued) pending.continued.add(change.continued);
    if (!pending.frame) pending.frame = requestAnimationFrame(flush);
  }

  function flush() {
    pending.frame = 0;
    const added = pending.added.splice(0);
    const continued = [...pending.continued];
    pending.continued.clear();
    if (!visible()) return;
    for (const entry of continued) {
      const old = rows.get(entry);
      if (old?.isConnected) old.replaceWith(row(entry));
    }
    const fresh = added.filter(shown);
    if (!fresh.length) return;
    if (fresh.length > 1000) { render(); return; }
    view.querySelector(".entry.dim")?.remove();
    const fragment = document.createDocumentFragment();
    for (let i = fresh.length - 1; i >= 0; i--) fragment.append(row(fresh[i])); // newest first
    view.prepend(fragment);
    while (view.childElementCount > 2000) view.lastChild.remove();
    if (follow.checked) view.scrollTop = 0;
  }

  const unlisten = backend.onLogLine((line) => {
    if (arriving.devbox) { arriving.devbox.push(line); return; }
    const change = add(entries.devbox, [line]);
    if (source === "devbox" && visible()) show(change);
  });

  for (const b of tab.pane.querySelectorAll(".mode[data-source]")) {
    b.addEventListener("click", () => {
      source = b.dataset.source;
      if (source !== "vm") vm.follow({ log: false });
      for (const other of tab.pane.querySelectorAll(".mode[data-source]")) other.classList.toggle("active", other === b);
      load();
    });
  }
  level.addEventListener("change", render);
  let searchTimer = null;
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(render, 150); // once typing pauses, not at every key
  });
  // Newest at the top: "follow" keeps the top in view; scrolling down, into older lines, stops it.
  follow.addEventListener("change", () => { if (follow.checked) view.scrollTop = 0; });
  view.addEventListener("wheel", (e) => { if (e.deltaY > 0) follow.checked = false; }, { passive: true });
  $(".copy-report", tab.pane).addEventListener("click", () => copyReport((text) => {
    showError(error, "");
    error.hidden = false;
    error.textContent = text;
  }));
  tab.onShow = load;
  tab.onVisible = (shown) => { if (!shown) vm.follow({ log: false }); };
  tab.onLogLevel = render;
  const unlistenVm = vm.on("log", (message) => {
    if (!message.lines) return;
    if (arriving.vm) { for (const line of message.lines) arriving.vm.push(line); return; }
    const change = add(entries.vm, message.lines);
    if (source === "vm" && visible()) show(change);
  });
  tab.onClose = () => { unlistenVm(); vm.follow({ log: false }); Promise.resolve(unlisten).then((stop) => stop?.()); };
  load();
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
