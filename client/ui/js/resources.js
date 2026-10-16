// Skills, extensions and prompts, in the Setup tab.

// ============================================================================
// What Pi loads, managed: each skill, extension and prompt turned on or off (as
// `pi config` does), local skills made, edited, imported from this computer or put in
// the bin, and packages installed from the gallery or a source (pi install, run in
// Pi's sandbox on the VM). See "managing what Pi loads" in the picker.
// ============================================================================

const KIND_LABELS = { skills: "Skills", extensions: "Extensions (they run code)", prompts: "Prompt templates" };

/** Opens `pi install` or `pi remove` in a terminal tab: what npm does stays visible. */
function openPackageTerminal(action, scope, source, label, onDone) {
  workspace.add("update", workspace.find("main")?.dock || "center", {
    params: { label: `${action} ${label}`, termKind: "package", args: [action, scope, source], onDone },
  });
}

function makeResourceManager(box, currentProject) {
  const list = el("div", { className: "resource-lists" });
  const error = el("p", { className: "error", hidden: true });
  const notice = el("p", { className: "notice", hidden: true });
  const scope = el("select", { title: "Where it goes" });
  scope.add(new Option("for you (every project)", "user"));
  scope.add(new Option("for this project only", "project"));
  const tools = el("div", { className: "resource-tools" });
  const panel = el("div", { className: "resource-panel", hidden: true });
  const button = (text, title, action) => {
    const b = el("button", { className: "secondary", textContent: text, title });
    b.addEventListener("click", action);
    return b;
  };
  tools.append(
    scope,
    button("Install a package…", "pi install npm:… / git:… / https://…, in Pi's sandbox on the VM", () => showInstall()),
    button("Browse the gallery…", "Packages for Pi (pi.dev/packages)", () => showGallery()),
    button("New skill…", "A skill of your own, from a template", () => showNewSkill()),
    button("Import a skill…", "A folder of this computer that holds a SKILL.md", () => importSkill()),
  );
  const refresh = el("button", { className: "link", textContent: "refresh", title: "Read again what Pi loads" });
  refresh.addEventListener("click", () => load());
  box.replaceChildren(el("div", { className: "resource-head" },
    el("span", { className: "dim small", textContent: "Checked: Pi loads it at its next start. Unchecked: it is left out, nothing is deleted." }), refresh),
    error, notice, list, tools, panel);

  let data = null;
  const target = () => (scope.value === "project" ? currentProject() : "user");
  const say = (text) => { notice.hidden = !text; notice.textContent = text || ""; };

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
  }

  function render() {
    list.innerHTML = "";
    for (const kind of ["skills", "extensions", "prompts"]) {
      const items = data?.[kind] || [];
      if (!items.length) continue;
      const ul = el("ul", { className: "startup resource-items" });
      for (const item of items) ul.append(row(kind, item));
      list.append(el("h3", { textContent: `${KIND_LABELS[kind]} (${items.length})` }), ul);
    }
    if (!list.childElementCount) list.append(el("p", { className: "dim small", textContent: "No skill, extension or prompt yet: make one, import one, or install a package." }));
  }

  function row(kind, item) {
    const li = el("li", { title: [item.description, item.source ? `from ${item.source}` : item.path].filter(Boolean).join("\n") });
    const check = el("input", { type: "checkbox", checked: item.enabled, title: item.enabled ? "Loaded: uncheck to leave it out" : "Left out: check to load it" });
    check.addEventListener("change", async () => {
      check.disabled = true;
      try {
        await backend.resourceToggle(item.scope, currentProject(), kind, item.source || "", item.rel, check.checked);
        item.enabled = check.checked;
        say(`${item.name}: ${check.checked ? "loaded" : "left out"} from the next start of Pi.`);
      } catch (e) {
        check.checked = !check.checked;
        showError(error, String(e));
      } finally {
        check.disabled = false;
      }
    });
    li.append(
      check,
      el("span", { className: "scope", textContent: item.scope === "project" ? "project" : "you" }),
      el("span", { className: "ellipsis", textContent: item.name }),
      el("span", { className: "dim small ellipsis", textContent: item.source ? item.source.replace(/^npm:/, "") : "local" }),
    );
    if (item.editable) {
      const name = item.rel.split("/")[1];
      const actions = el("span", { className: "row-actions" });
      const edit = el("button", { className: "link", textContent: "edit", title: "Its SKILL.md" });
      edit.addEventListener("click", () => editSkill(item.scope, name));
      const bin = el("button", { className: "icon", textContent: "×", title: "Put it in the bin (kept on the VM, in ~/.local/state/pier-picker/trash)" });
      bin.addEventListener("click", async () => {
        if (!(await ask(`Put the skill ${name} in the bin? Pi stops loading it; it stays recoverable on the VM.`))) return;
        try {
          const done = await backend.skillDelete(item.scope, currentProject(), name);
          say(`${name} is in the bin: ${done.kept}`);
          load();
        } catch (e) { showError(error, String(e)); }
      });
      actions.append(edit, bin);
      li.append(actions);
    }
    return li;
  }

  function openPanel(...children) {
    panel.replaceChildren(...children);
    panel.hidden = false;
  }
  const closeButton = () => {
    const b = el("button", { className: "link", textContent: "close" });
    b.addEventListener("click", () => { panel.hidden = true; panel.innerHTML = ""; });
    return b;
  };
  const warning = () => el("p", { className: "hint", textContent:
    "A package's extensions run code with your rights when Pi starts, and its skills can tell Pi to do anything. "
    + "Look at its source before installing it. The installation itself runs in Pi's sandbox on the VM." });

  function showInstall() {
    const input = el("input", { placeholder: "npm:package, git:github.com/user/repo, https://…", spellcheck: false });
    const go = el("button", { textContent: "Install" });
    const install = () => {
      const source = input.value.trim();
      if (!/^(npm:|git:|https:\/\/)[A-Za-z0-9@/._:+~-]{1,200}$/.test(source)) { showError(error, "A source starts with npm:, git: or https://"); return; }
      showError(error, "");
      openPackageTerminal("install", target(), source, source.replace(/^npm:/, ""), load);
      say(`Installing ${source} in a terminal; "refresh" here once it is done.`);
    };
    go.addEventListener("click", install);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") install(); });
    openPanel(el("h3", { textContent: `Install a package ${scope.value === "project" ? "for this project" : "for you"}` }),
      el("div", { className: "toolbar" }, input, go, closeButton()), warning());
    input.focus();
  }

  function showGallery() {
    const input = el("input", { type: "search", placeholder: "search the gallery (empty: all)", spellcheck: false });
    const results = el("ul", { className: "startup gallery" });
    let timer = null;
    const search = async () => {
      results.replaceChildren(el("li", { className: "dim small", textContent: "asking the npm registry, from the VM…" }));
      let answer;
      try {
        answer = await backend.api(["gallery", input.value.trim()]);
      } catch (e) {
        results.replaceChildren(el("li", { className: "error", textContent: String(e) }));
        return;
      }
      const installed = new Set((data?.packages || []).map((p) => p.source.replace(/@[^@/]*$/, "")));
      results.replaceChildren(...answer.results.map((pkg) => {
        const li = el("li", { title: pkg.description || "" });
        const there = installed.has(pkg.source);
        const action = el("button", { className: "link", textContent: there ? "installed" : "install", disabled: there });
        action.addEventListener("click", () => {
          openPackageTerminal("install", target(), pkg.source, pkg.name, load);
          say(`Installing ${pkg.name} in a terminal; "refresh" here once it is done.`);
        });
        li.append(
          el("span", { className: "ellipsis", textContent: pkg.name }),
          el("span", { className: "dim small ellipsis", textContent: [pkg.version && `v${pkg.version}`, pkg.publisher, pkg.description].filter(Boolean).join(" · ") }),
          action,
        );
        return li;
      }));
      if (!answer.results.length) results.append(el("li", { className: "dim small", textContent: "Nothing found." }));
    };
    input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 400); });
    openPanel(el("h3", { textContent: "The gallery (packages tagged pi-package)" }),
      el("div", { className: "toolbar" }, input, closeButton()), warning(), results);
    input.focus();
    search();
  }

  function showNewSkill() {
    const name = el("input", { placeholder: "name: my-skill (lowercase, digits, hyphens)", spellcheck: false });
    const description = el("input", { placeholder: "what it does, and when Pi should use it", spellcheck: false });
    const go = el("button", { textContent: "Create" });
    go.addEventListener("click", async () => {
      try {
        const made = await backend.skillCreate(scope.value, currentProject(), name.value.trim(), description.value.trim());
        await load();
        editSkill(scope.value, made.name);
      } catch (e) { showError(error, String(e)); }
    });
    openPanel(el("h3", { textContent: `New skill ${scope.value === "project" ? "for this project" : "for you"}` }),
      el("div", { className: "toolbar" }, name, description, go, closeButton()));
    name.focus();
  }

  async function editSkill(where, name) {
    let text;
    try {
      text = (await backend.api(["skill-read", where, currentProject(), name])).text;
    } catch (e) { showError(error, String(e)); return; }
    const area = el("textarea", { className: "editor", spellcheck: false, rows: 14, value: text });
    const save = el("button", { textContent: "Save" });
    save.addEventListener("click", async () => {
      try {
        await backend.skillSave(where, currentProject(), name, area.value);
        say(`${name} saved: Pi reads it at its next start.`);
        load();
      } catch (e) { showError(error, String(e)); }
    });
    area.addEventListener("keydown", (e) => { if (e.ctrlKey && e.key === "s") { e.preventDefault(); save.click(); } });
    openPanel(el("h3", { textContent: `${name} · SKILL.md (${where === "project" ? "this project" : "you"})` }), area,
      el("div", { className: "actions" }, save, closeButton()));
    area.focus();
  }

  async function importSkill() {
    const folder = await backend.pickFolder();
    if (!folder) return;
    try {
      const done = await backend.skillImport(scope.value, currentProject(), folder);
      say(`${done.name} imported ${scope.value === "project" ? "into this project" : "for you"}.`);
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

  return { load, loadFor };
}
