// The Activity panel: what Pi reads and changes, the files, what it was given, the restore points.

// Project: what the agent reads and changes, and the files

/** The tree's orders (Files, sorted from its bar); folders always come first. */
const fileExt = (name) => (name.includes(".", 1) ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");
const FILE_ORDER = {
  name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  type: (a, b) => fileExt(a.name).localeCompare(fileExt(b.name)) || FILE_ORDER.name(a, b),
  size: (a, b) => (b.size || 0) - (a.size || 0) || FILE_ORDER.name(a, b),
  date: (a, b) => (b.mtime || 0) - (a.mtime || 0) || FILE_ORDER.name(a, b),
};
/** A file's icon by what it holds: text, code, or anything else. */
const fileIcon = (entry) => entry.kind === "dir" ? "folder"
  : /\.(md|txt|rst|adoc)$/i.test(entry.name) || !entry.name.includes(".", 1) ? "file-text"
    : /\.(py|js|mjs|ts|tsx|jsx|rs|go|c|h|cc|cpp|hpp|java|kt|rb|php|sh|bash|zsh|ps1|toml|json|ya?ml|css|scss|html|xml|sql|lua|swift)$/i.test(entry.name) ? "file-code" : "file";

const STATES = {
  modifying: { mark: "✎", label: "Being modified" },
  reading: { mark: "◐", label: "Being read" },
  modified: { mark: "✓", label: "Modified" },
  read: { mark: "●", label: "Read" },
  error: { mark: "!", label: "Failed" },
};

/** git's two-letter status of a file, in words ("?? notes.md": new, not in git). */
function gitWords(code) {
  if (!code) return "";
  const c = code.trim();
  if (c === "??") return "new, not in git";
  if (c === "!!") return "ignored by git";
  const words = { M: "changed", A: "added", D: "deleted", R: "renamed", C: "copied", U: "in conflict", T: "type changed" };
  const [staged, worktree] = [code[0], code[1]];
  const said = [];
  if (staged && staged !== " " && staged !== "?") said.push(`${words[staged] || staged}, staged`);
  if (worktree && worktree !== " " && worktree !== "?") said.push(`${words[worktree] || worktree}`);
  return said.join(", then ") || code;
}

function makeProject(tab) {
  tab.pane.append($("#tpl-project").content.cloneNode(true));
  const error = $(".error", tab.pane);
  const activityView = $(".view-activity", tab.pane);
  const filesView = $(".view-files", tab.pane);
  const tree = $(".tree", tab.pane);
  const showHidden = $(".show-hidden", tab.pane);
  const sortBy = $(".files-sort", tab.pane);
  sortBy.value = FILE_ORDER[prefs.filesSort] ? prefs.filesSort : "name";
  const restoreView = $(".view-restore", tab.pane);
  const points = $(".points", restoreView);
  const restoreNote = $(".restore-note", restoreView);
  const whichPi = $(".which-pi", tab.pane);
  let mode = "activity";
  let activity = null;
  let base = "";
  let selected = null;
  let chosenFile = null; // the conversation shown, when several Pis run here; else the one in use

  const visible = () => !tab.pane.hidden && tab.pane.offsetParent !== null;

  function relative(path) {
    return path.startsWith(base + "/") ? path.slice(base.length + 1) : path;
  }

  async function mention(rel) {
    try {
      const slot = activity?.pis?.find((pi) => pi.file === chosenFile)?.slot || "";
      const result = await backend.api(["type", `@${rel} `, base, slot]);
      showError(error, result.typed ? "" : "Could not type into Pi.");
    } catch (e) {
      showError(error, String(e));
    }
  }

  /** What to follow: this project's activity (of the chosen Pi), and its restore points
   *  while they are shown. */
  function follow() {
    const shown = tab.shown !== false;
    vm.follow({
      activity: base && shown ? { project: base, file: chosenFile } : null,
      checkpoints: base && shown && mode === "restore" ? base : null,
    });
  }

  let stale = false;

  function onActivity(message) {
    if (!vm.current(message)) return;
    if (message.error) { showError(error, message.error); return; }
    showError(error, "");
    activity = message.data;
    if (chosenFile && !activity.pis.some((pi) => pi.file === chosenFile)) {
      chosenFile = null; // that Pi stopped: back to the one used last
      follow();
    }
    if (!visible()) { stale = true; return; }
    stale = false;
    renderPis();
    renderAgent();
    if (mode === "activity") renderActivity();
    else decorateTree();
  }

  /** Several Pis here: a list to choose whose work is shown. */
  function renderPis() {
    const pis = activity?.pis || [];
    whichPi.hidden = pis.length < 2;
    if (pis.length < 2) return;
    whichPi.replaceChildren();
    whichPi.add(new Option("the Pi used last", ""));
    for (const pi of pis) whichPi.add(new Option(`Pi #${pi.n}${pi.working ? " · working" : ""}`, pi.file || ""));
    whichPi.value = chosenFile && pis.some((pi) => pi.file === chosenFile) ? chosenFile : "";
  }

  whichPi.addEventListener("change", () => {
    chosenFile = whichPi.value || null;
    activity = null;
    follow();
  });

  function renderAgent() {
    const agent = $(".agent", tab.pane);
    agent.replaceChildren();
    if (!activity?.session) { agent.textContent = "no session yet"; return; }
    agent.append(el("span", { className: activity.working ? "" : "dim", textContent: activity.working ? "working" : "idle" }));
    const usage = $(".usage", tab.pane);
    const u = activity.usage;
    usage.hidden = !u;
    if (u) {
      const parts = [`${tokens(u.input)} in`, `${tokens(u.output)} out`];
      if (u.cacheRead) parts.push(`${tokens(u.cacheRead)} cached`);
      parts.push(dollars(u.cost) || "cost unknown");
      usage.replaceChildren(`session · ${parts.join(" · ")}`);
      // The model: a click goes where models are chosen.
      if (u.model) usage.append(" · ", linkButton(u.model, "The models of Pi, the orchestrator, workers and helpers: Settings > Agents", () => { openPrefs(); showPrefsPage("agents"); }));
    }
  }

  let drawnActivity = "";
  function renderActivity() {
    // Activity comes every 1.5 s while a Pi works: drawn again only when what it shows
    // changed, and without losing the focus or the scroll.
    const shape = JSON.stringify([activity, base]);
    if (shape === drawnActivity && activityView.childElementCount) return;
    drawnActivity = shape;
    keepPlace(activityView, drawActivity);
  }

  function drawActivity() {
    activityView.replaceChildren();
    if (!activity) return;
    const files = Object.entries(activity.files);
    for (const [state, spec] of Object.entries(STATES)) {
      const items = files.filter(([, f]) => f.state === state).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)));
      if (!items.length) continue;
      activityView.append(group(`${spec.label} (${items.length})`, items.map(([path, f]) => fileRow(path, spec, f))));
    }
    // Changes git sees that did not go through Pi's edit or write tools: made by
    // a bash command, or by you.
    const touched = new Set(files.filter(([, f]) => f.modified || f.edits > 0 || f.state === "modifying" || f.state === "modified").map(([p]) => p));
    const outside = Object.entries(activity.git).filter(([path]) => !touched.has(path));
    if (outside.length) {
      activityView.append(group(`Changed on disk, not by Pi's edit tool (${outside.length})`,
        outside.map(([path, code]) => fileRow(path, { mark: code }, null))));
    }
    if (activity.events.length) {
      activityView.append(group("Recent", activity.events.slice(0, 15).map((e) => {
        const li = el("li");
        const mark = e.state === "running" ? "…" : e.state === "error" ? "!" : "·";
        li.append(
          el("span", { textContent: mark }),
          el("span", { className: "dim", textContent: e.tool }),
          el("span", { className: "path", textContent: e.target }),
        );
        return li;
      })));
    }
    if (!activityView.childElementCount) {
      activityView.append(el("p", { className: "dim", textContent: activity.session ? "Pi has not touched any file yet." : "No Pi session for this project yet." }));
    }
    activityView.append(el("p", {
      className: "hint",
      textContent: "Shown from Pi's own session log: files read or changed by a bash command only appear under \"changed on disk\". What Pi will read next cannot be known in advance.",
    }));
  }

  function group(title, rows) {
    const box = el("div", { className: "group" });
    const list = el("ul");
    list.append(...rows);
    box.append(el("h3", { textContent: title }), list);
    return box;
  }

  function fileRow(path, spec, f) {
    const li = el("li");
    li.dataset.key = path;
    const changed = !f || f.edits > 0 || f.state === "modifying" || f.state === "modified" || f.state === "error";
    li.title = changed ? "Click to see the changes, double-click to mention it in Pi" : "Double-click to mention it in Pi";
    if (changed) {
      li.classList.add("clickable");
      li.addEventListener("click", (e) => { if (e.detail === 1) openDiff(path, base); });
    }
    li.append(
      el("span", { textContent: spec.mark }),
      splitPath(path),
    );
    if (f) {
      const counts = [f.reads ? `${f.reads} read` : "", f.edits ? `${f.edits} edit${f.edits > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ");
      const git = gitWords(activity.git[path]);
      li.append(el("span", { className: "count", textContent: [counts, git].filter(Boolean).join(" · ") }));
    }
    li.addEventListener("dblclick", () => mention(path));
    return pressable(li);
  }

  // --- files view ---

  async function loadTree() {
    tree.replaceChildren();
    if (base) await fill(tree, base);
  }

  async function fill(list, dir) {
    const asked = base;
    let listing;
    try {
      listing = await backend.api(["ls", dir]);
    } catch (e) {
      if (asked === base) showError(error, String(e));
      return;
    }
    if (asked !== base) return; // another project is shown now
    list.replaceChildren();
    const shown = listing.entries.filter((entry) => !entry.hidden || showHidden.getAttribute("aria-pressed") === "true");
    // Folders first, then the order chosen.
    shown.sort((a, b) => (b.kind === "dir") - (a.kind === "dir") || FILE_ORDER[sortBy.value](a, b));
    for (const entry of shown) list.append(node(entry));
    if (listing.truncated) list.append(el("li", { className: "dim small", textContent: "… (list cut short)" }));
    decorateTree();
  }

  /** A row of the tree: an arrow for a folder, its kind, its name, what Pi and git did to
   *  it, and the size or the date when the files are sorted by them. */
  function node(entry) {
    const li = el("li");
    li.className = entry.kind === "dir" ? "dir" : "file";
    li.dataset.rel = relative(entry.path);
    const row = el("div");
    row.className = "node" + (entry.hidden ? " hidden-entry" : "");
    row.setAttribute("role", "treeitem");
    if (entry.kind === "dir") row.setAttribute("aria-expanded", "false");
    const name = el("span", { className: "name", textContent: entry.name + (entry.kind === "link" ? " \u2197\uFE0E" : "") });
    const meta = sortBy.value === "size" && entry.kind === "file" ? humanSize(entry.size)
      : sortBy.value === "date" && entry.mtime ? relTime(entry.mtime).replace(/ ago$/, "") : "";
    row.append(el("span", { className: "fold-arrow" }, ...(entry.kind === "dir" ? [svgIcon("chevron-right")] : [])),
      el("span", { className: "kind" }, svgIcon(fileIcon(entry))), name,
      el("span", { className: "badge" }), el("span", { className: "git" }), el("span", { className: "size", textContent: meta }));
    li.append(pressable(row));
    row.addEventListener("contextmenu", (e) => { e.preventDefault(); nodeMenu(entry, li.dataset.rel, row, { x: e.clientX, y: e.clientY }); });
    row.addEventListener("keydown", (e) => {
      if (e.target !== row) return;
      if (e.key === "F2") { e.preventDefault(); renameEntry(entry, li.dataset.rel, row); return; }
      if (e.key === "Delete") { e.preventDefault(); deleteEntry(entry, li.dataset.rel, li); return; }
      if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
      e.preventDefault();
      const box = row.getBoundingClientRect();
      nodeMenu(entry, li.dataset.rel, row, { x: box.left + 24, y: box.bottom });
    });
    row.addEventListener("click", async () => {
      selected?.classList.remove("selected");
      selected = row;
      row.classList.add("selected");
      if (entry.kind !== "dir") {
        const rel = li.dataset.rel;
        // A file Pi or git changed: its changes (the file itself is a link away); any
        // other: the file.
        if (activity && (activity.git[rel] || activity.files[rel]?.edits)) openDiff(rel, base);
        else openFile(rel, base);
        return;
      }
      let children = $(":scope > ul", li);
      if (children) {
        children.remove();
        row.setAttribute("aria-expanded", "false");
      } else {
        children = el("ul");
        li.append(children);
        row.setAttribute("aria-expanded", "true");
        await fill(children, entry.path);
      }
    });
    row.addEventListener("dblclick", () => { if (entry.kind !== "dir") mention(li.dataset.rel); });
    return li;
  }

  /** A right click on a file or a folder: what Pier can do with it from here. */
  function nodeMenu(entry, rel, row, at) {
    const copy = (text) => backend.copyText(text).then(() => flashStatus("copied")).catch((e) => showError(error, String(e)));
    const items = [];
    if (entry.kind === "dir") items.push([row.getAttribute("aria-expanded") === "true" ? "Fold" : "Open", () => row.click(), false, { icon: "folder" }]);
    else {
      if (activity && (activity.git[rel] || activity.files[rel]?.edits)) items.push(["Open its changes", () => openDiff(rel, base), false, { icon: "git-compare" }]);
      items.push(["Open in a tab", () => openFile(rel, base), false, { icon: "external-link" }], [`Mention it to Pi (@${rel})`, () => mention(rel), false, { icon: "at-sign" }]);
    }
    items.push(null, ["Copy its path", () => copy(entry.path), false, { icon: "copy" }], ["Copy its path in the project", () => copy(rel), false, { icon: "copy" }]);
    // New things go in the folder clicked, or beside the file clicked.
    const li = row.parentElement;
    const where = entry.kind === "dir" ? { li, rel } : { li: li.parentElement.closest("li.dir"), rel: rel.split("/").slice(0, -1).join("/") };
    items.push(null,
      ["New file here", () => newEntry("file", where), false, { icon: "file-plus" }],
      ["New folder here", () => newEntry("dir", where), false, { icon: "folder-plus" }],
      null,
      ["Rename", () => renameEntry(entry, rel, row), false, { icon: "pencil" }],
      ...(entry.kind === "file" ? [["Duplicate", () => change(["fs-copy", base, rel], li.parentElement, parentOf(entry.path)), false, { icon: "copy-plus" }]] : []),
      ["Delete…", () => deleteEntry(entry, rel, li), false, { icon: "trash", danger: true }]);
    showMenu(null, items, at);
  }

  const parentOf = (path) => path.slice(0, path.lastIndexOf("/")) || base;
  /** A change through the picker, then the folder it touched listed again. */
  async function change(args, list, dir) {
    try {
      await backend.api(args);
      showError(error, "");
    } catch (e) { showError(error, String(e)); return false; }
    await fill(list, dir);
    return true;
  }

  /** A name typed in the tree, in the row of a new entry or of the one renamed: Enter
   *  does it, Escape leaves it; what the picker refuses ("already exists") shows in the row. */
  function nameField(row, { value = "", kind, done, cancel }) {
    const input = el("input", { value, spellcheck: false });
    input.setAttribute("aria-label", kind === "dir" ? "Folder name" : "File name");
    input.placeholder = kind === "dir" ? "Folder name" : "File name";
    const hint = el("span", { className: "name-hint", textContent: "Enter to save" });
    hint.id = `name-hint-${Date.now()}`;
    input.setAttribute("aria-describedby", hint.id);
    $(".name", row).replaceWith(input);
    row.append(hint);
    row.classList.add("naming");
    let busy = false;
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", async (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
      if (e.key !== "Enter" || busy || !input.value.trim()) return;
      e.preventDefault();
      busy = true;
      const problem = await done(input.value.trim());
      busy = false;
      if (problem) { hint.textContent = problem; hint.classList.add("bad"); input.setAttribute("aria-invalid", "true"); }
    });
    input.addEventListener("input", () => { hint.textContent = "Enter to save"; hint.classList.remove("bad"); input.removeAttribute("aria-invalid"); });
    input.focus();
    // A file's name chosen up to its extension, as in every file manager.
    const dot = kind === "file" ? value.lastIndexOf(".") : -1;
    input.setSelectionRange(0, dot > 0 ? dot : value.length);
    return input;
  }

  /** A new file or folder: a row at the top of its folder (opened first) to name it. */
  async function newEntry(kind, where = { li: null, rel: "" }) {
    const dir = where.rel ? `${base}/${where.rel}` : base;
    let list = tree;
    if (where.li) {
      list = $(":scope > ul", where.li);
      if (!list) { // the folder opened first, listed before the new row goes on top
        list = el("ul");
        where.li.append(list);
        $(":scope > .node", where.li).setAttribute("aria-expanded", "true");
        await fill(list, dir);
      }
    }
    const li = el("li", { className: kind === "dir" ? "dir" : "file" });
    const row = el("div", { className: "node" },
      el("span", { className: "fold-arrow" }, ...(kind === "dir" ? [svgIcon("chevron-right")] : [])),
      el("span", { className: "kind" }, svgIcon(kind === "dir" ? "folder" : "file")), el("span", { className: "name" }));
    li.append(row);
    list.prepend(li);
    nameField(row, { kind,
      cancel: () => li.remove(),
      done: async (name) => {
        const rel = where.rel ? `${where.rel}/${name}` : name;
        try { await backend.api(["fs-new", base, rel, kind]); } catch (e) { return String(e); }
        await fill(list, dir);
        $(`:scope > li[data-rel="${CSS.escape(rel)}"] > .node`, list)?.focus();
        return null;
      } });
  }

  function renameEntry(entry, rel, row) {
    const list = row.parentElement.parentElement;
    const back = () => fill(list, parentOf(entry.path));
    nameField(row, { kind: entry.kind, value: entry.name,
      cancel: back,
      done: async (name) => {
        if (name === entry.name) { back(); return null; }
        try { await backend.api(["fs-rename", base, rel, name]); } catch (e) { return String(e); }
        await back();
        const moved = rel.split("/").slice(0, -1).concat(name).join("/");
        $(`:scope > li[data-rel="${CSS.escape(moved)}"] > .node`, list)?.focus();
        return null;
      } });
  }

  async function deleteEntry(entry, rel, li) {
    const what = entry.kind === "dir" ? `the folder "${rel}" and all it holds` : `"${rel}"`;
    if (!(await ask(`Delete ${what} for good? It goes from the VM, not to a bin; a restore point taken before has it.`))) return;
    await change(["fs-delete", base, rel], li.parentElement, parentOf(entry.path));
  }

  /** Marks files the agent touched, and folders that contain any. */
  function decorateTree() {
    if (!activity) return;
    const touchedDirs = new Set();
    for (const path of [...Object.keys(activity.files), ...Object.keys(activity.git)]) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) touchedDirs.add(parts.slice(0, i).join("/"));
    }
    for (const li of tree.querySelectorAll("li[data-rel]")) {
      const rel = li.dataset.rel;
      const f = activity.files[rel];
      const badge = $(":scope > .node > .badge", li);
      const git = $(":scope > .node > .git", li);
      badge.textContent = f ? (STATES[f.state]?.mark ?? "?") : li.classList.contains("dir") && touchedDirs.has(rel) ? "•" : "";
      badge.className = "badge";
      git.textContent = activity.git[rel] || "";
      git.title = gitWords(activity.git[rel]);
    }
  }

  // --- restore points ---

  const POINT_MARKS = { start: "\u25B6\uFE0E", prompt: "›", idle: "■", manual: "★", "before-restore": "↺" };
  const CHANGE_MARKS = { created: ["+", "created since: going back removes it"], modified: ["~", "changed since"], deleted: ["−", "deleted since: going back brings it back"] };
  let pointsData = null;
  let openPoint = null;

  /** What the last action did, or why it failed: it stays until the next action
   *  (the panel's own error line is cleared by every refresh). */
  function note(text, failed = false) {
    restoreNote.textContent = text;
    restoreNote.hidden = !text;
    restoreNote.classList.toggle("error", failed);
    restoreNote.classList.toggle("notice", !failed);
    if (failed) uiLog("warn", "shown-error", { where: "project.restore", msg: text });
  }

  function pointTitle(point) {
    if (point.reason === "prompt") return `before “${point.label}”`;
    return point.label || { start: "Pi started", idle: "Pi finished working" }[point.reason] || point.reason;
  }

  function pointWhen(point) {
    const at = new Date(point.at * 1000);
    const today = at.toDateString() === new Date().toDateString();
    return today ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : at.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  /** The refresh link: asked now, not waiting for the watch. */
  async function loadPoints() {
    if (!base) {
      points.replaceChildren();
      return;
    }
    const asked = base;
    try {
      const answer = await backend.api(["checkpoints", asked]);
      if (asked === base) showPoints(answer);
    } catch (e) {
      if (asked === base) note(String(e), true);
    }
  }

  function onPoints(message) {
    if (!vm.current(message)) return;
    if (message.error) { note(message.error, true); return; }
    if (openPoint) return; // the list follows once the open point is closed
    showPoints(message.data);
  }

  function showPoints(data) {
    pointsData = data;
    const notes = [];
    if (!pointsData.git) notes.push("git is missing on the VM, and restore points need it: sudo apt install git.");
    else if (!pointsData.enabled) notes.push("Restore points are turned off on the VM (checkpoints = false in ~/.config/pier-picker/config.toml).");
    if (notes.length) note(notes.join(" "));
    renderPoints();
  }

  function renderPoints() {
    points.replaceChildren();
    const list = pointsData?.points || [];
    if (!list.length) {
      points.append(el("li", { className: "dim", textContent: "No restore point yet: one is saved when Pi starts here." }));
      return;
    }
    for (const point of list) {
      const li = el("li");
      const head = el("div", { className: "point-head", title: point.prompts.length > 1 ? `Also before:\n${point.prompts.slice(1).join("\n")}` : "Click to see what changed since" });
      head.append(
        el("span", { className: "mark", textContent: POINT_MARKS[point.reason] || "·" }),
        el("span", { className: "when", textContent: pointWhen(point) }),
        el("span", { className: "what", textContent: pointTitle(point) }),
      );
      if (point.prompts.length > 1) head.append(el("span", { className: "more", textContent: `+${point.prompts.length - 1} earlier` }));
      head.addEventListener("click", () => {
        openPoint = openPoint === point.id ? null : point.id;
        renderPoints();
        // Back on the same point, by keyboard as by mouse.
        [...points.querySelectorAll(".point-head")].find((h) => h.dataset.key === point.id)?.focus({ preventScroll: true });
      });
      head.dataset.key = point.id;
      pressable(head);
      li.append(head);
      if (openPoint === point.id) li.append(pointBody(point));
      points.append(li);
    }
  }

  function pointBody(point) {
    const body = el("div", { className: "point-body" });
    body.append(el("span", { className: "dim small", textContent: "looking at what changed since…" }));
    backend.api(["checkpoint-diff", base, point.id]).then((diff) => {
      body.replaceChildren();
      if (!diff.changes.length) {
        body.append(el("span", { className: "dim small", textContent: "Nothing changed since: the project is as it was then." }));
        return;
      }
      const list = el("ul", { className: "changes" });
      for (const change of diff.changes) {
        const [mark, title] = CHANGE_MARKS[change.change] || ["?", String(change.change)];
        const row = el("li");
        row.title = title;
        const actions = el("span", { className: "row-actions" });
        if (change.change !== "created") {
          const see = el("button", { className: "link", textContent: "diff" });
          see.addEventListener("click", () => openDiff(change.path, base, { id: point.id, when: pointWhen(point) }));
          actions.append(see);
        }
        const undo = el("button", { className: "link", textContent: change.change === "created" ? "remove" : "put back" });
        undo.addEventListener("click", () => restore(point, [change.path]));
        actions.append(undo);
        row.append(
          el("span", { className: "kind", textContent: mark }),
          el("span", { className: "path", textContent: change.path }),
          actions,
        );
        list.append(row);
      }
      const total = diff.total > diff.changes.length ? ` (the first ${diff.changes.length} of ${diff.total})` : "";
      const all = el("button", { textContent: `Go back to ${pointWhen(point)}` });
      all.addEventListener("click", () => restore(point, []));
      body.append(el("span", { className: "dim small", textContent: `${diff.total} file${diff.total > 1 ? "s" : ""} differ from then${total}:` }), list, all);
    }).catch((e) => {
      body.replaceChildren();
      body.append(el("span", { className: "error", textContent: String(e) }));
      uiLog("warn", "shown-error", { where: "project.restore", msg: String(e) });
    });
    return body;
  }

  async function restore(point, files) {
    const what = files.length === 1 ? files[0] : "the project";
    const question = files.length
      ? `Put ${what} back as it was at ${pointWhen(point)} (${pointTitle(point)})?`
      : `Put the whole project back as it was at ${pointWhen(point)} (${pointTitle(point)})? Files created since are removed.`;
    const project = base; // the project asked about, even if the panel follows another meanwhile
    if (!(await ask(`${question}\n\nWhat is there now is saved first, as a restore point: this can be undone.`))) return;
    uiLog("info", "restore", { project, point: point.id, files: files.length || "all" });
    try {
      const result = await backend.checkpointRestore(project, point.id, files);
      note(`Done: ${result.restored} file${result.restored === 1 ? "" : "s"} put back, ${result.removed} removed. Pi does not know: tell it what you undid.`);
      openPoint = null;
      await loadPoints();
      vm.poke();
      for (const t of workspace.tabs()) if (t.kind === "diff" && t.params.project === base) t.reload?.();
    } catch (e) {
      note(String(e), true);
    }
  }

  $(".save-point", restoreView).addEventListener("click", async (e) => {
    if (!base) return;
    e.target.disabled = true;
    try {
      const name = $(".point-name", restoreView);
      const made = await backend.checkpointCreate(base, name.value.trim());
      name.value = "";
      note(made.skipped?.length ? `Saved, without ${made.skipped.length} file(s) over 50 MB.` : "Saved.");
      await loadPoints();
    } catch (err) {
      note(String(err), true);
    } finally {
      e.target.disabled = false;
    }
  });
  $(".refresh-points", restoreView).addEventListener("click", loadPoints);

  // Given to Pi (what was handed to Pi: images, files, folders, shares) is a view of
  // Activity, built as its own panel was (context.js) inside it.
  const givenView = $(".view-given", tab.pane);
  const given = { kind: "context", pane: givenView };
  makeContext(given);
  tab.given = given;
  tab.showGiven = () => { workspace.show(tab); setMode("given"); };

  // Undo last prompt: back to the point saved as the latest prompt arrived.
  const undo = $(".undo-prompt", tab.pane);
  undo.addEventListener("click", async () => {
    if (!base) return;
    try {
      const answer = pointsData?.points?.length ? pointsData : await backend.api(["checkpoints", base]);
      const point = (answer.points || []).find((p) => p.reason === "prompt");
      if (!point) { note("No prompt to undo yet: a point is saved as each prompt arrives."); return; }
      await restore(point, []);
    } catch (e) { note(String(e), true); }
  });

  tab.setMode = (next) => setMode(next); // from the palette
  function setMode(next) {
    mode = next;
    for (const b of tab.pane.querySelectorAll(".mode")) b.classList.toggle("active", b.dataset.mode === mode);
    activityView.hidden = mode !== "activity";
    filesView.hidden = mode !== "files";
    restoreView.hidden = mode !== "restore";
    givenView.hidden = mode !== "given";
    given.onVisible?.(mode === "given" && tab.shown !== false);
    if (mode === "given") given.onShow?.();
    $(".files-hint", tab.pane).hidden = mode === "restore" || mode === "given";
    if (mode === "files" && !tree.childElementCount) loadTree();
    if (mode === "restore") loadPoints();
    follow();
    if (activity) { renderAgent(); if (mode === "activity") renderActivity(); else decorateTree(); }
  }

  async function retarget() {
    base = target?.path || "";
    chosenFile = null;
    $(".root", tab.pane).textContent = target ? target.label : "no Pi running: start one from the picker";
    activity = null;
    activityView.replaceChildren();
    tree.replaceChildren();
    pointsData = null;
    openPoint = null;
    points.replaceChildren();
    restoreNote.hidden = true;
    renderAgent();
    renderPis();
    follow();
    if (mode === "files") await loadTree();
    if (mode === "restore") loadPoints();
  }

  for (const b of tab.pane.querySelectorAll(".mode")) b.addEventListener("click", () => setMode(b.dataset.mode));
  $(".refresh", tab.pane).addEventListener("click", loadTree);
  $(".new-file", tab.pane).addEventListener("click", () => base && newEntry("file"));
  $(".new-folder", tab.pane).addEventListener("click", () => base && newEntry("dir"));
  showHidden.addEventListener("click", () => {
    const on = showHidden.getAttribute("aria-pressed") !== "true";
    showHidden.setAttribute("aria-pressed", String(on));
    showHidden.title = on ? "Hide hidden files" : "Show hidden files";
    showHidden.setAttribute("aria-label", showHidden.title);
    $("use", showHidden).setAttribute("href", on ? "#i-eye" : "#i-eye-off");
    loadTree();
  });
  sortBy.addEventListener("change", () => { prefs.filesSort = sortBy.value; savePrefs(); loadTree(); });
  tab.onTargetChange = () => { retarget(); given.onTargetChange?.(); };
  tab.onVisible = (shown) => { follow(); given.onVisible?.(shown !== false && mode === "given"); };
  tab.onShow = () => {
    if (stale && vm.latest("activity")) onActivity(vm.latest("activity"));
    if (mode === "given") given.onShow?.();
  };
  const unlisten = [vm.on("activity", onActivity), vm.on("checkpoints", onPoints)];
  tab.onClose = () => { unlisten.forEach((stop) => stop()); given.onClose?.(); vm.follow({ activity: null, checkpoints: null }); };
  retarget();
}

function tokens(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}
