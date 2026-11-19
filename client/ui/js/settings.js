// Settings > Models, Providers, Agents, Sandbox, Git & forges, Projects, Extensions: keys
// of the picker's config.toml on the VM (and Pi's own default model, its models.json),
// read and written through the picker, which checks each.

// The picker's config, from Pier

let pickerConfig = null;   // {keys: {key: {value, default, set}}, path, warning, network_builtin, writable}
let piModels = null;       // {models: ["provider/id"], providers, default, problem}
let piModelsAsked = null;  // the call under way: `pi --list-models` takes a moment
let piThinking = "";       // Pi's default thinking level ("": Pi's own)

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
  if (page === "models") {
    drawModels();
    // Pi's default as it is now (a model picked in Pi's own screen changes it).
    backend.api(["pi-default-read"]).then((r) => {
      const thinking = r?.thinking ?? "";
      if ((piModels && r?.default !== undefined && r.default !== piModels.default) || thinking !== piThinking) {
        if (piModels && r?.default !== undefined) piModels.default = r.default;
        piThinking = thinking;
        drawModels(false);
      }
    }).catch(() => {});
  }
  else if (page === "providers") drawProviders();
  else if (page === "agents") drawAgents();
  else if (page === "conversations") drawImageModel();
  else if (page === "sandbox") drawSandbox();
  else if (page === "network") drawNetwork();
  else if (page === "git") drawForges();
  else if (page === "extensions") { extInto(extHome()); drawExtensions(); }
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
  ({ agents: drawAgents, git: drawForges, sandbox: drawSandbox, network: drawNetwork, "conv-image": drawImageModel })[page]?.(false);
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

/** A model hidden from the pickers (Settings > Models), kept in Pier's preferences. */
const shownModel = (m) => !(prefs.hiddenModels || []).includes(m);

/** Pi's models as the palette's items: "claude-opus-5-5", and "bifrost · anthropic". */
function modelItems() {
  return (piModels?.models || []).filter(shownModel).map((m) => {
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

/** The model for images (look_at): one that sees them. Pi says which do (its list's
 *  "images"); a model of models.json is text only to Pi until marked, which choosing it
 *  here does. */
function imageModelRow() {
  const key = "image_model";
  const value = configValue(key);
  const error = el("p", { className: "error", hidden: true });
  const say = noticeSetter(error);
  const picker = modelPicker(value, "None", async (v) => {
    if (!(await setConfig(key, v || null, "conv-image", say))) return;
    if (v) {
      try { await backend.api(["model-images", v]); } catch { /* a built-in provider's: Pi knows */ }
      await loadPiModels(true);
      drawImageModel(false);
    }
  }, { emptyChoice: true });
  picker.setAttribute("aria-labelledby", "setting-image-label");
  const sees = piModels?.images;
  const blind = value && sees && !sees.includes(value);
  const hint = blind ? `Pi lists ${value} as text only: it cannot read images. Choose one that sees them: ${sees.slice(0, 3).join(", ") || "none listed yet"}.`
    : "Reads pasted images when the conversation's model cannot.";
  return el("div", { className: blind ? "set warn" : "set" },
    el("div", { className: "what" }, el("span", { id: "setting-image-label", textContent: "Image model" }), el("span", { textContent: hint }), error), picker);
}

/** Under a worker's model, the others a Pi may choose for a given worker: a chip each
 *  (× takes it out), then a link that opens the palette. */
function workerAlso(row) {
  const key = "worker_models";
  const items = [...(configValue(key) || [])];
  const save = (next) => setConfig(key, next, "agents", row.say);
  const line = el("div", { className: "also" });
  if (items.length) line.append(el("span", { className: "dim", textContent: "Also" }));
  for (const item of items) {
    const chip = el("button", { type: "button", className: "chip", title: `${item}: take it out` }, el("span", { textContent: item.split("/").pop() }), svgIcon("x"));
    chip.addEventListener("click", () => save(items.filter((i) => i !== item)));
    line.append(chip);
  }
  const add = el("button", { type: "button", className: "link" }, svgIcon("plus"), el("span", { textContent: items.length ? "Another" : "Others a Pi may choose" }));
  add.setAttribute("aria-haspopup", "listbox");
  add.addEventListener("click", async () => {
    if (!piModels) await loadPiModels();
    pickPalette(add, { items: modelItems().filter((it) => !items.includes(it.value)), placeholder: MODEL_SEARCH, custom: typedModel,
      onPick: (v) => { if (v && !items.includes(v)) save([...items, v]); } });
  });
  line.append(add);
  row.querySelector(".setting-key").before(line);
  return row;
}

/** A page that is off (Labs', Terminals'): what it does, and one button to turn it on. */
function offPage(icon, title, points, button, run) {
  const go = el("button", { type: "button", className: "secondary", textContent: button });
  go.addEventListener("click", run);
  return el("div", { className: "labs-welcome" }, svgIcon(icon), el("h2", { textContent: title }),
    el("ul", {}, ...points.map((t) => el("li", { textContent: t }))), el("div", { className: "actions" }, go));
}

function pageIntro(page) {
  const box = el("div");
  if (!pickerConfig) return box;
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
      section.replaceChildren(online ? el("p", { className: "error", textContent: `The picker on the VM did not answer: ${error}. An older picker? Settings > Overview updates it.` })
        : el("p", { className: "dim", textContent: "These settings live on the VM: connect to it to see and change them." }));
      return;
    }
  }
  const scroll = $("#prefs .prefs-pages").scrollTop;
  section.replaceChildren(pageIntro(page), ...draw());
  $("#prefs .prefs-pages").scrollTop = scroll;
  if ($("#prefs-search").value.trim()) searchSettings($("#prefs-search").value);
}

// --- Each page's action, on the right of its title ----------------------------------

function pageAction(icon, text, run) {
  const b = el("button", { type: "button", className: "page-act" }, svgIcon(icon), el("span", { textContent: text }));
  b.addEventListener("click", () => run(b));
  return b;
}
const PAGE_ACTIONS = {
  models: () => pageAction("refresh-cw", "Refresh", async () => { await loadPiModels(true); drawModels(false); }),
  providers: () => pageAction("plus", "Add a provider", () => providerDialog(null)),
  git: () => pageAction("plus", "Add an account", (b) => showMenu(b, Object.entries(FORGE_LABELS).map(([kind, label]) => [label, () => forgeAccountDialog(kind, (forge) => {
    flashStatus(`Connected: ${forge.login} on ${FORGE_LABELS[forge.kind]}`);
    drawForges();
  }), false, { icon: FORGE_ICONS[kind] || "git-branch" }]))),
  projects: () => pageAction("plus", "Add project", () => openFolderPicker()), // Settings stay behind until Pi starts
  extensions: () => pageAction("plus", "Add", (b) => extParts?.manager.addMenu(b)),
};

// --- Agents ------------------------------------------------------------------------

function drawModels(again) {
  drawSettingsPage("models", again, () => {
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
    // Pi's default thinking level, for the models that think (its settings.json too).
    const LEVELS = [["", "Pi's own"], ["off", "Off"], ["minimal", "Minimal"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"]];
    const thinkError = el("p", { className: "error", hidden: true });
    const think = el("button", { type: "button", className: "pick", "aria-haspopup": "menu", "aria-labelledby": "setting-thinking-label" },
      el("span", { textContent: (LEVELS.find(([v]) => v === piThinking) || LEVELS[0])[1] }));
    think.addEventListener("click", () => showMenu(think, LEVELS.map(([v, label]) => [label, async () => {
      try {
        piThinking = (await backend.piThinking(v)).thinking ?? v;
        noticeSetter(thinkError)("");
        flashStatus("Pi's default thinking saved");
        drawModels(false);
      } catch (error) { noticeSetter(thinkError)(String(error)); }
    }, false, { mark: v === piThinking ? svgIcon("check") : el("span"), current: v === piThinking }])));
    const out = [el("div", { className: "rows" }, el("div", { className: "set" },
      el("div", { className: "what" }, el("span", { id: "setting-pi-default-label", textContent: "Default model" }), el("span", { textContent: "Every new conversation starts on it." }), defError), def),
      el("div", { className: "set" },
        el("div", { className: "what" }, el("span", { id: "setting-thinking-label", textContent: "Default thinking" }), el("span", { textContent: "For models that think." }), thinkError), think)),
      el("h2", { textContent: "Shown in the pickers" })];
    if (!piModels) {
      out.push(el("p", { className: "hint", textContent: "Asking Pi…" }));
      loadPiModels().then(() => drawModels(false));
    } else if (!piModels.models.length) {
      out.push(el("p", { className: "hint", textContent: piModels.problem ? `Pi did not list them (${piModels.problem}): type them as provider/id.` : "Pi lists no model yet: add a provider." }));
    } else out.push(modelList());
    return out;
  });
}

/** Pi's models, grouped by where they come from, a search above (as OpenCode's). */
function modelList() {
  const groups = new Map();
  for (const m of piModels.models) {
    // bifrost/openrouter/anthropic/claude-x: in bifrost, named claude-x, "openrouter · anthropic" beside.
    const parts = m.split("/");
    const name = parts.pop();
    const from = parts.shift() || "other";
    if (!groups.has(from)) groups.set(from, []);
    groups.get(from).push([m, name, parts.join(" · ")]);
  }
  const sees = piModels.images || [];
  const blocks = [...groups].map(([from, list]) => {
    const rows = list.map(([m, name, via]) => {
      const sw = el("input", { type: "checkbox", checked: shownModel(m) });
      sw.setAttribute("aria-label", `Show ${name} in the pickers`);
      sw.addEventListener("change", () => {
        const hidden = (prefs.hiddenModels || []).filter((x) => x !== m);
        prefs.hiddenModels = sw.checked ? hidden : [...hidden, m];
        savePrefs();
      });
      const row = el("div", { className: "set tight" }, el("div", { className: "what" }, el("span", { textContent: name, title: m })),
        el("span", { className: "origin", textContent: [via, sees.includes(m) ? "sees images" : ""].filter(Boolean).join(" · ") }), sw);
      row.dataset.model = m.toLowerCase();
      return row;
    });
    const box = el("details", { className: "model-group", open: groups.size === 1 },
      el("summary", {}, svgIcon("chevron-right"), el("span", { textContent: from }), el("span", { className: "n", textContent: String(list.length) })),
      el("div", { className: "rows" }, ...rows));
    box.rows = rows;
    return box;
  });
  const field = el("input", { type: "search", placeholder: "Search models", spellcheck: false, autocomplete: "off" });
  field.setAttribute("aria-label", "Search Pi's models");
  field.addEventListener("input", () => {
    const needle = field.value.trim().toLowerCase();
    for (const box of blocks) {
      let any = false;
      for (const row of box.rows) { row.hidden = Boolean(needle) && !row.dataset.model.includes(needle); any ||= !row.hidden; }
      box.hidden = !any;
      if (needle) box.open = true;
    }
  });
  return el("div", { className: "model-list" }, el("div", { className: "toolbar host-bar" }, searchBox(field)), ...blocks);
}

/** Conversations' image model: a row of the page's card, once the VM's config is known. */
async function drawImageModel(again) {
  const slot = $("#conv-image-slot");
  try { if (again !== false || !pickerConfig) await loadPickerConfig(); } catch { slot.hidden = true; return; }
  if (!piModels) loadPiModels().then(() => { if (prefsPage === "conversations") drawImageModel(false); });
  slot.replaceChildren(imageModelRow());
  slot.hidden = false;
}

const PROVIDER_WORDS = { anthropic: "Claude, with an API key.", openai: "GPT, with an API key.", deepseek: "DeepSeek's own API.", openrouter: "Every model through one key.",
  google: "Gemini, with an API key.", groq: "Open models, fast.", mistral: "Mistral's own API.", together: "Open models, hosted.", ollama: "Models running on the VM.", lmstudio: "LM Studio's server." };
const PROVIDER_FIRST = ["anthropic", "openai", "deepseek", "openrouter"];
const PROVIDER_LOGOS = { anthropic: "anthropic", claude: "anthropic", openai: "openai", gemini: "google", google: "google", googleapis: "google", mistral: "mistral",
  ollama: "ollama", deepseek: "deepseek", openrouter: "openrouter", groq: "groq", lmstudio: "lmstudio", together: "together" };
/** A provider's mark: its logo when it is a known one (by its name, or its address's host;
 *  a gateway's path is not looked at), else its first letter. */
function providerMark(name, url = "") {
  let host = "";
  try { host = new URL(url).host.toLowerCase(); } catch { /* no address */ }
  const words = `${name.toLowerCase()} ${host}`;
  const key = Object.keys(PROVIDER_LOGOS).find((k) => words.includes(k))
    || (/:11434$/.test(host) ? "ollama" : /:1234$/.test(host) ? "lmstudio" : null);
  return el("span", { className: "avatar", "aria-hidden": "true" }, key ? svgIcon(`logo-${PROVIDER_LOGOS[key]}`) : document.createTextNode(name[0]?.toUpperCase() || "?"));
}
let providersMore = false;
function drawProviders(again) {
  drawSettingsPage("providers", again, () => {
    const out = [el("h2", { textContent: "Connected" }), providersBlock()];
    // The well-known ones not added yet, a Connect each (the dialog filled in for it).
    const have = (piProviders?.providers || []).map((p) => p.name.toLowerCase());
    const rank = (name) => (PROVIDER_FIRST.includes(name) ? PROVIDER_FIRST.indexOf(name) : 99);
    const popular = PROVIDER_PRESETS.map((p, i) => [...p, i]).filter(([, name]) => name && !have.includes(name)).sort((a, b) => rank(a[1]) - rank(b[1]));
    if (piProviders && popular.length) {
      const shown = providersMore ? popular : popular.slice(0, 4);
      out.push(el("h2", { textContent: "Popular" }), el("div", { className: "rows" }, ...shown.map(([label, name, url, , i]) => {
        const go = el("button", { type: "button", className: "secondary quiet" }, svgIcon("plus"), el("span", { textContent: "Connect" }));
        go.setAttribute("aria-label", `Connect ${label}`);
        go.addEventListener("click", () => providerDialog(null, i));
        return el("div", { className: "set" }, providerMark(name, url),
          el("div", { className: "what" }, el("span", { textContent: label }), el("span", { textContent: PROVIDER_WORDS[name] || url })), go);
      })));
      if (popular.length > 4) {
        const more = el("button", { type: "button", className: "link more-providers", textContent: providersMore ? "Show fewer providers" : "Show more providers" });
        more.addEventListener("click", () => { providersMore = !providersMore; drawProviders(false); });
        out.push(more);
      }
    }
    return out;
  });
}

function drawAgents(again) {
  drawSettingsPage("agents", again, () => [
    el("h2", { textContent: "Workers" }),
    toggleRow("workers", "Workers", "A Pi may start worker Pis, each in its own worktree (the first one waits for your approval).", "agents"),
    (() => {
      const input = el("input", { type: "number", min: 1, max: 12, value: configValue("workers_max") ?? 4 });
      const row = settingRow("workers_max", "At most", Object.assign(stepper(input), { input }), "Workers running at once.", "agents");
      input.addEventListener("change", () => setConfig("workers_max", Math.round(Number(input.value)), "agents", row.say));
      return row;
    })(),
    workerAlso(modelRow("worker_model", "Their model", "When a Pi names none. A cheaper model does.", "Pi's default")),
    modelRow("orchestrator_model", "Orchestrator's model", "The one that plans, splits and merges.", "Pi's default"),
    el("h2", { textContent: "Helpers (consult)" }),
    toggleRow("helpers", "Helpers", "Read-only Pis a Pi asks at once: scout, reviewer, critic, checker.", "agents"),
    modelRow("helper_model", "Their model", "A fast, cheap model does.", "Pi's default"),
    el("h2", { textContent: "Each Pi" }),
    toggleRow("checkpoints", "Restore points", "Undo a prompt and what it changed.", "agents",
      { confirmOff: "Turn restore points off? What Pi does can then no longer be undone from Pier." }),
    toggleRow("track_sessions", "Which conversation each Pi holds", "So the list and the tabs follow Pi.", "agents"),
  ]);
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
  const box = el("div", { className: "rows provider-list" });
  if (!piProviders) {
    box.append(el("div", { className: "set" }, el("div", { className: "what" }, el("span", { textContent: "Asking the VM…" }))));
    loadProviders().then(() => drawProviders(false));
    return box;
  }
  if (piProviders.problem) box.append(el("p", { className: "error", textContent: piProviders.problem }));
  for (const p of piProviders.providers) {
    const more = el("button", { className: "icon-btn", type: "button", title: `${p.name}: more` }, svgIcon("ellipsis"));
    more.setAttribute("aria-label", more.title);
    more.setAttribute("aria-haspopup", "menu");
    more.addEventListener("click", () => showMenu(more, [
      ["Edit…", () => providerDialog(p), false, { icon: "pencil" }],
      ["Remove", async () => {
        if (!(await ask(`Remove the provider ${p.name}? Its models leave Pi's list (models.json).`))) return;
        try { await backend.api(["provider-delete", p.name]); } catch (e) { flashStatus(String(e)); return; }
        await afterProviders();
      }, false, { icon: "trash", danger: true }],
    ]));
    // Its models' context: as the provider said it (or as typed), else Pi's 128K by default.
    const sized = (p.contexts || []).filter(Boolean);
    const tokens = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}K`);
    const context = !p.models.length ? "" : sized.length ? `${[...new Set(sized.map(tokens))].join(", ")} context` : "context unknown: Pi takes 128K";
    const facts = [p.baseUrl, `${p.models.length} model${p.models.length === 1 ? "" : "s"}`, context, p.key ? "" : "no key"];
    box.append(el("div", { className: "set" }, providerMark(p.name, p.baseUrl),
      el("div", { className: "what" }, el("span", { textContent: p.name }), el("span", { textContent: facts.filter(Boolean).join(" · "), title: `${p.api}${p.keyEnv ? ` · key from ${p.keyEnv}` : ""}` })), more));
  }
  if (!piProviders.providers.length) box.append(el("div", { className: "set" }, el("div", { className: "what" }, el("span", { textContent: "None of your own yet" }), el("span", { textContent: "Connect a popular one below, or add your own." }))));
  return box;
}

/** After a change: models.json read again, and Pi's models (its list holds them). */
async function afterProviders() {
  await loadProviders();
  await loadPiModels(true);
  drawProviders(false);
}

/** A provider added (from a well-known one or by hand) or changed: its name, address, API,
 *  key (left empty, the one set stays) and models, one per line. */
function providerDialog(p, from = null) {
  const field = (label, input, hint) => el("label", { className: "provider-field" }, el("span", { textContent: label }), input, hint ? el("small", { textContent: hint }) : null);
  const preset = el("select", {});
  PROVIDER_PRESETS.forEach(([label], i) => preset.add(new Option(label, String(i))));
  const name = el("input", { value: p?.name || "", spellcheck: false, placeholder: "openrouter", disabled: Boolean(p) });
  const base = el("input", { value: p?.baseUrl || "", spellcheck: false, placeholder: "https://api.example.com/v1" });
  const api = el("select", {});
  PROVIDER_APIS.forEach((a) => api.add(new Option(a, a)));
  api.value = p?.api || "openai-completions";
  const key = el("input", { type: "password", autocomplete: "off", spellcheck: false, placeholder: p?.key ? "set: leave empty to keep it" : "its API key, or an environment variable's NAME" });
  // A model a line, its context in tokens after it (as known, or typed: 1048576, 1M, 200k).
  const models = el("textarea", { rows: 5, spellcheck: false, placeholder: "deepseek-v4-pro  1048576\nkimi-k3", value: (p?.models || []).map((m, i) => (p.contexts?.[i] ? `${m}  ${p.contexts[i]}` : m)).join("\n") });
  const size = (word) => {
    const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(word || "");
    if (!m) return null;
    const n = Number(m[1]) * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] || 1);
    return n >= 1000 ? Math.round(n) : null;
  };
  const problem = dialogError();
  preset.addEventListener("change", () => {
    const [, n, url, kind] = PROVIDER_PRESETS[Number(preset.value)];
    if (!name.value || !p) name.value = n;
    base.value = url;
    api.value = kind;
    api.dispatchEvent(new Event("change"));
    name.focus();
  });
  if (from !== null) { preset.value = String(from); preset.dispatchEvent(new Event("change")); }
  const save = el("button", { type: "button", textContent: p ? "Save" : "Add" });
  const dialog = resourceDialog(p ? `Provider ${p.name}` : "Add a provider", [
    ...(p ? [] : [field("Start from", preset)]),
    field("Name", name, "As Pi will show it, before each model: name/model."),
    field("Address", base),
    field("API", api),
    field("Key", key, "Kept on the VM, in Pi's models.json (readable by your user only); never logged."),
    field("Models", models, "One a line, as the provider names it, then its context in tokens. Pier asks the provider for it on Save; type it where the provider does not tell (else Pi takes 128 000)."),
    problem], [save]);
  dialog.box.classList.add("provider-dialog");
  save.addEventListener("click", async () => {
    const lines = models.value.split(/[\n,]+/).map((l) => l.trim().split(/\s+/)).filter((w) => w[0]);
    const body = { baseUrl: base.value.trim(), api: api.value, models: lines.map(([id, n]) => (size(n) ? { id, contextWindow: size(n) } : id)) };
    if (key.value.trim()) body.apiKey = key.value.trim();
    let saved;
    try { saved = await backend.api(["provider-save", (p?.name || name.value).trim(), JSON.stringify(body)]); } catch (e) { showError(problem, String(e)); return; }
    const sized = saved?.sized?.length ?? 0;
    flashStatus(!body.models.length ? "Provider saved" : sized ? (sized < body.models.length ? `Saved: the context of ${sized} of ${body.models.length} models known; type the others after them (Edit…)` : "Saved: every model's context known") : "Saved: the provider did not tell its models' context; type it after each model (Edit…), else Pi takes 128K");
    dialog.close();
    await afterProviders();
  });
}

// --- Projects (the proposals' 2B): the VM's projects, one at a time -----------------

let projectsOpen = null; // the project whose page is shown, else the list
let projectsSub = null;  // "instructions" or "repository": that page of the project
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
  extInto(extHome()); // Extensions' parts back in their page (a project's shows them in its own)
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
        el("span", { className: "what" }, el("span", { textContent: x.label }), el("span", { textContent: `${x.sessions.length} conversation${x.sessions.length === 1 ? "" : "s"}` })));
      b.addEventListener("click", () => { projectsOpen = x.project; drawProjects(); });
      b.append(svgIcon("chevron-right"));
      const line = el("div", { className: "project-line" }, b);
      line.dataset.name = `${x.label} ${x.project}`.toLowerCase();
      return line;
    });
    const create = () => { closePrefs(); openFolderPicker(); };
    if (!rows.length) {
      // None yet: what a project is, and one button (as Labs and Terminals).
      const go = el("button", { type: "button", className: "secondary", textContent: "Create a project" });
      go.addEventListener("click", create);
      section.replaceChildren(el("div", { className: "labs-welcome" }, svgIcon("folder"),
        el("h2", { textContent: "Your projects" }),
        el("ul", {}, el("li", { textContent: "A project is a folder of the VM where Pi works: its conversations, its instructions, what it loads." }),
          el("li", { textContent: "Pick a folder that exists, or make a new one; Pi starts in it." }),
          el("li", { textContent: "Each gets a mark (a colour, a letter, an icon or a picture) to find it in the lists." })),
        el("div", { className: "actions" }, go)));
      return;
    }
    const field = el("input", { type: "search", placeholder: "Search projects", spellcheck: false, autocomplete: "off" });
    field.setAttribute("aria-label", "Search projects");
    field.addEventListener("input", () => {
      const needle = field.value.trim().toLowerCase();
      for (const r of rows) r.hidden = Boolean(needle) && !r.dataset.name.includes(needle);
    });
    section.replaceChildren(el("div", { className: "toolbar host-bar" }, searchBox(field)), el("div", { className: "rows project-list" }, ...rows));
    return;
  }
  $("#prefs-act").replaceChildren(); // Add project: on the list, not in a project
  const back = el("button", { type: "button", className: "link back-to" }, svgIcon("arrow-left"), el("span", { textContent: "Back to projects" }));
  back.addEventListener("click", () => { projectsSub = null; projectsOpen = null; drawProjects(); });
  // Its mark: a click changes it (a pencil over it under the pointer, as Edit's).
  const mark = el("button", { type: "button", className: "mark-edit", title: "Change its mark: a colour, a letter, an icon or a picture", "aria-label": "Change its mark" },
    projectBadge(p.project, looks[p.project]), el("span", { className: "mark-pen" }, svgIcon("pencil")));
  mark.addEventListener("click", () => openMark());
  const title = el("div", { className: "project-title" }, mark, el("div", { className: "what" }, el("h2", { textContent: p.label }), el("span", { className: "dim small code", textContent: p.project })));
  // Its pages, as tabs: General, Instructions and Repository here, Extensions on its own page.
  const tabs = el("span", { className: "seg project-tabs", role: "tablist" });
  for (const [key, label, go] of [["general", "General"], ["instructions", "Instructions"],
    ["extensions", "Extensions"],
    ["repository", "Repository"]]) {
    const b = el("button", { type: "button", role: "tab", textContent: label });
    b.setAttribute("aria-selected", String((projectsSub || "general") === key));
    b.addEventListener("click", go || (() => { projectsSub = key === "general" ? null : key; drawProjects(); }));
    tabs.append(b);
  }
  const openMark = () => projectLookDialog(p.project, p.label, looks[p.project] || {}, (look) => {
    try { saved.looks = { ...looks, [p.project]: look }; localStorage.setItem(STORE, JSON.stringify(saved)); } catch { /* not kept */ }
    workspace.find("conversations")?.reloadLooks?.();
    drawProjects();
  }, (look) => $(".pbadge", title)?.replaceWith(projectBadge(p.project, look)));
  if (projectsSub === "instructions") {
    section.replaceChildren(back, title, tabs, promptCards(p.project));
    return;
  }
  if (projectsSub === "extensions") {
    // Its Extensions here: the Extensions page's parts, moved in while this tab is shown.
    extProject = p.project;
    extFromProject = true;
    const host = el("div", { className: "project-extensions" });
    section.replaceChildren(back, title, tabs, host);
    extInto(host);
    $("#prefs-act").replaceChildren(PAGE_ACTIONS.extensions());
    drawExtensions();
    return;
  }
  if (projectsSub === "repository") {
    const box = el("div", {}, el("p", { className: "dim", textContent: "Asking the VM…" }));
    section.replaceChildren(back, title, tabs, box);
    projectRepository(p.project, box);
    return;
  }
  const row = (name, words, control) => el("div", { className: "set" }, el("div", { className: "what" }, el("span", { textContent: name }), el("span", { textContent: words })), control);
  const markBtn = el("button", { type: "button", className: "mark-edit", title: "Change its mark", "aria-label": "Change its mark" }, projectBadge(p.project, looks[p.project]), el("span", { className: "mark-pen" }, svgIcon("pencil")));
  markBtn.addEventListener("click", openMark);
  const copy = el("button", { type: "button", className: "secondary quiet", textContent: "Copy" });
  copy.addEventListener("click", () => backend.copyText(p.project).then(() => flashStatus("path copied")).catch((e) => flashStatus(String(e))));
  section.replaceChildren(back, title, tabs,
    el("div", { className: "rows" },
      row("Its mark", "A colour, a letter, an icon or a picture: click it to change.", markBtn),
      row("Its path", p.project, copy)));
}

/** A project's Repository, as its settings (the proposals' A): the repository it is
 *  connected to, what Pi may do with it, and its activity in one line, the Repository panel
 *  of the window a click away. Read through the Git panel's manager (its dialogs too). */
function projectRepository(project, box) {
  const error = el("p", { className: "error", hidden: true });
  const git = makeGitManager(el("div"), () => project, (data, problem) => {
    if (!box.isConnected) return;
    if (!data) { box.replaceChildren(el("p", { className: "error", textContent: problem })); return; }
    const row = (name, words, ...controls) => el("div", { className: "set" }, el("div", { className: "what" }, el("span", { textContent: name }), el("span", { textContent: words })), ...controls);
    const button = (text, run, className = "secondary") => {
      const b = el("button", { type: "button", className, textContent: text });
      b.addEventListener("click", run);
      return b;
    };
    const out = [el("h2", { textContent: "Its repository" })];
    const forge = data.link && data.forges.find((f) => f.id === data.link.forge);
    if (!data.forges.length) {
      out.push(el("div", { className: "rows" }, row("No account on a forge yet", "Pi pushes its branches and opens pull requests through one: GitHub, GitLab, Gitea.",
        button("Add an account", () => showPrefsPage("git")))));
    } else if (!data.link) {
      out.push(el("div", { className: "rows" }, row("Not connected yet", "A repository of yours, where Pi pushes its pi/… branches.",
        button("Connect…", () => git.linkDialog()), button("Create…", () => git.createDialog()))));
    } else {
      let host = forge?.url || "";
      try { host = new URL(host).host; } catch { /* as written */ }
      const unlink = button("Unlink", async () => {
        if (!(await ask(`Unlink this project from ${data.link.repo}? Pi can no longer push nor open pull requests for it. Nothing is deleted, there or here.`))) return;
        try { await backend.repoUnlink(project); git.load(); } catch (e) { showError(error, String(e)); }
      }, "secondary danger");
      const logo = el("span", { className: "avatar", "aria-hidden": "true" }, svgIcon(/forgejo|codeberg/i.test(forge?.url || "") ? "logo-forgejo" : FORGE_ICONS[forge?.kind] || "git-branch"));
      out.push(el("div", { className: "rows" }, el("div", { className: "set" }, logo,
        el("div", { className: "what" }, el("span", { textContent: data.link.repo }),
          el("span", { textContent: [host, forge?.login, `default branch ${data.link.default_branch}`, data.branch ? `here: ${data.branch}` : ""].filter(Boolean).join(" · ") })), unlink)));
      // What Pi may do with it, and how a pull request is merged: saved as soon as chosen.
      const link = data.link;
      const save = async (mode, method) => {
        try { Object.assign(link, await backend.repoSettings(project, mode, method, link.agents || "")); git.load(); } catch (e) { showError(error, String(e)); }
      };
      const mode = el("button", { type: "button", className: "pick", "aria-haspopup": "menu" }, el("span"));
      const method = el("button", { type: "button", className: "pick", "aria-haspopup": "menu" }, el("span"));
      choiceButton(mode, Object.entries(REPO_MODES).map(([v, [label]]) => [v, label]), () => link.mode || "ask", (v) => save(v, link.merge_method || "merge"));
      choiceButton(method, Object.entries(MERGE_LABELS), () => link.merge_method || "merge", (v) => save(link.mode || "ask", v));
      out.push(el("h2", { textContent: "What Pi may do" }), el("div", { className: "rows" },
        row("Pi may", REPO_MODES[link.mode || "ask"][1], mode),
        row("Merges", "How a pull request is merged, once you approve it.", method)));
    }
    // What happens there, in one line: the Repository panel of the window has it all.
    const waits = data.approvals.length, prs = (data.prs || []).length, trees = (data.worktrees || []).length;
    const open = button("Open", () => { closePrefs(); showRepository(); }, "");
    out.push(el("h2", { textContent: "Activity" }), el("div", { className: "rows" }, row(
      waits ? `${waits} request${waits === 1 ? "" : "s"} wait${waits === 1 ? "s" : ""} for you` : "Nothing waits for you",
      [`${prs} pull request${prs === 1 ? "" : "s"} open`, `${trees} worktree${trees === 1 ? "" : "s"} of Pis`].join(" · ") + ". In the Repository panel of the window.", open)), error);
    box.replaceChildren(...out);
  });
  git.load();
}

/** A project's texts for Pi (the Project tab's, here now): AGENTS.md, APPEND_SYSTEM.md and
 *  SYSTEM.md, a row each (what it does, its file, empty or its tokens); one open at a time
 *  (the proposals' B), its text and Revert, Save. */
let promptOpen = null;
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

function drawSandbox(again) {
  drawSettingsPage("sandbox", again, () => (configValue("sandbox")
    ? [toggleRow("sandbox", "Sandbox", "Pi sees its project and ~/.pi only.", "sandbox",
      { confirmOff: "Run Pi without its sandbox? It then sees and may change everything your account can on the VM." })]
    : [offPage("shield", "Pi in a sandbox", [
      "Pi sees its project and its own settings (~/.pi), little else of the VM (bubblewrap).",
      "Where it may connect from there is set in Network.",
      "Off, as now: Pi sees and may change everything your account can on the VM.",
    ], "Turn on the sandbox", () => setConfig("sandbox", true, "sandbox"))]));
}

function drawNetwork(again) {
  drawSettingsPage("network", again, () => {
    const out = [];
    if (!configValue("sandbox")) {
      const go = el("button", { type: "button", className: "secondary quiet", textContent: "Open Sandbox" });
      go.addEventListener("click", () => showPrefsPage("sandbox"));
      return [el("div", { className: "rows" }, el("div", { className: "set" },
        el("div", { className: "what" }, el("span", { textContent: "The sandbox is off" }), el("span", { textContent: "The network is limited from inside the sandbox: turn it on first." })), go))];
    }
    if (!configValue("network_limit")) {
      return [offPage("globe", "Limit where Pi connects", [
        "Pi reaches only the places you allow: model providers, npm, GitHub, PyPI, and yours (a gateway, a mirror).",
        "The rest is refused and written to the picker's log (net.blocked).",
        "Off, as now: Pi may connect anywhere, and could send what it reads to any address.",
      ], "Limit the network", () => setConfig("network_limit", true, "network"))];
    }
    out.push(toggleRow("network_limit", "Limit the network", "Only the places below.", "network",
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
        el("span", { className: "origin", textContent: mine ? "yours" : "Pier's" }));
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
    out.push(el("h2", {}, el("span", { textContent: "Allowed places" }), el("span", { className: "aside", textContent: `${own.length + builtin.length} places, ${allowed} allowed` })));
    out.push(el("div", { className: "toolbar host-bar" }, searchBox(field), add), error, box);
    if (!piModels) loadPiModels().then(() => { if (!$("#prefs").hidden && prefsPage === "network") drawNetwork(false); });
    return out;
  });
}

// --- Git & forges ------------------------------------------------------------------

// Each forge's mark, monochrome as Pier's other icons (Gitea and Forgejo have none in Lucide).
const FORGE_ICONS = { github: "logo-github", gitlab: "logo-gitlab", gitea: "logo-gitea" };

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
    const more = el("button", { className: "icon-btn", type: "button", title: `${f.login}: more` }, svgIcon("ellipsis"));
    more.setAttribute("aria-label", more.title);
    more.setAttribute("aria-haspopup", "menu");
    more.addEventListener("click", () => showMenu(more, [["Forget this account", async () => {
      if (!(await ask(`Forget the ${FORGE_LABELS[f.kind]} account ${f.login}? Its token is deleted on the VM; revoke it on ${FORGE_LABELS[f.kind]} too. Repositories connected through it can no longer be pushed to.`))) return;
      try { await backend.forgeRemove(f.id); drawForges(); } catch (e) { showError(error, String(e)); }
    }, false, { icon: "trash", danger: true }]]));
    let host = f.url;
    try { host = new URL(f.url).host; } catch { /* as written */ }
    rows.append(el("div", { className: "set" },
      el("span", { className: "avatar", "aria-hidden": "true" }, svgIcon(/forgejo|codeberg/i.test(f.url) ? "logo-forgejo" : FORGE_ICONS[f.kind] || "git-branch")),
      el("div", { className: "what" }, el("span", { textContent: `${host} · ${f.login}` }), el("span", { textContent: "Token kept on the VM, never in Pi's sandbox." })),
      more));
  }
  if (!forges.length) rows.append(el("div", { className: "set" },
    el("div", { className: "what" }, el("span", { textContent: "No account yet" }),
      el("span", { textContent: "Pi pushes its pi/… branches and opens pull requests through one; each project picks one in Repository." }))));
  section.replaceChildren(
    el("h2", { textContent: "Accounts" }),
    rows, error,
    el("h2", { textContent: "Pi's git tools" }),
    (() => {
      // A key of config.toml: drawn as on Agents, once the config is known.
      const row = el("div");
      loadPickerConfig().then(() => row.replaceWith(toggleRow("git_tools", "Git tools", "Push, pull requests, tasks, through Pier.", "git"),
        toggleRow("worktrees", "Worktrees", "A worker works in a worktree of its own.", "git"))).catch(() => row.remove());
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
let extTab = "installed"; // the tab shown: installed or browse

/** Extensions' parts (its bar, its lists, Browse): in their page, or in a project's page. They
 *  stay in the document either way (their lists are drawn again once read). */
const extHome = () => $('#prefs .prefs-page[data-page="extensions"]');
function extInto(host) {
  for (const part of [$(".ext-bar"), $("#ext-manager"), $("#ext-packages"), $("#ext-pack")]) {
    if (part && part.parentElement !== host && !(part.id === "ext-packages" && part.closest("#ext-manager"))) host.append(part);
  }
}

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
  $(".ext-bar").classList.toggle("only-yours", !extFromProject);
  const back = $("#ext-back");
  back.hidden = !extFromProject;
  $("#ext-title").hidden = !extFromProject;
  if (extFromProject) {
    back.replaceChildren(svgIcon("arrow-left"), el("span", { textContent: "Back" }));
    back.title = `Back to ${projectLabel(extProject)}`;
    back.onclick = () => { extFromProject = false; projectsOpen = extProject; projectsSub = null; showPrefsPage("projects"); };
    let looks = {};
    try { looks = JSON.parse(localStorage.getItem("devbox.conversations.v1"))?.looks || {}; } catch { /* none */ }
    $("#ext-title").replaceChildren(projectBadge(extProject, looks[extProject]), el("h2", { textContent: projectLabel(extProject) }));
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
    // What is added from a project's settings is that project's; from anywhere else, yours.
    const whereTo = () => (extFromProject ? "project" : "user");
    // The tabs: Skills, Extensions, Prompts (the manager), Packages (the list and the gallery).
    // Installed (what Pi loads, by kind, its packages first) and Browse (pi.dev's): the proposals' 1A.
    const TABS = [["installed", "Installed"], ["browse", "Browse"]];
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
      $("#ext-manager").hidden = key !== "installed";
      $("#ext-pack").hidden = key !== "browse";
      if (key === "browse") tools.shown();
      else manager.show("all");
    };
    const counts = () => {
      const d = manager.data();
      const n = { installed: (d?.skills?.length || 0) + (d?.extensions?.length || 0) + (d?.pier?.length || 0) + (d?.prompts?.length || 0) + (d?.packages?.length || 0) };
      for (const [k, b] of Object.entries(tabs)) $(".n", b).textContent = d && k in n ? String(n[k]) : "";
    };
    const packs = el("div", { className: "loads-packages" }, el("h3", { className: "loads-group", textContent: "Packages" }), $("#ext-packages"));
    const manager = makeResourceManager($("#ext-manager"), current,
      () => { renderPackageList($("#ext-packages"), manager.data(), extProject, () => manager.load()); tools.installed(manager.data()?.packages, manager.data()?.skills); counts(); }, packs,
      { scope: whereTo, browse: () => showTab("browse"), only: () => (extFromProject ? null : "user"), bar: false });
    const tools = makePackageTools($("#ext-package-tools"), current, () => manager.load(), whereTo);
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
