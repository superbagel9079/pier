// The three docks and their tabs: placing, reordering, renaming, saving the layout.

// Workspace: three docks, any tab in any of them

const KINDS = {
  picker: { title: "picker", terminal: true },
  shell: { title: "shell", terminal: true },
  project: { title: "Activity", single: true, make: (tab) => makeProject(tab) },
  setup: { title: "Project", single: true, make: (tab) => makeSetup(tab) },
  repository: { title: "Repository", single: true, make: (tab) => makeRepository(tab) },
  conversations: { title: "Conversations", single: true, make: (tab) => makeConversations(tab) },
  pi: { title: "pi", terminal: true },
  chat: { title: "Pi", make: (tab) => makeChat(tab) },
  update: { title: "pi update", terminal: true },
  diff: { title: "diff", make: (tab) => makeDiff(tab) },
  file: { title: "file", make: (tab) => makeFile(tab) },
  takeback: { title: "Pi's work", make: (tab) => makeTakeBack(tab) },
  labs: { title: "Labs", single: true, make: (tab) => makeLabs(tab) },
  lab: { title: "lab", terminal: true },
};
const DOCKS = ["left", "center", "right"];
// "main" is the pinned picker: the terminal Pier opens on, which cannot be closed.
// Fixed, as the mock-up: Conversations on the left, Activity on the right, everything else
// (terminals, files, Project, Repository, Logs, Labs) as tabs in the middle.
const HOME = { conversations: "left", project: "right" };
const homeOf = (kind) => HOME[kind] || "center";
function defaultLayout() {
  return {
    left: { tabs: ["conversations"], active: "conversations", collapsed: false, width: 236 },
    right: { tabs: ["project"], active: "project", collapsed: false, width: 360 },
    center: { tabs: [] },
    layout: 8,
  };
}

const workspace = (() => {
  const docks = {};
  for (const name of DOCKS) {
    const node = $(`#dock-${name}`);
    docks[name] = {
      name, el: node, side: name !== "center", tabs: [], active: null, collapsed: false,
      width: defaultLayout()[name]?.width || 320, splitter: $(`.splitter[data-dock="${name}"]`),
    };
  }
  let nextId = 1;

  const keyOf = (tab) => (tab.pinned ? "main" : tab.kind);
  const tabs = () => DOCKS.flatMap((name) => docks[name].tabs);
  const find = (key) => tabs().find((t) => keyOf(t) === key);

  // --- rendering ---

  // A narrow window, as the mock-up: a side the middle has no room for leaves the row and
  // opens over the middle from its header button (closed again by a click in the middle).
  const CENTRE_MIN = { left: 400, right: 480 };
  function layoutSides() {
    const room = $("#workspace").clientWidth - ($("#rail").offsetWidth || 44);
    const { left, right } = docks;
    left.over = room - left.width < CENTRE_MIN.left;
    const leftIn = !left.over && !left.collapsed && left.tabs.length;
    right.over = room - (leftIn ? left.width : 0) - right.width < CENTRE_MIN.right;
  }
  /** A side out of sight: hidden by its toggle, or over the middle and not opened. */
  const folded = (dock) => dock.side && (dock.over ? !dock.overOpen : dock.collapsed);

  function render(name) {
    const dock = docks[name];
    if (dock.side) {
      layoutSides();
      const empty = !dock.tabs.length;
      dock.el.hidden = empty;
      dock.splitter.hidden = empty || folded(dock) || dock.over;
      dock.el.classList.toggle("over", dock.over);
      dock.el.classList.toggle("collapsed", folded(dock) && !empty); // hidden by the header's toggle
      dock.el.style.setProperty("--width", `${dock.width}px`);
      dock.splitter.setAttribute("aria-valuenow", String(dock.width));
    }
    const bar = $(".tabs", dock.el);
    bar.replaceChildren();
    for (const tab of dock.tabs) bar.append(tabElement(tab, dock));
    // The active tab entirely in view: in a narrow side, the bar scrolls to it.
    bar.children[dock.tabs.indexOf(dock.active)]?.scrollIntoView({ block: "nearest", inline: "nearest" });
    // Tabs never shrink below six letters: those that do not fit are listed by ».
    let more = $(".more-tabs", dock.el);
    if (!more) {
      more = el("button", { className: "icon more-tabs", textContent: "\u00BB", title: "The tabs that do not fit" });
      more.addEventListener("click", () => showMenu(more, dock.tabs.map((t) => [t.title, () => show(t)])));
      bar.after(more);
    }
    requestAnimationFrame(() => { more.hidden = bar.scrollWidth <= bar.clientWidth + 1; });
    for (const tab of dock.tabs) {
      tab.pane.hidden = folded(dock) || tab !== dock.active;
      // Panels follow the VM only while shown (vm.js): nothing is computed there for a
      // tab nobody looks at.
      if (tab.shown !== !tab.pane.hidden) {
        tab.shown = !tab.pane.hidden;
        tab.onVisible?.(tab.shown);
        // Only a terminal just shown is fitted here; the others follow their ResizeObserver
        // (terminal.js). Fitting all at every redraw reflowed all their histories.
        if (tab.shown) tab.refit?.();
      }
    }
    const panes = $(".panes", dock.el);
    $(":scope > .empty", panes)?.remove();
    if (!dock.tabs.length) panes.append(emptyDock(name));
    frame();
  }

  function renderAll() {
    for (const name of DOCKS) render(name);
  }

  /** Which side is open (the window's buttons sit over the right one's header, else over
   *  the middle's), and the middle's header: the tab shown, the toggles' state. */
  function frame() {
    const ws = $("#workspace");
    for (const name of ["left", "right"]) {
      const open = !docks[name].el.hidden && !folded(docks[name]);
      ws.classList.toggle(`${name}-open`, open);
      const b = $(`#toggle-${name}`);
      const what = name === "left" ? "the conversations" : "Activity";
      b.setAttribute("aria-pressed", String(open));
      b.title = `${open ? "Hide" : "Show"} ${what}`;
      b.setAttribute("aria-label", b.title);
      $("use", b).setAttribute("href", `#i-panel-${name}${open ? "-close" : ""}`);
    }
    $("#head-title").textContent = docks.center.active?.title || "New tab";
    $("#btn-conversations").setAttribute("aria-pressed", String(ws.classList.contains("left-open")));
  }

  /** The middle's toggles: a side hidden or shown again. */
  function toggle(name) {
    const dock = docks[name];
    if (dock.over) dock.overOpen = !dock.overOpen; // over the middle: for a look, not saved
    else dock.collapsed = !dock.collapsed;
    renderAll();
    if (!folded(dock)) dock.active?.onShow?.();
    save();
  }

  function tabElement(tab, dock) {
    const node = el("div");
    node.className = "tab" + (tab === dock.active && !folded(dock) ? " active" : "") + (tab.pinned ? " pinned" : "");
    node.setAttribute("role", "tab");
    // The keyboard: the shown tab is the one Tab reaches, arrows go to its neighbours.
    const shown = tab === dock.active && !folded(dock);
    node.setAttribute("aria-selected", shown ? "true" : "false");
    node.tabIndex = shown ? 0 : -1;
    node.addEventListener("keydown", (e) => {
      const tabs = dock.tabs || [];
      const at = tabs.indexOf(tab);
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); show(tab); return; }
      // The tab's menu by keyboard: the menu key, or Shift+F10.
      if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
        e.preventDefault();
        const box = node.getBoundingClientRect();
        contextMenu(tab, box.left, box.bottom);
        return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const next = tabs[(at + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      if (!next) return;
      e.preventDefault();
      show(next);
      requestAnimationFrame(() => dock.el?.querySelector(".tab.active")?.focus());
    });
    node.title = tab.pinned ? "picker: the main terminal (cannot be closed)" : tab.title;
    node.append(el("span", { textContent: tab.title }));
    const actions = el("span");
    actions.className = "tab-actions";
    // Only ×: moving, renaming and the rest are in the tab's right-click menu.
    if (!tab.pinned) {
      const x = iconButton("", "Close", () => close(tab));
      x.append(svgIcon("x"));
      actions.append(x);
    }
    node.append(actions);
    dragSource(node, tab);
    node.addEventListener("auxclick", (e) => { if (e.button === 1 && !tab.pinned) close(tab); });
    node.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      contextMenu(tab, e.clientX, e.clientY);
    });
    return node;
  }

  /** Right click on a tab. */
  function contextMenu(tab, x, y) {
    const dock = docks[tab.dock];
    const items = [["Rename…", () => rename(tab)]];
    if (KINDS[tab.kind].terminal) {
      items.push(null,
        [`New ${tab.kind} terminal`, () => add(tab.kind, tab.dock)],
        ["Restart", () => tab.restart?.()],
        ["Clear scrollback", () => tab.clearScreen?.()]);
    }
    const others = dock.tabs.filter((t) => t !== tab && !t.pinned);
    items.push(null, ["Close", () => close(tab), tab.pinned], ["Close the other tabs here", () => others.forEach(close), !others.length]);
    showMenu(null, items, { x, y });
  }

  /** Edits a tab's name in place: Enter keeps it, Escape cancels, empty restores it. */
  function rename(tab) {
    const label = [...$(".tabs", docks[tab.dock].el).children][docks[tab.dock].tabs.indexOf(tab)]?.firstChild;
    if (!label) return;
    const input = el("input", { className: "tab-rename", value: tab.title });
    input.size = Math.max(6, tab.title.length + 2);
    label.replaceWith(input);
    input.addEventListener("pointerdown", (e) => e.stopPropagation());
    input.focus();
    input.select();
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (keep) {
        tab.title = name || tab.defaultTitle;
        tab.renamed = Boolean(name) && name !== tab.defaultTitle;
      }
      render(tab.dock);
      save();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
      e.stopPropagation();
    });
    input.addEventListener("blur", () => finish(true));
  }

  function iconButton(text, title, action) {
    const b = el("button");
    b.className = "icon";
    b.textContent = text;
    b.title = title;
    b.setAttribute("aria-label", title); // a glyph: its title is what a screen reader says
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", (e) => { e.stopPropagation(); action(b); });
    return b;
  }


  /** The middle with nothing open (the mock-up's New tab): what Pier can open, then the
   *  latest conversations. */
  function emptyDock(name) {
    const line = (icon, label, detail, action) => {
      const b = el("button", { className: "lrow" }, svgIcon(icon), el("span", { textContent: label }), el("span", { className: "m", textContent: detail }));
      b.addEventListener("click", action);
      return b;
    };
    const project = target?.path || lastProjects?.recent?.[0]?.path || lastProjects?.running?.[0]?.path;
    const group = el("div", { className: "lgroup" },
      line("square-pen", "New conversation", project ? projectLabel(project) : "", () => (project ? openPiTerminal(project, projectLabel(project), ["--new"]) : openFolderPicker())),
      line("folder", "Open a folder…", "start Pi in a folder of the VM", () => openFolderPicker()),
      line("terminal", "New shell", "on the VM", () => add("shell", name)));
    const recent = (vm.latest("conversations")?.data?.projects || []).flatMap((p) => p.sessions.filter((s) => !s.archived && !s.subagent).map((s) => [p, s]))
      .sort((a, b) => b[1].modified - a[1].modified).slice(0, 5);
    if (recent.length) {
      group.append(el("p", { className: "llabel", textContent: "Recent conversations" }));
      for (const [p, s] of recent) group.append(line("message-square", conversationTitle(s), p.label, () => openPiTerminal(p.project, p.label, ["--session", s.path])));
    }
    return el("div", { className: "empty launcher" }, group);
  }

  function addChoices(name) {
    const items = [
      ["New shell", () => add("shell", name), false, { icon: "terminal" }],
      ["New picker", () => add("picker", name), false, { icon: "folder" }],
    ];
    const ICONS = { setup: "folder-cog", repository: "git-branch", labs: "flask-conical", conversations: "message-square", project: "activity" };
    // The panels of the middle, and the sides' two when closed. Labs once they are on
    // (Settings > Labs); Given to Pi is in Activity.
    for (const kind of ["setup", "repository", ...(labsOn() || find("labs") ? ["labs"] : []), "conversations", "project"]) {
      const open = find(kind);
      if (!open) items.push([KINDS[kind].title, () => add(kind, name), false, { icon: ICONS[kind] }]);
      else if (open.dock === "center") items.push([`${KINDS[kind].title} · show`, () => show(open), false, { icon: ICONS[kind] }]);
    }
    return items;
  }

  // --- tabs ---

  function create(kind, { pinned = false, params = null } = {}) {
    const pane = el("div");
    pane.className = "pane";
    const same = tabs().filter((t) => t.kind === kind).length;
    const title = pinned || KINDS[kind].single || !same ? KINDS[kind].title : `${KINDS[kind].title} ${same + 1}`;
    const tab = { id: nextId++, kind, pinned, pane, title, defaultTitle: title, params };
    if (KINDS[kind].terminal) makeTerminal(tab, kind);
    else KINDS[kind].make(tab);
    focusFollows(tab);
    tab.defaultTitle = tab.title; // a panel may name itself (a diff tab: the file)
    return tab;
  }

  /** Opens a tab where its kind lives (homeOf: the dock asked is only a wish kept for
   *  callers); a single-instance panel already open is shown instead. */
  function add(kind, name, { reveal = true, pinned = false, params = null, replace = false } = {}) {
    name = homeOf(kind);
    const existing = KINDS[kind].single ? find(kind) : null;
    if (existing) return move(existing, name, { reveal });
    const tab = create(kind, { pinned, params });
    // replace: in the place of the tab shown in the middle (a file opened after a file),
    // unless that one is a conversation or a terminal: closing it would end what runs there.
    const old = replace ? docks[name].active : null;
    const swap = old && !old.pinned && old.kind !== "chat" && !KINDS[old.kind].terminal;
    place(tab, name, { reveal, index: swap ? docks[name].tabs.indexOf(old) + 1 : null });
    if (swap) close(old);
    return tab;
  }

  function place(tab, name, { reveal = true, index = null } = {}) {
    name = homeOf(tab.kind);
    const dock = docks[name];
    if (index === null || index > dock.tabs.length) dock.tabs.push(tab);
    else dock.tabs.splice(index, 0, tab);
    tab.dock = name;
    $(".panes", dock.el).append(tab.pane);
    if (reveal || !dock.active) dock.active = tab;
    if (reveal && dock.over) dock.overOpen = true;
    else if (reveal) dock.collapsed = false;
    render(name);
    if (reveal) {
      tab.onShow?.();
      setCurrentTab(tab);
    }
    save();
  }

  function detach(tab) {
    const dock = docks[tab.dock];
    const index = dock.tabs.indexOf(tab);
    dock.tabs.splice(index, 1);
    if (dock.active === tab) dock.active = dock.tabs[Math.min(index, dock.tabs.length - 1)] || null;
    render(tab.dock);
    dock.active?.onShow?.();
  }

  /** Moves a tab to a dock, at `index` in its bar (the end by default); within the
   *  same dock, an index reorders. */
  function move(tab, name, { reveal = true, index = null } = {}) {
    if (homeOf(tab.kind) !== name) { // a panel stays in its home: shown, not moved
      if (reveal) show(tab);
      return tab;
    }
    if (tab.dock !== name) {
      detach(tab);
      place(tab, name, { reveal, index });
    } else if (index !== null) {
      const dock = docks[name];
      const from = dock.tabs.indexOf(tab);
      dock.tabs.splice(from, 1);
      dock.tabs.splice(index > from ? index - 1 : index, 0, tab);
      if (reveal) dock.active = tab;
      render(name);
      if (reveal) tab.onShow?.();
      save();
    } else if (reveal) {
      show(tab);
    }
    return tab;
  }

  function close(tab) {
    if (tab.pinned) return;
    if (currentTab === tab) setCurrentTab(null);
    detach(tab);
    tab.onClose?.();
    tab.pane.remove();
    save();
  }

  function show(tab) {
    const dock = docks[tab.dock];
    dock.active = tab;
    if (dock.over) dock.overOpen = true;
    else dock.collapsed = false;
    render(tab.dock);
    tab.onShow?.();
    setCurrentTab(tab);
  }

  /** A click on a tab shows it. */
  function clickTab(tab) {
    show(tab);
    save();
  }

  // --- dragging a tab along its bar (the middle's: a side holds one panel) ---

  let dragging = null;

  // Listeners go on the window, not the tab: a drag redraws the bars and replaces the tab's
  // element, which would never hear the release.
  function dragSource(node, tab) {
    node.addEventListener("pointerdown", (down) => {
      if (down.button !== 0) return;
      const start = { x: down.clientX, y: down.clientY };
      let moved = false;
      const ghost = $("#drag-ghost");
      const onMove = (e) => {
        if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 6) return;
        if (!moved) {
          moved = true;
          dragging = tab;
          ghost.textContent = tab.title;
          ghost.hidden = false;
        }
        ghost.style.left = `${e.clientX + 12}px`;
        ghost.style.top = `${e.clientY + 8}px`;
        showDropTarget(dropTarget(e));
      };
      const finish = (e) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        window.removeEventListener("blur", finish);
        ghost.hidden = true;
        showDropTarget(null);
        if (!moved) {
          if (e.type === "pointerup") clickTab(tab);
          return;
        }
        const target = e.type === "pointerup" ? dropTarget(e) : null;
        dragging = null;
        if (target) move(tab, target.dock, { index: target.index });
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
      window.addEventListener("blur", finish);
    });
  }

  /** Where a dragged tab would land: a dock, and a position in its tab bar computed
   *  from the tabs' middles (the end when the pointer is over the dock's content). */
  function dropTarget(event) {
    const name = dockAt(event);
    if (!name || name !== dragging?.dock) return null; // a tab stays in its dock (homeOf)
    const elements = [...$(".tabs", docks[name].el).children];
    let index = elements.length;
    const bar = $(".dock-head", docks[name].el).getBoundingClientRect();
    if (event.clientY <= bar.bottom) {
      index = elements.findIndex((node) => {
        const box = node.getBoundingClientRect();
        return event.clientX < box.left + box.width / 2;
      });
      if (index < 0) index = elements.length;
    }
    return { dock: name, index };
  }

  function showDropTarget(target) {
    for (const d of DOCKS) docks[d].el.classList.toggle("drop-over", target?.dock === d);
    for (const node of document.querySelectorAll(".insert-before, .insert-after")) node.classList.remove("insert-before", "insert-after");
    if (!target) return;
    const elements = [...$(".tabs", docks[target.dock].el).children];
    if (target.index < elements.length) elements[target.index].classList.add("insert-before");
    else elements.at(-1)?.classList.add("insert-after");
  }

  function dockAt(event) {
    for (const name of DOCKS) {
      const node = docks[name].el;
      if (node.hidden) continue;
      const box = node.getBoundingClientRect();
      if (event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom) return name;
    }
    return null;
  }

  // A click in the middle closes a side open over it; a resize may move a side in or out.
  docks.center.el.addEventListener("pointerdown", () => {
    for (const name of ["left", "right"]) {
      if (docks[name].over && docks[name].overOpen) { docks[name].overOpen = false; render(name); }
    }
  }, true);
  let resizeFrame = 0;
  window.addEventListener("resize", () => {
    if (!resizeFrame) resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; renderAll(); });
  });

  // --- the sides' widths ---

  const MIN_SIDE_WIDTH = 220; // px: narrower, a side's panels cut their lines

  for (const name of DOCKS) {
    const dock = docks[name];
    if (!dock.side) continue;
    // Dragging changes one width per frame at most. Terminals are not fitted here: their
    // ResizeObserver does it once the size rests (terminal.js).
    let resizing = false;
    let frame = 0;
    let lastX = 0;
    /** The side at width px, held between MIN_SIDE_WIDTH and 60% of the workspace. */
    const setWidth = (width) => {
      const box = $("#workspace").getBoundingClientRect();
      dock.width = Math.round(Math.min(box.width * 0.6, Math.max(MIN_SIDE_WIDTH, width)));
      dock.el.style.setProperty("--width", `${dock.width}px`);
      dock.splitter.setAttribute("aria-valuenow", String(dock.width));
    };
    const applyWidth = () => {
      frame = 0;
      const box = $("#workspace").getBoundingClientRect();
      setWidth(name === "left" ? lastX - box.left : box.right - lastX);
    };
    const stopResizing = () => {
      if (!resizing) return;
      resizing = false;
      dock.splitter.classList.remove("dragging");
      save();
    };
    dock.splitter.addEventListener("pointerdown", (e) => {
      resizing = true;
      dock.splitter.classList.add("dragging");
      dock.splitter.setPointerCapture(e.pointerId);
    });
    dock.splitter.addEventListener("pointermove", (e) => {
      if (!resizing) return;
      lastX = e.clientX;
      if (!frame) frame = requestAnimationFrame(applyWidth);
    });
    dock.splitter.addEventListener("pointerup", stopResizing);
    dock.splitter.addEventListener("pointercancel", stopResizing);
    dock.splitter.addEventListener("lostpointercapture", stopResizing);
    // A double click on the divider, or Enter on it: back to the usual width.
    const resetWidth = () => {
      setWidth(defaultLayout()[name]?.width || 320);
      save();
    };
    dock.splitter.addEventListener("dblclick", resetWidth);
    // By keyboard too, as the ARIA window splitter: Tab reaches the divider, the arrows
    // move it 16 px (64 with Shift) the way they point, on either side.
    dock.splitter.tabIndex = 0;
    dock.splitter.setAttribute("aria-label", `Width of the ${name} side`);
    dock.splitter.setAttribute("aria-valuemin", String(MIN_SIDE_WIDTH));
    dock.splitter.addEventListener("focus", () => {
      const box = $("#workspace").getBoundingClientRect();
      dock.splitter.setAttribute("aria-valuemax", String(Math.round(box.width * 0.6)));
    });
    dock.splitter.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); resetWidth(); return; }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const step = (e.shiftKey ? 64 : 16) * (e.key === "ArrowRight" ? 1 : -1);
      setWidth(dock.width + (name === "left" ? step : -step));
      save();
    });
    dock.splitter.title = "Drag to resize, or the arrow keys; double-click or Enter for the usual width";
  }

  // --- persistence ---

  function snapshot() {
    const saved = {};
    for (const name of DOCKS) {
      const dock = docks[name];
      saved[name] = { tabs: dock.tabs.filter((t) => t.pinned || KINDS[t.kind].single).map(keyOf), active: dock.active ? keyOf(dock.active) : null, collapsed: dock.collapsed, width: dock.width };
    }
    saved.layout = 8; // what restore() keeps; below, it starts from the default layout
    // Names given by the user, for the tabs that come back at the next connection.
    saved.titles = Object.fromEntries(tabs().filter((t) => t.renamed && (t.pinned || KINDS[t.kind].single)).map((t) => [keyOf(t), t.title]));
    return saved;
  }

  function save() {
    if (!tabs().length) return; // keep the last useful layout
    try { localStorage.setItem("devbox.layout.v3", JSON.stringify(snapshot())); } catch { /* storage off */ }
  }

  function restore() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem("devbox.layout.v3")); } catch { /* default */ }
    saved = saved || defaultLayout();
    // An older layout gets the new arrangement once (Reset layout gives it again); the
    // names given to tabs stay.
    // Before 6, Context had a tab of its own: the default layout again (it is in Activity).
    if ((saved.layout || 0) < 8) saved = { ...defaultLayout(), titles: saved.titles };
    clear();
    let mainPlaced = false;
    for (const name of DOCKS) {
      const want = saved[name] || defaultLayout()[name];
      const dock = docks[name];
      dock.width = want.width || dock.width;
      for (const key of want.tabs || []) {
        if (key === "main") {
          if (!mainPlaced) place(create("picker", { pinned: true }), name, { reveal: false });
          mainPlaced = true;
        } else if (KINDS[key]?.single && !find(key)) {
          place(create(key), name, { reveal: false });
        }
      }
      dock.active = dock.tabs.find((t) => keyOf(t) === want.active) || dock.tabs[0] || null;
      dock.collapsed = Boolean(want.collapsed) && dock.side;
    }
    for (const [key, title] of Object.entries(saved.titles || {})) {
      const tab = find(key);
      if (tab && typeof title === "string" && title.trim()) Object.assign(tab, { title: title.trim(), renamed: true });
    }
    renderAll();
    find("main")?.onShow?.();
    save();
  }

  /** Puts the open tabs where `layout` says, without closing any: terminals keep their
   *  session and scrollback. Panels the layout lists but that are closed get opened. */
  function arrange(layout) {
    for (const name of DOCKS) {
      const want = layout[name] || {};
      docks[name].width = want.width || docks[name].width;
      docks[name].collapsed = Boolean(want.collapsed) && docks[name].side;
    }
    for (const name of DOCKS) {
      for (const key of layout[name]?.tabs || []) {
        const tab = find(key);
        if (tab) move(tab, name, { reveal: false });
        else if (KINDS[key]?.single) add(key, name, { reveal: false });
      }
    }
    // Extra terminals are not in any layout: they gather next to the main picker.
    const home = find("main")?.dock || "center";
    for (const tab of tabs()) {
      if (KINDS[tab.kind].terminal && !tab.pinned) move(tab, home, { reveal: false });
    }
    for (const name of DOCKS) {
      const dock = docks[name];
      dock.active = dock.tabs.find((t) => keyOf(t) === layout[name]?.active) || dock.active || dock.tabs[0] || null;
    }
    renderAll();
    for (const name of DOCKS) docks[name].active?.onShow?.();
    save();
  }

  function clear() {
    setCurrentTab(null);
    for (const tab of tabs()) {
      tab.onClose?.();
      tab.pane.remove();
    }
    for (const name of DOCKS) Object.assign(docks[name], { tabs: [], active: null });
    renderAll();
  }

  // The New tab page lists the latest conversations: drawn again once they are known.
  vm.on("conversations", () => { if (!docks.center.tabs.length) render("center"); });
  $(".add", docks.center.el).addEventListener("click", (event) => showMenu(event.currentTarget, addChoices("center")));
  $("#toggle-left").addEventListener("click", () => toggle("left"));
  $("#toggle-right").addEventListener("click", () => toggle("right"));
  return { add, move, close, show, find, tabs, restore, arrange, save, clear, docks, toggle, dockAtPoint: (x, y) => dockAt({ clientX: x, clientY: y }) };
})();

// Focus follows the mouse (a setting): the tab under the pointer gets the keyboard, on its
// last element. Nothing moves while a button is held, a dialog or menu is open, or a rename.
function focusFollows(tab) {
  tab.pane.tabIndex = -1;
  tab.pane.addEventListener("focusin", (e) => {
    tab.lastFocus = e.target;
    setCurrentTab(tab);
  });
  tab.pane.addEventListener("pointerleave", () => {
    if (tab.pane.contains(document.activeElement) && document.activeElement !== tab.pane) tab.lastFocus = document.activeElement;
  });
  tab.pane.addEventListener("pointerenter", (e) => {
    if (!prefs.focusFollowsMouse || e.buttons !== 0) return;
    if (document.querySelector(".overlay:not([hidden])") || !$("#menu").hidden || document.querySelector(".tab-rename")) return;
    if (tab.pane.contains(document.activeElement)) return;
    if (tab.focus) tab.focus();
    else if (tab.lastFocus?.isConnected && tab.pane.contains(tab.lastFocus)) tab.lastFocus.focus({ preventScroll: true });
    else tab.pane.focus({ preventScroll: true });
  });
}

let menuOpener = null; // what had the focus when the menu opened: it gets it back
let menuAnchor = null; // the button that opened it: clicked again, it closes it

function showMenu(anchor, items, at = null) {
  const menu = $("#menu");
  if (!menu.hidden && anchor && anchor === menuAnchor) { closeMenu(); return; }
  closeMenu(false);
  menu.replaceChildren();
  menu.setAttribute("role", "menu");
  // The icons' column only when an item has one: otherwise the labels start at the edge.
  menu.classList.toggle("no-icons", !items.some((item) => item?.[3]?.icon));
  for (const item of items) {
    if (!item) { menu.append(el("hr")); continue; }
    // [label, action, disabled, { icon, danger }]: every row keeps the icon's column.
    const [label, action, disabled, { icon, danger } = {}] = item;
    const b = el("button", { className: danger ? "danger" : "" });
    b.append(el("span", { className: "menu-icon" }, ...(icon ? [svgIcon(icon)] : [])), el("span", { textContent: label }));
    b.disabled = Boolean(disabled);
    b.setAttribute("role", "menuitem");
    b.addEventListener("click", () => { closeMenu(false); action(); });
    menu.append(b);
  }
  const box = at ? { left: at.x, bottom: at.y } : anchor.getBoundingClientRect();
  menuOpener = document.activeElement;
  menuAnchor = anchor;
  anchor?.setAttribute("aria-expanded", "true");
  menu.hidden = false;
  // Under its button; above it when there is no room below (the composer's): never over it.
  const below = box.bottom + 4;
  const above = (box.top ?? box.bottom) - menu.offsetHeight - 4;
  menu.style.top = `${below + menu.offsetHeight > window.innerHeight - 8 && above >= 8 ? above : Math.max(8, Math.min(below, window.innerHeight - menu.offsetHeight - 8))}px`;
  menu.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.querySelector("button:not(:disabled)")?.focus(); // by keyboard: the arrows go on from here
}

function closeMenu(giveBack = true) {
  const menu = $("#menu");
  if (menu.hidden) return;
  menu.hidden = true;
  menuAnchor?.setAttribute("aria-expanded", "false");
  menuAnchor = null;
  if (giveBack && menuOpener && document.contains(menuOpener)) menuOpener.focus?.();
  menuOpener = null;
}

// The menu by keyboard: up and down (round), Home and End, Escape closes it.
$("#menu").addEventListener("keydown", (e) => {
  const items = [...$("#menu").querySelectorAll("button:not(:disabled)")];
  const at = items.indexOf(document.activeElement);
  const go = (i) => { e.preventDefault(); items[(i + items.length) % items.length]?.focus(); };
  if (e.key === "ArrowDown") go(at + 1);
  else if (e.key === "ArrowUp") go(at - 1);
  else if (e.key === "Home") go(0);
  else if (e.key === "End") go(items.length - 1);
  else if (e.key === "Tab") { e.preventDefault(); closeMenu(); }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
document.addEventListener("pointerdown", (event) => {
  // The opener's own click closes it (showMenu): left to it here.
  if (!event.target.closest("#menu, .add, .tab-actions") && !menuAnchor?.contains(event.target)) closeMenu(false);
});
