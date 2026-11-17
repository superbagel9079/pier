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
  const close = () => { overlay.remove(); release(); };
  cancel.addEventListener("click", close);
  box.append(el("h1", { textContent: title }), ...body, el("div", { className: "actions end" }, cancel, ...actions));
  overlay.append(box);
  overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(); });
  document.body.append(overlay);
  release = trapDialog(box, close);
  // Its lists as picks now (ui.js would do it a frame later, after the focus is placed).
  for (const select of box.querySelectorAll("select")) pickify(select);
  ([...box.querySelectorAll("input, textarea, button.pick")].find((e) => !e.hidden && e.offsetParent) || actions[0] || cancel).focus();
  return { close, box };
}

/** "for you / for this project": where a new skill or a package goes. */
function scopeChoice(value = "user") {
  const select = el("select", { title: "Where it goes" });
  select.add(new Option("for you (every project)", "user"));
  select.add(new Option("for this project only", "project"));
  select.value = value;
  return select;
}

function dialogError() {
  return el("p", { className: "error", role: "alert", hidden: true });
}

/** The Skills page. onChange: after each load or change (the summary counts follow). */
function makeResourceManager(box, currentProject, onChange) {
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
    error, notice, list, off);

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
    const items = (data?.[kind] || []).filter(shown);
    // Pier's own extensions: given to each Pi it starts (--extension), never in Pi's
    // settings; shown, not toggled here (each has its setting in the picker's config).
    const pier = kind === "extensions" ? (data?.pier || []).filter(shown) : [];
    const rows = el("div", { className: "rows" },
      ...items.filter((i) => i.scope === "user").map((i) => row(kind, i)),
      ...items.filter((i) => i.scope === "project").map((i) => row(kind, i)),
      ...pier.map(pierRow));
    if (rows.childElementCount) list.append(rows);
    else list.append(el("p", { className: "dim small", textContent: needle ? "Nothing matches." : `No ${KIND_LABELS[kind].toLowerCase()} yet: Add makes one, imports one, or installs a package.` }));
    off.hidden = !rows.childElementCount;
  }

  /** Where an item comes from, in words: "yours, local", "from pi-hindsight", "this project only". */
  const origin = (item) => (item.scope === "project" ? "this project only"
    : item.source ? `from ${item.source.replace(/^npm:/, "")}` : "yours, local");
  const said = (description, from) => [description, from].filter(Boolean).join(" · ");

  /** One of Pier's extensions: whether the next Pi gets it, and (its title) how to change
   *  that. */
  function pierRow(item) {
    const how = item.setting
      ? `${item.setting} = ${item.enabled ? "false" : "true"} in ~/.config/pier-picker/config.toml, the picker's config on the VM`
      : "set up a lab host in Labs";
    const check = el("input", { type: "checkbox", checked: item.enabled, disabled: true }); // its state, not a control
    check.setAttribute("aria-label", item.name);
    return el("div", { className: item.enabled ? "set" : "set off" },
      el("div", { className: "what" }, el("span", { textContent: item.name }), el("span", { textContent: said(item.description, "Pier's, given to each Pi it starts") })),
      el("span", { className: "switch-hint", title: `To ${item.enabled ? "leave it out" : "have it"}: ${how}` }, check)); // a disabled switch gets no pointer events
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
      el("div", { className: "grid fields" },
        el("label", { textContent: "Where" }), scope,
        el("label", { textContent: "Name" }), name,
        el("label", { textContent: "Description" }), description),
      el("p", { className: "hint", textContent: "A name: lowercase letters, digits and single hyphens. It opens to edit once made." }),
      problem], [create]);
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
      el("div", { className: "grid fields" }, el("label", { textContent: "Where" }), scope),
      el("p", { className: "hint", textContent: "A folder of this computer that holds a SKILL.md: it is copied into the skills, under the name it declares." }),
      problem], [choose]);
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
    filter.placeholder = `Filter ${KIND_LABELS[kind].toLowerCase()}`;
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
  const line = (name, detail, title, ...actions) => el("li", { title: title || "" },
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
  if (!(r.packages || []).length) list.append(el("li", { className: "dim small note", textContent: "No package yet: install one, or find one in the gallery below." }));
}

/** Installing a package: a source, for you or the project, then pi install in a tab. */
function installDialog(currentProject, onDone, source = "") {
  const scope = scopeChoice();
  const input = el("input", { placeholder: "npm:package, git:github.com/user/repo, https://…", spellcheck: false, value: source });
  const problem = dialogError();
  const install = el("button", { textContent: "Install" });
  const dialog = resourceDialog("Install a package", [
    el("div", { className: "grid fields" },
      el("label", { textContent: "Where" }), scope,
      el("label", { textContent: "Source" }), input),
    el("p", { className: "hint", textContent: PACKAGE_WARNING }),
    problem], [install]);
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

/** Under the packages: Install a package…, and the gallery, searched as you type. */
function makePackageTools(box, currentProject, onDone) {
  const install = el("button", { className: "secondary", title: "pi install npm:… / git:… / https://…, in Pi's sandbox on the VM" }, svgIcon("plus"), el("span", { textContent: "Install a package…" }));
  install.addEventListener("click", () => installDialog(currentProject, onDone));
  const input = el("input", { type: "search", placeholder: "Search the gallery", spellcheck: false });
  input.setAttribute("aria-label", "Search the gallery");
  const results = el("ul", { className: "resource-items gallery" });
  box.replaceChildren(
    el("h2", {}, el("span", { textContent: "Gallery" }), el("span", { className: "aside", textContent: "pi.dev/packages, searched from the VM" })),
    el("div", { className: "resource-bar" }, input, install),
    results);
  let installed = new Set();
  let searched = false;
  let timer = null;

  async function search() {
    searched = true;
    results.replaceChildren(el("li", { className: "dim small", textContent: "asking the npm registry, from the VM…" }));
    let answer;
    try {
      answer = await backend.api(["gallery", input.value.trim()]);
    } catch (e) {
      results.replaceChildren(el("li", { className: "error", textContent: String(e) }));
      return;
    }
    results.replaceChildren(...answer.results.map((pkg) => {
      const there = installed.has(pkg.source);
      const action = el("button", { className: "link", textContent: there ? "installed" : "install", disabled: there });
      action.addEventListener("click", () => installDialog(currentProject, onDone, pkg.source));
      // The name in full, then its version (from npm), author and downloads a month (from
      // pi.dev); the description on a line of its own.
      return el("li", { className: "two-lines", title: pkg.description || "" },
        el("div", { className: "line" },
          el("span", { className: "name", textContent: pkg.name }),
          el("span", { className: "dim small ellipsis", textContent: [pkg.version && `v${pkg.version}`, pkg.publisher, pkg.downloads].filter(Boolean).join(" · ") }),
          action),
        pkg.description ? el("div", { className: "desc dim small", textContent: pkg.description }) : null);
    }));
    if (!answer.results.length) results.append(el("li", { className: "dim small", textContent: "Nothing found." }));
  }
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 400); });
  // Asked once the field is used, not at every Setup refresh.
  input.addEventListener("focus", () => { if (!searched) search(); });

  return {
    shown() { if (!searched) search(); },
    installed(packages) { installed = new Set((packages || []).map((p) => p.source.replace(/@[^@/]*$/, ""))); },
  };
}
