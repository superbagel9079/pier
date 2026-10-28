// The Setup tab: a project's instructions, what Pi reads at startup, its conversations.

// ============================================================================
// Setup: what a project's Pi starts with, and its sessions
// ============================================================================
//
// Pi has no project settings of its own beyond files: a project is a folder, and
// every session started in it reads the same context. This tab writes those files
// (AGENTS.md, .pi/APPEND_SYSTEM.md, .pi/SYSTEM.md, with a history), shows exactly
// what Pi loads at startup, and starts or continues sessions.

const INSTRUCTION_SNIPPETS = [
  ["About the project", "## Project\n<What it is, who it is for, what matters most.>\n"],
  ["Commands", "## Commands\n- Install: `<command>`\n- Run: `<command>`\n- Test: `<command>` (run it before saying a task is done)\n"],
  ["Conventions", "## Conventions\n- <naming, structure, style rules Pi cannot guess>\n"],
  ["Git", "## Git\n- Small commits with clear messages, one change each.\n- Never push, rebase or force anything without asking.\n"],
  ["Language", "## Language\nTalk to me in French. Code, comments and commit messages in English.\n"],
  ["Never", "## Never\n- Delete or rewrite files unrelated to the task.\n- Add or upgrade dependencies without asking.\n- Touch secrets or .env files.\n"],
];

const DRAFT_PROMPT = "Read this project: its structure, README, build, run and test setup, and the conventions you can infer from the code. Then write an AGENTS.md at the project root for future sessions: what the project is, the exact commands to install, run and test, the conventions to follow, and what to avoid. Keep it short (under 60 lines) and concrete. If an AGENTS.md already exists, improve it instead and tell me what you changed.";

/** A terminal on a Pi of project. args: nothing (the Pi used last there, or a new one),
 *  ["--new"], ["--slot", NAME] (a running Pi), ["--continue"] or ["--session", FILE]
 *  (that conversation: its Pi if one runs it, else a new Pi on it). A tab already open
 *  on the same Pi is shown instead; n numbers the project's Pis in the tab's title. */
function openPiTerminal(project, label, args = [], n = 1) {
  // The same Pi: the tab that shows that tmux session (it learns it when attached), or
  // one opened the same way.
  const slot = args[0] === "--slot" ? args[1] : null;
  const same = (t) => t.kind === "pi" && t.params?.project === project && args[0] !== "--new"
    && ((slot && t.slot === slot) || canon(t.params.args) === canon(args));
  const existing = workspace.tabs().find(same);
  if (existing) { workspace.show(existing); return existing; }
  const suffix = args[0] === "--new" ? " · new" : n > 1 ? ` #${n}` : "";
  return workspace.add("pi", workspace.find("main")?.dock || "center", { params: { project, label: label + suffix, args } });
}

function makeSetup(tab) {
  tab.pane.append($("#tpl-setup").content.cloneNode(true));
  const $$ = (sel) => $(sel, tab.pane);
  const error = $$(".error");
  const notice = $$(".notice");
  const select = $$(".setup-project");
  let data = null;
  let chosen = null;      // a project picked in the list, else the Pi in use
  let shownProjects = ""; // what the project list holds now
  const editors = {};
  const manager = makeResourceManager($$(".resource-manager"), () => data?.project || project(), () => { if (data) renderSummary(); });
  const packageTools = makePackageTools($$(".package-tools"), () => data?.project || project(), () => manager.load());

  // The four pages; the one chosen is remembered.
  function showPage(page, initial = false) {
    // Git and Team: the Repository panel now (repository.js).
    if (page === "git" || page === "team") {
      if (!initial) { repositoryTab(page); return; } // the page shown here stays as it was
      page = "instructions";
    }
    if (!["instructions", "skills", "packages", "advanced"].includes(page)) page = "instructions";
    for (const b of tab.pane.querySelectorAll(".setup-pages .mode")) b.classList.toggle("active", b.dataset.page === page);
    for (const section of tab.pane.querySelectorAll(".setup-page")) section.hidden = section.dataset.page !== page;
    if (prefs.setupPage !== page) { prefs.setupPage = page; savePrefs(); }
    // At creation the project is not known yet: the setup's arrival loads them (onSetup).
    if (initial) return;
    if (page === "packages") packageTools.shown();
  }
  for (const b of tab.pane.querySelectorAll(".setup-pages .mode")) b.addEventListener("click", () => showPage(b.dataset.page));
  tab.showPage = (page) => showPage(page); // from the palette
  showPage(prefs.setupPage, true);

  const project = () => chosen || target?.path || select.value || "";

  async function fillProjects(projects = lastProjects) {
    if (!projects) {
      try { projects = await fetchProjects(); } catch { return; }
    }
    const options = [];
    for (const p of [...projects.running, ...projects.recent]) if (!options.some((o) => o.path === p.path)) options.push(p);
    // A project opened from Conversations may be neither running nor recent.
    if (chosen && !options.some((o) => o.path === chosen)) options.push({ path: chosen, label: projectLabel(chosen), running: false });
    // Rebuilt only when the list itself changes: the projects arrive again each time a
    // Pi starts or stops working, and rebuilding closed the list while one chose in it.
    const key = JSON.stringify(options.map((p) => [p.path, p.label, Boolean(p.running)]));
    if (key !== shownProjects) {
      shownProjects = key;
      select.innerHTML = "";
      for (const p of options) select.add(new Option(`${p.running ? "[pi] " : ""}${p.label}`, p.path));
    }
    if (project() && select.value !== project()) select.value = project();
    // Following the Pi in use, or kept on a project chosen in the list.
    const follow = $$(".follow");
    follow.hidden = !chosen;
    follow.textContent = "back to the Pi in use";
    follow.title = "Show the project of the Pi you use, and follow it when you switch";
  }

  /** Follows the project shown; its setup comes from the watch, now and when it changes. */
  function load() {
    if (!project()) { $$(".state").textContent = "no project yet"; return; }
    if (tab.shown !== false) vm.follow({ setup: project() });
  }

  function onSetup(message) {
    if (!vm.current(message)) return;
    if (message.error) { showError(error, message.error); return; }
    showError(error, "");
    data = message.data;
    if (select.value !== data.project) select.value = data.project;
    const count = data.pis.length;
    $$(".state").textContent = !count ? "no pi running" : count === 1 ? "pi running" : `${count} pis running`;
    renderSummary();
    for (const which of ["instructions", "append", "system"]) editors[which].show(data.texts[which]);
    renderStartup();
    renderResources();
  }

  // --- the project's conversations: a line, the list is in Conversations ---

  function link(text, title, action) {
    const b = el("button", { className: "link", textContent: text, title });
    b.addEventListener("click", action);
    return b;
  }

  /** One line on what the project holds, and the counts on the page buttons. */
  function renderSummary() {
    const box = $$(".setup-summary");
    const n = data.conversations ?? 0;
    const r = data.resources || {};
    const managed = manager.data();
    const skills = managed ? managed.skills : r.skills || [];
    const off = managed ? skills.filter((s) => !s.enabled).length : 0;
    const packages = (r.packages || []).length;
    const facts = [
      r.pi?.version && `Pi ${r.pi.version}`,
      `${packages} package${packages === 1 ? "" : "s"}`,
      `${skills.length} skill${skills.length === 1 ? "" : "s"}${off ? ` (${off} off)` : ""}`,
      (r.mcp || []).length && `${r.mcp.length} MCP`,
      `${n} conversation${n === 1 ? "" : "s"}`,
    ].filter(Boolean);
    box.replaceChildren(
      el("span", { className: "dim", textContent: facts.join(" · ") }),
      link("open them in Conversations", "Its Pis and conversations: new, continue, stop", () => {
        const conversations = workspace.find("conversations") || workspace.add("conversations", "left");
        conversations?.focusProject?.(data.project);
      }),
    );
  }

  /** From Conversations: show this project here. */
  tab.openProject = (path) => {
    chosen = path;
    workspace.show(tab);
    fillProjects();
    load();
  };

  // --- editors ---

  function editor(which, box) {
    const area = $(".editor", box);
    const tokens = $(".tokens", box);
    const state = $(".unsaved", box);
    const historyList = $(".history-list", box);
    let saved = "";
    let current = null;
    let owner = null; // the project the text in the box belongs to

    const update = () => {
      const n = Math.ceil(area.value.length / 4);
      tokens.textContent = area.value.trim() ? `≈ ${n.toLocaleString()} tokens, read in every session` : "empty";
      state.hidden = area.value === saved;
    };
    area.addEventListener("input", update);
    area.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save(); }
    });

    async function save() {
      try {
        await backend.writeText(owner || data.project, which, area.value);
        saved = area.value;
        update();
        showError(notice, `${current.name} saved. New sessions read it; a running Pi only after it restarts.`);
        vm.poke();
      } catch (e) { showError(error, String(e)); }
    }

    $(".save", box).addEventListener("click", save);
    $(".revert", box).addEventListener("click", () => { area.value = saved; update(); });
    $(".history-toggle", box).addEventListener("click", () => {
      historyList.hidden = !historyList.hidden;
    });

    return {
      dirty: () => area.value !== saved,
      insert(text) {
        const at = area.selectionStart ?? area.value.length;
        const before = area.value.slice(0, at);
        const glue = before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
        area.value = before + glue + text + area.value.slice(at);
        area.focus();
        update();
      },
      show(info) {
        const dirty = area.value !== saved;
        // Unsaved typing stays with its own project: another project's text never
        // takes its place, and a save goes where the text came from.
        if (dirty && owner && owner !== data.project) return;
        current = info;
        $(".file-name", box).textContent = info.name + (info.exists ? "" : " (not created yet)");
        if (!dirty) area.value = info.text;
        saved = info.text;
        owner = data.project;
        update();
        historyList.innerHTML = "";
        for (const version of info.history) {
          const li = el("li");
          li.append(
            el("span", { className: "dim small", textContent: new Date(version.at * 1000).toLocaleString() }),
            el("span", { className: "ellipsis small", textContent: version.text.split("\n").find((l) => l.trim()) || "(empty)" }),
          );
          const restore = el("button", { className: "link", textContent: "restore" });
          restore.addEventListener("click", () => { area.value = version.text; update(); historyList.hidden = true; });
          li.append(restore);
          historyList.append(li);
        }
        if (!info.history.length) historyList.append(el("li", { className: "dim small", textContent: "No earlier version: every save keeps the previous one here." }));
        if (which !== "instructions") {
          const note = $(".global-note", box);
          note.hidden = !info.global || info.exists;
          note.textContent = `A global one exists in ~/.pi/agent: it applies unless this project has its own.`;
        }
      },
    };
  }

  for (const which of ["instructions", "append", "system"]) editors[which] = editor(which, $$(`.box-${which}`));

  $$(".insert").addEventListener("click", (event) => {
    showMenu(event.currentTarget, INSTRUCTION_SNIPPETS.map(([label, text]) => [label, () => editors.instructions.insert(text)]));
  });
  $$(".ask-pi").addEventListener("click", async () => {
    if (!data) return;
    if (!data.pis.length) {
      openPiTerminal(data.project, data.label, []);
      showError(notice, "Starting Pi… the request is typed into it in a moment: press Enter there to send it.");
      const asked = data.project;
      setTimeout(() => backend.api(["type", DRAFT_PROMPT, asked]).catch((e) => showError(error, String(e))), 5000);
      return;
    }
    try {
      await backend.api(["type", DRAFT_PROMPT, data.project]);
      showError(notice, "The request is typed into Pi: press Enter in its terminal to send it. Pi writes AGENTS.md itself; this tab shows it when you come back.");
    } catch (e) { showError(error, String(e)); }
  });

  // --- what Pi reads ---

  /** Whether version a is newer than b ("1.10.0" > "1.9.2"); false when one is missing. */
  function newer(a, b) {
    if (!a || !b) return false;
    const [ma, pra] = a.split("-", 2);
    const [mb, prb] = b.split("-", 2);
    const pa = ma.split(".").map((x) => parseInt(x, 10) || 0);
    const pb = mb.split(".").map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    if (!pra && prb) return true;    // 1.3.0 is newer than 1.3.0-beta.1
    if (pra && prb) return pra.localeCompare(prb, undefined, { numeric: true }) > 0;
    return false;
  }

  /** Pi and its packages (Packages), MCP servers and the model (Advanced). Skills,
   *  extensions and prompts are the manager's (Skills page, resources.js). */
  function renderResources() {
    const list = $$(".resources");
    const advanced = $$(".advanced-list");
    list.innerHTML = "";
    advanced.innerHTML = "";
    const r = data.resources;
    if (!r) return;
    const row = (kind, scope, name, detail, title, action) => el("li", { title: title || "" },
      el("span", { className: "scope", textContent: scope === "project" ? `${kind} · project` : kind }),
      el("span", { className: "ellipsis", textContent: name }),
      el("span", { className: "dim small", textContent: detail || "" }),
      action || null);
    const update = (label, args, title) => link("update", title, () => {
      workspace.add("update", workspace.find("main")?.dock || "center", { params: { label, args } });
    });
    // Packages: compact rows, as on the Skills page.
    const line = (name, detail, title, ...actions) => el("li", { title: title || "" },
      el("span", { className: "name ellipsis", textContent: name }),
      el("span", { className: "dim small ellipsis", textContent: detail || "" }),
      actions.length ? el("span", { className: "row-actions" }, ...actions) : null);
    if (r.pi?.version) {
      const behind = newer(r.pi.latest, r.pi.version);
      list.append(line(`Pi ${r.pi.version}`, behind ? `${r.pi.latest} available` : r.pi.latest ? "up to date" : "",
        "Pi itself. Running Pis keep their version until they restart.",
        ...(behind ? [update("Pi", [], "pi update, in a terminal")] : [])));
    }
    let outdated = 0;
    for (const p of r.packages) {
      const name = p.source.replace(/^npm:/, "");
      const behind = p.installed !== false && newer(p.latest, p.version);
      outdated += behind ? 1 : 0;
      const detail = p.installed === false ? "not installed" : behind ? `v${p.version} → ${p.latest}` : p.version ? `v${p.version}` : "";
      const remove = link("remove", `pi remove ${p.source}, in a terminal (in Pi's sandbox)`, async () => {
        if (!(await ask(`Remove the package ${name}? Pi stops loading its skills and extensions at its next start.`))) return;
        openPackageTerminal("remove", p.scope === "project" ? data.project : "user", p.source, name, () => manager.load());
      });
      list.append(line(name, [p.scope === "project" ? "this project" : "", detail].filter(Boolean).join(" · "),
        [p.source, p.description].filter(Boolean).join(": "),
        ...(behind ? [update(name, [p.source], `pi update ${p.source}, in a terminal`)] : []), remove));
    }
    if (outdated > 1) list.append(el("li", { className: "note small" }, update("all packages", ["--extensions"], "pi update --extensions, in a terminal")));
    manager.loadFor(data.project);
    if (prefs.setupPage === "packages") packageTools.shown();
    packageTools.installed(r.packages);
    if (!r.packages.length) list.append(el("li", { className: "dim small note", textContent: "No package yet: install one, or find one in the gallery below." }));
    for (const server of r.mcp) {
      advanced.append(row("MCP", server.scope, server.name, [server.kind, server.enabled ? "" : "off"].filter(Boolean).join(" · "),
        [server.description, `in ${server.from}`].filter(Boolean).join(" · ")));
    }
    const m = r.model || {};
    if (m.defaultModel) {
      const model = [m.defaultProvider, m.defaultModel].filter(Boolean).join(" / ");
      advanced.append(row("model", "user", model, m.defaultThinkingLevel ? `thinking ${m.defaultThinkingLevel}` : "", `Pi's default model, from settings.json: ${model}`));
    }
    if (!r.mcp.length) advanced.prepend(el("li", { className: "dim small note", textContent: "No MCP server: add one with pi mcp add on the VM." }));
  }

  function renderStartup() {
    const list = $$(".startup");
    list.innerHTML = "";
    for (const file of data.startup) {
      const li = el("li");
      li.append(
        el("span", { className: "scope", textContent: file.scope }),
        el("span", { className: "ellipsis", textContent: file.label }),
        el("span", { className: "dim small", textContent: `≈ ${Math.ceil(file.size / 4).toLocaleString()} tokens` }),
      );
      list.append(li);
    }
    if (!data.startup.length) list.append(el("li", { className: "dim small note", textContent: "No instructions file anywhere: Pi starts with its defaults only." }));
    const trust = $$(".trust");
    trust.textContent = data.trusted === true
      ? "This project is trusted: Pi also reads its .pi/ settings and system prompt files."
      : data.trusted === false
        ? "You told Pi not to trust this project: its .pi/ settings and system prompt files are ignored. Instructions files above still count."
        : "Pi has not asked yet whether to trust this project: until you accept in Pi, its .pi/ settings and system prompt files are ignored.";
  }

  select.addEventListener("change", async () => {
    if (Object.values(editors).some((e) => e.dirty()) && !(await ask("Leave this project? Unsaved text will be lost."))) {
      select.value = project();
      return;
    }
    chosen = select.value;
    fillProjects();
    load();
  });
  $$(".follow").addEventListener("click", () => { chosen = null; fillProjects(); load(); });

  tab.onShow = async () => { await fillProjects(); load(); };
  tab.onTargetChange = async () => {
    if (chosen) return;
    // Unsaved text: stay on its project rather than follow the Pi in use elsewhere.
    if (Object.values(editors).some((e) => e.dirty())) {
      chosen = project();
      showError(notice, "Unsaved text here: Setup stays on this project. Save it, then \"back to the Pi in use\".");
      fillProjects();
      return;
    }
    await fillProjects();
    load();
  };
  tab.onProjects = (projects) => fillProjects(projects);
  const unlisten = vm.on("setup", onSetup);
  // A request of Pi (merge, new repository): the Git page shows it at once.
  tab.onClose = () => { unlisten(); vm.follow({ setup: null }); };
  tab.onVisible = (shown) => { if (shown) load(); else vm.follow({ setup: null }); };
  fillProjects().then(load);
}
