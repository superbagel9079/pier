// Labs: machines where Pi may do anything. Settings > Labs turns them on and sets their
// limits and the machines; the Labs tab shows them, with a terminal in each.

// ============================================================================
// An option, off until turned on: Pi's sandbox does not change. A lab is a disposable
// Incus container (or a VM) on the VM, made by Pi or by you; a machine is a computer
// you add, reached over SSH with a key the picker makes. See "labs" in the picker.
// ============================================================================

let labsStatus = null; // the last answer of the picker: settings, labs, machines

const LABS_INSTALL = `sudo apt install incus
sudo incus admin init --minimal
sudo adduser $USER incus`;

function labsAge(seconds) {
  const left = seconds - Date.now() / 1000;
  if (left <= 0) return "going now";
  const h = Math.floor(left / 3600);
  return h >= 24 ? `goes in ${Math.floor(h / 24)} d` : h >= 1 ? `goes in ${h} h` : `goes in ${Math.max(1, Math.round(left / 60))} min`;
}

/** A terminal in a lab or on a machine. */
function openLabTerminal(name) {
  const existing = workspace.tabs().find((t) => t.kind === "lab" && t.params?.args?.[0] === name);
  if (existing) { workspace.show(existing); return; }
  workspace.add("lab", workspace.find("main")?.dock || "center", { params: { args: [name], label: name } });
}

// --- Settings > Labs ------------------------------------------------------------------

const LAB_LIMITS = [
  ["max", "Labs at most, at a time", "number", 1, 10],
  ["ttl_hours", "A lab goes after (hours)", "number", 1, 720],
  ["cpu", "CPUs per lab", "number", 1, 64],
  ["memory_gib", "Memory per lab (GiB)", "number", 1, 256],
  ["disk_gib", "Disk per lab (GiB)", "number", 2, 2000],
  ["network", "Network", "select"],
  ["image", "Default image", "text"],
];

async function fillLabsPrefs() {
  const state = $("#labs-state");
  showError($("#labs-error"), "");
  state.textContent = "Asking the VM…";
  try {
    labsStatus = await backend.api(["labs"]);
  } catch (e) {
    state.textContent = "";
    showError($("#labs-error"), String(e));
    return;
  }
  renderLabsPrefs();
}

function renderLabsPrefs() {
  const s = labsStatus;
  if (!s) return;
  $("#labs-enabled").checked = s.settings.enabled;
  $("#labs-state").textContent = s.incus
    ? `Incus answers on the VM · ${s.kvm ? "containers and virtual machines" : "containers (virtual machines need /dev/kvm: in Proxmox, the VM's CPU type set to host)"} · ${s.labs.length} lab${s.labs.length === 1 ? "" : "s"} now`
    : `${s.why}. To make labs, on the VM:`;
  $("#labs-install").hidden = s.incus;
  $("#labs-install").textContent = LABS_INSTALL;
  $("#labs-relogin").hidden = s.incus;
  for (const section of document.querySelectorAll(".labs-on")) section.hidden = !s.settings.enabled;

  const grid = $("#labs-limits");
  grid.innerHTML = "";
  for (const [key, label, type, min, max] of LAB_LIMITS) {
    let input;
    if (type === "select") {
      input = el("select");
      input.add(new Option("open (apt, git, the internet)", "open"));
      input.add(new Option("cut (nothing in or out)", "none"));
    } else {
      input = el("input", { type, spellcheck: false });
      if (type === "number") Object.assign(input, { min, max });
    }
    input.id = `labs-${key}`;
    input.value = s.settings[key];
    input.addEventListener("change", () => saveLabsSettings({ [key]: type === "number" ? Math.round(Number(input.value)) : input.value.trim() }));
    grid.append(el("label", { htmlFor: input.id, textContent: label }), input);
  }

  const list = $("#labs-machines");
  list.innerHTML = "";
  for (const m of s.machines) {
    const test = el("button", { className: "link", textContent: "test", title: "Connect and ask its system's name" });
    test.addEventListener("click", async () => {
      test.disabled = true;
      try {
        const answer = await backend.machineTest(m.name);
        flashStatus(`${m.name}: ${answer.answer}`);
      } catch (e) { showError($("#labs-error"), `${m.name}: ${e}`); } finally { test.disabled = false; }
    });
    const remove = el("button", { className: "link", textContent: "×", title: "Pi can no longer use it (remove the key on the machine too)" });
    remove.addEventListener("click", async () => {
      if (!(await ask(`Remove the machine ${m.name}? Pi can no longer use it. Remove Pier's key from its authorized_keys too.`))) return;
      try { await backend.machineRemove(m.name); fillLabsPrefs(); } catch (e) { showError($("#labs-error"), String(e)); }
    });
    list.append(el("li", { className: "two-lines" },
      el("div", { className: "line" }, el("span", { className: "name", textContent: m.name }), el("span", { className: "dim" }), test, remove),
      el("div", { className: "desc dim small", textContent: `${m.user}@${m.host}:${m.port} · ${m.policy === "auto" ? "Pi runs commands freely" : "each command waits for your approval"}` })));
  }
  if (!s.machines.length) list.append(el("li", { className: "dim small note", textContent: "None. A machine is a computer of yours Pi may use over SSH: a server with a GPU, a test server…" }));
  $("#labs-key").hidden = !s.public_key;
  $("#labs-key-text").textContent = s.public_key || "";
}

async function saveLabsSettings(changes) {
  showError($("#labs-error"), "");
  try {
    labsStatus = await backend.labsSettings(JSON.stringify(changes));
    renderLabsPrefs();
    vm.poke();
  } catch (e) {
    showError($("#labs-error"), String(e));
    fillLabsPrefs();
  }
}

$("#labs-enabled").addEventListener("change", (e) => saveLabsSettings({ enabled: e.target.checked }));
$("#labs-open").addEventListener("click", () => {
  closePrefs();
  workspace.add("labs", workspace.find("setup")?.dock || "right");
});
$("#labs-key-copy").addEventListener("click", async () => {
  try { await backend.copyText(labsStatus?.public_key || ""); flashStatus("Pier's key copied"); } catch (e) { showError($("#labs-error"), String(e)); }
});
$("#labs-machine-add").addEventListener("click", () => {
  const name = el("input", { placeholder: "gpu-box", spellcheck: false });
  const host = el("input", { placeholder: "192.168.1.30 or box.example.org", spellcheck: false });
  const port = el("input", { type: "number", value: 22, min: 1, max: 65535 });
  const user = el("input", { placeholder: "leo", spellcheck: false });
  const policy = el("select");
  policy.add(new Option("each command waits for my approval", "ask"));
  policy.add(new Option("Pi runs commands freely", "auto"));
  const problem = dialogError();
  const go = el("button", { textContent: "Add" });
  const dialog = resourceDialog("A machine for Pi", [
    el("div", { className: "grid fields" },
      el("label", { textContent: "Name" }), name, el("label", { textContent: "Address" }), host,
      el("label", { textContent: "Port" }), port, el("label", { textContent: "User" }), user,
      el("label", { textContent: "Pi's commands" }), policy),
    el("p", { className: "hint", textContent: "Pier makes a key of its own on the VM (Pi never sees it). Once added, put its public key in that user's ~/.ssh/authorized_keys on the machine, then test it. Prefer a user made for this, without sudo." }),
    problem], [go]);
  go.addEventListener("click", async () => {
    go.disabled = true;
    try {
      const added = await backend.machineAdd(name.value.trim(), host.value.trim(), Number(port.value) || 22, user.value.trim(), policy.value);
      dialog.close();
      await fillLabsPrefs();
      try { await backend.copyText(added.public_key); } catch { /* shown anyway */ }
      flashStatus(`${added.machine} added: Pier's key copied, put it in ~/.ssh/authorized_keys there`);
    } catch (e) { showError(problem, String(e)); } finally { go.disabled = false; }
  });
  name.focus();
});

// --- the Labs tab ------------------------------------------------------------------------

function makeLabs(tab) {
  const error = el("p", { className: "error", hidden: true });
  const body = el("div");
  const make = el("button", { className: "secondary", textContent: "New lab" });
  const makeVm = el("button", { className: "secondary", textContent: "New VM lab", hidden: true });
  const settings = el("button", { className: "link", textContent: "settings", title: "Settings > Labs" });
  const bar = el("div", { className: "toolbar" }, make, makeVm, el("span", { className: "dim small", style: "flex:1" }), settings);
  tab.pane.append(el("div", { className: "pane-labs" }, bar, error, body));
  settings.addEventListener("click", () => { openPrefs(); showPrefsPage("labs"); fillLabsPrefs(); });
  const create = (vmKind) => async () => {
    make.disabled = makeVm.disabled = true;
    flashStatus(vmKind ? "Making a VM lab (a minute or two)…" : "Making a lab…");
    try {
      const made = await backend.labAction("create", "", vmKind ? "vm" : "");
      flashStatus(`${made.lab} is ready`);
      vm.poke();
    } catch (e) { showError(error, String(e)); } finally { make.disabled = makeVm.disabled = false; }
  };
  make.addEventListener("click", create(false));
  makeVm.addEventListener("click", create(true));

  const action = (text, title, run) => {
    const b = el("button", { className: "link", textContent: text, title });
    b.addEventListener("click", run);
    return b;
  };
  const line = (name, detail, ...actions) => el("li", { className: "two-lines" },
    el("div", { className: "line" }, el("span", { className: "name", textContent: name }), el("span", { className: "dim" }), ...actions),
    detail ? el("div", { className: "desc dim small", textContent: detail }) : null);

  function render(message) {
    if (message.error) { showError(error, message.error); return; }
    showError(error, "");
    const s = message.data;
    labsStatus = s;
    body.innerHTML = "";
    bar.hidden = !s.settings.enabled || !s.incus;
    makeVm.hidden = !s.kvm;
    if (!s.settings.enabled) {
      body.append(el("p", { className: "dim small", textContent: "Labs are off. They let Pi make disposable machines where it may do anything (install packages, run services, Docker) and use your machines over SSH, without changing its own sandbox." }));
      const on = el("button", { className: "secondary", textContent: "Turn them on in Settings…" });
      on.addEventListener("click", () => { openPrefs(); showPrefsPage("labs"); fillLabsPrefs(); });
      body.append(on);
      return;
    }
    if (!s.incus) body.append(el("p", { className: "notice", textContent: `No lab can be made: ${s.why}. See Settings > Labs.` }));

    body.append(el("h2", { textContent: `Labs · ${s.labs.length} of ${s.settings.max}` }));
    const labs = el("ul", { className: "resource-items" });
    for (const lab of s.labs) {
      const owner = lab.project ? projectLabel(lab.project) : "yours";
      const facts = [owner, lab.vm ? "VM" : "container", lab.image, lab.status?.toLowerCase(), lab.network === "none" ? "no network" : lab.address,
        lab.docker === false && !lab.vm ? "no Docker" : "", lab.expires ? labsAge(lab.expires) : ""].filter(Boolean);
      labs.append(line(lab.name, facts.join(" · "),
        action("terminal", "A shell in the lab, as root", () => openLabTerminal(lab.name)),
        action("reset", "Back to how it was made", async () => {
          if (!(await ask(`Put ${lab.name} back as it was made? What was done in it since is lost.`))) return;
          try { await backend.labAction("reset", lab.name, ""); flashStatus(`${lab.name} is clean again`); vm.poke(); } catch (e) { showError(error, String(e)); }
        }),
        action("destroy", "Destroy it now", async () => {
          if (!(await ask(`Destroy ${lab.name}? Everything in it goes.`))) return;
          try { await backend.labAction("destroy", lab.name, ""); vm.poke(); } catch (e) { showError(error, String(e)); }
        })));
    }
    if (!s.labs.length) labs.append(el("li", { className: "dim small note", textContent: "No lab. Pi makes one when it needs it (lab_create), or New lab makes one for you." }));
    body.append(labs);

    if (s.machines.length) {
      body.append(el("h2", { textContent: `Machines · ${s.machines.length}` }));
      const machines = el("ul", { className: "resource-items" });
      for (const m of s.machines) {
        machines.append(line(m.name, `${m.user}@${m.host} · ${m.policy === "auto" ? "Pi runs commands freely" : "each command waits for your approval"}`,
          action("terminal", "A shell there", () => openLabTerminal(m.name))));
      }
      body.append(machines);
    }

    body.append(el("h2", { textContent: "What was done" }));
    const journal = el("ul", { className: "resource-items" });
    for (const j of (message.data.journal || []).slice(0, 40)) {
      const when = new Date(j.at * 1000).toLocaleTimeString();
      const what = j.command ? `$ ${j.command}` : j.what;
      const result = j.command ? (j.exit === 0 ? "ok" : j.exit === null ? "stopped" : `exit ${j.exit}`) : "";
      journal.append(line(`${j.lab} · ${what}`, [when, result, j.ms ? `${(j.ms / 1000).toFixed(1)} s` : "", j.project ? projectLabel(j.project) : ""].filter(Boolean).join(" · ")));
    }
    if (!(message.data.journal || []).length) journal.append(el("li", { className: "dim small note", textContent: "Nothing yet. Every command Pi runs in a lab or on a machine is written here." }));
    body.append(journal);
  }

  vm.follow({ labs: true });
  const unlisten = vm.on("labs", render);
  tab.onClose = () => { unlisten(); vm.follow({ labs: false }); };
}
