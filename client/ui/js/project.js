// The Project tab: what Pi reads and changes, the files, the restore points.

// ============================================================================
// Project: what the agent reads and changes, and the files
// ============================================================================

const STATES = {
  modifying: { mark: "✎", label: "Being modified", live: true },
  reading: { mark: "◐", label: "Being read", live: true },
  modified: { mark: "✓", label: "Modified" },
  read: { mark: "●", label: "Read" },
  error: { mark: "!", label: "Failed" },
};

function makeProject(tab) {
  tab.pane.append($("#tpl-project").content.cloneNode(true));
  const error = $(".error", tab.pane);
  const activityView = $(".view-activity", tab.pane);
  const filesView = $(".view-files", tab.pane);
  const tree = $(".tree", tab.pane);
  const showHidden = $(".show-hidden", tab.pane);
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
    whichPi.innerHTML = "";
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
    agent.innerHTML = "";
    if (!activity?.session) { agent.textContent = "no session yet"; return; }
    const dot = el("span", { textContent: activity.working ? "●" : "○" });
    if (activity.working) dot.className = "live-dot";
    agent.append(dot, ` ${activity.working ? "working" : "idle"}`);
    const usage = $(".usage", tab.pane);
    const u = activity.usage;
    usage.hidden = !u;
    if (u) {
      const parts = [`${tokens(u.input)} in`, `${tokens(u.output)} out`];
      if (u.cacheRead) parts.push(`${tokens(u.cacheRead)} cached`);
      parts.push(u.cost ? `$${u.cost.toFixed(u.cost < 1 ? 3 : 2)}` : "cost unknown");
      if (u.model) parts.push(u.model);
      usage.textContent = `session · ${parts.join(" · ")}`;
    }
  }

  function renderActivity() {
    activityView.innerHTML = "";
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
          el("span", { textContent: mark, className: e.state === "running" ? "live-dot" : "" }),
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
    const changed = !f || f.edits > 0 || f.state === "modifying" || f.state === "modified" || f.state === "error";
    li.title = changed ? "Click to see the changes, double-click to mention it in Pi" : "Double-click to mention it in Pi";
    if (changed) {
      li.classList.add("clickable");
      li.addEventListener("click", (e) => { if (e.detail === 1) openDiff(path, base); });
    }
    li.append(
      el("span", { textContent: spec.mark, className: spec.live ? "live-dot" : "" }),
      el("span", { className: "path", textContent: visibleText(path), title: visibleText(path) }),
    );
    if (f) {
      const counts = [f.reads ? `${f.reads} read` : "", f.edits ? `${f.edits} edit${f.edits > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ");
      const git = activity.git[path];
      li.append(el("span", { className: "count", textContent: [counts, git].filter(Boolean).join(" · ") }));
    }
    li.addEventListener("dblclick", () => mention(path));
    return li;
  }

  // --- files view ---

  async function loadTree() {
    tree.innerHTML = "";
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
    list.innerHTML = "";
    for (const entry of listing.entries) {
      if (entry.hidden && !showHidden.checked) continue;
      list.append(node(entry));
    }
    if (listing.truncated) list.append(el("li", { className: "dim small", textContent: "… (list cut short)" }));
    decorateTree();
  }

  function node(entry) {
    const li = el("li");
    li.className = entry.kind === "dir" ? "dir" : "file";
    li.dataset.rel = relative(entry.path);
    const row = el("div");
    row.className = "node" + (entry.hidden ? " hidden-entry" : "");
    row.setAttribute("role", "treeitem");
    const label = (open) => (entry.kind === "dir" ? `${open ? "▾" : "▸"} ${entry.name}/` : `${entry.name}${entry.kind === "link" ? " \u2197\uFE0E" : ""}`);
    const name = el("span", { textContent: label(false) });
    row.append(el("span", { className: "badge" }), el("span", { className: "git" }), name);
    if (entry.kind === "file") row.append(el("span", { className: "size", textContent: humanSize(entry.size) }));
    li.append(row);
    row.addEventListener("click", async () => {
      selected?.classList.remove("selected");
      selected = row;
      row.classList.add("selected");
      if (entry.kind !== "dir") {
        const rel = li.dataset.rel;
        if (activity && (activity.git[rel] || activity.files[rel]?.edits)) openDiff(rel, base);
        return;
      }
      let children = $(":scope > ul", li);
      if (children) {
        children.remove();
        name.textContent = label(false);
      } else {
        children = el("ul");
        li.append(children);
        name.textContent = label(true);
        await fill(children, entry.path);
      }
    });
    row.addEventListener("dblclick", () => { if (entry.kind !== "dir") mention(li.dataset.rel); });
    return li;
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
      badge.className = "badge" + (f && STATES[f.state]?.live ? " live-dot" : "");
      git.textContent = activity.git[rel] || "";
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
      points.innerHTML = "";
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
    points.innerHTML = "";
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
      });
      li.append(head);
      if (openPoint === point.id) li.append(pointBody(point));
      points.append(li);
    }
  }

  function pointBody(point) {
    const body = el("div", { className: "point-body" });
    body.append(el("span", { className: "dim small", textContent: "looking at what changed since…" }));
    backend.api(["checkpoint-diff", base, point.id]).then((diff) => {
      body.innerHTML = "";
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
      body.innerHTML = "";
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

  tab.setMode = (next) => setMode(next); // from the palette
  function setMode(next) {
    mode = next;
    for (const b of tab.pane.querySelectorAll(".mode")) b.classList.toggle("active", b.dataset.mode === mode);
    activityView.hidden = mode !== "activity";
    filesView.hidden = mode !== "files";
    restoreView.hidden = mode !== "restore";
    $(".files-hint", tab.pane).hidden = mode === "restore";
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
    activityView.innerHTML = "";
    tree.innerHTML = "";
    pointsData = null;
    openPoint = null;
    points.innerHTML = "";
    restoreNote.hidden = true;
    renderAgent();
    renderPis();
    follow();
    if (mode === "files") await loadTree();
    if (mode === "restore") loadPoints();
  }

  for (const b of tab.pane.querySelectorAll(".mode")) b.addEventListener("click", () => setMode(b.dataset.mode));
  $(".refresh", tab.pane).addEventListener("click", loadTree);
  showHidden.addEventListener("change", loadTree);
  tab.onTargetChange = retarget;
  tab.onVisible = () => follow();
  tab.onShow = () => { if (stale && vm.latest("activity")) onActivity(vm.latest("activity")); };
  const unlisten = [vm.on("activity", onActivity), vm.on("checkpoints", onPoints)];
  tab.onClose = () => { unlisten.forEach((stop) => stop()); vm.follow({ activity: null, checkpoints: null }); };
  retarget();
}

function tokens(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}
