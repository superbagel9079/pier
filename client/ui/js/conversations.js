// Conversations: every conversation of every project, grouped by project, with the Pis
// running them; pinned ones first, then each category as a folder, searchable, archived
// ones out of the way. The one place for conversations (Setup is a project's
// configuration).

/** A conversation's title: the name given in Pier, else in Pi, else its first question. */
const conversationTitle = (s) => s?.title || s?.name || s?.prompt || "(a conversation not started yet)";

/** Facts under a title, " · " between them: a line breaks between two facts, never
 *  inside one ("801k tokens" stays whole). */
const factLine = (parts) => parts.filter(Boolean).map((t) => String(t).replace(/ /g, "\u00a0")).join(" · ");

function relTime(secs) {
  const d = Date.now() / 1000 - secs;
  return d < 90 ? "just now" : d < 3600 ? `${Math.round(d / 60)} min ago` : d < 86400 ? `${Math.round(d / 3600)} h ago` : `${Math.round(d / 86400)} d ago`;
}

/** Whether a conversation matches a search (lowercase text): title, question, Pi's
 *  name, category. */
function conversationMatches(s, query) {
  return !query || [conversationTitle(s), s.prompt, s.name, s.category].some((t) => t && t.toLowerCase().includes(query));
}

/** The ⋯ menu of a conversation: name and category, pin, archive, delete. */
function conversationMenu(anchor, project, session, { edit, changed, failed }) {
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
    ["Name and category…", edit],
    [session.pinned ? "Unpin" : "Pin to the top", () => mark("pinned", !session.pinned), session.archived],
    [session.archived ? "Bring back from the archive" : "Archive (hide, keep searchable)", () => mark("archived", !session.archived)],
    ["Give to a colleague…", () => giveDialog(project, session)],
    null,
    // Disabled while a Pi runs it: the picker refuses, Pi would write it again.
    ["Delete…", () => deleteConversation(project, session, { changed, failed }), Boolean(session.slot)],
  ]);
}

/** Deletes a conversation for good, once the user said so. */
async function deleteConversation(project, session, { changed, failed }) {
  if (!(await ask(`Delete "${conversationTitle(session)}" for good? The whole conversation is erased from the VM; it cannot be undone. (Archive only hides it.)`))) return;
  try {
    await backend.sessionDelete(project, session.path);
    session.deleted = true;
    uiLog("info", "session-delete", {});
    flashStatus("Conversation deleted");
    changed();
  } catch (e) { failed(String(e)); }
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
  let view = { folded: {}, expanded: {}, openFolders: {} };
  try { view = { ...view, ...JSON.parse(localStorage.getItem(STORE)) }; } catch { /* defaults */ }
  view.openFolders ||= {};
  const keep = () => { try { localStorage.setItem(STORE, JSON.stringify(view)); } catch { /* storage off */ } };
  let data = null;
  let query = "";
  let archived = false;
  let editing = false;
  let categories = [];
  const PER_PROJECT = 5;

  async function stop(project, pi) {
    const what = pi ? `Pi #${pi.n}` : "its Pis";
    if (!(await ask(`Stop ${what} in ${project.label}? What it is doing now is lost; its conversation stays saved, to continue later.`))) return;
    try {
      await backend.stopPi(project.project, pi?.slot || null);
      uiLog("info", "stop-pi", { project: project.project, slot: pi?.slot || "all" });
      vm.poke();
    } catch (e) { showError(error, String(e)); }
  }

  function more(p, s) {
    return linkButton("⋯", "Name, category, pin, archive", (event) => {
      const at = event.currentTarget.closest("li");
      conversationMenu(event.currentTarget, p.project, s, {
        edit: () => {
          editing = true;
          conversationEditor(at, p.project, s, categories, {
            done: () => { editing = false; redraw(); vm.poke(); },
            failed: (e) => showError(error, e),
          });
        },
        changed: () => { render(); vm.poke(); },
        failed: (e) => showError(error, e),
      });
    });
  }

  const facts = (s) => {
    const u = s.usage;
    return [relTime(s.modified), u ? `${u.turns} msg` : "", u ? spentText(u.cost, usageTokens(u)) : "", s.category, s.archived ? "archived" : ""];
  };

  /** Who a running Pi is: "Pi #2", an orchestrator, or a worker of one, on its task. */
  const piRole = (pi) => pi.role === "orchestrator" ? `Pi #${pi.n}, orchestrator,`
    : pi.role === "worker" ? `Pi #${pi.n}, worker of #${pi.orchestrator}${pi.task ? ` on "${pi.task}"` : ""},` : `Pi #${pi.n}`;

  /** A running Pi: its conversation (or a new one, nothing said yet), open and stop. */
  function piRow(p, pi, s) {
    // Its bar on the left says it runs: bright and breathing while Pi works, grey
    // while it waits. The column of the mark stays, as on the other rows (pinned: ★).
    return keyed(`pi:${pi.slot}`, el("li", { className: pi.working ? "running working" : "running" },
      el("span", { className: "dim", textContent: s?.pinned ? "★" : " " }),
      el("div", { className: "meta" },
        el("span", { className: s ? "title" : "title fresh", textContent: s ? conversationTitle(s) : "New conversation", title: s?.prompt || "Pi writes it at its first answer" }),
        el("span", { className: "dim small facts", textContent: factLine([`${piRole(pi)} ${pi.working ? "working" : pi.reported ? "reported" : "waiting"}`, ...(s ? facts(s) : ["nothing said yet"])]) })),
      el("span", { className: "row-actions" },
        linkButton("open", "Open its terminal", () => openPiTerminal(p.project, p.label, ["--slot", pi.slot], pi.n)),
        linkButton("stop", "Stop this Pi; its conversation stays saved", () => stop(p, pi)),
        s ? more(p, s) : null)));
  }

  function row(p, s, inFolder = false) {
    return keyed(s.path, el("li", { className: [s.archived ? "archived" : "", inFolder ? "in-folder" : ""].filter(Boolean).join(" ") },
      el("span", { className: "dim", textContent: s.pinned ? "★" : " " }),
      el("div", { className: "meta" },
        el("span", { className: "title", textContent: conversationTitle(s), title: s.prompt || "" }),
        // In its folder, its category goes without saying.
        el("span", { className: "dim small facts", textContent: factLine(facts(s).filter((f) => !inFolder || f !== s.category)) })),
      el("span", { className: "row-actions" },
        linkButton("continue", "Start a Pi on this conversation", () => openPiTerminal(p.project, p.label, ["--session", s.path])),
        more(p, s))));
  }

  /** A folder: a category of the project (or its sub-agents), with how many it holds;
   *  ⋯ renames or deletes the category (its conversations stay). */
  function folderHead(p, folder, open, key) {
    const count = folder.sessions.length;
    const li = el("li", { className: "folder-head" + (folder.subagents ? " subagents" : "") },
      el("button", { className: "fold", textContent: open ? "▾" : "▸", title: open ? "Fold" : "Show its conversations" }),
      el("div", { className: "meta" },
        el("span", { className: "title folder-name", textContent: folder.name,
          title: folder.subagents ? "Conversations of sub-agents (the helpers an orchestrator or a worker consults, pi-multiagent's agent_team): a Pi's work, not yours" : "" }),
        el("span", { className: "dim small facts", textContent: `${count} conv.` })),
      el("span", { className: "row-actions" },
        folder.subagents ? null : linkButton("⋯", "Rename or delete this category", (event) => {
          showMenu(event.currentTarget, [
            ["Rename…", () => renameFolder(li, p, folder.name, key)],
            ["Delete the category (its conversations stay)", () => removeFolder(p, folder.name)],
          ]);
        })));
    const toggle = () => {
      if (view.openFolders[key]) delete view.openFolders[key]; else view.openFolders[key] = true;
      keep();
      render();
    };
    li.querySelector(".fold").addEventListener("click", toggle);
    li.querySelector(".folder-name").addEventListener("click", toggle);
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

  function head(p, folded, inUse) {
    const pis = p.pis || [];
    const li = el("li", { className: "project-head" + (folded ? " folded" : "") + (inUse ? " in-use" : "") },
      el("button", { className: "fold", textContent: folded ? "▸" : "▾", title: folded ? "Show its conversations" : "Fold" }),
      el("div", { className: "meta" },
        el("span", { className: "ellipsis project-name", textContent: p.label, title: p.project }),
        el("span", { className: "dim small facts", textContent: factLine([
          pis.length ? `${pis.length} running` : "",
          `${p.sessions.length} conv.`,
        ]), title: inUse ? "The project of the Pi in use" : "" }),
        projectTotals(p.sessions) ? el("span", { className: "dim small facts", textContent: projectTotals(p.sessions), title: "Tokens (or dollars, when the model has a price in Pi) today and over 7 days" }) : null),
      el("span", { className: "row-actions" },
        linkButton("new", "A new Pi in this project, in a new conversation", () => openPiTerminal(p.project, p.label, pis.length ? ["--new"] : [])),
        p.sessions.length ? linkButton("last", "Continue the last conversation", () => openPiTerminal(p.project, p.label, ["--continue"])) : null,
        linkButton("orchestrate", "A new orchestrator Pi: it splits the work and starts worker Pis, each in a git worktree of its own, once you approve its workers; it and its workers may consult read-only helpers (scout, reviewer, critic, checker)", () => openPiTerminal(p.project, p.label, ["--orchestrator"])),
        linkButton("setup", "Instructions and what Pi loads in this project", () => workspace.find("setup")?.openProject?.(p.project))));
    li.querySelector(".fold").addEventListener("click", () => {
      view.folded[p.project] = !folded;
      keep();
      render();
    });
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
    const shape = JSON.stringify([data, query, archived, view, target?.path || null]);
    if (shape === drawn) return; // the same as on screen: nothing to redraw (every 5 s while a Pi works)
    drawn = shape;
    keepPlace(list, draw);
  }

  function draw() {
    const all = data.projects.flatMap((x) => x.sessions);
    categories = [...new Set(all.map((x) => x.category).filter(Boolean))].sort();
    list.replaceChildren();
    let shown = 0;
    // The project of the Pi in use first.
    const inUse = target?.path;
    const projects = [...data.projects].sort((a, b) => (b.project === inUse) - (a.project === inUse));
    for (const [index, p] of projects.entries()) {
      const matches = p.sessions.filter((s) => (archived || !s.archived || query || s.slot) && conversationMatches(s, query));
      const pis = p.pis || [];
      if (query && !matches.length) continue;
      if (!query && !matches.length && !pis.length) continue;
      // Folded by default past the first three (the most recent), open when asked.
      const folded = !query && (view.folded[p.project] ?? index >= 3) && p.project !== inUse;
      list.append(head(p, folded, p.project === inUse));
      if (folded) continue;
      if (p.interrupted && !query) {
        list.append(el("li", { className: "interrupted small" },
          el("span", { textContent: "Pi stopped in the middle of its work (the VM restarted?): its conversation is saved." }),
          linkButton("continue where it stopped", "", () => openPiTerminal(p.project, p.label, ["--session", p.interrupted]))));
      }
      // Running Pis first, each with its conversation, an orchestrator's workers right
      // under it; then pinned, then the latest.
      const held = new Set(matches.filter((s) => s.slot).map((s) => s.slot));
      const fresh = (pi) => !p.sessions.some((s) => s.slot === pi.slot);
      const ordered = [...pis.filter((pi) => fresh(pi) && pi.role !== "worker"),
        ...matches.filter((s) => s.slot).map((s) => pis.find((x) => x.slot === s.slot) || s).filter((x) => query || x.role !== "worker")];
      // A search lists what matches, flat; otherwise each worker follows its orchestrator.
      const workersOf = (pi) => query ? [] : pis.filter((w) => w.role === "worker" && w.orchestrator === pi.n);
      const orphans = query ? [] : pis.filter((w) => w.role === "worker" && !pis.some((o) => o.role === "orchestrator" && o.n === w.orchestrator));
      for (const item of [...ordered, ...orphans]) {
        for (const pi of item.slot && pis.includes(item) ? [item, ...(item.role === "orchestrator" ? workersOf(item) : [])] : [item]) {
          const s = matches.find((x) => x.slot === pi.slot);
          if (!pis.includes(pi)) { list.append(row(p, pi)); shown += 1; continue; } // a session whose Pi just went
          if (!s && (query || !fresh(pi))) continue;
          const li = piRow(p, pi, s || null);
          if (pi.role === "worker" && item !== pi) li.classList.add("in-team");
          list.append(li);
          if (s) shown += 1;
        }
      }
      const idle = matches.filter((s) => !s.slot && !s.deleted);
      const pinnedFirst = (xs) => [...xs.filter((s) => s.pinned), ...xs.filter((s) => !s.pinned)];
      // Outside any folder: the latest few, the rest behind "show all".
      const rest = pinnedFirst(idle.filter((s) => !s.category && !s.subagent));
      const room = Math.max(PER_PROJECT - held.size, rest.filter((s) => s.pinned).length);
      const visible = query || view.expanded[p.project] ? rest : rest.slice(0, room);
      for (const s of visible) {
        list.append(row(p, s));
        shown += 1;
      }
      const tools = el("li", { className: "small more" });
      if (visible.length < rest.length) {
        tools.append(linkButton(`show all ${rest.length + held.size}`, "", () => { view.expanded[p.project] = true; keep(); render(); }));
      } else if (view.expanded[p.project] && !query && rest.length > room) {
        tools.append(linkButton("show fewer", "", () => { delete view.expanded[p.project]; keep(); render(); }));
      }
      if (pis.length > 1 && !query) tools.append(linkButton("stop them all", "", () => stop(p, null)));
      if (tools.children.length) list.append(tools);
      // Each category, a folder (folded until opened); the sub-agents of pi-multiagent in
      // one of their own, last.
      const named = [...new Set(idle.filter((s) => s.category && !s.subagent).map((s) => s.category))].sort((a, b) => a.localeCompare(b));
      const folders = named.map((name) => ({ name, sessions: pinnedFirst(idle.filter((s) => s.category === name && !s.subagent)) }));
      const subagents = idle.filter((s) => s.subagent);
      if (subagents.length) folders.push({ name: "sub-agents", subagents: true, sessions: subagents });
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
      const start = el("button", { className: "secondary", textContent: "Open a folder…", title: "Choose a folder of the VM and start Pi in it" });
      start.addEventListener("click", () => openFolderPicker());
      const ready = el("button", { className: "link", textContent: "Is the VM ready?", title: "What Pier needs on the VM, and what is missing" });
      ready.addEventListener("click", () => openVmReady());
      list.append(el("li", { className: "dim small", textContent: "No conversation yet. Choose a folder and Pi starts there (in the picker: the arrows, then p)." }),
        el("li", { className: "toolbar" }, start, ready));
    }
    const count = all.length;
    $$(".count").textContent = `${count} conversation${count === 1 ? "" : "s"} in ${data.projects.length} project${data.projects.length === 1 ? "" : "s"}${data.truncated ? " (the latest 2000)" : ""}`;
  }

  /** From elsewhere (Setup): this project open and in view. */
  tab.focusProject = (path) => {
    delete view.folded[path];
    keep();
    workspace.show(tab);
    render();
    [...list.querySelectorAll(".project-head .project-name")].find((n) => n.title === path)?.scrollIntoView({ block: "start" });
  };
  tab.onTargetChange = () => render();

  // Redrawn once typing pauses: with every conversation of every project, at each key
  // it rebuilt thousands of rows.
  let filterTimer = null;
  $$(".conversation-filter").addEventListener("input", (event) => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => { query = event.target.value.trim().toLowerCase(); render(); }, 150);
  });
  $$(".show-archived").addEventListener("change", (event) => { archived = event.target.checked; render(); });

  const unlisten = vm.on("conversations", (message) => {
    if (message.error) { showError(error, message.error); return; }
    showError(error, "");
    data = message.data;
    render();
  });
  tab.onVisible = (shown) => vm.follow({ conversations: shown });
  tab.onClose = () => { unlisten(); vm.follow({ conversations: false }); };
  vm.follow({ conversations: tab.shown !== false });
}
