// The Logs tab.

// ============================================================================
// Logs: Pier's own, and the picker's on the VM, as they happen
// ============================================================================

const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const LOG_KEPT = 5000;

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

  /** Raw lines to entries: a continuation line joins the entry before it. */
  function add(list, rows) {
    for (const raw of rows) {
      const entry = parseLogLine(raw);
      if (entry) list.push(entry);
      else if (list.length) (list.at(-1).trace ||= []).push(raw.replace(/^ {4}/, ""));
    }
    if (list.length > LOG_KEPT) list.splice(0, list.length - LOG_KEPT);
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
      const during = arriving[which];
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
  const unlisten = backend.onLogLine((line) => {
    if (arriving.devbox) { arriving.devbox.push(line); return; }
    const before = entries.devbox.length;
    add(entries.devbox, [line]);
    if (source !== "devbox" || !visible()) return;
    const entry = entries.devbox.at(-1);
    if (entries.devbox.length === before) {
      render(); // a continuation line: redraw its entry
    } else if (shown(entry)) {
      view.querySelector(".entry.dim")?.remove();
      view.prepend(row(entry));
      while (view.childElementCount > 2000) view.lastChild.remove();
      if (follow.checked) view.scrollTop = 0;
    }
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
  search.addEventListener("input", render);
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
    if (arriving.vm) { arriving.vm.push(...message.lines); return; }
    const before = entries.vm.length;
    const last = entries.vm.at(-1);
    add(entries.vm, message.lines);
    if (source !== "vm" || !visible()) return;
    const added = entries.vm.slice(before);
    // A continuation of the last entry, or a big batch: redrawn. Otherwise the new
    // entries go on top, as Pier's own do.
    if (!added.length || added.length > 200 || entries.vm.at(before - 1) !== last) {
      render();
      return;
    }
    view.querySelector(".entry.dim")?.remove();
    for (const entry of added) if (shown(entry)) view.prepend(row(entry));
    while (view.childElementCount > 2000) view.lastChild.remove();
    if (follow.checked) view.scrollTop = 0;
  });
  tab.onClose = () => { unlistenVm(); vm.follow({ log: false }); Promise.resolve(unlisten).then((stop) => stop?.()); };
  load();
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
