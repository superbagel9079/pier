// The three docks and their tabs: placing, dragging, renaming, saving the layout.

// ============================================================================
// Workspace: three docks, any tab in any of them
// ============================================================================

const KINDS = {
  picker: { title: "picker", terminal: true },
  shell: { title: "shell", terminal: true },
  context: { title: "Context", single: true, make: (tab) => makeContext(tab) },
  project: { title: "Activity", single: true, make: (tab) => makeProject(tab) },
  setup: { title: "Setup", single: true, make: (tab) => makeSetup(tab) },
  conversations: { title: "Conversations", single: true, make: (tab) => makeConversations(tab) },
  pi: { title: "pi", terminal: true },
  update: { title: "pi update", terminal: true },
  diff: { title: "diff", make: (tab) => makeDiff(tab) },
  takeback: { title: "take back", make: (tab) => makeTakeBack(tab) },
  logs: { title: "Logs", single: true, make: (tab) => makeLogs(tab) },
  labs: { title: "Labs", single: true, make: (tab) => makeLabs(tab) },
  lab: { title: "lab", terminal: true },
};
const DOCKS = ["left", "center", "right"];
const DOCK_NAMES = { left: "left", center: "center", right: "right" };
// "main" is the pinned picker: the terminal Pier opens on, which cannot be closed.
// The terminals in the middle, every panel on one side (Settings > Layout chooses which):
// Conversations first, then what the Pi in use does, what it was given, its setup. The
// Logs tab is a diagnostics option.
function defaultLayout(side = prefs.panelSide) {
  const panels = side === "left" ? "left" : "right";
  const other = panels === "left" ? "right" : "left";
  return {
    [panels]: { tabs: ["conversations", "project", "context", "setup"], active: "conversations", collapsed: false, width: 400 },
    [other]: { tabs: [], collapsed: false, width: 320 },
    center: { tabs: ["main"] },
    layout: 5,
  };
}

const workspace = (() => {
  const docks = {};
  for (const name of DOCKS) {
    const node = $(`#dock-${name}`);
    docks[name] = {
      name, el: node, side: name !== "center", tabs: [], active: null, collapsed: false,
      width: name === "left" ? 320 : 380, splitter: $(`.splitter[data-dock="${name}"]`),
    };
  }
  let nextId = 1;

  const keyOf = (tab) => (tab.pinned ? "main" : tab.kind);
  const tabs = () => DOCKS.flatMap((name) => docks[name].tabs);
  const find = (key) => tabs().find((t) => keyOf(t) === key);

  // --- rendering ---

  function render(name) {
    const dock = docks[name];
    if (dock.side) {
      const empty = !dock.tabs.length;
      dock.el.hidden = empty && !dragging;
      dock.splitter.hidden = empty || dock.collapsed;
      dock.el.classList.toggle("collapsed", dock.collapsed && !empty);
      // While a tab is dragged, an empty side shows as a wide drop target.
      dock.el.classList.toggle("drop-target", empty && Boolean(dragging));
      dock.el.style.setProperty("--width", `${dock.width}px`);
      const collapse = $(".collapse", dock.el);
      if (dock.peek) collapse.replaceChildren(pinIcon());
      else collapse.textContent = (name === "right") === dock.collapsed ? "‹" : "›";
      collapse.title = dock.peek ? "Keep this side open (otherwise it folds back when you go back to the terminals)"
        : dock.collapsed ? "Expand" : "Collapse";
    }
    const bar = $(".tabs", dock.el);
    bar.innerHTML = "";
    for (const tab of dock.tabs) bar.append(tabElement(tab, dock));
    // The active tab entirely in view: in a narrow side, the bar scrolls to it.
    bar.children[dock.tabs.indexOf(dock.active)]?.scrollIntoView({ block: "nearest", inline: "nearest" });
    for (const tab of dock.tabs) {
      tab.pane.hidden = dock.collapsed || tab !== dock.active;
      // Panels follow the VM only while shown (vm.js): nothing is computed there for a
      // tab nobody looks at.
      if (tab.shown !== !tab.pane.hidden) {
        tab.shown = !tab.pane.hidden;
        tab.onVisible?.(tab.shown);
        // Only a terminal just shown is fitted here; the others follow their size on
        // their own (a ResizeObserver in terminal.js). Fitting every terminal at every
        // redraw reflowed all their histories.
        if (tab.shown) tab.refit?.();
      }
    }
    const panes = $(".panes", dock.el);
    $(":scope > .empty", panes)?.remove();
    if (!dock.tabs.length) panes.append(emptyDock(name));
  }

  function renderAll() {
    for (const name of DOCKS) render(name);
  }

  function tabElement(tab, dock) {
    const node = el("div");
    node.className = "tab" + (tab === dock.active && !dock.collapsed ? " active" : "") + (tab.pinned ? " pinned" : "");
    node.setAttribute("role", "tab");
    node.title = tab.pinned ? "picker: the main terminal (cannot be closed)" : tab.title;
    node.append(el("span", { textContent: tab.title }));
    const actions = el("span");
    actions.className = "tab-actions";
    // Only ×: moving, renaming and the rest are in the tab's right-click menu.
    if (!tab.pinned) actions.append(iconButton("×", "Close", () => close(tab)));
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
    const items = [["Rename…", () => rename(tab)], null];
    for (const name of DOCKS) items.push([`Move to the ${DOCK_NAMES[name]}`, () => move(tab, name), tab.dock === name]);
    if (dock.side && dock.peek) items.push(["Keep this side open", () => keepOpen(tab.dock)]);
    if (dock.side) items.push(["Collapse this side", () => { dock.peek = false; dock.collapsed = true; render(tab.dock); save(); }, dock.collapsed]);
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
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", (e) => { e.stopPropagation(); action(b); });
    return b;
  }


  function emptyDock(name) {
    const choices = el("div");
    choices.className = "choices";
    for (const [label, action] of addChoices(name)) {
      const b = el("button", { className: "link", textContent: label, title: label });
      b.addEventListener("click", action);
      choices.append(b);
    }
    const box = el("div");
    box.className = "empty";
    box.append(el("span", { textContent: "Open a tab here" }), choices);
    return box;
  }

  function addChoices(name) {
    const items = [
      ["New shell", () => add("shell", name)],
      ["New picker", () => add("picker", name)],
    ];
    const main = find("main");
    if (main && main.dock !== name) items.push([`picker (main) · move here`, () => move(main, name)]);
    // Every panel: the closed ones to open again, the others to bring here.
    for (const kind of ["conversations", "project", "context", "setup", "logs", "labs"]) {
      const open = find(kind);
      const title = KINDS[kind].title;
      if (!open) items.push([title, () => add(kind, name)]);
      else if (open.dock !== name) items.push([`${title} · move here`, () => move(open, name)]);
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

  /** Opens a tab in a dock; a single-instance panel already open is moved instead. */
  function add(kind, name, { reveal = true, pinned = false, params = null } = {}) {
    const existing = KINDS[kind].single ? find(kind) : null;
    if (existing) return move(existing, name, { reveal });
    const tab = create(kind, { pinned, params });
    place(tab, name, { reveal });
    return tab;
  }

  function place(tab, name, { reveal = true, index = null } = {}) {
    const dock = docks[name];
    if (index === null || index > dock.tabs.length) dock.tabs.push(tab);
    else dock.tabs.splice(index, 0, tab);
    tab.dock = name;
    $(".panes", dock.el).append(tab.pane);
    if (reveal || !dock.active) dock.active = tab;
    if (reveal) dock.collapsed = false;
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
    dock.collapsed = false;
    render(tab.dock);
    tab.onShow?.();
    setCurrentTab(tab);
  }

  /** A click on a tab shows it. Collapsing a side is its own button (‹ ›) or the
   *  tab's right-click menu: a click meant to look at a tab never hides the panel.
   *  On a collapsed side, the click unfolds it for a look ("peek"): it folds back once
   *  you are back on the terminals (see foldPeeks), unless you keep it open (the pin button). */
  function clickTab(tab) {
    const dock = docks[tab.dock];
    if (dock.side && dock.collapsed) dock.peek = true;
    show(tab);
    save();
  }

  function keepOpen(name) {
    docks[name].peek = false;
    render(name);
    save();
  }

  /** The sides unfolded for a look, folded again. */
  function foldPeeks() {
    for (const name of DOCKS) {
      const dock = docks[name];
      if (!dock.peek) continue;
      dock.peek = false;
      dock.collapsed = true;
      render(name);
      save();
    }
  }


  // --- dragging tabs between docks ---

  let dragging = null;

  // Listeners go on the window, not the tab: starting a drag redraws the tab bars,
  // which replaces the tab's element, and a listener on it would never hear the
  // release (the ghost stayed on screen).
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
          renderAll(); // empty sides appear as thin drop targets
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
        // Every dock, not only the two the tab moved between: an empty side shown as
        // a drop target must go away even though nothing landed on it.
        renderAll();
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
    if (!name) return null;
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

  // --- side controls ---

  /** A pin, drawn in the text's colour like the other icons (never a coloured emoji). */
  function pinIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    for (const [k, v] of Object.entries({ viewBox: "0 0 16 16", width: "13", height: "13", fill: "none", stroke: "currentColor",
      "stroke-width": "1.4", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
    for (const d of ["M5.5 2h5", "M6.5 2v4L4.5 8.5h7L9.5 6V2", "M8 8.5V14"]) {
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }

  // Back on the terminals, a side unfolded for a look folds again: as soon as the
  // pointer is there when the focus follows the mouse, at the next click otherwise.
  const center = docks.center.el;
  center.addEventListener("pointerenter", (e) => {
    if (prefs.focusFollowsMouse && e.buttons === 0) foldPeeks();
  });
  center.addEventListener("pointerdown", () => foldPeeks(), true);

  for (const name of DOCKS) {
    const dock = docks[name];
    $(".add", dock.el).addEventListener("click", (event) => showMenu(event.currentTarget, addChoices(name)));
    if (!dock.side) continue;
    $(".collapse", dock.el).addEventListener("click", () => {
      if (dock.peek) { keepOpen(name); return; } // the pin: the look becomes the layout
      dock.collapsed = !dock.collapsed;
      render(name);
      if (!dock.collapsed) dock.active?.onShow?.();
      save();
    });
    // Dragging the divider changes one width per frame, at most. The terminals are not
    // fitted here: their ResizeObserver does it once the size rests (terminal.js), so a
    // drag no longer reflows every history at every pixel.
    let resizing = false;
    let frame = 0;
    let lastX = 0;
    const applyWidth = () => {
      frame = 0;
      const box = $("#workspace").getBoundingClientRect();
      const width = name === "left" ? lastX - box.left : box.right - lastX;
      dock.width = Math.round(Math.min(box.width * 0.6, Math.max(220, width)));
      dock.el.style.setProperty("--width", `${dock.width}px`);
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
    // A double click on the divider: back to the usual width.
    dock.splitter.addEventListener("dblclick", () => {
      dock.width = defaultLayout()[name]?.width || (name === "left" ? 320 : 400);
      dock.el.style.setProperty("--width", `${dock.width}px`);
      save();
    });
    dock.splitter.title = "Drag to resize; double-click for the usual width";
  }

  // --- persistence ---

  function snapshot() {
    const saved = {};
    for (const name of DOCKS) {
      const dock = docks[name];
      saved[name] = { tabs: dock.tabs.filter((t) => t.pinned || KINDS[t.kind].single).map(keyOf), active: dock.active ? keyOf(dock.active) : null, collapsed: dock.collapsed || Boolean(dock.peek), width: dock.width };
    }
    // Names given by the user, for the tabs that come back at the next connection.
    saved.knowsSetup = true;
    saved.knowsConversations = true;
    saved.layout = 5;
    saved.titles = Object.fromEntries(tabs().filter((t) => t.renamed && (t.pinned || KINDS[t.kind].single)).map((t) => [keyOf(t), t.title]));
    return saved;
  }

  function save() {
    if (!tabs().length) return; // keep the last useful layout
    try { localStorage.setItem("devbox.layout.v3", JSON.stringify(snapshot())); } catch { /* storage off */ }
  }

  function restore(layout) {
    let saved = layout;
    if (!saved) {
      try { saved = JSON.parse(localStorage.getItem("devbox.layout.v3")); } catch { /* default */ }
    }
    saved = saved || defaultLayout();
    // An older layout gets the new arrangement once (Reset layout gives it again); the
    // names given to tabs stay.
    if ((saved.layout || 0) < 5) saved = { ...defaultLayout(), titles: saved.titles };
    clear();
    let mainPlaced = false;
    for (const name of DOCKS) {
      const want = saved[name] || defaultLayout()[name];
      const dock = docks[name];
      dock.width = want.width || dock.width;
      for (const key of (want.tabs || []).map((k) => (k === "send" || k === "shares" ? "context" : k))) {
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
    if (!mainPlaced) place(create("picker", { pinned: true }), "center", { reveal: true });
    if (!saved.knowsSetup && !find("setup")) place(create("setup"), "right", { reveal: false });
    if (!saved.knowsConversations && !find("conversations")) place(create("conversations"), "right", { reveal: false });
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

  return { add, move, close, show, find, tabs, restore, arrange, save, clear, docks, keyOf, dockAtPoint: (x, y) => dockAt({ clientX: x, clientY: y }) };
})();

// Focus follows the mouse (a setting), as on many Linux desktops: the tab under the
// pointer gets the keyboard. Each tab keeps the element that had the focus last (the
// terminal, an editor, a field) and gets it back; nothing moves while a button is held,
// a dialog or a menu is open, or a name is being typed in a tab.
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

function showMenu(anchor, items, at = null) {
  const menu = $("#menu");
  menu.innerHTML = "";
  for (const item of items) {
    if (!item) { menu.append(el("hr")); continue; }
    const [label, action, disabled] = item;
    const b = el("button");
    b.textContent = label;
    b.disabled = Boolean(disabled);
    b.addEventListener("click", () => { menu.hidden = true; action(); });
    menu.append(b);
  }
  const box = at ? { left: at.x, bottom: at.y } : anchor.getBoundingClientRect();
  menu.hidden = false;
  menu.style.top = `${Math.max(8, Math.min(box.bottom + 2, window.innerHeight - menu.offsetHeight - 8))}px`;
  menu.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - menu.offsetWidth - 8))}px`;
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#menu").hidden = true; });
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest("#menu, .add, .tab-actions")) $("#menu").hidden = true;
});
