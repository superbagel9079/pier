// The three docks and their tabs: placing, reordering, renaming, saving the layout.

// Workspace: three docks, any tab in any of them

const KINDS = {
  shell: { title: "shell", terminal: true },
  project: { title: "Activity", single: true, make: (tab) => makeProject(tab) },
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
// The docks: the two sides and the middle's groups of tabs ("center", then "center-2"...,
// added and removed as the middle is split: see the panes below).
const DOCKS = ["left", "center", "right"];
const isCenterDock = (name) => name === "center" || String(name || "").startsWith("center-");
// A tab's icon: a file's or a diff's by its type, else by what the tab is.
const TAB_ICON = { chat: "message-square", project: "activity", repository: "git-branch",
  conversations: "inbox", takeback: "undo-2", labs: "flask-conical" };
const tabIcon = (tab) => tab.kind === "diff" ? "git-compare" : tab.kind === "file" && tab.params?.rel ? fileTypeIcon(tab.params.rel)
  : TAB_ICON[tab.kind] || (KINDS[tab.kind]?.terminal ? "terminal" : "file");
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
  const centerEl = $("#dock-center");
  const grid = $(".center-grid", centerEl);
  for (const name of DOCKS) {
    const node = name === "center" ? $('.group[data-dock="center"]', centerEl) : $(`#dock-${name}`);
    docks[name] = {
      name, el: node, side: name !== "center", tabs: [], active: null, collapsed: false,
      width: defaultLayout()[name]?.width || 320, splitter: $(`.splitter[data-dock="${name}"]`),
    };
  }
  let nextId = 1;

  const keyOf = (tab) => tab.kind;
  const tabs = () => DOCKS.flatMap((name) => docks[name].tabs);
  const find = (key) => tabs().find((t) => keyOf(t) === key);

  // --- the middle's panes (as tmux's): a tree of rows and columns of groups of tabs ---
  // A leaf {g: name}; a split {dir: "row"|"col", items, sizes} (sizes: the items' shares).
  // "center" is always there: when it empties, the next group takes its place; any other
  // group goes away with its last tab.
  let tree = { g: "center" };
  let focusGroup = "center"; // the group a new tab goes to, whose tab the header names
  let groupSeq = 1;
  const centerNames = (node = tree) => (node.g ? [node.g] : node.items.flatMap((n) => centerNames(n)));
  const locate = (name, node = tree, parent = null) => {
    if (node.g === name) return { node, parent };
    for (const child of node.items || []) { const found = locate(name, child, node); if (found) return found; }
    return null;
  };
  /** Where a tab of `name` goes: a side's own dock; in the middle, the group asked if it
   *  exists, else the one in focus ("center" means the middle, wherever). */
  const target = (kind, name) => (homeOf(kind) !== "center" ? homeOf(kind)
    : isCenterDock(name) && name !== "center" && docks[name] ? name : focusGroup);

  function newGroup() {
    const name = `center-${++groupSeq}`;
    const node = el("div", { className: "group" });
    node.dataset.dock = name;
    const plus = el("button", { className: "icon add", title: "Add a tab", "aria-label": "Add a tab", "aria-haspopup": "menu" }, svgIcon("plus"));
    plus.addEventListener("click", (event) => showMenu(event.currentTarget, addChoices(name)));
    node.append(el("div", { className: "dock-head" }, el("div", { className: "tabs", role: "tablist" }), plus), el("div", { className: "panes" }));
    node.addEventListener("pointerdown", () => focusOn(name), true);
    docks[name] = { name, el: node, side: false, tabs: [], active: null, collapsed: false, width: 0 };
    DOCKS.splice(DOCKS.indexOf("right"), 0, name);
    return name;
  }

  /** A new group beside `name` (side: left, right, top or bottom): its name. */
  function splitAt(name, side) {
    const fresh = newGroup();
    const dir = side === "left" || side === "right" ? "row" : "col";
    const before = side === "left" || side === "top";
    const { node, parent } = locate(name);
    const leaf = { g: fresh };
    if (parent && parent.dir === dir) {
      const i = parent.items.indexOf(node);
      const half = parent.sizes[i] / 2;
      parent.sizes[i] = half;
      parent.items.splice(before ? i : i + 1, 0, leaf);
      parent.sizes.splice(before ? i : i + 1, 0, half);
    } else {
      const same = { g: node.g };
      delete node.g;
      Object.assign(node, { dir, items: before ? [leaf, same] : [same, leaf], sizes: [1, 1] });
    }
    return fresh;
  }

  /** The tree without the leaf `name` (its share to its neighbour; a split of one, gone). */
  function removeLeaf(name) {
    const found = locate(name);
    if (!found?.parent) return;
    const { node, parent } = found;
    const i = parent.items.indexOf(node);
    parent.items.splice(i, 1);
    const [share] = parent.sizes.splice(i, 1);
    parent.sizes[Math.max(0, i - 1)] += share;
    if (parent.items.length === 1) {
      const only = parent.items[0];
      for (const key of Object.keys(parent)) delete parent[key];
      Object.assign(parent, only);
    }
  }

  function dropGroup(name) {
    docks[name].el.remove();
    delete docks[name];
    DOCKS.splice(DOCKS.indexOf(name), 1);
    if (focusGroup === name) focusGroup = "center";
  }

  /** A group left empty: gone (its neighbour takes the room); "center" takes the tabs of
   *  the next group, which goes, so that "center" stays. */
  function collapse(name) {
    if (tree.g) return; // the only group: its New tab page
    if (name !== "center") {
      removeLeaf(name);
      dropGroup(name);
    } else {
      const other = centerNames().find((n) => n !== "center");
      const from = docks[other];
      for (const t of from.tabs) { t.dock = "center"; $(".panes", docks.center.el).append(t.pane); }
      docks.center.tabs = from.tabs;
      docks.center.active = from.active;
      removeLeaf("center");
      locate(other).node.g = "center";
      dropGroup(other);
    }
    renderGrid();
    render("center");
    frame();
  }

  function focusOn(name) {
    if (!docks[name]) return;
    if (docks[name].active?.attention) attention(docks[name].active, false); // seen
    if (focusGroup === name) return;
    focusGroup = name;
    for (const n of centerNames()) docks[n].el.classList.toggle("focus", n === focusGroup);
    frame();
  }

  /** The middle drawn from the tree: groups in rows and columns, a gutter between two. */
  function renderGrid() {
    const build = (node) => {
      if (node.g) return docks[node.g].el;
      const box = el("div", { className: `split ${node.dir}` });
      node.items.forEach((child, i) => {
        if (i) box.append(gutter(node, i));
        const cell = el("div", { className: "cell" }, build(child));
        cell.style.flex = `${node.sizes[i]} 1 0`;
        box.append(cell);
      });
      return box;
    };
    grid.replaceChildren(build(tree));
    grid.classList.toggle("many", !tree.g);
    for (const n of centerNames()) docks[n].el.classList.toggle("focus", n === focusGroup);
  }

  /** Between two items of a split: dragged, it moves the line; a double click, halves. */
  function gutter(node, i) {
    const line = el("div", { className: "gutter", role: "separator", title: "Drag to resize; double-click for halves" });
    line.setAttribute("aria-orientation", node.dir === "row" ? "vertical" : "horizontal");
    line.addEventListener("pointerdown", (down) => {
      const cells = [...line.parentElement.children].filter((c) => c.classList.contains("cell"));
      const a = cells[i - 1], b = cells[i];
      const across = node.dir === "row";
      const sizeA = across ? a.offsetWidth : a.offsetHeight;
      const both = sizeA + (across ? b.offsetWidth : b.offsetHeight);
      const total = node.sizes[i - 1] + node.sizes[i];
      line.setPointerCapture(down.pointerId);
      line.classList.add("dragging");
      const onMove = (e) => {
        const now = Math.max(120, Math.min(both - 120, sizeA + (across ? e.clientX - down.clientX : e.clientY - down.clientY)));
        node.sizes[i - 1] = (total * now) / both;
        node.sizes[i] = total - node.sizes[i - 1];
        a.style.flex = `${node.sizes[i - 1]} 1 0`;
        b.style.flex = `${node.sizes[i]} 1 0`;
      };
      const onUp = () => {
        line.classList.remove("dragging");
        line.removeEventListener("pointermove", onMove);
        line.removeEventListener("pointerup", onUp);
        line.removeEventListener("pointercancel", onUp);
      };
      line.addEventListener("pointermove", onMove);
      line.addEventListener("pointerup", onUp);
      line.addEventListener("pointercancel", onUp);
    });
    line.addEventListener("dblclick", () => {
      node.sizes[i - 1] = node.sizes[i] = (node.sizes[i - 1] + node.sizes[i]) / 2;
      renderGrid();
    });
    return line;
  }

  /** A tab in a new pane beside its group (or beside `name`'s): Ctrl+\, the tab's menu, a
   *  drop on a pane's edge. A group's only tab goes nowhere: there would be nothing left. */
  function splitWith(tab, name = tab.dock, side = "right") {
    if (!isCenterDock(tab.dock) || (name === tab.dock && docks[name].tabs.length < 2)) {
      flashStatus("Open a second tab here first: a pane needs a tab of its own");
      return;
    }
    const fresh = splitAt(name, side);
    renderGrid();
    move(tab, fresh);
    focusOn(fresh);
  }

  /** A tab that wants you (its Pi finished, or waits for an answer): a dot on it, a ring
   *  around its pane, until it is shown. */
  function attention(tab, on) {
    if (Boolean(tab.attention) === Boolean(on)) return;
    tab.attention = Boolean(on);
    if (!docks[tab.dock]) return;
    render(tab.dock);
  }

  // --- rendering ---

  // A narrow window, as the mock-up: a side the middle has no room for leaves the row and
  // opens over the middle from its header button (closed again by a click in the middle).
  const CENTRE_MIN = { left: 400, right: 480 };
  let lastOpened = null; // the side opened last: when both do not fit, it goes over the middle
  function layoutSides() {
    const room = $("#workspace").clientWidth - ($("#rail").offsetWidth || 44);
    const { left, right } = docks;
    const wasOver = { left: left.over, right: right.over };
    // A side the middle has no room for even alone: over the middle.
    left.over = room - left.width < CENTRE_MIN.left;
    right.over = room - right.width < CENTRE_MIN.right;
    // Each fits alone, not both: the one opened last goes over, the other stays in its place
    // (opening the conversations no longer closes Details, closing them no longer reopens it).
    const wants = (d) => !d.collapsed && d.tabs.length;
    if (!left.over && !right.over && wants(left) && wants(right) && room - left.width - right.width < CENTRE_MIN.right) {
      (lastOpened === "left" ? left : right).over = true;
    }
    // A side that just left the row (a narrower window, a start) folds into its button; it
    // opens over the middle only if its button was what pushed it out.
    for (const d of [left, right]) if (d.over && !wasOver[d.name]) d.overOpen = opening === d.name;
  }
  let opening = null; // the side whose button is being clicked
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
    if (!dock.side) dock.el.classList.toggle("attn", dock.tabs.some((t) => t.attention));
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
    // Narrow: the rail stays, with a square per project (conversations.js); they follow the
    // VM even while the side is closed.
    if (ws.classList.contains("left-over") !== Boolean(docks.left.over)) {
      ws.classList.toggle("left-over", Boolean(docks.left.over));
      for (const t of docks.left.tabs) t.onVisible?.(Boolean(t.shown));
    }
    $("#head-title").textContent = (docks[focusGroup] || docks.center).active?.title || "New tab";
    $("#btn-conversations").setAttribute("aria-pressed", String(ws.classList.contains("left-open")));
  }

  /** The middle's toggles: a side hidden or shown again. */
  function toggle(name) {
    const dock = docks[name];
    // Over the middle too, open or closed is what a wider window keeps.
    if (dock.over) { dock.overOpen = !dock.overOpen; dock.collapsed = !dock.overOpen; }
    else dock.collapsed = !dock.collapsed;
    if (!folded(dock)) { lastOpened = name; dock.overOpen = true; opening = name; }
    renderAll();
    opening = null;
    if (!folded(dock)) dock.active?.onShow?.();
    save();
  }

  function tabElement(tab, dock) {
    const node = el("div");
    node.className = "tab" + (tab === dock.active && !folded(dock) ? " active" : "");
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
    node.title = tab.title;
    node.append(el("span", { className: "tab-icon" }, svgIcon(tabIcon(tab))), el("span", { textContent: tab.title }),
      ...(tab.attention ? [el("i", { className: "attn-dot", title: "Pi finished or waits for you" })] : []));
    const actions = el("span");
    actions.className = "tab-actions";
    // Only ×: moving, renaming and the rest are in the tab's right-click menu.
    const x = iconButton("", "Close", () => close(tab));
    x.removeAttribute("title"); // no hint over the ×: its name is enough for a reader
    x.append(svgIcon("x"));
    actions.append(x);
    node.append(actions);
    dragSource(node, tab);
    node.addEventListener("auxclick", (e) => { if (e.button === 1) close(tab); });
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
    // A conversation: on in the other view (switchPiView, setup.js).
    if (tab.kind === "pi") items.push(null, ["Continue in the conversation view", () => switchPiView(tab), false, { icon: "message-square" }]);
    if (tab.kind === "chat") items.push(null, ["Continue in Pi's screen (tmux)", () => switchPiView(tab), false, { icon: "terminal" }]);
    if (isCenterDock(tab.dock)) {
      const alone = dock.tabs.length < 2;
      items.push(null, ["Split right", () => splitWith(tab, tab.dock, "right"), alone, { icon: "panel-right" }],
        ["Split down", () => splitWith(tab, tab.dock, "bottom"), alone, { icon: "panel-bottom" }]);
    }
    const others = dock.tabs.filter((t) => t !== tab);
    items.push(null, ["Close", () => close(tab)], ["Close the other tabs here", () => others.forEach(close), !others.length]);
    showMenu(null, items, { x, y });
  }

  /** Edits a tab's name in place: Enter keeps it, Escape cancels, empty restores it. */
  function rename(tab) {
    const label = [...$(".tabs", docks[tab.dock].el).children][docks[tab.dock].tabs.indexOf(tab)]?.querySelector(":scope > .tab-icon + span");
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
  let newTabProject = null; // the project the New tab's message field starts Pi in, once chosen
  let newTabDraft = "";     // what is typed there, kept while the page is drawn again
  let newTabModel = null;   // a model chosen there, for that conversation only
  let newTabThinking = null;
  function emptyDock(name) {
    if (!settings || (!online && vmForm)) return quickStart(); // no VM yet, or its form asked for: how to begin (3A)
    if (!online) return el("div", { className: "empty launcher" }, pierMark(), loginCard()); // a VM known: its password (D)
    const line = (icon, label, detail, action) => {
      const b = el("button", { className: "lrow" }, svgIcon(icon), el("span", { textContent: label }), el("span", { className: "m", textContent: detail }));
      b.addEventListener("click", () => (online ? action() : toLogin())); // not connected: connect first
      return b;
    };
    const project = newTabProject || target?.path || lastProjects?.recent?.[0]?.path || lastProjects?.running?.[0]?.path;
    // Pier's conversation view: write first, Enter starts Pi in the project chosen above. Pi
    // in tmux: the lines as before.
    const group = el("div", { className: "lgroup" },
      ...(prefs.piTerminal || !project ? [line("square-pen", "New conversation", project ? projectLabel(project) : "", () => (project ? openPiTerminal(project, projectLabel(project), ["--new"]) : openFolderPicker()))] : [newTabComposer(project)]),
      line("folder-plus", "Start a project…", "a folder of the VM, or a new one", () => openFolderPicker()),
      line("terminal", "New shell", "on the VM", () => add("shell", name)));
    // The recent ones even with the conversations' side folded (it follows them only while
    // shown): asked here, the page drawn again when they come (the listener below).
    vm.follow({ conversations: true });
    const recent = (vm.latest("conversations")?.data?.projects || []).flatMap((p) => p.sessions.filter((s) => !s.archived && !s.subagent).map((s) => [p, s]))
      .sort((a, b) => b[1].modified - a[1].modified).slice(0, 5);
    if (recent.length) {
      group.append(el("p", { className: "llabel", textContent: "Recent conversations" }));
      for (const [p, s] of recent) group.append(line("message-square", conversationTitle(s), p.label, () => openPiTerminal(p.project, p.label, ["--session", s.path])));
    }
    return el("div", { className: "empty launcher" }, group);
  }

  /** The New tab's message field: the project (its mark, a menu of the others), the field, send. */
  function newTabComposer(project) {
    let looks = {};
    try { looks = JSON.parse(localStorage.getItem("devbox.conversations.v1"))?.looks || {}; } catch { /* none */ }
    const projects = [...new Map([...(vm.latest("conversations")?.data?.projects || []).map((p) => [p.project, p.label]),
      ...[...(lastProjects?.running || []), ...(lastProjects?.recent || [])].map((p) => [p.path, p.label || projectLabel(p.path)])]).entries()];
    const pick = el("button", { type: "button", className: "nt-project", title: "The project Pi starts in" },
      projectBadge(project, looks[project]), el("span", { textContent: projectLabel(project) }), svgIcon("chevron-down"));
    pick.setAttribute("aria-haspopup", "menu");
    pick.addEventListener("click", () => showMenu(pick, [
      ...projects.map(([path, label]) => [label, () => { newTabProject = path; render("center"); }, false, { mark: projectBadge(path, looks[path]) }]),
      null,
      ["Start a project…", () => openFolderPicker(), false, { icon: "folder-plus" }],
    ]));
    // The conversation's own composer (chat.js), the same in every way: its text, + (a file
    // from this PC, a skill), the model and the thinking (for this conversation), "/" for the
    // project's skills and prompts. Enter starts Pi in the project with them; a file added
    // starts it at once, the text kept to finish there.
    const field = el("textarea", { placeholder: "Message Pi. / for skills and commands, @ for files", spellcheck: true, value: newTabDraft });
    field.setAttribute("aria-label", "Message Pi");
    field.addEventListener("input", () => { newTabDraft = field.value; });
    const send = el("button", { type: "button", className: "send", title: "Send: Pi starts in this project" }, svgIcon("arrow-up"));
    send.setAttribute("aria-label", "Send");
    const plus = el("button", { type: "button", className: "icon-btn", title: "Add to the message" }, svgIcon("plus"));
    plus.setAttribute("aria-label", "Add to the message");
    plus.setAttribute("aria-haspopup", "menu");
    const modelBtn = el("button", { type: "button", className: "pickish", textContent: "model ▾" });
    const thinkBtn = el("button", { type: "button", className: "pickish", textContent: `thinking${newTabThinking ? `: ${newTabThinking}` : ""} ▾` });
    const composer = el("div", { className: "composer nt-composer" }, field,
      el("div", { className: "bar" }, plus, modelBtn, thinkBtn, el("span", { className: "head-gap" }), send));
    const slash = slashMenu(field, composer, () => project);
    const label = () => projectLabel(project);
    const asked = () => ({ ...(newTabModel ? { model: newTabModel } : {}), ...(newTabThinking ? { thinking: newTabThinking } : {}) });
    const started = () => { newTabDraft = ""; newTabModel = null; newTabThinking = null; };
    // The model: Pi's default until another is chosen here (for this conversation only).
    backend.api(["pi-default-read"]).then((r) => { if (!newTabModel && r?.default) modelBtn.textContent = `${String(r.default).split("/").pop()} ▾`; }).catch(() => {});
    if (newTabModel) modelBtn.textContent = `${newTabModel.split("/").pop()} ▾`;
    modelBtn.addEventListener("click", async () => {
      await loadPiModels();
      pickPalette(modelBtn, { items: modelItems(), current: newTabModel, placeholder: MODEL_SEARCH,
        onPick: (v) => { newTabModel = v; modelBtn.textContent = `${v.split("/").pop()} ▾`; } });
    });
    thinkBtn.addEventListener("click", () => showMenu(thinkBtn, ["off", "minimal", "low", "medium", "high", "xhigh"].map((level) =>
      [level, () => { newTabThinking = level; thinkBtn.textContent = `thinking: ${level} ▾`; }, false, { icon: level === newTabThinking ? "check" : null }])));
    plus.addEventListener("click", () => showMenu(plus, [
      ["Add a file from this PC", async () => {
        const paths = await backend.pickFiles();
        if (!paths.length) return;
        const draft = field.value;
        started();
        openChat(project, label(), ["--new"], { ...asked(), draft, give: paths });
      }, false, { icon: "paperclip" }],
      ["Use a skill…", () => { if (!field.value.startsWith("/")) field.value = `/${field.value}`; field.focus(); field.setSelectionRange(1, 1); slash.update(); }, false, { icon: "gift" }],
    ]));
    const go = () => {
      const text = field.value.trim();
      if (!text) { field.focus(); return; }
      const extra = asked();
      started();
      openChat(project, label(), ["--new"], { ...extra, firstPrompt: text });
    };
    send.addEventListener("click", go);
    field.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); go(); } });
    setTimeout(() => { if (field.isConnected && !document.querySelector(".overlay:not([hidden])") && $("#prefs").hidden) field.focus({ preventScroll: true }); }, 0);
    return el("div", { className: "nt-start" },
      el("h2", { textContent: "New conversation" }),
      el("div", { className: "nt-bar" }, pick),
      composer);
  }

  /** No VM yet: three steps, the next one put forward (the proposals' 3A). */
  function quickStart() {
    const step = (n, done, on, title, detail, button) => el("div", { className: `qs-step${done ? " done" : ""}${on ? " on" : ""}` },
      el("span", { className: "n", "aria-hidden": "true" }, ...(done ? [svgIcon("check")] : [String(n)])),
      el("div", { className: "what" }, el("span", { textContent: title }), el("span", { textContent: detail })), button || null);
    // The first step open in place, its fields in it (the proposals' G): no window.
    const first = step(1, false, true, "Add your VM", "Its address and your user on it.");
    first.classList.add("open");
    const vmFields = firstVmForm(vmForm === "edit" ? settings : null);
    if (vmFields.back) $(".what", first).after(vmFields.back); // back to "Your VM", in the step's header
    first.append(vmFields);
    return el("div", { className: "empty launcher quick-start" }, el("div", { className: "qs" }, pierMark(),
      el("h2", { textContent: "Run Pi on your Linux VM" }),
      el("p", { textContent: "Pier talks to it over SSH: Pi works there, you follow it from here." }),
      first,
      step(2, false, false, "Connect", "Pier installs its picker there if it is missing."),
      step(3, false, false, "Start a conversation", "In a folder of the VM.")));
  }

  /** The New tab page drawn again (connected or not, a VM known or not). */
  function redrawEmpty() { if (!docks.center.tabs.length) render("center"); }

  function addChoices(name) {
    const items = [
      // As the rail's pen: in the project of the Pi in use, else the last one.
      ...(online ? [["New conversation", () => $("#rail-new").click(), false, { icon: "square-pen" }],
        ["Start a project…", () => openFolderPicker(), false, { icon: "folder-plus" }]] : []),
      ["New shell", () => add("shell", name), false, { icon: "terminal" }],
    ];
    const ICONS = { repository: "git-branch", labs: "flask-conical", conversations: "message-square", project: "activity" };
    // The panels of the middle, and the sides' two when closed. Labs once they are on
    // (Settings > Labs); Given to Pi is in Activity.
    for (const kind of ["repository", ...(labsOn() || find("labs") ? ["labs"] : []), "conversations", "project"]) {
      const open = find(kind);
      if (!open) items.push([KINDS[kind].title, () => add(kind, name), false, { icon: ICONS[kind] }]);
      else if (open.dock === "center") items.push([`${KINDS[kind].title} · show`, () => show(open), false, { icon: ICONS[kind] }]);
    }
    return items;
  }

  // --- tabs ---

  function create(kind, { params = null } = {}) {
    const pane = el("div");
    pane.className = "pane";
    const same = tabs().filter((t) => t.kind === kind).length;
    const title = KINDS[kind].single || !same ? KINDS[kind].title : `${KINDS[kind].title} ${same + 1}`;
    const tab = { id: nextId++, kind, pane, title, defaultTitle: title, params };
    if (KINDS[kind].terminal) makeTerminal(tab, kind);
    else KINDS[kind].make(tab);
    focusFollows(tab);
    tab.defaultTitle = tab.title; // a panel may name itself (a diff tab: the file)
    return tab;
  }

  /** Opens a tab where its kind lives (homeOf: the dock asked is only a wish kept for
   *  callers); a single-instance panel already open is shown instead. */
  function add(kind, name, { reveal = true, params = null, replace = false } = {}) {
    name = target(kind, name);
    const existing = KINDS[kind].single ? find(kind) : null;
    if (existing) return move(existing, name, { reveal });
    const tab = create(kind, { params });
    // replace: in the place of the file or diff shown in the middle; any other tab stays.
    const old = replace ? docks[name].active : null;
    const swap = old && (old.kind === "file" || old.kind === "diff");
    place(tab, name, { reveal, index: swap ? docks[name].tabs.indexOf(old) + 1 : null });
    if (swap) close(old);
    return tab;
  }

  function place(tab, name, { reveal = true, index = null, exact = false } = {}) {
    name = exact ? name : target(tab.kind, name); // exact: the group named, as a drag says
    const dock = docks[name];
    if (index === null || index > dock.tabs.length) dock.tabs.push(tab);
    else dock.tabs.splice(index, 0, tab);
    tab.dock = name;
    $(".panes", dock.el).append(tab.pane);
    if (reveal || !dock.active) dock.active = tab;
    if (reveal && dock.over) dock.overOpen = true;
    if (reveal) dock.collapsed = false;
    render(name);
    if (reveal) {
      if (isCenterDock(name)) focusOn(name);
      tab.onShow?.();
      setCurrentTab(tab);
      attention(tab, false);
    }
    save();
  }

  function detach(tab, { fold = true } = {}) {
    const dock = docks[tab.dock];
    const index = dock.tabs.indexOf(tab);
    dock.tabs.splice(index, 1);
    if (dock.active === tab) dock.active = dock.tabs[Math.min(index, dock.tabs.length - 1)] || null;
    render(tab.dock);
    dock.active?.onShow?.();
    if (fold && isCenterDock(tab.dock) && !dock.tabs.length) collapse(tab.dock);
  }

  /** Moves a tab to a dock, at `index` in its bar (the end by default); within the
   *  same dock, an index reorders. */
  function move(tab, name, { reveal = true, index = null } = {}) {
    // A panel stays in its home (a side's): shown, not moved; the middle's go to any group.
    const home = homeOf(tab.kind);
    if (home === "center" ? !isCenterDock(name) : home !== name) {
      if (reveal) show(tab);
      return tab;
    }
    if (home === "center") name = docks[name] ? name : focusGroup;
    if (tab.dock !== name) {
      // Its group, left empty, goes once the tab is in its new place (not before: the
      // group it goes to could be the one taking the empty one's place).
      const from = tab.dock;
      detach(tab, { fold: false });
      place(tab, name, { reveal, index, exact: true });
      if (isCenterDock(from) && docks[from] && !docks[from].tabs.length) collapse(from);
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
    if (currentTab === tab) setCurrentTab(null);
    detach(tab);
    stopIdlePi(tab);
    tab.onClose?.();
    tab.pane.remove();
    save();
  }

  function show(tab) {
    const dock = docks[tab.dock];
    if (isCenterDock(tab.dock)) focusOn(tab.dock);
    attention(tab, false);
    dock.active = tab;
    if (dock.over) dock.overOpen = true;
    dock.collapsed = false;
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
        const where = e.type === "pointerup" ? dropTarget(e) : null;
        dragging = null;
        if (where?.split) splitWith(tab, where.dock, where.split);
        else if (where) move(tab, where.dock, { index: where.index });
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
    if (!name || !dragging) return null;
    // A side's tab stays in its dock (homeOf); the middle's go to any of its groups.
    if (isCenterDock(dragging.dock) ? !isCenterDock(name) : name !== dragging.dock) return null;
    const dock = docks[name];
    // Over a pane's content, near an edge: a new pane there (the tab must leave a tab behind,
    // or come from another group); elsewhere over it, the end of its tabs.
    if (isCenterDock(name) && event.clientY > $(".dock-head", dock.el).getBoundingClientRect().bottom) {
      const box = $(".panes", dock.el).getBoundingClientRect();
      const fx = (event.clientX - box.left) / box.width, fy = (event.clientY - box.top) / box.height;
      const edge = fx < 0.25 ? "left" : fx > 0.75 ? "right" : fy < 0.3 ? "top" : fy > 0.7 ? "bottom" : null;
      if (edge && (dock.tabs.length > 1 || dragging.dock !== name)) return { dock: name, split: edge, box };
      return { dock: name, index: dock.tabs.length };
    }
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

  const splitHint = el("div", { className: "split-hint", hidden: true });
  document.body.append(splitHint);
  function showDropTarget(target) {
    for (const d of DOCKS) docks[d].el.classList.toggle("drop-over", target?.dock === d && !target.split);
    splitHint.hidden = !target?.split;
    if (target?.split) {
      const { box, split } = target;
      const half = { left: [box.left, box.top, box.width / 2, box.height], right: [box.left + box.width / 2, box.top, box.width / 2, box.height],
        top: [box.left, box.top, box.width, box.height / 2], bottom: [box.left, box.top + box.height / 2, box.width, box.height / 2] }[split];
      Object.assign(splitHint.style, { left: `${half[0]}px`, top: `${half[1]}px`, width: `${half[2]}px`, height: `${half[3]}px` });
      return;
    }
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
  centerEl.addEventListener("pointerdown", () => {
    for (const name of ["left", "right"]) {
      // Closed, as by its button: a wider window does not bring it back.
      if (docks[name].over && docks[name].overOpen) { docks[name].overOpen = false; docks[name].collapsed = true; render(name); save(); }
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
    for (const name of ["left", "center", "right"]) {
      const dock = docks[name];
      // The middle's panes are not kept (its conversations and terminals are not either):
      // its panels come back in one group.
      const own = name === "center" ? centerNames().flatMap((n) => docks[n].tabs) : dock.tabs;
      saved[name] = { tabs: own.filter((t) => KINDS[t.kind].single).map(keyOf), active: dock.active ? keyOf(dock.active) : null, collapsed: dock.collapsed, width: dock.width };
    }
    saved.layout = 8; // what restore() keeps; below, it starts from the default layout
    // Names given by the user, for the tabs that come back at the next connection.
    saved.titles = Object.fromEntries(tabs().filter((t) => t.renamed && KINDS[t.kind].single).map((t) => [keyOf(t), t.title]));
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
    for (const name of DOCKS) {
      const want = saved[name] || defaultLayout()[name];
      const dock = docks[name];
      dock.width = want.width || dock.width;
      for (const key of want.tabs || []) {
        if (KINDS[key]?.single && !find(key)) {
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
    // Terminals are not in any layout: they gather in the middle.
    for (const tab of tabs()) {
      if (KINDS[tab.kind].terminal) move(tab, "center", { reveal: false });
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
    for (const name of centerNames()) if (name !== "center") dropGroup(name);
    tree = { g: "center" };
    focusGroup = "center";
    renderGrid();
    for (const name of DOCKS) Object.assign(docks[name], { tabs: [], active: null });
    renderAll();
  }

  // The New tab page lists the latest conversations: drawn again once they are known.
  vm.on("conversations", () => { if (!docks.center.tabs.length) render("center"); });
  $(".add", docks.center.el).addEventListener("click", (event) => showMenu(event.currentTarget, addChoices("center")));
  docks.center.el.addEventListener("pointerdown", () => focusOn("center"), true);
  // Ctrl+\ splits the pane in focus to the right, Ctrl+Shift+\ downwards, with its tab shown
  // (not inside a terminal: there, Ctrl+\ is the program's).
  document.addEventListener("keydown", (e) => {
    if (!e.ctrlKey || e.altKey || e.code !== "Backslash" || e.target.closest?.(".xterm")) return;
    const tab = docks[focusGroup]?.active;
    if (!tab) return;
    e.preventDefault();
    splitWith(tab, focusGroup, e.shiftKey ? "bottom" : "right");
  });
  // Back to Pier: the tab shown no longer waits for you.
  window.addEventListener("focus", () => { if (currentTab) attention(currentTab, false); });
  $("#toggle-left").addEventListener("click", () => toggle("left"));
  $("#toggle-right").addEventListener("click", () => toggle("right"));
  return { add, move, close, show, find, tabs, restore, arrange, save, clear, docks, toggle, redrawEmpty, attention, splitWith,
    focused: () => focusGroup, retitle: (tab) => render(tab.dock), dockAtPoint: (x, y) => dockAt({ clientX: x, clientY: y }) };
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
  menu.classList.toggle("no-icons", !items.some((item) => item?.[3]?.icon || item?.[3]?.mark));
  for (const item of items) {
    if (!item) { menu.append(el("hr")); continue; }
    // [label, action, disabled, { icon, danger }]: every row keeps the icon's column.
    const [label, action, disabled, { icon, danger, mark } = {}] = item;
    const b = el("button", { className: danger ? "danger" : "" });
    b.append(el("span", { className: "menu-icon" }, ...(mark ? [mark] : icon ? [svgIcon(icon)] : [])), el("span", { textContent: label }));
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
