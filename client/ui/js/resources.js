// Skills, extensions and prompts, and packages, in the Setup tab.

// ============================================================================
// What Pi loads, managed: each skill, extension and prompt turned on or off (as
// `pi config` does), local skills made, edited, imported from this computer or put in
// the bin, and packages installed from the gallery or a source (pi install, run in
// Pi's sandbox on the VM). See "managing what Pi loads" in the picker.
// ============================================================================

const KIND_LABELS = { skills: "Skills", extensions: "Extensions (they run code)", prompts: "Prompt templates" };
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
  (box.querySelector("input, select, textarea") || actions[0] || cancel).focus();
  return { close };
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
  return el("p", { className: "error", hidden: true });
}

/** The Skills page. onChange: after each load or change (the summary counts follow). */
function makeResourceManager(box, currentProject, onChange) {
  const error = el("p", { className: "error", hidden: true });
  const notice = el("p", { className: "notice", hidden: true });
  const filter = el("input", { type: "search", placeholder: "filter", spellcheck: false });
  const add = el("button", { className: "secondary", textContent: "+ Add ▾", title: "A new skill, a skill from this computer, a package" });
  const refresh = el("button", { className: "link", textContent: "refresh", title: "Read again what Pi loads" });
  const list = el("div", { className: "resource-lists" });
  box.replaceChildren(
    el("div", { className: "toolbar resource-bar" }, filter, add, refresh),
    error, notice, list,
    el("p", { className: "hint", textContent: "Unchecked: Pi leaves it out at its next start. Nothing is deleted." }));

  let data = null;
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

  function render() {
    list.innerHTML = "";
    const needle = filter.value.trim().toLowerCase();
    const shown = (item) => !needle || [item.name, item.description, item.source].some((t) => t && t.toLowerCase().includes(needle));
    for (const kind of ["skills", "extensions", "prompts"]) {
      const items = (data?.[kind] || []).filter(shown);
      if (!items.length) continue;
      list.append(el("h3", { textContent: `${KIND_LABELS[kind]} · ${items.length}` }));
      for (const [scope, label] of [["user", "Yours"], ["project", "This project"]]) {
        const mine = items.filter((item) => item.scope === scope);
        if (!mine.length) continue;
        const ul = el("ul", { className: "resource-items" });
        for (const item of mine) ul.append(row(kind, item));
        list.append(el("p", { className: "group dim small", textContent: label }), ul);
      }
    }
    if (!list.childElementCount) {
      list.append(el("p", { className: "dim small", textContent: needle ? "Nothing matches." : "No skill, extension or prompt yet: + Add makes one, imports one, or installs a package." }));
    }
  }

  function row(kind, item) {
    const li = el("li", { className: item.enabled ? "" : "off", title: [item.description, item.source ? `from ${item.source}` : item.path].filter(Boolean).join("\n") });
    const check = el("input", { type: "checkbox", checked: item.enabled, title: item.enabled ? "Loaded: uncheck to leave it out" : "Left out: check to load it" });
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
    li.append(
      check,
      el("span", { className: "name ellipsis", textContent: item.name }),
      el("span", { className: "dim small ellipsis", textContent: item.source ? item.source.replace(/^npm:/, "") : "local" }),
    );
    if (item.editable) {
      const name = item.rel.split("/")[1];
      const more = el("button", { className: "icon more", textContent: "⋯", title: "Edit, put in the bin" });
      more.addEventListener("click", () => showMenu(more, [
        ["Edit its SKILL.md…", () => editSkill(item.scope, name)],
        ["Put it in the bin", () => binSkill(item.scope, name)],
      ]));
      li.append(more);
    }
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

  return { load, loadFor, data: () => data };
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
  const install = el("button", { className: "secondary", textContent: "Install a package…", title: "pi install npm:… / git:… / https://…, in Pi's sandbox on the VM" });
  install.addEventListener("click", () => installDialog(currentProject, onDone));
  const input = el("input", { type: "search", placeholder: "search the gallery", spellcheck: false });
  const results = el("ul", { className: "resource-items gallery" });
  box.replaceChildren(
    el("div", { className: "toolbar" }, install),
    el("h2", { textContent: "Gallery" }),
    el("p", { className: "hint", textContent: "The packages tagged pi-package on npm (pi.dev/packages), searched from the VM." }),
    el("div", { className: "toolbar" }, input),
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
      // The name in full, then its version and author; the description on a line of its own.
      return el("li", { className: "two-lines", title: pkg.description || "" },
        el("div", { className: "line" },
          el("span", { className: "name", textContent: pkg.name }),
          el("span", { className: "dim small ellipsis", textContent: [pkg.version && `v${pkg.version}`, pkg.publisher].filter(Boolean).join(" · ") }),
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
