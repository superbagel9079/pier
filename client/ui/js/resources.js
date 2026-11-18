// Skills, extensions and prompts, and packages, in the Project panel.

// What Pi loads, managed: skills, extensions, prompts on or off (as `pi config`), local skills
// made, edited, imported; packages installed (pi install, in Pi's sandbox on the VM).

const KIND_LABELS = { skills: "Skills", extensions: "Extensions", prompts: "Prompts" };
const PACKAGE_WARNING = "A package's extensions run code with your rights when Pi starts, and its skills can tell Pi to do anything. "
  + "Look at its source before installing it. The installation itself runs in Pi's sandbox on the VM.";

/** Opens `pi install` or `pi remove` in a terminal tab: what npm does stays visible. */
function openPackageTerminal(action, scope, source, label, onDone) {
  workspace.add("update", workspace.find("main")?.dock || "center", {
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

/** "for you / for this project": where a new skill or a package goes. */
function scopeChoice(value = "user") {
  const select = el("select", { title: "Where it goes" });
  select.add(new Option("You, in every project", "user"));
  select.add(new Option("This project only", "project"));
  select.value = value;
  return select;
}

/** A dialog's field as Pier's others (Start a project, a provider): its name above, a hint under. */
function dialogField(label, control, hint = "") {
  return el("label", { className: "provider-field" }, el("span", { textContent: label }), control, hint ? el("small", { textContent: hint }) : null);
}

function dialogError() {
  return el("p", { className: "error", role: "alert", hidden: true });
}

/** The Skills page. onChange: after each load or change (the summary counts follow). */
function makeResourceManager(box, currentProject, onChange, top = null) {
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
  box.replaceChildren(
    el("div", { className: "toolbar resource-bar" }, filter, add, refresh),
    error, notice, ...(top ? [top] : []), list, off);

  let data = null;
  let kind = "skills"; // the tab shown (settings.js): skills, extensions or prompts
  const say = noticeSetter(notice);

  add.addEventListener("click", () => showMenu(add, [
    ["New skill…", () => newSkill()],
    ["Import a skill from this computer…", () => importSkill()],
    null,
    ["Install a package…", () => installDialog(currentProject, () => load())],
  ]));
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
    const shown = (item) => !needle || [item.name, item.description, item.source].some((t) => t && t.toLowerCase().includes(needle));
    // "all" (Installed): skills, extensions and prompts, one group under the other.
    const kinds = kind === "all" ? Object.keys(KIND_LABELS) : [kind];
    let any = false;
    for (const k of kinds) {
      const items = (data?.[k] || []).filter(shown);
      // Pier's own extensions: given to each Pi it starts (--extension), never in Pi's
      // settings; shown, not toggled here (each has its setting in the picker's config).
      const pier = k === "extensions" ? (data?.pier || []).filter(shown) : [];
      const rows = el("div", { className: "rows" },
        ...items.filter((i) => i.scope === "user").map((i) => row(k, i)),
        ...items.filter((i) => i.scope === "project").map((i) => row(k, i)),
        ...pier.map(pierRow));
      if (!rows.childElementCount) continue;
      any = true;
      if (kind === "all") list.append(el("h3", { className: "loads-group" }, el("span", { textContent: KIND_LABELS[k] }), el("span", { className: "n", textContent: String(rows.childElementCount) })));
      list.append(rows);
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
      el("div", { className: "what" }, el("span", { textContent: item.name }), el("span", { textContent: said(item.description, "Pier's, given to each Pi it starts") })),
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
        ["Edit its SKILL.md…", () => editSkill(item.scope, name)],
        ["Put it in the bin", () => binSkill(item.scope, name)],
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
      say(`${name} is in the bin: ${done.kept}`);
      load();
    } catch (e) { showError(error, String(e)); }
  }

  function newSkill() {
    const scope = scopeChoice();
    const name = el("input", { placeholder: "my-skill", spellcheck: false });
    const description = el("input", { placeholder: "what it does, and when Pi should use it", spellcheck: false });
    const problem = dialogError();
    const create = el("button", { textContent: "Create" });
    const dialog = resourceDialog("New skill", [
      dialogField("Name", name, "Lowercase letters, digits and single hyphens. It opens to edit once made."),
      dialogField("Description", description),
      dialogField("For", scope),
      problem], [create]);
    dialog.box.classList.add("provider-dialog");
    const go = async () => {
      try {
        const made = await backend.skillCreate(scope.value, currentProject(), name.value.trim(), description.value.trim());
        dialog.close();
        await load();
        editSkill(scope.value, made.name);
      } catch (e) { showError(problem, String(e)); }
    };
    create.addEventListener("click", go);
    for (const input of [name, description]) input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    name.focus();
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

  function importSkill() {
    const scope = scopeChoice();
    const problem = dialogError();
    const choose = el("button", { textContent: "Choose a folder…" });
    const dialog = resourceDialog("Import a skill", [
      el("p", { className: "hint", textContent: "A folder of this computer that holds a SKILL.md: it is copied into the skills, under the name it declares." }),
      dialogField("For", scope),
      problem], [choose]);
    dialog.box.classList.add("provider-dialog");
    choose.addEventListener("click", async () => {
      const folder = await backend.pickFolder();
      if (!folder) return;
      try {
        const done = await backend.skillImport(scope.value, currentProject(), folder);
        dialog.close();
        say(`${done.name} imported ${scope.value === "project" ? "into this project" : "for you"}.`);
        load();
      } catch (e) { showError(problem, String(e)); }
    });
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

  return { load, loadFor, show, data: () => data };
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
  const update = (label, args, title) => linkButton("update", title, () => {
    workspace.add("update", workspace.find("main")?.dock || "center", { params: { label, args } });
  });
  const tiles = [];
  const line = (name, detail, title, ...actions) => el("li", { title: title || "" },
    (() => { const t = packageTile(name.startsWith("Pi ") ? "pi" : name); tiles.push([name, t]); return t; })(),
    el("span", { className: "name ellipsis", textContent: name }),
    el("span", { className: "dim small ellipsis", textContent: detail || "" }),
    actions.length ? el("span", { className: "row-actions" }, ...actions) : null);
  if (r.pi?.version) {
    const behind = newerVersion(r.pi.latest, r.pi.version);
    list.append(line(`Pi ${r.pi.version}`, behind ? `${r.pi.latest} available` : r.pi.latest ? "up to date" : "",
      "Pi itself. Running Pis keep their version until they restart.",
      ...(behind ? [update("Pi", [], "pi update, in a terminal")] : [])));
  }
  let outdated = 0;
  for (const p of r.packages || []) {
    const name = p.source.replace(/^npm:/, "");
    const behind = p.installed !== false && newerVersion(p.latest, p.version);
    outdated += behind ? 1 : 0;
    const detail = p.installed === false ? "not installed" : behind ? `v${p.version} → ${p.latest}` : p.version ? `v${p.version}` : "";
    const remove = linkButton("remove", `pi remove ${p.source}, in a terminal (in Pi's sandbox)`, async () => {
      if (!(await ask(`Remove the package ${name}? Pi stops loading its skills and extensions at its next start.`))) return;
      openPackageTerminal("remove", p.scope === "project" ? project : "user", p.source, name, reload);
    });
    list.append(line(name, [p.scope === "project" ? "this project" : "", detail].filter(Boolean).join(" · "),
      [p.source, p.description].filter(Boolean).join(": "),
      ...(behind ? [update(name, [p.source], `pi update ${p.source}, in a terminal`)] : []), remove));
  }
  if (outdated > 1) list.append(el("li", { className: "note small" }, update("all packages", ["--extensions"], "pi update --extensions, in a terminal")));
  if (!(r.packages || []).length) list.append(el("li", { className: "dim small note", textContent: "No package yet: find one in Browse." }));
  showPackageMedia(tiles.filter(([name]) => !name.startsWith("Pi ")).map(([, t]) => t));
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

/** Installing a package: a source, for you or the project, then pi install in a tab. */
function installDialog(currentProject, onDone, source = "") {
  const scope = scopeChoice();
  const input = el("input", { placeholder: "npm:pi-hindsight", spellcheck: false, value: source });
  const problem = dialogError();
  const install = el("button", { textContent: "Install" });
  const dialog = resourceDialog("Install a package", [
    dialogField("Source", input, "npm:, git: or https://"),
    dialogField("For", scope),
    el("p", { className: "hint", textContent: PACKAGE_WARNING }),
    problem], [install]);
  dialog.box.classList.add("provider-dialog");
  const go = () => {
    const value = input.value.trim();
    if (!/^(npm:|git:|https:\/\/)[A-Za-z0-9@/._:+~-]{1,200}$/.test(value)) { showError(problem, "A source starts with npm:, git: or https://"); return; }
    dialog.close();
    openPackageTerminal("install", scope.value === "project" ? currentProject() : "user", value, value.replace(/^npm:/, ""), onDone);
  };
  install.addEventListener("click", go);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  input.focus();
}

/** Browse (the proposals' 1A, as Paseo's plugins): pi.dev's packages searched as you type,
 *  the first ones with a picture as featured cards, then the list; a click shows a package's
 *  detail beside the list, Install on its row and there. */
function makePackageTools(box, currentProject, onDone) {
  const install = el("button", { className: "secondary", title: "pi install npm:… / git:… / https://…, in Pi's sandbox on the VM" }, svgIcon("plus"), el("span", { textContent: "Install from a source…" }));
  install.addEventListener("click", () => installDialog(currentProject, onDone));
  const input = el("input", { type: "search", placeholder: "Search pi.dev's packages", spellcheck: false });
  input.setAttribute("aria-label", "Search the packages");
  const featured = el("div", { className: "pkg-featured" });
  const featuredHead = el("h3", { className: "loads-group", textContent: "Featured" });
  const results = el("div", { className: "pkg-list" });
  const detail = el("aside", { className: "pkg-detail", hidden: true });
  const where = el("p", { className: "hint pkg-from" });
  box.replaceChildren(
    el("div", { className: "toolbar resource-bar" }, input, install),
    featuredHead, featured,
    el("h3", { className: "loads-group", textContent: "All packages" }),
    el("div", { className: "pkg-browse" }, results, detail),
    where);
  let installed = new Set();
  let searched = false;
  let timer = null;
  let shownName = null;

  const facts = (pkg) => [pkg.publisher, pkg.downloads].filter(Boolean).join(" · ");
  const installButton = (pkg) => {
    const there = installed.has(pkg.source);
    const b = el("button", { type: "button", className: there ? "secondary pkg-installed" : "secondary", textContent: there ? "Installed" : "Install", disabled: there });
    b.addEventListener("click", (e) => { e.stopPropagation(); installDialog(currentProject, onDone, pkg.source); });
    return b;
  };

  function showDetail(pkg) {
    shownName = pkg.name;
    for (const r of results.children) r.classList.toggle("on", r.dataset.name === pkg.name);
    const close = el("button", { type: "button", className: "icon-btn", title: "Close" }, svgIcon("x"));
    close.addEventListener("click", () => { detail.hidden = true; shownName = null; for (const r of results.children) r.classList.remove("on"); });
    const copy = (text) => { const b = linkButton("copy", `Copy ${text}`, () => backend.copyText(text).then(() => flashStatus("copied")).catch((e) => flashStatus(String(e)))); return b; };
    const tile = packageTile(pkg.name, "big");
    detail.replaceChildren(
      el("div", { className: "pkg-detail-head" }, tile, close),
      el("h3", { textContent: pkg.name }),
      el("p", { className: "dim small", textContent: facts(pkg) }),
      ...(pkg.types?.length ? [el("p", { className: "pkg-types" }, ...pkg.types.map((t) => el("span", { className: "chip", textContent: t })))] : []),
      el("p", { className: "pkg-desc", textContent: pkg.description || "No description." }),
      el("p", { className: "pkg-src" }, el("code", { textContent: pkg.source }), copy(pkg.source)),
      ...(pkg.repo ? [el("p", { className: "pkg-src" }, el("span", { className: "dim small ellipsis", textContent: pkg.repo.replace(/^https:\/\//, "") }), copy(pkg.repo))] : []),
      installButton(pkg));
    detail.hidden = false;
    showPackageMedia([tile]);
  }

  function row(pkg) {
    const tile = packageTile(pkg.name);
    const r = el("button", { type: "button", className: "pkg-row" }, tile,
      el("span", { className: "tx" },
        el("span", { className: "name" }, el("b", { textContent: pkg.name }), ...(pkg.types || []).map((t) => el("span", { className: "chip", textContent: t }))),
        pkg.description ? el("span", { className: "desc", textContent: pkg.description }) : null,
        el("span", { className: "by", textContent: facts(pkg) })),
      installButton(pkg), svgIcon("chevron-right"));
    r.dataset.name = pkg.name;
    r.addEventListener("click", () => showDetail(pkg));
    return [r, tile];
  }

  function card(pkg) {
    const tile = packageTile(pkg.name, "shot");
    const c = el("button", { type: "button", className: "pkg-card" }, tile,
      el("span", { className: "tx" }, el("b", { textContent: pkg.name }), el("span", { className: "desc", textContent: pkg.description || "" }), el("span", { className: "by", textContent: facts(pkg) })));
    c.addEventListener("click", () => showDetail(pkg));
    return [c, tile];
  }

  async function search() {
    searched = true;
    const query = input.value.trim();
    results.replaceChildren(el("p", { className: "dim small", textContent: "Asking pi.dev, from the VM…" }));
    let answer;
    try {
      answer = await backend.api(["gallery", query]);
    } catch (e) {
      results.replaceChildren(el("p", { className: "error", textContent: String(e) }));
      return;
    }
    if (input.value.trim() !== query) return; // typed again meanwhile
    const list = answer.results || [];
    const rows = list.map(row);
    results.replaceChildren(...rows.map(([r]) => r));
    if (!list.length) results.append(el("p", { className: "dim small", textContent: "Nothing found." }));
    where.textContent = answer.from === "npm" ? "From the npm registry (pi.dev did not answer), asked from the VM." : "From pi.dev/packages, asked from the VM.";
    // Featured, without a search: the most installed that have a picture.
    featured.replaceChildren();
    featured.hidden = featuredHead.hidden = Boolean(query);
    const top = list.slice(0, 16);
    await loadPackageMedia(top.map((p) => p.name));
    rows.forEach(([, t]) => t.refresh());
    showPackageMedia(rows.slice(16).map(([, t]) => t));
    if (!query && input.value.trim() === query) {
      const withPicture = top.filter((p) => packageMedia.get(p.name));
      const cards = [...withPicture, ...top.filter((p) => !packageMedia.get(p.name))].slice(0, 3).map(card);
      featured.replaceChildren(...cards.map(([c]) => c));
      cards.forEach(([, t]) => t.refresh());
    }
    const again = list.find((p) => p.name === shownName);
    if (again) showDetail(again);
  }
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 400); });

  return {
    shown() { if (!searched) search(); },
    installed(packages) {
      const next = new Set((packages || []).map((p) => p.source.replace(/@[^@/]*$/, "")));
      const changed = next.size !== installed.size || [...next].some((s) => !installed.has(s));
      installed = next;
      if (searched && changed) search(); // its Install buttons say Installed (the picker keeps the answer 10 min)
    },
  };
}
