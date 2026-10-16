// Conversations: every conversation of every project, grouped by project, with the Pis
// running them; pinned ones first, searchable, archived ones out of the way. The one
// place for conversations (Setup is a project's configuration).

/** A conversation's title: the name given in Pier, else in Pi, else its first question. */
const conversationTitle = (s) => s?.title || s?.name || s?.prompt || "(a conversation not started yet)";

/** Facts under a title, " · " between them: a line breaks between two facts, never
 *  inside one ("801k tokens" stays whole). */
const factLine = (parts) => parts.filter(Boolean).map((t) => String(t).replace(/ /g, "\u00a0")).join(" · ");

function relTime(secs) {
  const d = Date.now() / 1000 - secs;
  return d < 90 ? "just now" : d < 3600 ? `${Math.round(d / 60)} min ago` : d < 86400 ? `${Math.round(d / 3600)} h ago` : `${Math.round(d / 86400)} d ago`;
}

/** "today", "this week", "older": from local midnight, as people count days. */
function dateGroup(secs) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const start = midnight.getTime() / 1000;
  return secs >= start ? "today" : secs >= start - 6 * 86400 ? "this week" : "older";
}

/** Whether a conversation matches a search (lowercase text): title, question, Pi's
 *  name, category. */
function conversationMatches(s, query) {
  return !query || [conversationTitle(s), s.prompt, s.name, s.category].some((t) => t && t.toLowerCase().includes(query));
}

function linkButton(text, title, action) {
  const b = el("button", { className: "link", textContent: text, title });
  b.addEventListener("click", action);
  return b;
}

/** The ⋯ menu of a conversation: name and category, pin, archive. */
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
  ]);
}

/** In place of a row: a conversation's name and category, kept by Pier. */
function conversationEditor(at, project, session, categories, { done, failed }) {
  const name = el("input", { value: session.title || "", placeholder: session.name || session.prompt || "a name", spellcheck: false });
  const category = el("input", { value: session.category || "", placeholder: "category (optional)", spellcheck: false });
  const options = el("datalist", { id: `categories-${Math.random().toString(36).slice(2)}` }, ...categories.map((c) => el("option", { value: c })));
  category.setAttribute("list", options.id);
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
  for (const input of [name, category]) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); save(); }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); done(); }
    });
  }
  const form = el("li", { className: "label-editor" }, name, category, options,
    el("span", { className: "row-actions" }, linkButton("save", "", save), linkButton("cancel", "", done)));
  at.replaceWith(form);
  name.focus();
}

/** Tokens of a conversation's usage (cache included, as Pi counts them). */
const usageTokens = (u) => (u ? (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) : 0);
const shortNumber = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
/** What a conversation cost: in dollars when the model has a price in Pi, else tokens. */
const spentText = (cost, count) => (cost >= 0.005 ? `$${cost.toFixed(2)}` : count ? `${shortNumber(count)} tok` : "");

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
  const text = ([count, cost]) => [cost >= 0.005 ? `$${cost.toFixed(2)}` : "", count ? `${shortNumber(count)} tok` : ""].filter(Boolean).join(", ") || "nothing";
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
  let view = { folded: {}, expanded: {} };
  try { view = { ...view, ...JSON.parse(localStorage.getItem(STORE)) }; } catch { /* defaults */ }
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
            done: () => { editing = false; render(); vm.poke(); },
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

  /** A running Pi: its conversation (or a new one, nothing said yet), open and stop. */
  function piRow(p, pi, s) {
    return el("li", { className: "running" },
      el("span", { className: pi.working ? "live-dot" : "dim", textContent: pi.working ? "●" : "○" }),
      el("div", { className: "meta" },
        el("span", { className: s ? "title" : "title fresh", textContent: s ? conversationTitle(s) : "New conversation", title: s?.prompt || "Pi writes it at its first answer" }),
        el("span", { className: "dim small facts", textContent: factLine([`Pi #${pi.n} ${pi.working ? "working" : "waiting"}`, ...(s ? facts(s) : ["nothing said yet"])]) })),
      el("span", { className: "row-actions" },
        linkButton("open", "Open its terminal", () => openPiTerminal(p.project, p.label, ["--slot", pi.slot], pi.n)),
        linkButton("stop", "Stop this Pi; its conversation stays saved", () => stop(p, pi)),
        s ? more(p, s) : null));
  }

  function row(p, s) {
    return el("li", { className: s.archived ? "archived" : "" },
      el("span", { className: "dim", textContent: s.pinned ? "★" : " " }),
      el("div", { className: "meta" },
        el("span", { className: "title", textContent: conversationTitle(s), title: s.prompt || "" }),
        el("span", { className: "dim small facts", textContent: factLine(facts(s)) })),
      el("span", { className: "row-actions" },
        linkButton("continue", "Start a Pi on this conversation", () => openPiTerminal(p.project, p.label, ["--session", s.path])),
        more(p, s)));
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
        linkButton("setup", "Instructions and what Pi loads in this project", () => workspace.find("setup")?.openProject?.(p.project))));
    li.querySelector(".fold").addEventListener("click", () => {
      view.folded[p.project] = !folded;
      keep();
      render();
    });
    return li;
  }

  function render() {
    if (!data || editing) return;
    const all = data.projects.flatMap((x) => x.sessions);
    categories = [...new Set(all.map((x) => x.category).filter(Boolean))].sort();
    list.innerHTML = "";
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
      // Running Pis first, each with its conversation; then pinned, then the latest.
      const held = new Set(matches.filter((s) => s.slot).map((s) => s.slot));
      if (!query) for (const pi of pis) if (!p.sessions.some((s) => s.slot === pi.slot)) list.append(piRow(p, pi, null));
      for (const s of matches.filter((x) => x.slot)) {
        const pi = pis.find((x) => x.slot === s.slot);
        list.append(pi ? piRow(p, pi, s) : row(p, s));
        shown += 1;
      }
      const rest = [...matches.filter((s) => !s.slot && s.pinned), ...matches.filter((s) => !s.slot && !s.pinned)];
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
    }
    if (query && !shown) list.append(el("li", { className: "dim small", textContent: "No conversation matches." }));
    if (!data.projects.length) list.append(el("li", { className: "dim small", textContent: "No conversation yet: start a Pi from the picker." }));
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
