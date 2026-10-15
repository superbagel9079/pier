// The palette (Ctrl+Shift+K, everywhere, terminals included): type a few letters to reach
// anything — a tab, a closed panel, a project (new Pi, last conversation, setup), a
// conversation, a setting, a theme — and Enter. As in editors: nothing to aim at, no
// panel to find first.

const palette = (() => {
  const box = $("#palette");
  const input = $("#palette-input");
  const list = $("#palette-list");
  let items = [];
  let shown = [];
  let selected = 0;
  let followed = false; // the conversations were asked for while open

  /** Everything the palette can do now: [kind, label, detail, action]. */
  function collect() {
    const out = [];
    const side = prefs.panelSide === "left" ? "left" : "right";
    for (const tab of workspace.tabs()) out.push(["tab", tab.title, `${tab.dock}`, () => workspace.show(tab)]);
    for (const kind of ["conversations", "project", "context", "setup", "logs"]) {
      if (!workspace.find(kind)) out.push(["panel", `Open ${KINDS[kind].title}`, "", () => workspace.add(kind, side)]);
    }
    const projects = new Map();
    for (const p of [...(lastProjects?.running || []), ...(lastProjects?.recent || [])]) projects.set(p.path, { label: p.label, running: p.running });
    const conversations = vm.latest("conversations")?.data?.projects || [];
    for (const p of conversations) if (!projects.has(p.project)) projects.set(p.project, { label: p.label, running: p.running > 0 });
    for (const [path, p] of projects) {
      out.push(["project", `${p.label}: new Pi`, p.running ? "running" : "", () => openPiTerminal(path, p.label, p.running ? ["--new"] : [])]);
      out.push(["project", `${p.label}: last conversation`, "", () => openPiTerminal(path, p.label, ["--continue"])]);
      out.push(["project", `${p.label}: setup`, "", () => (workspace.find("setup") || workspace.add("setup", side))?.openProject?.(path)]);
    }
    for (const p of conversations) {
      for (const s of p.sessions.slice(0, 100)) {
        if (s.archived) continue;
        const args = s.slot ? ["--slot", s.slot] : ["--session", s.path];
        out.push(["conversation", conversationTitle(s), `${p.label} · ${relTime(s.modified)}${s.slot ? " · Pi running" : ""}`,
          () => openPiTerminal(p.project, p.label, args)]);
      }
    }
    out.push(["action", "Settings", "", () => openPrefs()]);
    out.push(["action", "New shell", "", () => workspace.add("shell", workspace.find("main")?.dock || "center")]);
    out.push(["action", `Panels on the ${side === "left" ? "right" : "left"}`, "layout", () => {
      prefs.panelSide = side === "left" ? "right" : "left";
      savePrefs();
      placePanels();
    }]);
    out.push(["action", "Reset layout", "layout", () => placePanels()]);
    out.push(["action", workspace.find("logs") ? "Close the Logs tab" : "Open the Logs tab", "diagnostics", () => {
      const logs = workspace.find("logs");
      if (logs) workspace.close(logs); else workspace.add("logs", side);
    }]);
    for (const theme of [{ id: "system", name: "follow the system" }, ...allThemes()]) {
      if (theme.id !== prefs.theme) out.push(["theme", `Theme: ${theme.name}`, "", () => { prefs.theme = theme.id; savePrefs(); applyTheme(); }]);
    }
    return out;
  }

  /** Every word typed found in the label (or its detail); earlier and whole-word
   *  matches first, then the order above (tabs, panels, projects, conversations...). */
  function score(item, words) {
    const text = `${item[1]} ${item[2]}`.toLowerCase();
    let total = 0;
    for (const word of words) {
      const at = text.indexOf(word);
      if (at < 0) return -1;
      total += at + (at === 0 || /\W/.test(text[at - 1]) ? 0 : 20) + (item[1].toLowerCase().includes(word) ? 0 : 40);
    }
    return total;
  }

  function render() {
    const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    shown = words.length
      ? items.map((item, i) => [score(item, words), i, item]).filter(([s]) => s >= 0).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, , item]) => item)
      : items.filter(([kind]) => kind !== "theme" && kind !== "conversation").concat(items.filter(([kind]) => kind === "conversation").slice(0, 8));
    shown = shown.slice(0, 60);
    selected = Math.min(selected, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.map(([kind, label, detail], i) => {
      const li = el("li", { className: i === selected ? "selected" : "" },
        el("span", { className: "kind", textContent: kind }),
        el("span", { className: "label", textContent: label }),
        el("span", { className: "detail", textContent: detail }));
      li.addEventListener("mousemove", () => { if (selected !== i) { selected = i; mark(); } });
      li.addEventListener("click", () => run(i));
      return li;
    }));
    if (!shown.length) list.append(el("li", { className: "empty", textContent: "Nothing matches." }));
  }

  function mark() {
    [...list.children].forEach((li, i) => li.classList.toggle("selected", i === selected));
    list.children[selected]?.scrollIntoView({ block: "nearest" });
  }

  function run(i) {
    const item = shown[i];
    close();
    if (!item) return;
    uiLog("debug", "palette", { kind: item[0] });
    try { item[3](); } catch (error) { uiLog("warn", "palette-failed", { msg: String(error) }); }
  }

  function open() {
    if ($("#workspace").hidden) return; // not connected: nothing to reach
    if (!vm.latest("conversations")) { vm.follow({ conversations: true }); followed = true; }
    items = collect();
    input.value = "";
    selected = 0;
    box.hidden = false;
    render();
    input.focus();
  }

  function close() {
    box.hidden = true;
    if (followed) {
      followed = false;
      vm.follow({ conversations: workspace.find("conversations")?.shown === true });
    }
  }

  input.addEventListener("input", () => { selected = 0; render(); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { selected = Math.min(shown.length - 1, selected + 1); mark(); event.preventDefault(); }
    else if (event.key === "ArrowUp") { selected = Math.max(0, selected - 1); mark(); event.preventDefault(); }
    else if (event.key === "Enter") { run(selected); event.preventDefault(); }
    else if (event.key === "Escape") { close(); event.preventDefault(); event.stopPropagation(); }
  });
  box.addEventListener("pointerdown", (event) => { if (event.target === box) close(); });
  // The conversations arriving while it is open: added.
  vm.on("conversations", () => { if (!box.hidden) { items = collect(); render(); } });

  // Ctrl+Shift+K, the same everywhere (Ctrl+K alone belongs to the shells and to Pi).
  document.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey || event.code !== "KeyK") return;
    event.preventDefault();
    if (box.hidden) open(); else close();
  }, true);
  $("#btn-palette").addEventListener("click", open);

  return { open, close };
})();
