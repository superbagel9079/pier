// Settings > Agents and Network & sandbox: keys of the picker's config.toml on the VM
// (and Pi's own default model), read and written through the picker, which checks each.

// ============================================================================
// The picker's config, from Pier
// ============================================================================

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
  else drawNetwork(false);
  return true;
}

/** One setting: its label and control on a line, what it does under it; marked when
 *  config.toml sets it, with "reset" to drop it. */
function settingRow(key, label, control, hint, page) {
  const info = pickerConfig?.keys?.[key];
  const row = el("div", { className: "setting-row" + (info?.set ? " modified" : "") });
  row.dataset.key = key;
  const id = `setting-${key}`;
  const field = control.input || control; // a model picker: its field
  if (field.matches?.("input, select")) field.id = id;
  const error = el("p", { className: "error", hidden: true });
  const head = el("div", { className: "setting-head" },
    el("label", { htmlFor: id, textContent: label }), control);
  if (info?.set) {
    head.append(linkButton("reset", `Back to the default (${JSON.stringify(info.default)}): the line goes from config.toml`,
      () => setConfig(key, null, page, noticeSetter(error))));
  }
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
  const picker = modelPicker(configValue(key), empty, (v) => setConfig(key, v, "agents", row.say), { emptyChoice: true });
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
  box.append(el("p", { className: "hint", textContent: `Written to ${pickerConfig.path} on the VM, for the Pis started from now on (running ones keep what they had). Lines marked are set there; reset drops them.` }));
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
    const refresh = linkButton("list again", "Ask Pi for its models again (pi --list-models)", async () => {
      models.textContent = "Asking Pi…";
      await loadPiModels(true);
      drawAgents(false);
    });
    if (!piModels) {
      models.textContent = "Asking Pi for its models…";
      loadPiModels().then(() => drawAgents(false));
    } else if (piModels.problem && !piModels.models.length) {
      models.textContent = `Pi did not list its models (${piModels.problem}): type them as provider/id.`;
    } else {
      const providers = piModels.providers.join(", ");
      models.textContent = `${piModels.models.length} models Pi knows, from ${providers || "no provider"}: type a few letters in a field to choose. A gateway such as Bifrost lists its own as models of one provider.`;
    }
    models.append(" ", refresh);
    out.push(el("h2", { textContent: "Models" }), models, defRow,
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
      toggleRow("git_tools", "Git tools", "push, pull requests and tasks for the forge connected in Repository > Git, through the picker: the token stays out of Pi's reach.", "agents"),
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
    // Each place has its box: unchecked, it stays in the list but Pi no longer reaches it
    // (network_off). Yours also have × to take them out.
    const off = (configValue("network_off") || []).map((e) => e.toLowerCase());
    const isOff = (entry) => off.includes(entry.toLowerCase());
    const offRow = settingRow("network_off", "Built in", el("span"), "Model providers, npm, GitHub, PyPI: built into the picker. Uncheck those Pi does not need (a gateway such as Bifrost carries every model: the providers' own hosts are then of no use).", "network");
    const setOff = (entry, on) => {
      const rest = off.filter((e) => e !== entry.toLowerCase());
      return setConfig("network_off", on ? rest : [...rest, entry], "network", offRow.say);
    };
    const placeItem = (entry, removable) => {
      const box = el("input", { type: "checkbox", checked: !isOff(entry), title: isOff(entry) ? `Pi may not reach ${entry}: check to allow it` : `Pi may reach ${entry}: uncheck to refuse it` });
      box.setAttribute("aria-label", `Allow ${entry}`);
      box.addEventListener("change", () => setOff(entry, box.checked));
      const li = el("li", { className: isOff(entry) ? "off" : "" }, box, el("span", { className: "name", textContent: entry }));
      if (removable) li.append(el("button", { className: "icon", textContent: "×", title: `Take ${entry} out of the list`, onclick: () => removeOwn(entry) }));
      return li;
    };
    const builtin = el("ul", { className: "setting-list" }, ...(pickerConfig.network_builtin || []).map((h) => placeItem(h, false)));
    offRow.querySelector(".setting-key").before(builtin);
    offRow.querySelector(".setting-key").textContent = "network_off";
    const own = [...(configValue("network_allow") || [])];
    const ownRow = settingRow("network_allow", "Yours", el("span"), "A gateway (Bifrost), Hindsight, a mirror: host, host:port, or .domain for every name under it.", "network");
    const removeOwn = async (entry) => {
      if (await setConfig("network_allow", own.filter((e) => e !== entry), "network", ownRow.say) && isOff(entry)) {
        await setConfig("network_off", off.filter((e) => e !== entry.toLowerCase()), "network", ownRow.say);
      }
    };
    const ownList = el("ul", { className: "setting-list" }, ...own.map((h) => placeItem(h, true)));
    if (!own.length) ownList.append(el("li", { className: "dim", textContent: "none yet" }));
    const field = el("input", { type: "text", placeholder: "bifrost.example.org or .example.org", spellcheck: false, autocomplete: "off", id: "setting-network_allow-new" });
    field.setAttribute("aria-label", "Add a place Pi may reach");
    const add = el("button", { className: "secondary", textContent: "Add" });
    const go = () => { const v = field.value.trim(); if (v) setConfig("network_allow", [...own, v], "network", ownRow.say); };
    add.addEventListener("click", go);
    field.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
    ownRow.querySelector(".setting-head > label").htmlFor = field.id;
    ownRow.querySelector(".setting-key").before(ownList, el("div", { className: "setting-add" }, field, add));
    const limited = configValue("network_limit");
    for (const row of [offRow, ownRow]) row.classList.toggle("inactive", !limited);
    out.push(el("h2", { textContent: "Where Pi may connect" }));
    if (!limited) out.push(el("p", { className: "notice", textContent: "Limit where Pi may connect is off: Pi may connect anywhere, and this list does not apply." }));
    out.push(offRow, ownRow);
    const provider = (piModels?.default || "").split("/")[0];
    const known = ["anthropic", "openrouter", "deepseek"];
    if (provider && !known.includes(provider)) {
      out.push(el("p", { className: "notice", textContent: `Pi's default model goes through ${provider}: its host must be checked in Yours. If every model goes through it, the built-in model providers can be unchecked.` }));
    }
    if (!piModels) loadPiModels().then(() => { if (!$("#prefs").hidden && prefsPage === "network") drawNetwork(false); });
    return out;
  });
}
