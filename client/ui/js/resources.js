// Skills, extensions and prompts, and packages, in the Project panel.

// What Pi loads, managed: skills, extensions, prompts on or off (as `pi config`), local skills
// made, edited, imported; packages installed (pi install, in Pi's sandbox on the VM).

const KIND_LABELS = { skills: "Skills", extensions: "Extensions", prompts: "Prompts" };
const PACKAGE_WARNING = "A package's extensions run code with your rights when Pi starts, and its skills can tell Pi to do anything. "
  + "Look at its source before installing it. The installation itself runs in Pi's sandbox on the VM.";

/** Opens `pi install` or `pi remove` in a terminal tab: what npm does stays visible. */
function openPackageTerminal(action, scope, source, label, onDone) {
  workspace.add("update", "center", {
    params: { label: `${action} ${label}`, termKind: "package", args: [action, scope, source], onDone },
  });
}

/** A dialog in Pier's own style (.overlay .dialog): title, content, actions. Escape,
 *  Cancel or a click beside it closes it. Returns { close }. */
function resourceDialog(title, body, actions, wide = false) {
  const overlay = el("div", { className: "overlay" });
  const box = el("div", { className: wide ? "dialog wide" : "dialog" });
  const cancel = el("button", { className: "secondary", textContent: "Cancel" });
  let release = () => {};
  const api = {};
  const close = () => { overlay.remove(); release(); api.onClose?.(); };
  cancel.addEventListener("click", close);
  box.append(el("h1", { textContent: title }), ...body, el("div", { className: "actions end" }, cancel, ...actions));
  overlay.append(box);
  overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(); });
  document.body.append(overlay);
  release = trapDialog(box, close);
  // Its lists as picks now (ui.js would do it a frame later, after the focus is placed).
  for (const select of box.querySelectorAll("select")) pickify(select);
  ([...box.querySelectorAll("input, textarea, button.pick")].find((e) => !e.hidden && e.offsetParent) || actions[0] || cancel).focus();
  return Object.assign(api, { close, box });
}

function dialogError() {
  return el("p", { className: "error", role: "alert", hidden: true });
}

/** The Skills page. onChange: after each load or change (the summary counts follow). */
function makeResourceManager(box, currentProject, onChange, top = null, { scope = () => "user", browse = null, only = () => null, bar = true } = {}) {
  const error = el("p", { className: "error", hidden: true });
  const notice = el("p", { className: "notice", hidden: true });
  const filter = el("input", { type: "search", placeholder: "Filter skills", spellcheck: false });
  filter.setAttribute("aria-label", "Filter the list");
  const add = el("button", { className: "secondary", title: "A new skill, a skill from this computer, a package" }, svgIcon("plus"), el("span", { textContent: "Add" }));
  add.setAttribute("aria-haspopup", "menu");
  const refresh = el("button", { className: "icon-btn", title: "Read again what Pi loads" }, svgIcon("refresh-cw"));
  refresh.setAttribute("aria-label", refresh.title);
  const list = el("div", { className: "resource-lists" });
  const off = el("p", { className: "hint", textContent: "Off: Pi leaves it out at its next start. Nothing is deleted." });
  // Without its bar (Settings > Extensions, as the board): Add is the page's own, on top.
  box.replaceChildren(
    el("div", { className: "toolbar resource-bar", hidden: !bar }, searchBox(filter), add, refresh),
    error, notice, ...(top ? [top] : []), list, off);

  let data = null;
  let kind = "skills"; // the tab shown (settings.js): skills, extensions or prompts
  const say = noticeSetter(notice);

  // Added in place (the proposals' 2B): a new skill is a row to fill first in Skills, a
  // skill of this computer is imported at once, a package is found in Browse. Where it goes:
  // the project whose settings these are (scope).
  const addMenu = (anchor) => showMenu(anchor, [
    ["New skill", () => newSkill(), false, { icon: "plus" }],
    ["Import a skill from this computer…", () => importSkill(), false, { icon: "upload" }],
    ...(browse ? [null, ["Find a package", () => browse(), false, { icon: "search" }]] : []),
  ]);
  add.addEventListener("click", () => addMenu(add));
  refresh.addEventListener("click", () => load());
  let filterTimer = null;
  filter.addEventListener("input", () => { clearTimeout(filterTimer); filterTimer = setTimeout(render, 120); });

  async function load() {
    const project = currentProject();
    if (!project) return;
    showError(error, "");
    try {
      data = await backend.api(["resources", project]);
    } catch (e) {
      showError(error, String(e));
      return;
    }
    render();
    onChange?.();
  }

  /** The tab shown: its rows, yours first, then the project's, then Pier's own. Where
   *  each comes from is said after its description (the mock-up's option A1). */
  function render() {
    list.replaceChildren();
    const needle = filter.value.trim().toLowerCase();
    // Yours only, from Settings' menu (a project's own are on its page).
    const shown = (item) => (!only() || !item.scope || item.scope === only())
      && (!needle || [item.name, item.description, item.source].some((t) => t && t.toLowerCase().includes(needle)));
    // "all" (Installed): skills, extensions and prompts, one group under the other.
    const kinds = kind === "all" ? Object.keys(KIND_LABELS) : [kind];
    let any = false;
    for (const k of kinds) {
      const items = (data?.[k] || []).filter(shown);
      // Pier's own extensions: given to each Pi it starts (--extension), never in Pi's
      // settings; shown, not toggled here (each has its setting in the picker's config).
      const pier = k === "extensions" && kind !== "all" ? (data?.pier || []).filter(shown) : [];
      const rows = el("div", { className: "rows" },
        ...(k === "skills" && adding ? [adding] : []),
        ...items.filter((i) => i.scope === "user").map((i) => row(k, i)),
        ...items.filter((i) => i.scope === "project").map((i) => row(k, i)),
        ...pier.map(pierRow));
      if (!rows.childElementCount) continue;
      any = true;
      if (kind === "all") list.append(el("h3", { className: "loads-group" }, el("span", { textContent: KIND_LABELS[k] }), el("span", { className: "n", textContent: String(rows.childElementCount) })));
      list.append(rows);
    }
    const given = kind === "all" ? (data?.pier || []).filter(shown) : [];
    if (given.length) {
      any = true;
      list.append(el("h3", { className: "loads-group" }, el("span", { textContent: "Given by Pier" }), el("span", { className: "n", textContent: String(given.length) })),
        el("div", { className: "rows" }, ...given.map(pierRow)));
    }
    // MCP servers (Installed): shown, set with pi mcp add on the VM (Pi connects them itself).
    const servers = kind === "all" ? (data?.mcp || []).filter(shown) : [];
    if (servers.length) {
      any = true;
      list.append(el("h3", { className: "loads-group" }, el("span", { textContent: "MCP servers" }), el("span", { className: "n", textContent: String(servers.length) })),
        el("div", { className: "rows" }, ...servers.map((m) => {
          const state = el("input", { type: "checkbox", checked: m.enabled, disabled: true });
          state.setAttribute("aria-label", m.name);
          return el("div", { className: m.enabled ? "set" : "set off", title: `in ${m.from}` },
            el("div", { className: "what" }, el("span", { textContent: m.name }),
              el("span", { textContent: said([m.description, m.kind].filter(Boolean).join(" · "), m.scope === "project" ? "this project only" : "yours") })),
            el("span", { className: "switch-hint", title: `Set in ${m.from}, with pi mcp on the VM` }, state));
        })));
    }
    if (!any) list.append(el("p", { className: "dim small", textContent: needle ? "Nothing matches." : `Nothing ${kind === "all" ? "" : `of ${KIND_LABELS[kind].toLowerCase()} `}yet: Add makes a skill, imports one, or installs a package (Browse).` }));
    off.hidden = !any;
  }

  /** Where an item comes from, in words: "yours, local", "from pi-hindsight", "this project only". */
  const origin = (item) => (item.scope === "project" ? "this project only"
    : item.source ? `from ${item.source.replace(/^npm:/, "")}` : "yours, local");
  const said = (description, from) => [description, from].filter(Boolean).join(" · ");

  /** One of Pier's extensions: whether the next Pi gets it, and (its title) how to change
   *  that. */
  function pierRow(item) {
    const [page, where] = { track_sessions: ["agents", "Agents, Which conversation each Pi holds"], git_tools: ["git", "Git & forges, Git tools"],
      "workers, helpers": ["agents", "Agents, Workers and Helpers"] }[item.setting] || ["labs", "Labs, a lab host"];
    const how = `Settings > ${where}`;
    const check = el("input", { type: "checkbox", checked: item.enabled, disabled: true }); // its state, not a control
    check.setAttribute("aria-label", item.name);
    return el("div", { className: item.enabled ? "set" : "set off" },
      el("div", { className: "what" }, el("span", { textContent: item.name }), el("span", { textContent: item.description || "" })),
      (() => {
        // A disabled switch gets no pointer events: its hint and its click are its frame's.
        const b = el("button", { type: "button", className: "switch-hint", title: `To ${item.enabled ? "leave it out" : "have it"}: ${how}` }, check);
        b.addEventListener("click", () => showPrefsPage(page));
        return b;
      })());
  }

  function row(kind, item) {
    const li = el("div", { className: item.enabled ? "set" : "set off", title: item.path || "" });
    const check = el("input", { type: "checkbox", checked: item.enabled, title: item.enabled ? "Loaded: turn off to leave it out" : "Left out: turn on to load it" });
    check.setAttribute("aria-label", item.name);
    check.addEventListener("change", async () => {
      check.disabled = true;
      try {
        await backend.resourceToggle(item.scope, currentProject(), kind, item.source || "", item.rel, check.checked);
        item.enabled = check.checked;
        li.classList.toggle("off", !item.enabled);
        say(`${item.name}: ${check.checked ? "loaded" : "left out"} from the next start of Pi.`);
        onChange?.();
      } catch (e) {
        check.checked = !check.checked;
        showError(error, String(e));
      } finally {
        check.disabled = false;
      }
    });
    li.append(el("div", { className: "what" }, el("span", { textContent: item.name }), el("span", { textContent: said(item.description, origin(item)) })));
    if (item.editable) {
      const name = item.rel.split("/")[1];
      const more = el("button", { className: "icon-btn more", title: "Edit, put in the bin" }, svgIcon("ellipsis"));
      more.setAttribute("aria-label", `${item.name}: edit, put in the bin`);
      more.addEventListener("click", () => showMenu(more, [
        ["Edit its SKILL.md…", () => editSkill(item.scope, name), false, { icon: "pencil" }],
        null,
        [`Remove ${item.name}`, () => binSkill(item.scope, name), false, { icon: "trash", danger: true }],
      ]));
      li.append(more);
    }
    li.append(check);
    return li;
  }

  async function binSkill(where, name) {
    if (!(await ask(`Put the skill ${name} in the bin? Pi stops loading it; it stays recoverable on the VM.`))) return;
    try {
      const done = await backend.skillDelete(where, currentProject(), name);
      flashStatus(`${name} removed (kept in the picker's bin on the VM)`);
      load();
    } catch (e) { showError(error, String(e)); }
  }

  /** A new skill: a row first in Skills, its name and what it does typed there; Create makes
   *  it and opens its SKILL.md. Escape or × puts the row away. */
  let adding = null;
  function newSkill() {
    if (!adding) {
      const name = el("input", { placeholder: "skill-name", spellcheck: false, "aria-label": "The new skill's name: lowercase letters, digits and single hyphens" });
      const description = el("input", { placeholder: "What it does, and when Pi should use it", spellcheck: false, "aria-label": "What the new skill does" });
      const create = el("button", { type: "button", className: "secondary", textContent: "Create" });
      const cancel = el("button", { type: "button", className: "icon-btn", title: "Put it away" }, svgIcon("x"));
      cancel.setAttribute("aria-label", "Put the new skill away");
      adding = el("div", { className: "set new-skill" }, el("div", { className: "new-skill-fields" }, name, description), cancel, create);
      const away = () => { adding = null; render(); };
      const go = async () => {
        create.disabled = true;
        try {
          const made = await backend.skillCreate(scope(), currentProject(), name.value.trim(), description.value.trim());
          adding = null;
          await load();
          editSkill(scope(), made.name);
        } catch (e) { showError(error, String(e)); } finally { create.disabled = false; }
      };
      create.addEventListener("click", go);
      cancel.addEventListener("click", away);
      for (const input of [name, description]) {
        input.dataset.ownEscape = ""; // Escape puts the row away, not the settings
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); go(); }
          if (e.key === "Escape") { e.preventDefault(); away(); }
        });
      }
    }
    filter.value = "";
    render();
    $("input", adding).focus();
  }

  async function editSkill(where, name) {
    let text;
    try {
      text = (await backend.api(["skill-read", where, currentProject(), name])).text;
    } catch (e) { showError(error, String(e)); return; }
    const area = el("textarea", { className: "editor", spellcheck: false, rows: 18, value: text });
    area.setAttribute("aria-label", "SKILL.md");
    const problem = dialogError();
    const save = el("button", { textContent: "Save" });
    const dialog = resourceDialog(`${name} · SKILL.md`, [
      el("p", { className: "dim small", textContent: where === "project" ? "A skill of this project" : "One of your skills, for every project" }),
      area, problem], [save], true);
    const go = async () => {
      try {
        await backend.skillSave(where, currentProject(), name, area.value);
        dialog.close();
        say(`${name} saved: Pi reads it at its next start.`);
        load();
      } catch (e) { showError(problem, String(e)); }
    };
    save.addEventListener("click", go);
    area.addEventListener("keydown", (e) => { if (e.ctrlKey && e.key === "s") { e.preventDefault(); go(); } });
    area.focus();
  }

  /** A folder of this computer holding a SKILL.md, chosen at once: copied into the skills,
   *  under the name it declares. */
  async function importSkill() {
    const folder = await backend.pickFolder();
    if (!folder) return;
    try {
      const done = await backend.skillImport(scope(), currentProject(), folder);
      say(`${done.name} imported ${scope() === "project" ? "into this project" : "for you"}.`);
      load();
    } catch (e) { showError(error, String(e)); }
  }

  // Read again when the project changes; otherwise on "refresh" and after an action
  // (each read starts the picker on the VM).
  let loadedFor = null;
  function loadFor(project) {
    if (project && project !== loadedFor) {
      loadedFor = project;
      load();
    }
  }

  /** The tab shown: skills, extensions or prompts. */
  function show(next) {
    kind = next;
    filter.placeholder = kind === "all" ? "Filter skills, extensions and prompts" : `Filter ${KIND_LABELS[kind].toLowerCase()}`;
    render();
  }

  return { load, loadFor, show, render, addMenu, data: () => data };
}

/** Whether version a is newer than b ("1.10.0" > "1.9.2"); false when one is missing. */
function newerVersion(a, b) {
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

/** Pi and its packages, into list: each with its version, update when one is behind,
 *  remove; r is the resources answer of project. reload: after a remove. */
function renderPackageList(list, r, project, reload) {
  list.replaceChildren();
  if (!r) return;
  const update = (label, args) => () => workspace.add("update", "center", { params: { label, args } });
  const tiles = [];
  // As the board: its picture, its name and what it brings, its version, ⋯ (update, remove).
  const line = (name, sub, version, title, actions) => {
    const tile = packageTile(name.startsWith("Pi ") ? "pi" : name);
    tiles.push([name, tile]);
    let more = null;
    if (actions.length) {
      more = el("button", { type: "button", className: "icon-btn", title: `${name}: more` }, svgIcon("ellipsis"));
      more.setAttribute("aria-label", more.title);
      more.setAttribute("aria-haspopup", "menu");
      more.addEventListener("click", () => showMenu(more, actions));
    }
    return el("li", { title: title || "" }, tile,
      el("span", { className: "pkg-what" }, el("span", { className: "name ellipsis", textContent: name }), el("span", { className: "dim small ellipsis", textContent: sub || "" })),
      el("span", { className: "dim small pkg-ver", textContent: version || "" }), more);
  };
  if (r.pi?.version) {
    const behind = newerVersion(r.pi.latest, r.pi.version);
    list.append(line("Pi", behind ? `${r.pi.latest} available` : r.pi.latest ? "up to date" : "Pi itself", `v${r.pi.version}`,
      "Pi itself. Running Pis keep their version until they restart.",
      behind ? [["Update (pi update)", update("Pi", []), false, { icon: "refresh-cw" }]] : []));
  }
  // What a package brings: its skills, extensions and prompts Pi lists with its source.
  const brings = (source) => [["skills", "skill"], ["extensions", "extension"], ["prompts", "prompt"]]
    .map(([k, one]) => [(r[k] || []).filter((i) => i.source === source).length, one])
    .filter(([n]) => n).map(([n, one]) => `${n} ${one}${n === 1 ? "" : "s"}`).join(", ");
  let outdated = 0;
  for (const p of r.packages || []) {
    const name = p.source.replace(/^npm:/, "");
    const behind = p.installed !== false && newerVersion(p.latest, p.version);
    outdated += behind ? 1 : 0;
    const sub = [p.installed === false ? "not installed" : brings(p.source), p.scope === "project" ? "this project" : ""].filter(Boolean).join(" · ");
    const version = behind ? `v${p.version} → ${p.latest}` : p.version ? `v${p.version}` : "";
    list.append(line(name, sub, version, [p.source, p.description].filter(Boolean).join(": "), [
      ...(behind ? [[`Update to ${p.latest}`, update(name, [p.source]), false, { icon: "refresh-cw" }]] : []),
      [`Remove ${name}`, async () => {
        if (!(await ask(`Remove the package ${name}? Pi stops loading its skills and extensions at its next start.`))) return;
        openPackageTerminal("remove", p.scope === "project" ? project : "user", p.source, name, reload);
      }, false, { icon: "trash", danger: true }],
    ]));
  }
  if (outdated > 1) list.append(el("li", { className: "note small" }, linkButton("update all packages", "pi update --extensions, in a terminal", update("all packages", ["--extensions"]))));
  if (!(r.packages || []).length) list.append(el("li", { className: "dim small note", textContent: "No package yet: find one in Browse." }));
  showPackageMedia(tiles.filter(([name]) => name !== "Pi").map(([, t]) => t));
}

// --- the packages' pictures -------------------------------------------------------------

/** pi.dev's picture of each package (given by its author), read by the picker on the VM as
 *  a data URL (Pier's pages load nothing from the web): name -> URL, or null for none. */
const packageMedia = new Map();
const mediaAsked = new Set();
async function loadPackageMedia(names) {
  const want = [...new Set(names)].filter((n) => n && n !== "pi" && !packageMedia.has(n) && !mediaAsked.has(n));
  for (let i = 0; i < want.length; i += 16) {
    const part = want.slice(i, i + 16);
    part.forEach((n) => mediaAsked.add(n));
    try {
      const r = await backend.api(["gallery-media", ...part]);
      for (const n of part) packageMedia.set(n, r?.media?.[n] || null);
    } catch { part.forEach((n) => mediaAsked.delete(n)); } // asked again next time
  }
}

/** A package's square: its picture once known, else its first letter on a colour of its own. */
function packageTile(name, size = "") {
  const tile = el("span", { className: `pkg-tile ${size}`.trim(), "aria-hidden": "true" });
  tile.dataset.name = name;
  tile.refresh = () => {
    const url = packageMedia.get(name);
    if (url) {
      tile.classList.add("pic");
      tile.style.removeProperty("background");
      tile.replaceChildren(el("img", { src: url, alt: "" }));
    } else {
      tile.textContent = name === "pi" ? "π" : (name.replace(/^@[^/]+\//, "").replace(/^pi-/, "")[0] || "?").toUpperCase();
      tile.style.background = defaultColor(name);
    }
  };
  tile.refresh();
  return tile;
}

/** The pictures of these tiles, asked together, each drawn once known. */
function showPackageMedia(tiles) {
  loadPackageMedia(tiles.map((t) => t.dataset.name)).then(() => tiles.forEach((t) => t.refresh()));
}

const SKILL_WARNING = "A skill can tell Pi to do anything: read it (its page shows its SKILL.md) before installing it. "
  + "npx skills add runs in Pi's sandbox on the VM and puts it in .agents/skills, where Pi finds it.";
/** "911.7K installs", as `npx skills find` says it. */
const installsText = (n) => (typeof n !== "number" ? "" : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M installs` : n >= 1e3 ? `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K installs` : `${n} installs`);

/** Browse (as Paseo's plugins): pi.dev's packages, filtered by kind and sorted, searched as
 *  you type; the most installed with a picture as featured cards, then the list with Install
 *  on each row. A click opens the package's own page (Back to packages): its facts, its
 *  picture, its links (GitHub, npm, its site) and its README. */
function makePackageTools(box, currentProject, onDone, scope = () => "user") {
  const KINDS = [["", "All kinds"], ["extension", "Extensions"], ["skill", "Skills"], ["prompt", "Prompts"], ["theme", "Themes"]];
  const SORTS = [["installs", "Most installed"], ["recent", "Recently updated"], ["name", "Name"]];
  let kind = "", sort = "installs";
  // Where from: pi.dev's packages (pi install), or skills.sh's skills (npx skills add, for Pi).
  let from = "packages";
  const fromSeg = el("span", { className: "seg pkg-from-seg", role: "tablist", "aria-label": "Where from" });
  const fromTab = (key, text, tip) => {
    const b = el("button", { type: "button", role: "tab", title: tip, textContent: text });
    b.addEventListener("click", () => { if (from === key) return; from = key; drawFrom(); all = []; search(); });
    b.dataset.key = key;
    return b;
  };
  fromSeg.append(fromTab("packages", "Packages", "pi.dev's packages: extensions, skills, prompts, themes (pi install)"),
    fromTab("skills", "Skills", "skills.sh's skills (npx skills add, for Pi)"));
  const input = el("input", { type: "search", placeholder: "Search packages, or type a source: npm:…, git:…, https://…", spellcheck: false });
  input.setAttribute("aria-label", "Search the packages");
  const kindBtn = el("button", { type: "button", className: "pick pkg-filter" });
  const sortBtn = el("button", { type: "button", className: "pick pkg-filter" });
  const label = () => {
    kindBtn.replaceChildren(el("span", { textContent: KINDS.find(([k]) => k === kind)[1] }));
    sortBtn.replaceChildren(el("span", { textContent: SORTS.find(([k]) => k === sort)[1] }));
  };
  label();
  function drawFrom() {
    for (const b of fromSeg.children) b.setAttribute("aria-selected", String(b.dataset.key === from));
    kindBtn.hidden = from === "skills";
    input.placeholder = from === "skills" ? "Search skills.sh's skills (two letters at least)" : "Search packages, or type a source: npm:…, git:…, https://…";
    warning.textContent = from === "skills" ? SKILL_WARNING : PACKAGE_WARNING;
    allHead.textContent = from === "skills" ? "Skills" : "All packages";
  }
  kindBtn.addEventListener("click", () => showMenu(kindBtn, KINDS.map(([k, name]) => [name, () => { kind = k; label(); render(); }, false, { icon: k === kind ? "check" : null }])));
  sortBtn.addEventListener("click", () => showMenu(sortBtn, SORTS.map(([k, name]) => [name, () => { sort = k; label(); render(); }, false, { icon: k === sort ? "check" : null }])));
  const warning = el("p", { className: "hint" });
  const allHead = el("h3", { className: "loads-group", textContent: "All packages" });
  const featured = el("div", { className: "pkg-featured" });
  const featuredHead = el("h3", { className: "loads-group", textContent: "Featured" });
  const results = el("div", { className: "pkg-list" });
  const where = el("p", { className: "hint pkg-from" });
  const listView = el("div", { className: "pkg-view" },
    el("div", { className: "pkg-tools" }, fromSeg, kindBtn, sortBtn, searchBox(input)),
    warning,
    featuredHead, featured,
    allHead,
    results, where);
  const pageView = el("div", { className: "pkg-page", hidden: true });
  box.replaceChildren(listView, pageView);
  let installed = new Set();
  let installedSkills = new Set(); // the names of the skills Pi loads here
  let searched = false;
  let timer = null;
  let all = [];
  let query = "";

  const facts = (pkg) => [pkg.publisher, pkg.downloads].filter(Boolean).join(" · ");
  /** pi install (a skill of skills.sh: npx skills add), in a tab: for the project whose
   *  settings these are (else for you). */
  const installPackage = (source) => openPackageTerminal(source.startsWith("skills:") ? "skill" : "install", scope() === "project" ? currentProject() : "user",
    source, source.replace(/^npm:/, "").replace(/^skills:.*\//, ""), onDone);
  const installButton = (pkg) => {
    const there = pkg.isSkill ? installedSkills.has(pkg.name) : installed.has(pkg.source);
    const b = el("button", { type: "button", className: there ? "secondary pkg-installed" : "secondary", textContent: there ? "Installed" : "Install", disabled: there });
    b.addEventListener("click", (e) => { e.stopPropagation(); installPackage(pkg.source); });
    return b;
  };

  function row(pkg) {
    const tile = packageTile(pkg.name);
    const r = el("button", { type: "button", className: "pkg-row" }, tile,
      el("span", { className: "tx" },
        el("span", { className: "name" }, el("b", { textContent: pkg.name }), ...(pkg.types || []).map((t) => el("span", { className: "chip", textContent: t }))),
        pkg.description ? el("span", { className: "desc", textContent: pkg.description }) : null,
        el("span", { className: "by", textContent: facts(pkg) })),
      installButton(pkg), svgIcon("chevron-right"));
    r.addEventListener("click", () => openPage(pkg));
    return [r, tile];
  }

  function card(pkg) {
    const tile = packageTile(pkg.name, "shot");
    const c = el("button", { type: "button", className: "pkg-card" }, tile,
      el("span", { className: "tx" }, el("b", { textContent: pkg.name }), el("span", { className: "desc", textContent: pkg.description || "" }), el("span", { className: "by", textContent: facts(pkg) })));
    c.addEventListener("click", () => openPage(pkg));
    return [c, tile];
  }

  /** The list as filtered and sorted now; featured without a search or a kind. */
  function render() {
    const shown = all.filter((p) => !kind || (p.types || []).includes(kind));
    const by = { installs: (a, b) => (b.monthly || 0) - (a.monthly || 0), recent: (a, b) => (b.updated || 0) - (a.updated || 0), name: (a, b) => a.name.localeCompare(b.name) }[sort];
    if (all.some((p) => p.monthly != null || sort === "name")) shown.sort(by); // npm's answer has no counts: its own order
    const rows = shown.map(row);
    results.replaceChildren(...rows.map(([r]) => r));
    if (!shown.length) results.append(el("p", { className: "dim small", textContent: all.length ? "No package of this kind here." : "Nothing found." }));
    rows.forEach(([, t]) => t.refresh());
    showPackageMedia(rows.map(([, t]) => t));
    const plain = !query && !kind && from === "packages";
    featured.hidden = featuredHead.hidden = !plain;
    if (plain) {
      const top = [...all].sort((a, b) => (b.monthly || 0) - (a.monthly || 0)).slice(0, 16);
      loadPackageMedia(top.map((p) => p.name)).then(() => {
        const cards = [...top.filter((p) => packageMedia.get(p.name)), ...top.filter((p) => !packageMedia.get(p.name))].slice(0, 3).map(card);
        featured.replaceChildren(...cards.map(([c]) => c));
        cards.forEach(([, t]) => t.refresh());
      });
    }
  }

  async function search() {
    searched = true;
    query = input.value.trim();
    if (from === "skills") { searchSkills(); return; }
    // A source typed: one row to install it, nothing searched.
    if (/^(npm:|git:|https:\/\/)/.test(query)) {
      featured.hidden = featuredHead.hidden = true;
      const ok = /^(npm:|git:|https:\/\/)[A-Za-z0-9@/._:+~-]{1,200}$/.test(query);
      const b = el("button", { type: "button", className: "secondary", textContent: "Install", disabled: !ok });
      b.addEventListener("click", () => installPackage(query));
      results.replaceChildren(el("div", { className: "pkg-row" }, packageTile(query.replace(/^(npm:|git:|https:\/\/)/, "")),
        el("span", { className: "tx" }, el("span", { className: "name" }, el("b", { textContent: query })),
          el("span", { className: "desc", textContent: ok ? "Installed as typed, in Pi's sandbox on the VM, in a tab." : "Not a source Pi installs: npm:name, git:host/user/repo or https://…" })), b));
      return;
    }
    results.replaceChildren(el("p", { className: "dim small", textContent: "Asking pi.dev, from the VM…" }));
    let answer;
    try {
      answer = await backend.api(["gallery", query]);
    } catch (e) {
      results.replaceChildren(el("p", { className: "error", textContent: String(e) }));
      return;
    }
    if (input.value.trim() !== query) return; // typed again meanwhile
    all = answer.results || [];
    where.textContent = answer.from === "npm" ? "From the npm registry (pi.dev did not answer), asked from the VM." : "From pi.dev/packages, asked from the VM.";
    render();
  }
  /** skills.sh's search (as `npx skills find`): two letters at least, no list without them. */
  async function searchSkills() {
    featured.hidden = featuredHead.hidden = true;
    where.textContent = "From skills.sh, asked from the VM. Installed with npx skills add, for Pi (.agents/skills).";
    if (query.length < 2) {
      all = [];
      results.replaceChildren(el("p", { className: "dim small", textContent: "Type what you look for: skills.sh searches from two letters." }));
      return;
    }
    results.replaceChildren(el("p", { className: "dim small", textContent: "Asking skills.sh, from the VM…" }));
    let answer;
    try {
      answer = await backend.api(["skills-search", query]);
    } catch (e) {
      results.replaceChildren(el("p", { className: "error", textContent: String(e) }));
      return;
    }
    if (input.value.trim() !== query || from !== "skills") return;
    all = (answer.skills || []).map((s) => ({ name: s.name, description: "", publisher: s.repo, downloads: installsText(s.installs), monthly: s.installs, types: ["skill"],
      source: s.source, repo: `https://github.com/${s.repo}`, page: s.page, isSkill: true }));
    render();
  }
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 400); });

  /** A README as Pier shows Markdown: its HTML tags and pictures left out (the pages load
   *  nothing from the web), a picture's words kept. */
  const readable = (text) => text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<img\b[^>]*>/gi, "").replace(/<\/?[a-z][^>]*>/gi, "").replace(/\n{3,}/g, "\n\n");

  /** A package's page, in place of the list: Back, its facts and Install, its picture, its
   *  links, its README. */
  function openPage(pkg) {
    const scroller = box.closest(".prefs-pages");
    const was = scroller?.scrollTop || 0;
    const back = el("button", { type: "button", className: "link back-to" }, svgIcon("arrow-left"), el("span", { textContent: "Back to packages" }));
    back.addEventListener("click", () => { pageView.hidden = true; listView.hidden = false; if (scroller) scroller.scrollTop = was; });
    const tile = packageTile(pkg.name, "head");
    const meta = el("p", { className: "pkg-facts", textContent: [pkg.publisher, pkg.downloads, ...(pkg.types || [])].filter(Boolean).join(" · ") });
    const links = el("div", { className: "pkg-links" });
    const link = (icon, text, url) => {
      const b = el("button", { type: "button", className: "pkg-link", title: url }, svgIcon(icon), el("span", { textContent: text }), svgIcon("external-link"));
      b.addEventListener("click", () => backend.openUrl(url).catch((e) => flashStatus(String(e))));
      return b;
    };
    const copy = linkButton("copy", `Copy ${pkg.source}`, () => backend.copyText(pkg.source).then(() => flashStatus("copied")).catch((e) => flashStatus(String(e))));
    const picture = el("div", { className: "pkg-picture", hidden: true });
    const overview = el("div", { className: "pkg-readme" }, el("p", { className: "dim small", textContent: "Reading its README, from the VM…" }));
    pageView.replaceChildren(back,
      el("div", { className: "pkg-head" }, tile, el("div", { className: "tx" }, el("h2", { textContent: pkg.name }), meta), installButton(pkg)),
      el("p", { className: "pkg-desc", textContent: pkg.description || "" }),
      picture,
      links,
      el("h3", { className: "loads-group", textContent: "Overview" }),
      overview);
    listView.hidden = true;
    pageView.hidden = false;
    if (scroller) scroller.scrollTop = 0;
    loadPackageMedia([pkg.name]).then(() => {
      tile.refresh();
      const url = packageMedia.get(pkg.name);
      if (url) { picture.replaceChildren(el("img", { src: url, alt: "" })); picture.hidden = false; }
    });
    links.append(...(pkg.repo ? [link("github", "GitHub", pkg.repo)] : []), el("span", { className: "pkg-src" }, el("code", { textContent: pkg.source }), copy));
    if (pkg.isSkill) {
      backend.api(["skill-page", pkg.source]).then((info) => {
        if (pageView.hidden) return;
        if (info.description) pageView.querySelector(".pkg-desc").textContent = info.description;
        const command = `npx skills add ${pkg.publisher} --skill ${pkg.source.split("/").pop()} --agent pi`;
        const copyCommand = linkButton("copy", "Copy the command", () => backend.copyText(command).then(() => flashStatus("copied")).catch((e) => flashStatus(String(e))));
        links.replaceChildren(link("github", "GitHub", info.repo), link("globe", "skills.sh", info.page),
          el("span", { className: "pkg-src" }, el("code", { textContent: command }), copyCommand));
        overview.replaceChildren(info.readme ? markdownPage(readable(info.readme)) : el("p", { className: "dim small", textContent: "Its SKILL.md was not found in its repository." }));
      }).catch((e) => overview.replaceChildren(el("p", { className: "error", textContent: String(e) })));
      return;
    }
    backend.api(["gallery-package", pkg.name]).then((info) => {
      if (pageView.hidden) return;
      meta.textContent = [pkg.publisher, pkg.downloads, ...(pkg.types || []), info.version && `v${info.version}`, info.license].filter(Boolean).join(" · ");
      links.replaceChildren(
        ...((info.repo || pkg.repo) ? [link("github", "GitHub", info.repo || pkg.repo)] : []),
        link("box", "npm", info.npm),
        ...(info.homepage ? [link("globe", "Website", info.homepage)] : []),
        el("span", { className: "pkg-src" }, el("code", { textContent: pkg.source }), copy));
      overview.replaceChildren(info.readme ? markdownPage(readable(info.readme)) : el("p", { className: "dim small", textContent: "No README." }));
    }).catch((e) => overview.replaceChildren(el("p", { className: "error", textContent: String(e) })));
  }

  drawFrom();
  return {
    shown() { if (!searched) search(); },
    installed(packages, skills = []) {
      const next = new Set((packages || []).map((p) => p.source.replace(/@[^@/]*$/, "")));
      const names = new Set((skills || []).map((s) => s.name));
      const changed = next.size !== installed.size || [...next].some((x) => !installed.has(x)) || names.size !== installedSkills.size || [...names].some((x) => !installedSkills.has(x));
      installed = next;
      installedSkills = names;
      if (searched && changed) render(); // its Install buttons say Installed
    },
  };
}
