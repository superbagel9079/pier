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
  else if (page === "projects") drawProjects();
}

const configValue = (key) => pickerConfig?.keys?.[key]?.value;

/** key = value in config.toml (null: back to the default), then the page drawn again. */
async function setConfig(key, value, page, note) {
  try {
    await backend.configSet(key, value);
    uiLog("info", "config-set", { key, reset: value === null });
    await loadPickerConfig();
    flashStatus(value === null ? "Back to the default, for the Pis started from now on" : "Saved, for the Pis started from now on");
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
  if (field.matches?.("input, select, button")) field.id = id;
  const error = el("p", { className: "error", hidden: true });
  // A button (a model's pick) is named by aria-labelledby, not a <label>: hovering a label
  // counts as hovering its control, which lit the pick with the pointer on the row's name.
  const name = field.matches?.("button")
    ? el("span", { id: `${id}-label`, textContent: label })
    : el("label", { htmlFor: id, textContent: label });
  if (field.matches?.("button")) field.setAttribute("aria-labelledby", name.id);
  const head = el("div", { className: "setting-head" }, name, control);
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

/** Pi's models as the palette's items: "claude-opus-5-5", and "bifrost · anthropic". */
function modelItems() {
  return (piModels?.models || []).map((m) => {
    const parts = m.split("/");
    const label = parts.pop();
    return { value: m, label, detail: parts.join(" · ") };
  });
}
const MODEL_SEARCH = "Search, or type provider/id";
const typedModel = (text) => (/^[\w.-]+\/\S+$/.test(text) ? text : null);

/** A model: a pick showing its name, opening the palette of Pi's models (ui.js); a model
 *  Pi does not list is typed there as provider/id. onCommit(value) once it changed.
 *  empty: what no model says, and when emptyChoice, the first item (back to Pi's default). */
function modelPicker(value, empty, onCommit, { emptyChoice = false } = {}) {
  const b = el("button", { type: "button", className: "pick model-pick" }, el("span"));
  b.setAttribute("aria-haspopup", "listbox");
  let current = value || "";
  const label = () => { $("span", b).textContent = current ? current.split("/").pop() : empty; b.title = current || empty; };
  label();
  b.addEventListener("click", async () => {
    if (!piModels) { $("span", b).textContent = "Asking Pi…"; await loadPiModels(); label(); }
    pickPalette(b, {
      items: [...(emptyChoice ? [{ value: "", label: empty }] : []), ...modelItems()],
      current, placeholder: MODEL_SEARCH, custom: typedModel,
      onPick: (v) => { if (v === current) return; current = v; label(); onCommit(v); },
    });
  });
  b.input = b; // settingRow and drawAgents name the control by its .input
  return b;
}

function modelRow(key, label, hint, empty) {
  let row;
  const picker = modelPicker(configValue(key), empty, (v) => setConfig(key, v || null, "agents", row.say), { emptyChoice: true });
  row = settingRow(key, label, picker, hint, "agents");
  return row;
}

/** The workers' other models, as the proposals' 2B: one line each (its name, where it
 *  comes from, ⋯ to remove it), then Add a model, which opens the palette. */
function workerModelsRow() {
  const key = "worker_models";
  const items = [...(configValue(key) || [])];
  let row;
  const save = (next) => setConfig(key, next, "agents", row.say);
  row = settingRow(key, "Other models for workers", el("span"), "Those a Pi may choose for a given worker, besides the one above.", "agents");
  const list = el("div", { className: "sub-rows" });
  for (const item of items) {
    const parts = item.split("/");
    const name = parts.pop();
    const more = el("button", { className: "icon-btn", title: `${name}: remove` }, svgIcon("ellipsis"));
    more.setAttribute("aria-label", more.title);
    more.setAttribute("aria-haspopup", "menu");
    more.addEventListener("click", () => showMenu(more, [["Remove", () => save(items.filter((i) => i !== item)), false, { icon: "trash", danger: true }]]));
    list.append(el("div", { className: "sub-row" }, el("span", { className: "name", textContent: name, title: item }), el("span", { className: "from", textContent: parts.join(" · ") }), more));
  }
  const add = el("button", { className: "link add-model", type: "button" }, svgIcon("plus"), el("span", { textContent: "Add a model" }));
  add.setAttribute("aria-haspopup", "listbox");
  add.addEventListener("click", async () => {
    if (!piModels) await loadPiModels();
    pickPalette(add, { items: modelItems().filter((it) => !items.includes(it.value)), placeholder: MODEL_SEARCH, custom: typedModel,
      onPick: (v) => { if (v && !items.includes(v)) save([...items, v]); } });
  });
  list.append(el("div", { className: "sub-row" }, add));
  row.querySelector(".setting-key").before(list);
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
      section.replaceChildren(online ? el("p", { className: "error", textContent: `The picker on the VM did not answer: ${error}. An older picker? Settings > Connection updates it.` })
        : el("p", { className: "dim", textContent: "These settings live on the VM: connect to it to see and change them." }));
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
    def.setAttribute("aria-labelledby", "setting-pi-default-label");
    const defRow = el("div", { className: "setting-row" },
      el("div", { className: "setting-head" }, el("span", { id: "setting-pi-default-label", textContent: "Default model" }), def),
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
    out.push(el("h2", { textContent: "Providers" }), providersBlock());
    out.push(el("h2", { textContent: "Models" }), knows, defRow,
      modelRow("orchestrator_model", "Orchestrator", "The model of a Pi started with orchestrate (Conversations): the one that plans, splits and merges. A strong model.", "Pi's default"));
    out.push(el("h2", { textContent: "Workers" }),
      toggleRow("workers", "A Pi may start workers", "Worker Pis, each in a git worktree of its own; the first one waits for your approval in Pier.", "agents"),
      (() => {
        const input = el("input", { type: "number", min: 1, max: 12, value: configValue("workers_max") ?? 4 });
        const row = settingRow("workers_max", "At most, at once", Object.assign(stepper(input), { input }), "Workers one Pi may have running at the same time (1 to 12).", "agents");
        input.addEventListener("change", () => setConfig("workers_max", Math.round(Number(input.value)), "agents", row.say));
        return row;
      })(),
      modelRow("worker_model", "Their model", "When a Pi names none for a worker. A cheaper model does.", "Pi's default"),
      workerModelsRow());
    out.push(el("h2", { textContent: "Helpers" }),
      toggleRow("helpers", "Every Pi may consult helpers", "Read-only helpers (scout, reviewer, critic, checker): short Pis that only read the project, and answer.", "agents"),
      modelRow("helper_model", "Their model", "A fast, cheap model does.", "Pi's default"));
    out.push(el("h2", { textContent: "What Pier gives each Pi" }),
      toggleRow("checkpoints", "Restore points", "The project saved before each prompt: Undo last prompt, Activity > Restore.", "agents",
        { confirmOff: "Turn restore points off? What Pi does can then no longer be undone from Pier." }),
      toggleRow("worktrees", "A worktree for each extra Pi", "A second Pi in a git project works in a worktree of its own (.pi-worktrees), on its own branch.", "agents"),
      toggleRow("track_sessions", "Which conversation each Pi holds", "A small extension tells Pier; without it, Pier guesses from the newest file.", "agents"));
    return out;
  });
}

// --- Providers (the proposals' 1B): Pi's models.json on the VM -----------------------

let piProviders = null; // {providers: [{name, baseUrl, api, models, key, keyEnv}], path}
async function loadProviders() {
  try { piProviders = await backend.api(["providers"]); } catch (e) { piProviders = { providers: [], problem: String(e) }; }
}
// Well-known ones, filled in for you: the name Pi will show, the address, the kind of API.
const PROVIDER_PRESETS = [
  ["OpenRouter", "openrouter", "https://openrouter.ai/api/v1", "openai-completions"],
  ["OpenAI", "openai", "https://api.openai.com/v1", "openai-responses"],
  ["Anthropic", "anthropic", "https://api.anthropic.com", "anthropic-messages"],
  ["Google Gemini", "google", "https://generativelanguage.googleapis.com/v1beta", "google-generative-ai"],
  ["Groq", "groq", "https://api.groq.com/openai/v1", "openai-completions"],
  ["DeepSeek", "deepseek", "https://api.deepseek.com/v1", "openai-completions"],
  ["Mistral", "mistral", "https://api.mistral.ai/v1", "openai-completions"],
  ["Together", "together", "https://api.together.xyz/v1", "openai-completions"],
  ["Ollama, on the VM", "ollama", "http://localhost:11434/v1", "openai-completions"],
  ["LM Studio", "lmstudio", "http://localhost:1234/v1", "openai-completions"],
  ["Custom (an OpenAI-compatible API)", "", "", "openai-completions"],
];
const PROVIDER_APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];

/** The providers of models.json, a row each (its address, kind of API, models, key), ⋯ to
 *  change or remove it; Add a provider below. */
function providersBlock() {
  const box = el("div", { className: "provider-list" });
  if (!piProviders) {
    box.append(el("p", { className: "hint", textContent: "Asking the VM…" }));
    loadProviders().then(() => drawAgents(false));
    return box;
  }
  if (piProviders.problem) box.append(el("p", { className: "error", textContent: piProviders.problem }));
  for (const p of piProviders.providers) {
    const more = el("button", { className: "icon-btn", type: "button", title: `${p.name}: more` }, svgIcon("ellipsis"));
    more.addEventListener("click", () => showMenu(more, [
      ["Edit…", () => providerDialog(p), false, { icon: "pencil" }],
      ["Remove", async () => {
        if (!(await ask(`Remove the provider ${p.name}? Its models leave Pi's list (models.json).`))) return;
        try { await backend.api(["provider-delete", p.name]); } catch (e) { flashStatus(String(e)); return; }
        await afterProviders();
      }, false, { icon: "trash", danger: true }],
    ]));
    const facts = [p.baseUrl, p.api, `${p.models.length} model${p.models.length === 1 ? "" : "s"}`, p.key ? (p.keyEnv ? `key from ${p.keyEnv}` : "key set") : "no key"];
    box.append(el("div", { className: "setting-row provider-row" },
      el("div", { className: "setting-head" }, el("span", { className: "provider-name", textContent: p.name }), more),
      el("p", { className: "hint", textContent: facts.filter(Boolean).join(" · ") })));
  }
  const add = el("button", { type: "button", className: "add-row" }, svgIcon("plus"), el("span", { textContent: "Add a provider" }));
  add.addEventListener("click", () => providerDialog(null));
  box.append(el("div", { className: "setting-row add-line" }, add));
  return box;
}

/** After a change: models.json read again, and Pi's models (its list holds them). */
async function afterProviders() {
  await loadProviders();
  await loadPiModels(true);
  drawAgents(false);
}

/** A provider added (from a well-known one or by hand) or changed: its name, address, API,
 *  key (left empty, the one set stays) and models, one per line. */
function providerDialog(p) {
  const field = (label, input, hint) => el("label", { className: "provider-field" }, el("span", { textContent: label }), input, hint ? el("small", { textContent: hint }) : null);
  const preset = el("select", {});
  PROVIDER_PRESETS.forEach(([label], i) => preset.add(new Option(label, String(i))));
  const name = el("input", { value: p?.name || "", spellcheck: false, placeholder: "openrouter", disabled: Boolean(p) });
  const base = el("input", { value: p?.baseUrl || "", spellcheck: false, placeholder: "https://api.example.com/v1" });
  const api = el("select", {});
  PROVIDER_APIS.forEach((a) => api.add(new Option(a, a)));
  api.value = p?.api || "openai-completions";
  const key = el("input", { type: "password", autocomplete: "off", spellcheck: false, placeholder: p?.key ? "set: leave empty to keep it" : "its API key, or an environment variable's NAME" });
  const models = el("textarea", { rows: 4, spellcheck: false, placeholder: "one model id a line, as the provider names it", value: (p?.models || []).join("\n") });
  const problem = dialogError();
  preset.addEventListener("change", () => {
    const [, n, url, kind] = PROVIDER_PRESETS[Number(preset.value)];
    if (!name.value || !p) name.value = n;
    base.value = url;
    api.value = kind;
    api.dispatchEvent(new Event("change"));
    name.focus();
  });
  const save = el("button", { type: "button", textContent: p ? "Save" : "Add" });
  const dialog = resourceDialog(p ? `Provider ${p.name}` : "Add a provider", [
    ...(p ? [] : [field("Start from", preset)]),
    field("Name", name, "As Pi will show it, before each model: name/model."),
    field("Address", base),
    field("API", api),
    field("Key", key, "Kept on the VM, in Pi's models.json (readable by your user only); never logged."),
    field("Models", models),
    problem], [save]);
  dialog.box.classList.add("provider-dialog");
  save.addEventListener("click", async () => {
    const body = { baseUrl: base.value.trim(), api: api.value, models: models.value.split(/[\n,]+/).map((m) => m.trim()).filter(Boolean) };
    if (key.value.trim()) body.apiKey = key.value.trim();
    try { await backend.api(["provider-save", (p?.name || name.value).trim(), JSON.stringify(body)]); } catch (e) { showError(problem, String(e)); return; }
    dialog.close();
    await afterProviders();
  });
}

// --- Projects (the proposals' 2B): the VM's projects, one at a time -----------------

let projectsOpen = null; // the project whose page is shown, else the list
let projectsSub = null;  // "instructions": that page of the project
/** Settings > Projects at a project (and its Instructions page): from Conversations' menu. */
function openProjectSettings(project, sub = null) {
  projectsOpen = project;
  projectsSub = sub;
  openPrefs();
  showPrefsPage("projects");
}
/** The host on top, then the VM's projects with their mark; a project's page: its
 *  instructions, what Pi loads, its mark, its repository, its path. */
function drawProjects() {
  const section = $('#prefs .prefs-page[data-page="projects"]');
  if (!online) { section.replaceChildren(); return; }
  const data = vm.latest("conversations")?.data;
  if (!data) {
    section.replaceChildren(el("p", { className: "dim", textContent: "Asking the VM…" }));
    vm.follow({ conversations: true });
    const stop = vm.on("conversations", () => { stop(); if (prefsPage === "projects") drawProjects(); });
    return;
  }
  const STORE = "devbox.conversations.v1";
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE)) || {}; } catch { /* none */ }
  const looks = saved.looks || {};
  const projects = [...data.projects].sort((a, b) => a.label.localeCompare(b.label));
  const p = projects.find((x) => x.project === projectsOpen);
  if (!p) {
    projectsOpen = null;
    const rows = projects.map((x) => {
      const b = el("button", { type: "button", className: "project-pick" }, projectBadge(x.project, looks[x.project]),
        el("span", { className: "what" }, el("span", { textContent: x.label }), el("span", { textContent: `${x.sessions.length} conversation${x.sessions.length === 1 ? "" : "s"}` })),
        svgIcon("chevron-right"));
      b.addEventListener("click", () => { projectsOpen = x.project; drawProjects(); });
      return b;
    });
    section.replaceChildren(el("h2", { textContent: "Projects" }), el("div", { className: "rows project-list" }, ...(rows.length ? rows : [el("p", { className: "dim", textContent: "No project yet: open a folder of the VM, Pi starts there." })])));
    return;
  }
  const back = el("button", { type: "button", className: "link back-to" }, svgIcon("arrow-left"), el("span", { textContent: projectsSub ? p.label : "All projects" }));
  back.addEventListener("click", () => { if (projectsSub) projectsSub = null; else projectsOpen = null; drawProjects(); });
  const title = el("div", { className: "project-title" }, projectBadge(p.project, looks[p.project]), el("h2", { textContent: projectsSub ? "Instructions" : p.label }));
  if (projectsSub === "instructions") {
    section.replaceChildren(back, title, promptCards(p.project));
    return;
  }
  const action = (text, run, primary = false) => {
    const b = el("button", { type: "button", className: primary ? "primary" : "secondary", textContent: text });
    b.addEventListener("click", run);
    return b;
  };
  const toTab = (kind, then) => () => { closePrefs(); const t = workspace.find(kind) || workspace.add(kind, "center"); workspace.show(t); then?.(t); };
  const row = (name, words, control) => el("div", { className: "set" }, el("div", { className: "what" }, el("span", { textContent: name }), el("span", { textContent: words })), control);
  const change = action("Change…", () => projectLookDialog(p.project, p.label, looks[p.project] || {}, (look) => {
    try { saved.looks = { ...looks, [p.project]: look }; localStorage.setItem(STORE, JSON.stringify(saved)); } catch { /* not kept */ }
    workspace.find("conversations")?.reloadLooks?.();
    drawProjects();
  }));
  const copy = action("Copy", () => backend.copyText(p.project).then(() => flashStatus("path copied")).catch((e) => flashStatus(String(e))));
  section.replaceChildren(back, title,
    el("div", { className: "rows" },
      row("Instructions", "AGENTS.md and Pi's system prompt: what Pi reads first in every session here.", action("Edit", () => { projectsSub = "instructions"; drawProjects(); })),
      row("What Pi loads", "Its skills, extensions, prompt templates and packages, the project's and yours.", action("Open", () => { extProject = p.project; extFromProject = true; showPrefsPage("extensions"); })),
      row("Its mark", "A colour, a letter, an icon or a picture, in the lists and the rail.", change),
      row("Repository", "Its git repository and forge: branches, pull requests, what Pi pushed.", action("Open", toTab("repository", (t) => t.openProject?.(p.project)))),
      row("Its path", p.project, copy)));
}

/** A project's texts for Pi (the Project tab's, here now): AGENTS.md, APPEND_SYSTEM.md and
 *  SYSTEM.md, a row each (what it does, its file, empty or its tokens); one open at a time
 *  (the proposals' B), its text and Revert, Save. */
let promptOpen = "instructions";
function promptCards(project) {
  const box = el("div"); // drawn once the VM answers: no frame around a waiting line
  const WORDS = {
    instructions: ["Read first in every session", "Read by Pi at the start of every session in this project: what it is, the commands to run and test, the conventions, what to avoid."],
    append: ["Added to Pi's system prompt", "Read after Pi's own instructions, in every session of this project."],
    system: ["Replaces Pi's system prompt", "Replaces Pi's own instructions entirely, including how it uses its tools. Leave it empty unless you know why you need it."],
  };
  backend.api(["setup", project]).then((data) => {
    const parts = ["instructions", "append", "system"].map((which) => {
      const info = data.texts[which];
      let saved = info.text;
      const area = el("textarea", { className: "prompt-edit", spellcheck: false, value: info.text, rows: 8, placeholder: WORDS[which][1], ariaLabel: WORDS[which][0] });
      const chip = el("span", { className: "prompt-chip" });
      const problem = el("p", { className: "error", hidden: true });
      const revert = el("button", { type: "button", className: "secondary", textContent: "Revert" });
      const save = el("button", { type: "button", className: "secondary", textContent: "Save" });
      const update = () => {
        const n = Math.ceil(area.value.length / 4);
        chip.textContent = area.value !== saved ? "not saved" : !info.exists ? (info.global ? "the global one applies" : "not created yet") : `≈ ${n.toLocaleString()} tokens`;
        chip.classList.toggle("on", info.exists && area.value === saved);
        revert.disabled = save.disabled = area.value === saved;
      };
      const write = async () => {
        try { await backend.writeText(project, which, area.value); } catch (e) { showError(problem, String(e)); return; }
        showError(problem, "");
        saved = area.value;
        info.exists = Boolean(area.value.trim()); // emptied: the file is removed, the global one applies
        update();
        flashStatus(`${info.name} saved: new sessions read it`);
      };
      // The field grows with its text (no grip to drag).
      const fit = () => { area.style.height = "auto"; area.style.height = `${Math.max(160, area.scrollHeight)}px`; };
      area.addEventListener("input", () => { update(); fit(); });
      area.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); write(); } });
      revert.addEventListener("click", () => { area.value = saved; update(); fit(); });
      save.addEventListener("click", write);
      update();
      const head = el("button", { type: "button", className: "prompt-head" }, svgIcon("chevron-right"),
        el("span", { className: "what" }, el("span", { textContent: WORDS[which][0] }), el("span", { textContent: info.name })), chip);
      const body = el("div", { className: "prompt-body" }, area, problem, el("div", { className: "prompt-foot" }, revert, save));
      const part = el("div", { className: "prompt-part" }, head, body);
      head.addEventListener("click", () => {
        promptOpen = promptOpen === which ? null : which;
        for (const x of parts) x.show();
        if (promptOpen === which) { fit(); area.focus(); }
      });
      part.show = () => {
        const open = promptOpen === which;
        part.classList.toggle("open", open);
        head.setAttribute("aria-expanded", String(open));
        body.hidden = !open;
        if (open) requestAnimationFrame(fit);
      };
      return part;
    });
    for (const x of parts) x.show();
    box.className = "prompt-acc";
    box.replaceChildren(...parts);
  }).catch((e) => box.replaceChildren(el("p", { className: "error", textContent: String(e) })));
  return box;
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
      // The switches stay in one column; yours have ⋯ after theirs (Remove), the others room.
      row.append(sw);
      if (mine) {
        const more = el("button", { className: "icon-btn", title: `${entry}: remove` }, svgIcon("ellipsis"));
        more.setAttribute("aria-label", more.title);
        more.setAttribute("aria-haspopup", "menu");
        more.addEventListener("click", () => showMenu(more, [[`Remove ${entry}`, () => removeOwn(entry), false, { icon: "trash", danger: true }]]));
        row.append(more);
      } else row.append(el("span", { className: "icon-room", "aria-hidden": "true" }));
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
    section.replaceChildren(online ? el("p", { className: "error", textContent: `The picker on the VM did not answer: ${error}` })
      : el("p", { className: "dim", textContent: "These settings live on the VM: connect to it to see and change them." }));
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
let extFromProject = false; // shown from Settings > Projects: that project's, its name on top
let extTab = "skills";   // the tab shown: skills, extensions, prompts, packages

/** From Project's "manage": that project's own resources, with yours. */
function settingsExtensionsFor(project) {
  extProject = project;
  extFromProject = true;
  if (!$("#prefs").hidden && prefsPage === "extensions") drawExtensions();
}

async function drawExtensions() {
  const select = $("#ext-project");
  // From a project's page: back to it, its name on top, no list of projects.
  $(".ext-bar").classList.toggle("from-project", extFromProject);
  const back = $("#ext-back");
  back.hidden = !extFromProject;
  if (extFromProject) {
    back.replaceChildren(svgIcon("arrow-left"), el("span", { textContent: projectLabel(extProject) }));
    back.onclick = () => { extFromProject = false; projectsOpen = extProject; projectsSub = null; showPrefsPage("projects"); };
  }
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
