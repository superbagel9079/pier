// The palette (Ctrl+Shift+K, everywhere, terminals included): type a few letters to reach
// a tab, panel, project, conversation, setting or theme, then Enter.

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
    for (const tab of workspace.tabs()) out.push(["tab", tab.title, { left: "left side", right: "right side" }[tab.dock] || "", () => workspace.show(tab), tab]);
    for (const kind of ["conversations", "project", "repository", ...(labsOn() ? ["labs"] : [])]) {
      if (!workspace.find(kind)) out.push(["panel", `Open ${KINDS[kind].title}`, "", () => workspace.add(kind)]);
    }
    const projects = new Map();
    for (const p of [...(lastProjects?.running || []), ...(lastProjects?.recent || [])]) projects.set(p.path, { label: p.label, running: p.running });
    const conversations = vm.latest("conversations")?.data?.projects || [];
    for (const p of conversations) if (!projects.has(p.project)) projects.set(p.project, { label: p.label, running: p.running > 0 });
    for (const [path, p] of projects) {
      out.push(["project", `${p.label}: new Pi`, p.running ? "running" : "", () => openPiTerminal(path, p.label, p.running ? ["--new"] : [])]);
      out.push(["project", `${p.label}: last conversation`, "", () => openPiTerminal(path, p.label, ["--continue"])]);
      out.push(["project", `${p.label}: settings`, "its instructions, what Pi loads, its mark", () => openProjectSettings(path)]);
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
    for (const button of document.querySelectorAll("#prefs .prefs-tabs button")) {
      out.push(["setting", `Settings: ${button.textContent}`, "", () => { openPrefs(); showPrefsPage(button.dataset.page); }]);
    }
    const panel = (kind) => workspace.find(kind) || workspace.add(kind);
    for (const [mode, label, detail] of [["activity", "Activity", "what Pi read and changed"], ["files", "Files", "the project's files"],
      ["restore", "Restore points", "undo what Pi did: go back to before a prompt"]]) {
      out.push(["page", `Activity: ${label}`, detail, () => { const t = panel("project"); workspace.show(t); t?.setMode?.(mode); }]);
    }
    out.push(["action", "Waiting for you", "Pi's requests: approve or refuse", () => waiting.show()]);
    if (online) { // what needs the VM, once connected
      out.push(["action", "Start a project…", "a folder of the VM, or a new one", () => openFolderPicker()]);
      out.push(["action", "Is the VM ready?", "what Pier needs on the VM", () => openVmReady()]);
    }
    out.push(["page", "Activity: Given to Pi", "images, files, folders and shares given to Pi", () => contextTab({ reveal: true })]);
    if (online) out.push(["action", "New shell", "", () => workspace.add("shell", "center")]);
    out.push(["action", "Reset layout", "layout", () => placePanels()]);
    out.push(["action", "Logs", "Settings > Diagnostics", () => { openPrefs(); showPrefsPage("diagnostics"); }]);
    for (const theme of [{ id: "system", name: "Follow the system" }, ...allThemes()]) {
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

  // As the proposals' A (Raycast): the results in groups, an icon on each line.
  const GROUPS = { tab: "Tabs", panel: "Panels", project: "Projects", conversation: "Conversations", page: "Pages", action: "Actions", setting: "Settings", theme: "Themes" };
  const ICONS = { panel: "panel-right", project: "folder", conversation: "message-square", page: "info", setting: "settings", theme: "palette" };
  const ACTION_ICONS = { "Settings": "settings", "Waiting for you": "inbox", "Start a project…": "folder-plus", "Is the VM ready?": "circle-check", "New shell": "terminal", "Reset layout": "panel-left", "Logs": "scroll-text" };
  const iconOf = ([kind, label, , , tab]) => kind === "tab"
    ? (tab?.kind === "chat" || tab?.kind === "conversations" ? "message-square" : KINDS[tab?.kind]?.terminal ? "terminal" : tab?.dock === "right" ? "panel-right" : "file")
    : kind === "action" ? ACTION_ICONS[label] || "play" : ICONS[kind] || "chevron-right";
  // In its group, a line needs no "Settings: " or "Theme: " before it.
  const shortLabel = ([kind, label]) => kind === "setting" ? label.replace(/^Settings: /, "") : kind === "theme" ? label.replace(/^Theme: /, "") : label;

  function render() {
    const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let found = words.length
      ? items.map((item, i) => [score(item, words), i, item]).filter(([s]) => s >= 0).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, , item]) => item)
      : items.filter(([kind]) => kind !== "theme" && kind !== "conversation").concat(items.filter(([kind]) => kind === "conversation").slice(0, 8));
    found = found.slice(0, 60);
    // Grouped by kind, the groups in the order of their best line (the order above when
    // nothing is typed); the arrows go down the lines as drawn.
    const groups = new Map();
    for (const item of found) {
      if (!groups.has(item[0])) groups.set(item[0], []);
      groups.get(item[0]).push(item);
    }
    shown = [...groups.values()].flat();
    selected = Math.min(selected, Math.max(0, shown.length - 1));
    const rows = [];
    let i = 0;
    for (const [kind, group] of groups) {
      rows.push(el("li", { className: "group", textContent: GROUPS[kind] || kind, role: "presentation" }));
      for (const item of group) {
        const at = i++;
        const li = el("li", { className: at === selected ? "selected" : "" }, svgIcon(iconOf(item)),
          el("span", { className: "label", textContent: shortLabel(item) }),
          el("span", { className: "detail", textContent: item[2] }));
        li.dataset.i = at;
        li.addEventListener("mousemove", () => { if (selected !== at) { selected = at; mark(); } });
        li.addEventListener("click", () => run(at));
        rows.push(li);
      }
    }
    list.replaceChildren(...rows);
    if (!shown.length) list.append(el("li", { className: "empty", textContent: "Nothing matches." }));
  }

  function mark() {
    for (const li of list.querySelectorAll("li[data-i]")) li.classList.toggle("selected", Number(li.dataset.i) === selected);
    list.querySelector(`li[data-i="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }

  function run(i) {
    const item = shown[i];
    close();
    if (!item) return;
    uiLog("debug", "palette", { kind: item[0] });
    // Anything but a setting or a theme happens in the workspace: out of the settings.
    if (!["setting", "theme"].includes(item[0]) && item[1] !== "Settings") closePrefs();
    try { item[3](); } catch (error) { uiLog("warn", "palette-failed", { msg: String(error) }); }
  }

  let release = null; // undoes the keyboard trap while open (trapDialog)

  function open() {
    if ($("#workspace").hidden) return; // not connected: nothing to reach
    if (!box.hidden) { input.focus(); return; } // already open
    // A dialog is already asking something: the palette would open under it and the
    // dialog would take its keys. It waits for the answer.
    if ([...document.querySelectorAll('[aria-modal="true"]')].some((n) => n.getClientRects().length)) return;
    if (!vm.latest("conversations")) { vm.follow({ conversations: true }); followed = true; }
    items = collect();
    input.value = "";
    selected = 0;
    // Modal like Pier's other dialogs: Tab stays inside, Escape closes it from anywhere,
    // and the focus goes back where it was (a terminal, most often).
    release = trapDialog($(".palette-box", box), close);
    box.hidden = false;
    render();
    input.focus();
  }

  function close() {
    box.hidden = true;
    release?.();
    release = null;
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
