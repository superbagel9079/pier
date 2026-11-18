// Conversations: every conversation of every project, grouped by project, with the Pis
// running them; pinned first, categories as folders, searchable, archived out of the way.

/** A conversation's title: the name given in Pier, else in Pi, else its first question. */
const conversationTitle = (s) => s?.title || s?.name || s?.prompt || "(a conversation not started yet)";

/** Facts under a title, " · " between them: a line breaks after a dot, never inside a
 *  fact ("801k tokens" stays whole) nor before its dot (no "·" alone on a line). */
const factLine = (parts) => parts.filter(Boolean).map((t) => String(t).replace(/ /g, "\u00a0")).join("\u00a0· ");

function relTime(secs) {
  const d = Date.now() / 1000 - secs;
  return d < 90 ? "just now" : d < 3600 ? `${Math.round(d / 60)} min ago` : d < 86400 ? `${Math.round(d / 3600)} h ago` : `${Math.round(d / 86400)} d ago`;
}

/** Whether a conversation matches a search (lowercase text): title, question, Pi's
 *  name, category. */
function conversationMatches(s, query) {
  return !query || [conversationTitle(s), s.prompt, s.name, s.category].some((t) => t && t.toLowerCase().includes(query));
}

/** The menu of a conversation (⋯, a right click): the row's own actions first, then name
 *  and category, pin, archive, give, delete. */
function conversationMenu(anchor, project, session, { edit, changed, failed, move, renameCategory, removeCategory }, first = [], at = null) {
  const mark = async (what, on) => {
    try {
      await backend.sessionMark(project, session.path, what, on);
      session[what] = on;
      if (what === "archived" && on) session.pinned = false;
      uiLog("info", "session-mark", { what, on });
      changed();
    } catch (e) { failed(String(e)); }
  };
  showMenu(anchor, [
    ...first, ...(first.length ? [null] : []),
    ["Rename…", edit, false, { icon: "pencil" }],
    // Its category: moved to one (or a new one, typed), and the category itself.
    ["Move to a category…", move, false, { icon: "folder" }],
    ...(session.category ? [
      [`Rename the category "${session.category}"…`, renameCategory, false, { icon: "folder-cog" }],
      [`Delete the category "${session.category}" (its conversations stay)`, removeCategory, false, { icon: "x" }],
    ] : []),
    null,
    [session.pinned ? "Unpin" : "Pin to the top", () => mark("pinned", !session.pinned), session.archived, { icon: "pin" }],
    [session.archived ? "Bring back from the archive" : "Archive (hide, keep searchable)", () => mark("archived", !session.archived), false,
      { icon: session.archived ? "archive-restore" : "archive" }],
    ["Give to a colleague…", () => giveDialog(project, session), false, { icon: "send" }],
    null,
    // Disabled while a Pi runs it: the picker refuses, Pi would write it again.
    ["Delete…", () => deleteConversation(project, session, { changed, failed }), false, { icon: "trash", danger: true }],
  ], at);
}

/** A row of the list: its mark, its title, a detail on the right, all one button that does
 *  the row's main thing (none for a row that only informs); its other actions under ⋯,
 *  shown under the pointer, and on a right click or the menu key. */
function conversationRow({ key, className = "", mark = null, title, fresh = false, meta = "", tip = "", run = null, menu = null, more: dots = false }) {
  const main = el(run ? "button" : "div", { className: "row-main", title: tip });
  main.append(el("span", { className: "mark" }, ...(mark ? [mark] : [])),
    el("span", { className: fresh ? "title fresh" : "title", textContent: title }),
    el("span", { className: "row-meta" }, ...(meta ? [meta] : [])));
  if (run) main.addEventListener("click", run);
  const li = keyed(key, el("li", { className }, main));
  if (menu && dots) {
    const more = el("button", { className: "row-more", title: "More" });
    more.setAttribute("aria-label", `More: ${title}`);
    more.setAttribute("aria-haspopup", "menu");
    more.append(svgIcon("ellipsis"));
    more.addEventListener("click", () => menu(more, null, li));
    li.append(more);
  }
  if (menu) {
    li.addEventListener("contextmenu", (e) => { e.preventDefault(); menu(null, { x: e.clientX, y: e.clientY }, li); });
    main.addEventListener("keydown", (e) => {
      if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
      e.preventDefault();
      const box = main.getBoundingClientRect();
      menu(null, { x: box.left + 24, y: box.bottom }, li);
    });
  }
  return li;
}

/** A project's mark: a square of its colour with its first letter, an icon or a picture,
 *  chosen per viewer (kept with the folded projects). */
const PROJECT_COLORS = ["#5b62b8", "#2f7aa8", "#2e7d5b", "#7a5ab0", "#2c7d7d", "#a0612a", "#a8414f", "#6b6b6b"];
const PROJECT_GLYPHS = ["folder", "terminal", "code", "file-code", "message-square", "git-branch", "flask-conical", "globe", "server", "database",
  "cloud", "cpu", "box", "layers", "network", "shield", "bot", "brain", "sparkles", "zap", "rocket", "puzzle", "wrench", "book-open",
  "graduation-cap", "briefcase", "house", "smartphone", "gamepad-2", "music", "camera", "image", "palette", "heart", "star", "leaf", "coffee"];
const projectLetter = (path) => (String(path).split("/").filter(Boolean).pop() || "?").charAt(0).toUpperCase();
function defaultColor(path) {
  let n = 0;
  for (const c of String(path)) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return PROJECT_COLORS[n % PROJECT_COLORS.length];
}
function projectBadge(path, look = {}) {
  const badge = el("span", { className: "pbadge" });
  badge.setAttribute("aria-hidden", "true");
  if (look.image) badge.style.background = `center / cover no-repeat url(${JSON.stringify(look.image)})`;
  else {
    badge.style.background = look.color || defaultColor(path);
    badge.append(look.glyph ? svgIcon(look.glyph) : projectLetter(path));
  }
  return badge;
}

/** Any picture as a 64 × 64 square, cut to its centre: sharp at 16 px on any screen, small to keep. */
const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/gif"];
async function squarePicture(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const side = Math.min(img.naturalWidth, img.naturalHeight) || 64;
    const canvas = el("canvas", { width: 64, height: 64 });
    canvas.getContext("2d").drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 64, 64);
    return canvas.toDataURL("image/png");
  } finally { URL.revokeObjectURL(url); }
}

/** Change a project's mark: its colour, a letter or an icon, or a picture from this PC. */
function projectLookDialog(project, label, look, save, live = null) {
  const next = { ...look };
  const preview = el("span", { className: "look-preview" });
  const draw = () => { preview.replaceChildren(projectBadge(project, next), el("span", { textContent: label })); live?.(next); };
  const choice = (node, name, pressed, pick) => {
    const b = el("button", { className: "look-choice" });
    b.setAttribute("aria-label", name);
    b.title = name;
    b.setAttribute("aria-pressed", String(pressed));
    b.append(node);
    b.addEventListener("click", () => {
      pick();
      b.parentElement.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      draw();
    });
    return b;
  };
  const colors = el("div", { className: "look-row" }, ...PROJECT_COLORS.map((c) => {
    const swatch = el("span", { className: "look-swatch" });
    swatch.style.background = c;
    return choice(swatch, `Colour ${c}`, (next.color || defaultColor(project)) === c, () => { next.color = c; });
  }));
  const glyphs = el("div", { className: "look-row" }, choice(document.createTextNode(projectLetter(project)), "First letter", !next.glyph && !next.image, () => { next.glyph = null; next.image = null; }),
    ...PROJECT_GLYPHS.map((g) => choice(svgIcon(g), `Icon: ${g}`, next.glyph === g && !next.image, () => { next.glyph = g; next.image = null; })));
  const note = el("p", { className: "hint", textContent: "A square picture, 64 × 64 px or larger: PNG, JPG, WebP, SVG or GIF, up to 1 MB. Another shape is cut to its centre." });
  const file = el("input", { type: "file", accept: PICTURE_TYPES.join(","), hidden: true });
  const fail = (text) => { note.textContent = text; note.classList.add("error"); };
  file.addEventListener("change", async () => {
    const f = file.files[0];
    if (!f) return;
    if (!PICTURE_TYPES.includes(f.type)) return fail("Not a picture Pier shows: PNG, JPG, WebP, SVG or GIF.");
    if (f.size > 1048576) return fail(`Too big: ${(f.size / 1048576).toFixed(1)} MB, 1 MB at most.`);
    try { next.image = await squarePicture(f); draw(); } catch { fail("This picture could not be read. A PNG or a JPG?"); }
  });
  const pick = el("button", { className: "secondary", textContent: "Choose a picture…" });
  pick.addEventListener("click", () => file.click());
  const drop = el("button", { className: "link", textContent: "no picture" });
  drop.addEventListener("click", () => { next.image = null; draw(); });
  const ok = el("button", { textContent: "Save" });
  const dialog = resourceDialog("Project mark", [preview, el("h3", { textContent: "Colour" }), colors, el("h3", { textContent: "Letter or icon" }), glyphs,
    el("h3", { textContent: "Or a picture" }), el("div", { className: "actions" }, pick, drop, file), note], [ok]);
  let saved = false;
  dialog.onClose = () => { if (!saved) live?.(look); };
  ok.addEventListener("click", () => { saved = true; save(next); dialog.close(); });
  draw();
}

/** Deletes a conversation for good, once the user said so. */
/** A conversation's tab closed: its Pi stopped if it only waits for you (its conversation
 *  stays saved, to continue); one still working goes on, as do an orchestrator, a worker and
 *  a Pi consulting helpers. The conversation view knows itself whether Pi works. */
function stopIdlePi(tab) {
  if (tab.kind !== "chat" && tab.kind !== "pi") return;
  const slot = tab.slot || (tab.params?.args?.[0] === "--slot" ? tab.params.args[1] : null);
  if (!slot || tab.working || tab.keepPi) return;
  for (const p of vm.latest("conversations")?.data?.projects || []) {
    const pi = (p.pis || []).find((x) => x.slot === slot);
    if (!pi) continue;
    if (pi.working || pi.role === "orchestrator" || pi.role === "worker" || pi.helpers?.length) return;
    backend.stopPi(p.project, slot).then(() => vm.forget({ slot })).catch(() => {});
    uiLog("info", "stop-pi", { project: p.project, slot, why: "tab closed, idle" });
    return;
  }
}

async function deleteConversation(project, session, { changed, failed }) {
  const running = session.slot ? " Its Pi is stopped first, and its tab closed." : "";
  if (!(await ask(`Delete "${conversationTitle(session)}" for good? The whole conversation is erased from the VM; it cannot be undone. (Archive only hides it.)${running}`))) return;
  try {
    if (session.slot) {
      // Its tab closed; its Pi is stopped by the picker, which waits for it to end before
      // erasing the file (it would write it again).
      for (const t of workspace.tabs()) if (t.slot === session.slot || t.params?.args?.[1] === session.slot) { t.keepPi = true; workspace.close(t); }
    }
    await backend.sessionDelete(project, session.path);
    vm.forget({ path: session.path, slot: session.slot });
    session.deleted = true;
    uiLog("info", "session-delete", {});
    flashStatus("Conversation deleted");
    changed();
  } catch (e) { failed(String(e)); flashStatus(`Not deleted: ${e}`); }
}

/** In place of a row: a conversation's name and category, kept by Pier. */
function conversationEditor(at, project, session, categories, { done, failed }) {
  const name = el("input", { value: session.title || "", placeholder: session.name || session.prompt || "a name", spellcheck: false });
  // The category: a list like every other in Pier (the categories already used), and
  // "New category…" to type one.
  const NEW = "__new__";
  const picker = el("select", { title: "Category" });
  picker.add(new Option("no category", ""));
  for (const c of categories) picker.add(new Option(c, c));
  if (session.category && !categories.includes(session.category)) picker.add(new Option(session.category, session.category));
  picker.add(new Option("New category…", NEW));
  picker.value = session.category || "";
  const fresh = el("input", { placeholder: "new category", spellcheck: false, hidden: true });
  picker.addEventListener("change", () => {
    fresh.hidden = picker.value !== NEW;
    if (!fresh.hidden) fresh.focus();
  });
  const category = { get value() { return picker.value === NEW ? fresh.value : picker.value; } };
  const options = el("span", {}, picker, fresh);
  const save = async () => {
    try {
      await backend.sessionLabel(project, session.path, name.value, category.value);
    } catch (e) {
      failed(String(e)); // the editor stays, with what was typed
      return;
    }
    session.title = name.value.trim() || null;
    session.category = category.value.trim() || null;
    uiLog("info", "session-label", { category: session.category || "" });
    done();
  };
  for (const input of [name, picker, fresh]) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); save(); }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); done(); }
    });
  }
  const form = el("li", { className: "label-editor" }, name, options,
    el("span", { className: "row-actions" }, linkButton("save", "", save), linkButton("cancel", "", done)));
  at.replaceWith(form);
  name.focus();
}

/** Tokens of a conversation's usage (cache included, as Pi counts them). */
const usageTokens = (u) => (u ? (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) : 0);
const shortNumber = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
/** What a conversation cost: in dollars when the model has a price in Pi, else tokens. */
const spentText = (cost, count) => dollars(cost) || (count ? `${shortNumber(count)} tok` : "");

/** A project's use today and over 7 days, from its conversations' usage per day (UTC,
 *  as Pi stamps it). */
function projectTotals(sessions) {
  const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
  const today = day(0);
  const week = new Set(Array.from({ length: 7 }, (_, i) => day(i)));
  const sum = { today: [0, 0], week: [0, 0] };
  for (const s of sessions) {
    for (const [d, [count, cost]] of Object.entries(s.usage?.days || {})) {
      if (d === today) { sum.today[0] += count; sum.today[1] += cost; }
      if (week.has(d)) { sum.week[0] += count; sum.week[1] += cost; }
    }
  }
  if (!sum.week[0]) return "";
  const text = ([count, cost]) => [dollars(cost), count ? `${shortNumber(count)} tok` : ""].filter(Boolean).join(", ") || "nothing";
  return factLine([`today ${text(sum.today)}`, `7 d ${text(sum.week)}`]);
}

/** The Conversations tab: where the work is. Every project with its Pis and its
 *  conversations, the project of the Pi in use first and open. Per project: a new Pi,
 *  the last conversation again, its totals, its setup. Per conversation: open or
 *  continue, ⋯ (name, category, pin, archive). Searchable across all projects. */
function makeConversations(tab) {
  tab.pane.append($("#tpl-conversations").content.cloneNode(true));
  const $$ = (sel) => $(sel, tab.pane);
  const list = $$(".all-conversations");
  const error = $$(".error");
  const STORE = "devbox.conversations.v1"; // per viewer: which projects are folded or opened
  let view = { folded: {}, expanded: {}, openFolders: {}, looks: {} };
  try { view = { ...view, ...JSON.parse(localStorage.getItem(STORE)) }; } catch { /* defaults */ }
  view.openFolders ||= {};
  view.looks ||= {};
  const keep = () => { try { localStorage.setItem(STORE, JSON.stringify(view)); } catch { /* storage off */ } };
  let data = null;
  let query = "";
  let archived = false;
  let editing = false;
  let openConv = {}; // the conversation of the tab shown in the middle: its row is marked
  let categories = [];
  const PER_PROJECT = 3; // calm (the proposals' 2A): three a project, the rest behind "more"
  // A narrow window: the project whose square in the rail was clicked, alone in the list.
  let only = null;
  const alone = () => (workspace.docks.left.over ? only : null);

  /** The rail's squares (shown in a narrow window only): the project in view marked, how
   *  many of its Pis wait for you on it. */
  function drawRail(projects, inUse) {
    $("#rail-projects").replaceChildren(...projects.filter((p) => (p.pis || []).length || p.sessions.some((s) => !s.archived)).map((p) => {
      const waiting = (p.pis || []).filter((pi) => !pi.working && !pi.reported && pi.file).length; // a Pi with nothing said yet waits for no one
      const on = p.project === (alone() || inUse);
      const b = el("button", { className: "rail-btn rail-proj" + (on ? " on" : ""), type: "button", title: p.label },
        projectBadge(p.project, view.looks[p.project]), waiting ? el("span", { className: "badge", textContent: String(waiting) }) : null);
      b.setAttribute("aria-label", `${p.label}${waiting ? `, ${waiting} waiting for you` : ""}`);
      b.setAttribute("aria-current", String(on));
      b.addEventListener("click", () => {
        const left = workspace.docks.left;
        const open = left.overOpen;
        if (open && only === p.project) { workspace.toggle("left"); return; } // its square again: closed
        only = p.project;
        if (open) render();
        else { workspace.show(tab); render(); }
        list.scrollTop = 0;
      });
      return b;
    }));
  }
  /** The rail's speech bubble: every project again. */
  tab.showAll = () => { only = null; render(); };
  // A mark changed elsewhere (Settings > Projects): read again, drawn again.
  tab.reloadLooks = () => { try { view.looks = JSON.parse(localStorage.getItem(STORE))?.looks || view.looks; } catch { /* kept */ } redraw(); };
  tab.filtered = () => Boolean(alone());

  async function stop(project, pi) {
    const what = pi ? `Pi #${pi.n}` : "its Pis";
    if (!(await ask(`Stop ${what} in ${project.label}? What it is doing now is lost; its conversation stays saved, to continue later.`))) return;
    try {
      await backend.stopPi(project.project, pi?.slot || null);
      uiLog("info", "stop-pi", { project: project.project, slot: pi?.slot || "all" });
      if (pi?.slot) vm.forget({ slot: pi.slot }); else vm.poke();
    } catch (e) { showError(error, String(e)); }
  }

  /** A conversation's menu, with the row's own actions (`first`) on top. */
  const menuOf = (p, s, first = []) => (anchor, at, li) => conversationMenu(anchor, p.project, s, {
    edit: () => {
      editing = true;
      conversationEditor(li, p.project, s, categories, {
        done: () => { editing = false; redraw(); vm.poke(); },
        failed: (e) => showError(error, e),
      });
    },
    changed: () => { render(); vm.poke(); },
    failed: (e) => showError(error, e),
    // The palette of categories (ui.js): one of the project's, none, or a new one typed.
    move: () => pickPalette(li, {
      items: [{ value: "", label: "No category" }, ...categories.map((c) => ({ value: c, label: c }))],
      current: s.category || "", placeholder: "Search, or type a new category",
      custom: (text) => text,
      onPick: async (value) => {
        try { await backend.sessionLabel(p.project, s.path, s.title || "", value); } catch (e) { showError(error, String(e)); return; }
        s.category = value || null;
        flashStatus(value ? `Moved to ${value}` : "Out of its category");
        redraw();
        vm.poke();
      },
    }),
    renameCategory: () => renameCategoryDialog(p, s.category),
    removeCategory: () => removeFolder(p, s.category),
  }, first, at);

  /** A category renamed from a conversation's menu: a small dialog (the folder's own row
   *  is renamed in place). */
  function renameCategoryDialog(p, old) {
    const name = el("input", { value: old, spellcheck: false, id: "category-name" });
    const problem = dialogError();
    const save = el("button", { type: "button", textContent: "Rename" });
    const dialog = resourceDialog("Rename the category", [
      el("div", { className: "give-field" }, el("label", { htmlFor: "category-name", textContent: "Name" }), name), problem], [save]);
    const go = async () => {
      const value = name.value.trim();
      if (!value || value === old) { dialog.close(); return; }
      try { await backend.categoryRename(p.project, old, value); } catch (e) { showError(problem, String(e)); return; }
      for (const s of p.sessions) if (s.category === old) s.category = value;
      dialog.close();
      redraw();
      vm.poke();
    };
    save.addEventListener("click", go);
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    name.select();
  }
  const ago = (secs) => relTime(secs).replace(/ ago$/, "");

  const facts = (s) => {
    const u = s.usage;
    return [relTime(s.modified), u ? `${u.turns} msg` : "", u ? spentText(u.cost, usageTokens(u)) : "", s.category, s.archived ? "archived" : ""];
  };

  /** Who a running Pi is: "Pi #2", an orchestrator, or a worker of one, on its task. */
  const piRole = (pi) => pi.role === "orchestrator" ? `Pi #${pi.n}, orchestrator,`
    : pi.role === "worker" ? `Pi #${pi.n}, worker of #${pi.orchestrator}${pi.task ? ` on "${pi.task}"` : ""},` : `Pi #${pi.n}`;

  /** A read-only helper a Pi consults now (consult): under its Pi while it runs; its
   *  conversation goes to the sub-agents folder once it is done. */
  function helperRow(pi, h, i) {
    const since = Math.max(0, Math.round(Date.now() / 1000 - (h.since || 0)));
    return conversationRow({ key: `helper:${pi.slot}:${i}`, className: "running working helper in-team", mark: svgIcon("search"),
      title: `${h.role} · ${h.title}`, meta: since < 60 ? `${since} s` : `${Math.round(since / 60)} min`,
      tip: `A read-only helper of Pi #${pi.n}: it reads the project and answers its Pi` });
  }

  /** A pinned conversation's row: a pin after its title. */
  const pinned = (li, s) => { if (s?.pinned) $(".title", li)?.after(el("span", { className: "pin-mark", title: "Pinned to the top" }, svgIcon("pin"))); return li; };

  // A reply not read yet: the conversation moved since you last had it open (each one's
  // time then kept here; those older than the first look count as read).
  view.seen ||= {};
  view.seenFrom ||= Math.floor(Date.now() / 1000);
  const unread = (s) => Boolean(s) && openConv.file !== s.path && s.modified > (view.seen[s.path] ?? view.seenFrom) + 1;
  const sideNote = (text, dot) => el("span", { className: "side-note" }, el("span", { textContent: text }), dot ? el("i", { className: "unread-dot", title: "A reply you have not read" }) : null);
  const ring = () => el("i", { className: "work-ring", title: "Working" });

  /** A running Pi: its conversation (or a new one, nothing said yet), open and stop. */
  /** A running Pi with its conversation (or a new one, nothing said yet): a click opens its
   *  terminal. Its mark says what it does: working, waiting for you, or done (reported). */
  function piRow(p, pi, s) {
    const state = pi.working ? "working" : pi.reported ? "reported" : "waiting";
    // Its state as a mark, not in words (the proposals' 2A): a ring while it works, a dot
    // when it waits for you; its age, under the pointer.
    const meta = state === "reported" && s ? ago(s.modified) : "";
    const open = () => openPiTerminal(p.project, p.label, ["--slot", pi.slot], pi.n);
    // Its own screen in tmux, or Pier's conversation view (a Pi in RPC mode).
    const openWords = prefs.piTerminal || !/-r\d+$/.test(pi.slot || "") ? ["Open its terminal", "terminal"] : ["Open this conversation", "message-square"];
    const shown = workspace.tabs().some((t) => t.slot === pi.slot || t.params?.args?.[1] === pi.slot);
    const own = [[openWords[0], open, false, { icon: openWords[1] }],
      ...(state === "working" || !shown ? [["Stop this Pi (its conversation stays saved)", () => stop(p, pi), false, { icon: "square" }]] : [])];
    return pinned(conversationRow({ key: `pi:${pi.slot}`, className: `running ${state}${s?.archived ? " archived" : ""}${openConv.slot === pi.slot ? " current" : ""}`,
      title: s ? conversationTitle(s) : "New conversation", fresh: !s,
      meta: state === "working" ? ring() : unread(s) ? sideNote(ago(s.modified), true) : meta,
      tip: factLine([`${piRole(pi)} ${state}`, ...(s ? facts(s) : ["nothing said yet"])]) + (s?.prompt ? `\n${s.prompt}` : ""),
      run: open, menu: s ? menuOf(p, s, own) : (anchor, at) => showMenu(anchor, own, at) }), s);
  }

  /** A conversation no Pi runs: a click starts a Pi on it. Pinned ones carry a pin. */
  function row(p, s, inFolder = false) {
    const resume = () => openPiTerminal(p.project, p.label, ["--session", s.path]);
    const stopped = s.path === p.interrupted; // Pi stopped mid-work (the VM restarted?)
    return pinned(conversationRow({ key: s.path, className: [s.archived ? "archived" : "", inFolder ? "in-folder" : "", openConv.file === s.path ? "current" : ""].filter(Boolean).join(" "),
      title: conversationTitle(s), meta: stopped ? sideNote("stopped", true) : unread(s) ? sideNote(ago(s.modified), true) : "",
      // In its folder, its category goes without saying.
      tip: factLine(facts(s).filter((f) => !inFolder || f !== s.category)) + (s.prompt ? `\n${s.prompt}` : ""),
      run: resume, menu: menuOf(p, s, [["Continue: start a Pi on it", resume, false, { icon: "play" }]]) }), s);
  }

  /** A folder: a category of the project (or its sub-agents), with how many it holds;
   *  ⋯ renames or deletes the category (its conversations stay). */
  function folderHead(p, folder, open, key) {
    const toggle = () => {
      if (view.openFolders[key]) delete view.openFolders[key]; else view.openFolders[key] = true;
      keep();
      render();
    };
    const li = conversationRow({ key: `folder:${key}`, className: "folder-head" + (folder.subagents ? " subagents" : ""),
      mark: svgIcon("folder"), title: folder.name, meta: String(folder.sessions.length),
      tip: folder.subagents ? "Conversations of sub-agents (the helpers an orchestrator or a worker consults, pi-multiagent's agent_team): a Pi's work, not yours" : "",
      run: toggle, menu: folder.subagents ? null : (anchor, at, row) => showMenu(anchor, [
        ["Rename…", () => renameFolder(row, p, folder.name, key), false, { icon: "pencil" }],
        ["Delete the category (its conversations stay)", () => removeFolder(p, folder.name), false, { icon: "trash", danger: true }],
      ], at) });
    const main = $(".row-main", li);
    main.setAttribute("aria-expanded", String(open));
    main.prepend(el("span", { className: "fold-arrow" }, svgIcon("chevron-right")));
    return li;
  }

  /** In place of a folder's head: its new name. */
  function renameFolder(at, p, old, key) {
    editing = true;
    const name = el("input", { value: old, placeholder: "category", spellcheck: false });
    const done = () => { editing = false; redraw(); };
    const save = async () => {
      const value = name.value.trim();
      if (!value || value === old) { done(); return; }
      try {
        await backend.categoryRename(p.project, old, value);
      } catch (e) { showError(error, String(e)); return; }
      for (const s of p.sessions) if (s.category === old) s.category = value;
      if (view.openFolders[key]) {
        delete view.openFolders[key];
        view.openFolders[`${p.project}|${value}`] = true;
        keep();
      }
      uiLog("info", "category-rename", {});
      done();
      vm.poke();
    };
    name.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); save(); }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); done(); }
    });
    at.replaceWith(el("li", { className: "label-editor" }, name,
      el("span", { className: "row-actions" }, linkButton("save", "", save), linkButton("cancel", "", done))));
    name.focus();
    name.select();
  }

  /** Deletes a category: its conversations stay, out of any folder. */
  async function removeFolder(p, name) {
    const count = p.sessions.filter((s) => s.category === name).length;
    if (!(await ask(`Delete the category "${name}"? Its ${count} conversation${count === 1 ? "" : "s"} stay, out of any folder.`))) return;
    try {
      await backend.categoryRename(p.project, name, "");
    } catch (e) { showError(error, String(e)); return; }
    for (const s of p.sessions) if (s.category === name) s.category = null;
    uiLog("info", "category-delete", {});
    redraw();
    vm.poke();
  }

  /** A project: its arrow, its mark, its name (its facts on hover); + starts a new Pi in it,
   *  ⋯ and a right click hold the rest. */
  function head(p, folded, inUse) {
    const pis = p.pis || [];
    const fresh = () => openPiTerminal(p.project, p.label, ["--new"]);
    const items = [
      ["New conversation (a new Pi)", fresh, false, { icon: "plus" }],
      ["Continue the last conversation", () => openPiTerminal(p.project, p.label, ["--continue"]), !p.sessions.length, { icon: "history" }],
      ["New orchestrator (it splits the work between worker Pis)", () => openPiTerminal(p.project, p.label, ["--orchestrator"]), false, { icon: "network" }],
      null,
      ["Instructions and what Pi loads here", () => openProjectSettings(p.project), false, { icon: "folder-cog" }],
      ["Change its mark…", () => projectLookDialog(p.project, p.label, view.looks[p.project] || {}, (look) => { view.looks[p.project] = look; keep(); redraw(); }), false, { icon: "palette" }],
      ["Copy its path", () => backend.copyText(p.project).then(() => flashStatus("path copied")).catch((e) => showError(error, String(e))), false, { icon: "copy" }],
      ...(pis.length ? [null, [`Stop its Pis (${pis.length})`, () => stop(p, null), false, { icon: "square" }]] : []),
    ];
    // Counted as listed: the archived ones (unless shown), the helpers' and the Pis with
    // nothing said yet are not in the list, so not in its number either.
    const listed = p.sessions.filter((s) => !s.subagent && !s.deleted && (archived || !s.archived));
    const hiddenArchived = archived ? 0 : p.sessions.filter((s) => !s.subagent && !s.deleted && s.archived).length;
    const running = pis.filter((pi) => pi.role || p.sessions.some((s) => s.slot === pi.slot)).length;
    const li = conversationRow({ key: `project:${p.project}`, className: "project-head" + (folded ? " folded" : "") + (inUse ? " in-use" : ""),
      mark: projectBadge(p.project, view.looks[p.project]), title: p.label, meta: folded ? String(listed.length) : "",
      tip: [p.project, factLine([running ? `${running} running` : "", `${listed.length} conversation${listed.length === 1 ? "" : "s"}`,
        hiddenArchived ? `${hiddenArchived} archived` : ""]), projectTotals(p.sessions),
        inUse ? "the project of the Pi in use" : ""].filter(Boolean).join("\n"),
      run: () => { view.folded[p.project] = !folded; keep(); render(); },
      menu: (anchor, at) => showMenu(anchor, items, at), more: true });
    const main = $(".row-main", li);
    main.setAttribute("aria-expanded", String(!folded));
    main.prepend(el("span", { className: "fold-arrow" }, svgIcon("chevron-right")));
    const plus = el("button", { className: "row-more row-add", title: "New conversation here (a new Pi)" });
    plus.setAttribute("aria-label", `New conversation in ${p.label}`);
    plus.append(svgIcon("plus"));
    plus.addEventListener("click", fresh);
    $(".row-more", li).before(plus);
    return li;
  }

  let drawn = "";  // what the list shows, as text: drawn again only when it changes
  /** Drawn again even if the data did not change: an editor put in place of a row (its
   *  name, a folder's) goes, whether something was saved or not. */
  function redraw() {
    drawn = "";
    render();
  }
  function render() {
    if (!data || editing) return;
    openConv = shownConversation();
    const shape = JSON.stringify([data, query, archived, view, target?.path || null, openConv, alone()]);
    if (shape === drawn) return; // the same as on screen: nothing to redraw (every 5 s while a Pi works)
    drawn = shape;
    keepPlace(list, draw);
  }

  function draw() {
    const all = data.projects.flatMap((x) => x.sessions);
    const open = openConv.file && all.find((s) => s.path === openConv.file);
    if (open && view.seen[open.path] !== open.modified) { view.seen[open.path] = open.modified; keep(); }
    categories = [...new Set(all.map((x) => x.category).filter(Boolean))].sort();
    list.replaceChildren();
    let shown = 0;
    // The project of the Pi in use first.
    const inUse = target?.path;
    const projects = [...data.projects].sort((a, b) => (b.project === inUse) - (a.project === inUse));
    drawRail(projects, inUse);
    for (const [index, p] of projects.entries()) {
      if (alone() && p.project !== alone()) continue;
      const matches = p.sessions.filter((s) => (archived || !s.archived || query) && conversationMatches(s, query));
      const pis = p.pis || [];
      if (query && !matches.length) continue;
      if (!query && !matches.length && !pis.length) continue;
      // Folded by default past the first three (the most recent), open when asked.
      // Open by default for the project in use and the first three; a fold chosen is kept.
      const folded = !query && !alone() && (view.folded[p.project] ?? (index >= 3 && p.project !== inUse));
      list.append(head(p, folded, p.project === inUse));
      if (folded) continue;
      // Running Pis first, each with its conversation, an orchestrator's workers right
      // under it; then pinned, then the latest.
      const held = new Set(matches.filter((s) => s.slot).map((s) => s.slot));
      // Forks (1B): under the conversation they came from, folded in it ("2 forks"); open
      // by a click, or by themselves when one of them works or is open.
      const byPath = new Set(p.sessions.map((s) => s.path));
      const isFork = (s) => !query && s?.parent && byPath.has(s.parent) && s.parent !== s.path;
      const forksOf = (path) => matches.filter((x) => isFork(x) && x.parent === path);
      view.forksOpen ||= {};
      const withForks = (li, s) => {
        const kids = s ? forksOf(s.path) : [];
        if (!kids.length) return;
        const live = kids.some((k) => k.slot || openConv.file === k.path);
        // Your fold or unfold wins; until you choose, open while one of them works or is open.
        const opened = view.forksOpen[s.path] ?? live;
        const toggle = el("button", { type: "button", className: "forks-toggle", title: opened ? "Fold its forks" : "Show its forks" },
          el("span", { textContent: `${kids.length} fork${kids.length === 1 ? "" : "s"}` }), svgIcon(opened ? "chevron-down" : "chevron-right"));
        toggle.addEventListener("click", (e) => { e.stopPropagation(); view.forksOpen[s.path] = !opened; keep(); render(); });
        $(".row-main", li).after(toggle);
        li.classList.add("has-forks");
        if (!opened) return;
        for (const k of kids) {
          const pi = k.slot && pis.find((x) => x.slot === k.slot);
          const kid = pi ? piRow(p, pi, k) : row(p, k);
          kid.classList.add("fork-child");
          $(".title", kid)?.before(svgIcon("git-branch"));
          list.append(kid);
          withForks(kid, k);
        }
      };
      const idle = matches.filter((s) => !s.slot && !s.deleted && !isFork(s));
      // Pinned: on top of the project, above the Pis at work.
      const pinnedIdle = idle.filter((s) => s.pinned && !s.category && !s.subagent);
      for (const s of pinnedIdle) {
        const li = row(p, s);
        list.append(li);
        withForks(li, s);
        shown += 1;
      }
      const fresh = (pi) => !p.sessions.some((s) => s.slot === pi.slot);
      const isPinned = (x) => Boolean(matches.find((s) => s.slot && s.slot === x.slot)?.pinned);
      const ordered = [...pis.filter((pi) => fresh(pi) && pi.role !== "worker"),
        ...matches.filter((s) => s.slot && !isFork(s)).map((s) => pis.find((x) => x.slot === s.slot) || s).filter((x) => query || x.role !== "worker")]
        .sort((a, b) => isPinned(b) - isPinned(a));
      // A search lists what matches, flat; otherwise each worker follows its orchestrator.
      const workersOf = (pi) => query ? [] : pis.filter((w) => w.role === "worker" && w.orchestrator === pi.n);
      const orphans = query ? [] : pis.filter((w) => w.role === "worker" && !pis.some((o) => o.role === "orchestrator" && o.n === w.orchestrator));
      for (const item of [...ordered, ...orphans]) {
        for (const pi of item.slot && pis.includes(item) ? [item, ...(item.role === "orchestrator" ? workersOf(item) : [])] : [item]) {
          const s = matches.find((x) => x.slot === pi.slot);
          if (!pis.includes(pi)) { list.append(row(p, pi)); shown += 1; continue; } // a session whose Pi just went
          // A Pi with nothing said yet is not a conversation: listed once you wrote in it (an
          // orchestrator or a worker starting shows, its team follows it).
          if (!s && (query || !pi.role || !fresh(pi))) continue;
          const li = piRow(p, pi, s || null);
          if (pi.role === "worker" && item !== pi) li.classList.add("in-team");
          list.append(li);
          withForks(li, s);
          if (!query && view.helpers) (pi.helpers || []).forEach((h, i) => list.append(helperRow(pi, h, i)));
          if (s) shown += 1;
        }
      }
      const first = (s) => s.path === p.interrupted || s.pinned;
      const pinnedFirst = (xs) => [...xs.filter(first), ...xs.filter((s) => !first(s))];
      // Outside any folder: the latest few, the rest behind "show all".
      const rest = pinnedFirst(idle.filter((s) => !s.category && !s.subagent && !s.pinned));
      const room = Math.max(0, PER_PROJECT - held.size - pinnedIdle.length);
      const visible = query || view.expanded[p.project] ? rest : rest.slice(0, room);
      for (const s of visible) {
        const li = row(p, s);
        list.append(li);
        withForks(li, s);
        shown += 1;
      }
      const tools = el("li", { className: "small more" });
      if (visible.length < rest.length) {
        tools.append(linkButton(`${rest.length - visible.length} more`, "", () => { view.expanded[p.project] = true; keep(); render(); }));
      } else if (view.expanded[p.project] && !query && rest.length > room) {
        tools.append(linkButton("Show fewer", "", () => { delete view.expanded[p.project]; keep(); render(); }));
      }
      if (tools.children.length) list.append(tools);
      // Each category, a folder (folded until opened); the sub-agents of pi-multiagent in
      // one of their own, last.
      const named = [...new Set(idle.filter((s) => s.category && !s.subagent).map((s) => s.category))].sort((a, b) => a.localeCompare(b));
      const folders = named.map((name) => ({ name, sessions: pinnedFirst(idle.filter((s) => s.category === name && !s.subagent)) }));
      const subagents = idle.filter((s) => s.subagent);
      if (subagents.length && view.helpers) folders.push({ name: "sub-agents", subagents: true, sessions: subagents });
      for (const folder of folders) {
        const key = `${p.project}|${folder.subagents ? "\u0000sub-agents" : folder.name}`;
        const open = Boolean(query) || Boolean(view.openFolders[key]);
        list.append(folderHead(p, folder, open, key));
        if (!open) continue;
        for (const s of folder.sessions) {
          list.append(row(p, s, true));
          shown += 1;
        }
      }
    }
    if (query && !shown) list.append(el("li", { className: "dim small", textContent: "No conversation matches." }));
    if (!data.projects.length) {
      const start = el("button", { className: "secondary", textContent: "Start a project…", title: "A folder of the VM, or a new one: Pi starts in it" });
      start.addEventListener("click", () => openFolderPicker());
      const ready = el("button", { className: "link", textContent: "Is the VM ready?", title: "What Pier needs on the VM, and what is missing" });
      ready.addEventListener("click", () => openVmReady());
      list.append(el("li", { className: "dim small", textContent: "No conversation yet. Choose a folder and Pi starts there (in the picker: the arrows, then p)." }),
        el("li", { className: "toolbar" }, start, ready));
    }
    const count = all.length;
    // How many, in the search field; said aloud only when the list is cut short.
    $$(".conversation-filter").placeholder = `Search ${count} conversation${count === 1 ? "" : "s"} in ${data.projects.length} project${data.projects.length === 1 ? "" : "s"}`;
    $$(".count").hidden = !data.truncated;
    $$(".count").textContent = data.truncated ? "Only the latest 2000 conversations are listed." : "";
  }

  /** From elsewhere (Setup): this project open and in view. */
  tab.focusProject = (path) => {
    delete view.folded[path];
    keep();
    workspace.show(tab);
    render();
    list.querySelector(`[data-key="${CSS.escape(`project:${path}`)}"]`)?.scrollIntoView({ block: "start" });
  };
  tab.onTargetChange = () => render();

  // Redrawn once typing pauses: with every conversation of every project, at each key
  // it rebuilt thousands of rows.
  let filterTimer = null;
  $$(".conversation-filter").addEventListener("input", (event) => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => { query = event.target.value.trim().toLowerCase(); render(); }, 150);
  });
  // Display: the search field, the archived ones, the helpers (and their sub-agents).
  const searching = (on) => {
    const bar = $$(".toolbar");
    bar.hidden = !on;
    if (on) $$(".conversation-filter").focus();
    else if (query) { $$(".conversation-filter").value = ""; query = ""; render(); }
  };
  $$(".new-btn").addEventListener("click", () => openFolderPicker());
  $$(".display-btn").addEventListener("click", (event) => showMenu(event.currentTarget, [
    [$$(".toolbar").hidden ? "Search" : "Close the search", () => searching($$(".toolbar").hidden), false, { icon: "search" }],
    null,
    ["Show archived", () => { archived = !archived; render(); }, false, { icon: archived ? "check" : null }],
    ["Show helpers", () => { view.helpers = !view.helpers; keep(); redraw(); }, false, { icon: view.helpers ? "check" : null }],
  ]));
  $$(".conversation-filter").addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); searching(false); } });

  const unlisten = vm.on("conversations", (message) => {
    if (message.error) { showError(error, message.error); return; }
    showError(error, "");
    data = message.data;
    render();
  });
  // Followed while the rail's squares show too (a narrow window), the list closed or not.
  // Followed also while the rail's squares show (a narrow window) or the New tab lists the
  // recent ones (nothing open in the middle), the list itself hidden or not.
  tab.onVisible = (on) => { vm.follow({ conversations: on || Boolean(workspace.docks.left.over) || prefs.railAlways !== false || (online && !workspace.docks.center.tabs.length) }); render(); };
  tab.onShownTab = render; // the open conversation's row is marked
  tab.onClose = () => { unlisten(); vm.follow({ conversations: false }); };
  vm.follow({ conversations: tab.shown !== false });
}

// The rail's pen: a new conversation in the project of the Pi in use, else the last one.
$("#rail-new").addEventListener("click", () => {
  if (!online) return; // greyed: nothing to start before connecting
  const project = target?.path || lastProjects?.recent?.[0]?.path || lastProjects?.running?.[0]?.path;
  if (project) openPiTerminal(project, projectLabel(project), ["--new"]);
  else openFolderPicker();
});

// The rail's speech bubble: Conversations shown, opened on the left if it was closed.
$("#btn-conversations").addEventListener("click", () => {
  const tab = workspace.find("conversations");
  // Shown with every project: the bubble folds them (it is the rail's fold button).
  if (tab && $("#workspace").classList.contains("left-open") && !tab.filtered?.()) { workspace.toggle("left"); return; }
  tab?.showAll?.(); // narrow: every project, not only the one whose square was clicked
  if (tab) workspace.show(tab); // shows its side too, if it was hidden
  else workspace.add("conversations", "left");
});
