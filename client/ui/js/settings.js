// Settings > Agents and Network & sandbox: keys of the picker's config.toml on the VM
// (and Pi's own default model), read and written through the picker, which checks each.

// The picker's config, from Pier

let pickerConfig = null;   // {keys: {key: {value, default, set}}, path, warning, network_builtin, writable}
let piModels = null;       // {models: ["provider/id"], providers, default, problem}
let piModelsAsked = null;  // the call under way: `pi --list-models` takes a moment

async function loadPickerConfig() {
  pickerConfig = await backend.api(["config"]);
  return pickerConfig;
}

function loadPiModels(again = false) {
  if (again) { piModels = null; piModelsAsked = null; }
  piModelsAsked ||= backend.api(["models"]).then((answer) => (piModels = answer)).catch((error) => {
    piModels = { models: [], providers: [], default: "", problem: String(error) };
    return piModels;
  });
  return piModelsAsked;
}

/** A page of settings shown: drawn from the VM's config each time (another Pier, or a
 *  hand edit of config.toml, may have changed it). */
function settingsPageShown(page) {
  if (page === "agents") drawAgents();
  else if (page === "network") drawNetwork();
  else if (page === "git") drawForges();
  else if (page === "extensions") drawExtensions();
}

const configValue = (key) => pickerConfig?.keys?.[key]?.value;

/** key = value in config.toml (null: back to the default), then the page drawn again. */
async function setConfig(key, value, page, note) {
  try {
    await backend.configSet(key, value);
    uiLog("info", "config-set", { key, reset: value === null });
    await loadPickerConfig();
    flashStatus(value === null ? `${key}: back to its default` : `${key} saved: for the Pis started from now on`);
  } catch (error) {
    note?.(String(error));
    return false;
  }
  if (page === "agents") drawAgents(false);
  else if (page === "git") drawForges();
  else drawNetwork(false);
  return true;
}

/** One setting: its label and control on a line, what it does under it. No "reset": the
 *  control itself goes back (a switch, "Pi's default", a number typed again). */
function settingRow(key, label, control, hint, page) {
  const row = el("div", { className: "setting-row" });
  row.dataset.key = key;
  const id = `setting-${key}`;
  const field = control.input || control; // a model picker: its field
  if (field.matches?.("input, select")) field.id = id;
  const error = el("p", { className: "error", hidden: true });
  const head = el("div", { className: "setting-head" },
    el("label", { htmlFor: id, textContent: label }), control);
  row.append(head);
  if (hint) row.append(el("p", { className: "hint", textContent: hint }));
  row.append(el("p", { className: "dim small setting-key", textContent: key }), error);
  row.say = noticeSetter(error);
  return row;
}

/** A yes/no setting; asked first when turning it off weakens a protection. */
function toggleRow(key, label, hint, page, { confirmOff } = {}) {
  const box = el("input", { type: "checkbox", checked: Boolean(configValue(key)) });
  const row = settingRow(key, label, box, hint, page);
  row.classList.add("toggle");
  box.addEventListener("change", async () => {
    if (!box.checked && confirmOff && !(await ask(confirmOff))) { box.checked = true; return; }
    if (!(await setConfig(key, box.checked, page, row.say))) box.checked = !box.checked;
  });
  return row;
}

/** A model: typed, or chosen in Pier's own list of Pi's models (the browser's would be
 *  drawn by the system, out of the theme, and filtered by what the field holds). The
 *  whole list on opening; what is typed narrows it. ↑ ↓ choose, Enter takes, Esc closes.
 *  onCommit(value) once the value really changed. empty: the placeholder, and when
 *  emptyChoice, a first entry that clears the field (back to Pi's default). */
let comboIds = 0;
function modelPicker(value, empty, onCommit, { emptyChoice = false } = {}) {
  const n = ++comboIds;
  const input = el("input", { type: "text", value: value || "", placeholder: empty, spellcheck: false, autocomplete: "off", className: "model-input" });
  const list = el("ul", { className: "combo-list", id: `combo-${n}`, hidden: true });
  const toggle = el("button", { className: "icon combo-toggle", textContent: "▾", title: "Pi's models", tabIndex: -1 });
  const box = el("span", { className: "combo" }, input, toggle, list);
  box.input = input;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-autocomplete", "list");
  list.setAttribute("role", "listbox");
  let committed = input.value.trim();
  let shown = [];
  let at = -1;
  let typed = false; // the list narrows only once something is typed

  const commit = () => {
    const v = input.value.trim();
    if (v === committed) return;
    committed = v;
    onCommit(v);
  };
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); };
  const mark = (i) => {
    at = i;
    [...list.children].forEach((li, j) => li.setAttribute("aria-selected", String(j === i)));
    const li = list.children[i];
    if (li) { input.setAttribute("aria-activedescendant", li.id); li.scrollIntoView({ block: "nearest" }); }
  };
  const draw = () => {
    const query = typed ? input.value.trim().toLowerCase() : "";
    const models = piModels?.models || [];
    shown = [...(emptyChoice ? [""] : []), ...models.filter((m) => !query || m.toLowerCase().includes(query))];
    list.replaceChildren(...shown.map((m, i) => {
      const li = el("li", { id: `combo-${n}-${i}` });
      li.setAttribute("role", "option");
      if (!m) li.append(el("span", { className: "dim", textContent: empty }));
      else {
        const cut = m.indexOf("/");
        li.append(el("span", { className: "dim", textContent: m.slice(0, cut + 1) }), m.slice(cut + 1));
        li.title = m;
      }
      // pointerdown, not click: the field keeps the focus, so its blur does not commit first.
      li.addEventListener("pointerdown", (e) => { e.preventDefault(); input.value = m; close(); commit(); });
      return li;
    }));
    if (!shown.length) {
      list.append(el("li", { className: "dim", textContent: piModels ? (models.length ? "no model holds that: Enter keeps it as typed" : "Pi listed no model: type provider/id") : "asking Pi…" }));
    }
    mark(Math.max(0, shown.indexOf(input.value.trim())));
  };
  const open = () => {
    typed = false;
    draw();
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (!piModels) loadPiModels().then(() => { if (!list.hidden) draw(); });
  };

  input.addEventListener("focus", open);
  input.addEventListener("input", () => { typed = true; if (list.hidden) { list.hidden = false; input.setAttribute("aria-expanded", "true"); } draw(); });
  input.addEventListener("blur", () => { close(); commit(); });
  toggle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (list.hidden) { input.focus(); open(); } else close();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (list.hidden) { open(); return; }
      if (shown.length) mark((at + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!list.hidden && at >= 0 && shown[at] !== undefined && (typed || shown[at] !== input.value.trim())) input.value = shown[at];
      close();
      commit();
    } else if (e.key === "Escape" && !list.hidden) {
      e.preventDefault(); // the list closes; the settings stay
      e.stopPropagation();
      input.value = committed;
      close();
    }
  });
  return box;
}

function modelRow(key, label, hint, empty) {
  let row;
  const picker = modelPicker(configValue(key), empty, (v) => setConfig(key, v || null, "agents", row.say), { emptyChoice: true });
  row = settingRow(key, label, picker, hint, "agents");
  return row;
}

/** A list of texts (models, hosts): each with ×, and a field to add one. */
function listRow(key, label, hint, page, { placeholder, models = false } = {}) {
  const items = [...(configValue(key) || [])];
  const list = el("ul", { className: "setting-list" });
  let row;
  const save = (next) => setConfig(key, next, page, row.say);
  // A model chosen in the list is added at once.
  const picker = models ? modelPicker("", placeholder, (v) => { if (v) save([...items, v]); }) : null;
  const field = picker ? picker.input : el("input", { type: "text", placeholder, spellcheck: false, autocomplete: "off" });
  const add = el("button", { className: "secondary", textContent: "Add" });
  row = settingRow(key, label, el("span"), hint, page);
  for (const item of items) {
    list.append(el("li", {},
      el("span", { className: "name", textContent: item }),
      el("button", { className: "icon", textContent: "×", title: `Remove ${item}`, onclick: () => save(items.filter((i) => i !== item)) })));
  }
  if (!items.length) list.append(el("li", { className: "dim", textContent: "none" }));
  const adding = el("div", { className: "setting-add" }, picker || field, add);
  field.id = `setting-${key}-new`;
  field.setAttribute("aria-label", `Add to ${label}`);
  const go = () => { const v = field.value.trim(); if (v) save([...items, v]); };
  add.addEventListener("click", go);
  if (!picker) field.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
  row.querySelector(".setting-head > label").htmlFor = field.id;
  row.querySelector(".setting-key").before(list, adding);
  return row;
}

function pageIntro(page) {
  const box = el("div");
  if (!pickerConfig) return box;
  box.append(el("div", { className: "banner", title: `Saved on the VM in ${pickerConfig.path}.` },
    svgIcon("info"), el("span", { textContent: "For the Pis started from now on; running ones keep what they had." })));
  if (pickerConfig.warning) box.append(el("p", { className: "notice", textContent: pickerConfig.warning }));
  if (!pickerConfig.writable) box.append(el("p", { className: "notice", textContent: "The VM's Python is older than 3.11: config.toml can only be changed by hand." }));
  return box;
}

async function drawSettingsPage(page, again, draw) {
  const section = $(`#prefs .prefs-page[data-page="${page}"]`);
  if (again !== false || !pickerConfig) {
    if (!section.childElementCount) section.append(el("p", { className: "dim", textContent: "Asking the VM…" }));
    try {
      await loadPickerConfig();
    } catch (error) {
      section.replaceChildren(el("p", { className: "error", textContent: `The picker on the VM did not answer: ${error}. An older picker? Settings > Connection updates it.` }));
      return;
    }
  }
  const scroll = $("#prefs .prefs-pages").scrollTop;
  section.replaceChildren(pageIntro(page), ...draw());
  $("#prefs .prefs-pages").scrollTop = scroll;
  if ($("#prefs-search").value.trim()) searchSettings($("#prefs-search").value);
}

// --- Agents ------------------------------------------------------------------------

function drawAgents(again) {
  drawSettingsPage("agents", again, () => {
    const out = [];
    // Pi's default model: in Pi's own settings, for every Pi Pier starts.
    const defError = el("p", { className: "error", hidden: true });
    const def = modelPicker(piModels?.default || "", "Pi chooses (its first signed-in provider)", async (value) => {
      try {
        const answer = await backend.piDefault(value);
        if (piModels) piModels.default = answer.default;
        noticeSetter(defError)("");
        flashStatus("Pi's default model saved");
      } catch (error) { noticeSetter(defError)(String(error)); }
    });
    def.input.id = "setting-pi-default";
    const defRow = el("div", { className: "setting-row" },
      el("div", { className: "setting-head" }, el("label", { htmlFor: def.input.id, textContent: "Default model" }), def),
      el("p", { className: "hint", textContent: "Every Pi's model, unless a role below says otherwise. Written in Pi's own settings (~/.pi/agent/settings.json), as /model does." }),
      defError);
    const models = el("p", { className: "hint" });
    const refresh = el("button", { className: "secondary", title: "Ask Pi for its models again (pi --list-models)" }, svgIcon("refresh-cw"), el("span", { textContent: "Refresh" }));
    refresh.addEventListener("click", async () => {
      models.textContent = "Asking Pi…";
      await loadPiModels(true);
      drawAgents(false);
    });
    if (!piModels) {
      models.textContent = "Asking Pi…";
      loadPiModels().then(() => drawAgents(false));
    } else if (piModels.problem && !piModels.models.length) {
      models.textContent = `Pi did not list them (${piModels.problem}): type them as provider/id.`;
    } else {
      const providers = piModels.providers.join(" and ");
      models.textContent = `${piModels.models.length}, from ${providers || "no provider"}. A gateway such as Bifrost lists its own as one provider's. Type a few letters in a field to choose.`;
    }
    const knows = el("div", { className: "setting-row" }, el("div", { className: "setting-head" }, el("span", { textContent: "Models Pi knows" }), refresh), models);
    out.push(el("h2", { textContent: "Models" }), knows, defRow,
      modelRow("orchestrator_model", "Orchestrator", "The model of a Pi started with orchestrate (Conversations): the one that plans, splits and merges. A strong model.", "Pi's default"),
      modelRow("worker_model", "Workers", "The model of the workers a Pi starts, when it names none. A cheaper model does.", "Pi's default"),
      listRow("worker_models", "Other models for workers", "Those a Pi may choose for a given worker, besides the one above.", "agents", { placeholder: "provider/id", models: true }),
      modelRow("helper_model", "Helpers", "The model of the read-only helpers (scout, reviewer, critic, checker) any Pi consults. A fast, cheap model.", "Pi's default"));
    out.push(el("h2", { textContent: "Several Pis" }),
      toggleRow("workers", "Workers", "A Pi may start worker Pis, each in a git worktree of its own; the first one waits for your approval in Pier.", "agents"),
      (() => {
        const input = el("input", { type: "number", min: 1, max: 12, value: configValue("workers_max") ?? 4 });
        const row = settingRow("workers_max", "At most, at once", input, "Workers one Pi may have running at the same time (1 to 12).", "agents");
        input.addEventListener("change", () => setConfig("workers_max", Math.round(Number(input.value)), "agents", row.say));
        return row;
      })(),
      toggleRow("helpers", "Helpers", "Every Pi may consult read-only helpers: short Pis that only read the project, and answer.", "agents"));
    out.push(el("h2", { textContent: "What Pier gives each Pi" }),
      toggleRow("checkpoints", "Restore points", "The project saved before each prompt: Undo last prompt, Activity > Restore.", "agents",
        { confirmOff: "Turn restore points off? What Pi does can then no longer be undone from Pier." }),
      toggleRow("worktrees", "A worktree for each extra Pi", "A second Pi in a git project works in a worktree of its own (.pi-worktrees), on its own branch.", "agents"),
      toggleRow("track_sessions", "Which conversation each Pi holds", "A small extension tells Pier; without it, Pier guesses from the newest file.", "agents"));
    return out;
  });
}

// --- Network & sandbox -------------------------------------------------------------

function drawNetwork(again) {
  drawSettingsPage("network", again, () => {
    const out = [];
    out.push(el("h2", { textContent: "Sandbox" }),
      toggleRow("sandbox", "Run Pi in a sandbox", "Pi sees its project, its own settings and little else of the VM (bubblewrap).", "network",
        { confirmOff: "Run Pi without its sandbox? It then sees and may change everything your account can on the VM." }),
      toggleRow("network_limit", "Limit where Pi may connect", "In the sandbox, Pi reaches only the places below; the rest is refused and written to the picker's log (net.blocked).", "network",
        { confirmOff: "Let Pi connect anywhere? It could then send what it reads to any address." }));
    // Every place in one list (the mock-up's option C): yours, then the picker's own, each
    // with a switch (off: still listed, Pi no longer reaches it: network_off); yours also
    // have ×. The field on top finds a place, and adds what it holds.
    const off = (configValue("network_off") || []).map((e) => e.toLowerCase());
    const isOff = (entry) => off.includes(entry.toLowerCase());
    const own = [...(configValue("network_allow") || [])];
    const builtin = pickerConfig.network_builtin || [];
    const box = el("div", { className: "rows host-list" });
    const say = (text) => { error.textContent = text; error.hidden = !text; };
    const error = el("p", { className: "error", hidden: true });
    const setOff = (entry, on) => {
      const rest = off.filter((e) => e !== entry.toLowerCase());
      return setConfig("network_off", on ? rest : [...rest, entry], "network", say);
    };
    const removeOwn = async (entry) => {
      if (await setConfig("network_allow", own.filter((e) => e !== entry), "network", say) && isOff(entry)) {
        await setConfig("network_off", off.filter((e) => e !== entry.toLowerCase()), "network", say);
      }
    };
    const place = (entry, mine) => {
      const sw = el("input", { type: "checkbox", checked: !isOff(entry), title: isOff(entry) ? `Pi may not reach ${entry}` : `Pi may reach ${entry}` });
      sw.setAttribute("aria-label", `Allow ${entry}`);
      sw.addEventListener("change", () => setOff(entry, sw.checked));
      const row = el("div", { className: isOff(entry) ? "set tight off" : "set tight" },
        el("div", { className: "what" }, el("span", { className: "code", textContent: entry })),
        el("span", { className: "origin", textContent: mine ? "yours" : "built in" }));
      if (mine) {
        const x = el("button", { className: "icon-btn", title: `Take ${entry} out of the list` }, svgIcon("x"));
        x.setAttribute("aria-label", x.title);
        x.addEventListener("click", () => removeOwn(entry));
        row.append(x);
      }
      row.append(sw);
      row.dataset.host = entry.toLowerCase();
      return row;
    };
    box.append(...own.map((h) => place(h, true)), ...builtin.map((h) => place(h, false)));
    const field = el("input", { type: "search", placeholder: "Find a place, or add one: host, host:port, .domain", spellcheck: false, autocomplete: "off", id: "setting-network_allow-new" });
    field.setAttribute("aria-label", "Find or add a place Pi may reach");
    const add = el("button", { className: "secondary", title: "Add what the field holds to your places" }, svgIcon("plus"), el("span", { textContent: "Add" }));
    const go = () => { const v = field.value.trim(); if (v) setConfig("network_allow", [...own, v], "network", say); };
    add.addEventListener("click", go);
    field.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
    field.addEventListener("input", () => {
      const needle = field.value.trim().toLowerCase();
      for (const row of box.children) row.hidden = Boolean(needle) && !row.dataset.host.includes(needle);
    });
    const allowed = [...own, ...builtin].filter((h) => !isOff(h)).length;
    const limited = configValue("network_limit");
    box.classList.toggle("inactive", !limited);
    out.push(el("h2", {}, el("span", { textContent: "Where Pi may connect" }), el("span", { className: "aside", textContent: `${own.length + builtin.length} places, ${allowed} allowed` })));
    if (!limited) out.push(el("p", { className: "notice", textContent: "Limit where Pi may connect is off: Pi may connect anywhere, and this list does not apply." }));
    out.push(el("div", { className: "toolbar host-bar" }, field, add), error, box,
      el("p", { className: "hint", textContent: "Built in: model providers, npm, GitHub, PyPI. A gateway such as Bifrost carries every model: the providers' own hosts can then be turned off." }));
    const provider = (piModels?.default || "").split("/")[0];
    const known = ["anthropic", "openrouter", "deepseek"];
    if (provider && !known.includes(provider)) {
      out.push(el("p", { className: "notice", textContent: `Pi's default model goes through ${provider}: its host must be checked in Yours. If every model goes through it, the built-in model providers can be unchecked.` }));
    }
    if (!piModels) loadPiModels().then(() => { if (!$("#prefs").hidden && prefsPage === "network") drawNetwork(false); });
    return out;
  });
}

// --- Git & forges ------------------------------------------------------------------

// Each forge's mark, monochrome as Pier's other icons (Gitea and Forgejo have none in Lucide).
const FORGE_ICONS = { github: "github", gitlab: "gitlab" };

/** The accounts on the forges: everyone's, each project's repository picks one
 *  (Repository > Git). Tokens stay on the VM. */
async function drawForges() {
  const section = $('#prefs .prefs-page[data-page="git"]');
  if (!section.childElementCount) section.append(el("p", { className: "dim", textContent: "Asking the VM…" }));
  let forges;
  try {
    forges = (await backend.api(["forges"])).forges || [];
  } catch (error) {
    section.replaceChildren(el("p", { className: "error", textContent: `The picker on the VM did not answer: ${error}` }));
    return;
  }
  const error = el("p", { className: "error", hidden: true });
  // One row per account (its initial, the forge, the address), then Add an account.
  const rows = el("div", { className: "rows" });
  for (const f of forges) {
    const remove = el("button", { className: "secondary", textContent: "Remove", title: "Forget this account (its token is deleted on the VM)" });
    remove.addEventListener("click", async () => {
      if (!(await ask(`Forget the ${FORGE_LABELS[f.kind]} account ${f.login}? Its token is deleted on the VM; revoke it on ${FORGE_LABELS[f.kind]} too. Repositories connected through it can no longer be pushed to.`))) return;
      try { await backend.forgeRemove(f.id); drawForges(); } catch (e) { showError(error, String(e)); }
    });
    rows.append(el("div", { className: "set" },
      el("span", { className: "avatar", "aria-hidden": "true" }, svgIcon(FORGE_ICONS[f.kind] || "git-branch")),
      el("div", { className: "what" }, el("span", { textContent: f.login }), el("span", { textContent: `${FORGE_LABELS[f.kind] || f.kind} · ${f.url}` })),
      remove));
  }
  const add = el("button", { className: "pick", type: "button" }, el("span", { textContent: "Add…" }));
  add.setAttribute("aria-haspopup", "menu");
  add.addEventListener("click", () => showMenu(add, Object.entries(FORGE_LABELS).map(([kind, label]) => [label, () => forgeAccountDialog(kind, (forge) => {
    flashStatus(`Connected: ${forge.login} on ${FORGE_LABELS[forge.kind]}`);
    drawForges();
  }), false, { icon: FORGE_ICONS[kind] || "git-branch" }])));
  rows.append(el("div", { className: "set" },
    el("div", { className: "what" }, el("span", { textContent: forges.length ? "Add an account" : "No account yet" }),
      el("span", { textContent: "Where Pi pushes its pi/… branches and opens pull requests; each project picks one in Repository. The token stays on the VM: Pi never sees it." })),
    add));
  section.replaceChildren(
    el("h2", { textContent: "Accounts" }),
    rows, error,
    el("h2", { textContent: "Pi's git tools" }),
    (() => {
      // A key of config.toml: drawn as on Agents, once the config is known.
      const row = el("div");
      loadPickerConfig().then(() => row.replaceWith(toggleRow("git_tools", "Git tools", "Push, pull requests and tasks for the connected forge, through the picker. Off: Pi has git, nothing more.", "git"))).catch(() => row.remove());
      return row;
    })());
  if ($("#prefs-search").value.trim()) searchSettings($("#prefs-search").value);
}

// --- Extensions & skills -----------------------------------------------------------

/** Pi, its packages, skills, extensions and prompt templates: yours, and the chosen
 *  project's own. Built once; the project list and the lists drawn again on each visit. */
let extProject = null;  // the project whose own resources are shown with yours
let extParts = null;    // {manager, tools, showTab}
let extTab = "skills";   // the tab shown: skills, extensions, prompts, packages

/** From Project's "manage": that project's own resources, with yours. */
function settingsExtensionsFor(project) {
  extProject = project;
  if (!$("#prefs").hidden && prefsPage === "extensions") drawExtensions();
}

async function drawExtensions() {
  const select = $("#ext-project");
  const projects = lastProjects || await fetchProjects().catch(() => null);
  const options = [];
  for (const p of [...(projects?.running || []), ...(projects?.recent || [])]) if (!options.some((o) => o.path === p.path)) options.push(p);
  extProject ||= target?.path || options[0]?.path || null;
  if (extProject && !options.some((o) => o.path === extProject)) options.push({ path: extProject, label: projectLabel(extProject) });
  select.replaceChildren(...options.map((p) => new Option(p.label, p.path)));
  select.value = extProject || "";
  if (!extParts) {
    const current = () => extProject;
    // The tabs: Skills, Extensions, Prompts (the manager), Packages (the list and the gallery).
    const TABS = [["skills", "Skills"], ["extensions", "Extensions"], ["prompts", "Prompts"], ["packages", "Packages"]];
    const tabs = Object.fromEntries(TABS.map(([key, label]) => {
      const b = el("button", { type: "button" }, el("span", { textContent: label }), el("span", { className: "n" }));
      b.setAttribute("role", "tab");
      b.addEventListener("click", () => showTab(key));
      return [key, b];
    }));
    $("#ext-tabs").replaceChildren(...Object.values(tabs));
    const showTab = (key) => {
      extTab = key;
      for (const [k, b] of Object.entries(tabs)) b.setAttribute("aria-selected", String(k === key));
      $("#ext-manager").hidden = key === "packages";
      $("#ext-pack").hidden = key !== "packages";
      if (key === "packages") tools.shown();
      else manager.show(key);
    };
    const counts = () => {
      const d = manager.data();
      const n = { skills: d?.skills?.length, extensions: (d?.extensions?.length || 0) + (d?.pier?.length || 0), prompts: d?.prompts?.length, packages: d?.packages?.length };
      for (const [k, b] of Object.entries(tabs)) $(".n", b).textContent = d ? String(n[k] || 0) : "";
    };
    const manager = makeResourceManager($("#ext-manager"), current,
      () => { renderPackageList($("#ext-packages"), manager.data(), extProject, () => manager.load()); tools.installed(manager.data()?.packages); counts(); });
    const tools = makePackageTools($("#ext-package-tools"), current, () => manager.load());
    extParts = { manager, tools, showTab };
    select.addEventListener("change", () => { extProject = select.value; extParts.manager.load(); });
  }
  extParts.showTab(extTab);
  if (!extProject) {
    $("#ext-packages").replaceChildren(el("li", { className: "dim small note", textContent: "Open a project first: Pi's packages and skills are read from the VM through one." }));
    return;
  }
  extParts.manager.load();
}
