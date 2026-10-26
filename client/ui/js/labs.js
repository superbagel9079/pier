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
sudo adduser $USER incus

# optional, once you reconnected (instant reset; Docker in containers):
sudo incus project set user-$(id -u) restricted.snapshots=allow restricted.containers.nesting=allow`;

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
  if (s.incus && s.labs.some((l) => l.snapshots === false)) {
    $("#labs-state").textContent += " · this Incus project refuses snapshots: Reset rebuilds a lab from its image (allow them: sudo incus project set user-$(id -u) restricted.snapshots=allow)";
  }
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
      input.add(new Option("open: Incus's NAT (apt, git, the internet)", "open"));
      input.add(new Option("your VLAN (an IP from your firewall)", "vlan"));
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
      m.description ? el("div", { className: "desc dim small", textContent: m.description }) : null,
      el("div", { className: "desc dim small", textContent: `${m.user}@${m.host}:${m.port} · ${m.policy === "auto" ? "Pi runs commands freely" : "each command waits for your approval"}` })));
  }
  if (!s.machines.length) list.append(el("li", { className: "dim small note", textContent: "None. A machine is a computer of yours Pi may use over SSH: a server with a GPU, a test server…" }));
  const vlan = s.vlan || {};
  const vlanSetup = $("#labs-vlan");
  vlanSetup.hidden = s.settings.network !== "vlan";
  $("#labs-vlan-state").textContent = vlan.ready
    ? `The labs get their address from your firewall, on the Incus network ${vlan.network}.`
    : `The Incus network ${vlan.network} is not there, or this account may not use it${vlan.networks?.length ? ` (it sees: ${vlan.networks.join(", ")})` : ""}. Once, as described in the README (Labs on a VLAN of their own): the VLAN on the firewall, a second network card of the VM on it in Proxmox, then on the VM:`;
  $("#labs-vlan-commands").hidden = Boolean(vlan.ready);
  $("#labs-vlan-commands").textContent = `ip -br link        # the new card, without an address (often ens19)
sudo incus network create ${vlan.network} --type=macvlan parent=ens19
incus network list  # your own network's name (often incusbr-1000)
sudo incus project set user-$(id -u) restricted.networks.access=incusbr-$(id -u),${vlan.network}`;
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
  const description = el("input", { placeholder: "what it is for, what to leave alone there", spellcheck: false });
  const policy = el("select");
  policy.add(new Option("each command waits for my approval", "ask"));
  policy.add(new Option("Pi runs commands freely", "auto"));
  const problem = dialogError();
  const go = el("button", { textContent: "Add" });
  const dialog = resourceDialog("A machine for Pi", [
    el("div", { className: "grid fields" },
      el("label", { textContent: "Name" }), name, el("label", { textContent: "Address" }), host,
      el("label", { textContent: "Port" }), port, el("label", { textContent: "User" }), user,
      el("label", { textContent: "Description" }), description,
      el("label", { textContent: "Pi's commands" }), policy),
    el("p", { className: "hint", textContent: "Pier makes a key of its own on the VM (Pi never sees it). Once added, put its public key in that user's ~/.ssh/authorized_keys on the machine, then test it. Prefer a user made for this, without sudo." }),
    problem], [go]);
  go.addEventListener("click", async () => {
    go.disabled = true;
    try {
      const added = await backend.machineAdd(name.value.trim(), host.value.trim(), Number(port.value) || 22, user.value.trim(), policy.value, description.value.trim());
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
  const make = el("button", { className: "secondary", textContent: "New lab…" });
  const settings = el("button", { className: "link", textContent: "settings", title: "Settings > Labs" });
  const bar = el("div", { className: "toolbar" }, make, el("span", { className: "dim small", style: "flex:1" }), settings);
  tab.pane.append(el("div", { className: "pane-labs" }, bar, error, body));
  settings.addEventListener("click", () => { openPrefs(); showPrefsPage("labs"); fillLabsPrefs(); });
  make.addEventListener("click", () => newLabDialog());

  /** A lab of your own: a name, what it is for, a container or a VM. */
  function newLabDialog() {
    const name = el("input", { placeholder: "lab-N when left empty", spellcheck: false });
    const description = el("input", { placeholder: "what it is for (optional)", spellcheck: false });
    const kind = el("select");
    kind.add(new Option("container (seconds to make)", ""));
    if (labsStatus?.kvm) kind.add(new Option("virtual machine (a minute or two)", "vm"));
    const problem = dialogError();
    const go = el("button", { textContent: "Make it" });
    const dialog = resourceDialog("A new lab", [
      el("div", { className: "grid fields" }, el("label", { textContent: "Name" }), name, el("label", { textContent: "Description" }), description,
        el("label", { textContent: "Kind" }), kind),
      el("p", { className: "hint", textContent: "Yours: no project's Pi uses it. Open a terminal in it from the list once it is ready." }), problem], [go]);
    go.addEventListener("click", async () => {
      go.disabled = true;
      go.textContent = "Making it…";
      try {
        const made = await backend.labNew(name.value.trim(), kind.value === "vm", description.value.trim());
        dialog.close();
        flashStatus(`${made.lab} is ready`);
        vm.poke();
      } catch (e) { showError(problem, String(e)); } finally { go.disabled = false; go.textContent = "Make it"; }
    });
    name.focus();
  }

  /** A lab or a machine renamed, its description changed. */
  function editDialog(item, what) {
    const name = el("input", { value: item.name, spellcheck: false });
    const description = el("input", { value: item.description || "", placeholder: what === "machine" ? "what it is for, what to leave alone there" : "what it is for", spellcheck: false });
    const problem = dialogError();
    const go = el("button", { textContent: "Save" });
    const dialog = resourceDialog(`Edit ${item.name}`, [
      el("div", { className: "grid fields" }, el("label", { textContent: "Name" }), name, el("label", { textContent: "Description" }), description),
      el("p", { className: "hint", textContent: what === "machine"
        ? "Pi reads the description in lab_list: say what the machine is for, and what it must not touch."
        : "Renaming stops the lab for a moment (Incus renames a stopped lab), then starts it again." }), problem], [go]);
    go.addEventListener("click", async () => {
      go.disabled = true;
      try {
        await backend.labEdit(item.name, name.value.trim(), description.value.trim());
        dialog.close();
        vm.poke();
      } catch (e) { showError(problem, String(e)); } finally { go.disabled = false; }
    });
    description.focus();
  }

  const action = (text, title, run) => {
    const b = el("button", { className: "link", textContent: text, title });
    b.addEventListener("click", run);
    return b;
  };
  // A name, its actions, then its description (if any) and its facts, each on its line.
  const line = (name, detail, ...actions) => el("li", { className: "two-lines" },
    el("div", { className: "line" }, el("span", { className: "name", textContent: name }), el("span", { className: "dim" }), ...actions),
    ...[].concat(detail || []).filter(Boolean).map((text) => el("div", { className: "desc dim small", textContent: text })));

  function render(message) {
    if (message.error) { showError(error, message.error); return; }
    showError(error, "");
    const s = message.data;
    labsStatus = s;
    body.innerHTML = "";
    bar.hidden = !s.settings.enabled || !s.incus;
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
      const facts = [owner, lab.vm ? "VM" : "container", lab.image, lab.status?.toLowerCase(),
        lab.network === "none" ? "no network" : lab.network === "vlan" ? `VLAN ${lab.address || "(waiting for its address)"}` : lab.address,
        lab.docker === false && !lab.vm ? "no Docker" : "", lab.snapshots === false ? "reset rebuilds it" : "", lab.expires ? labsAge(lab.expires) : ""].filter(Boolean);
      labs.append(line(lab.name, [lab.description, facts.join(" · ")],
        action("terminal", "A shell in the lab, as root", () => openLabTerminal(lab.name)),
        action("edit", "Rename it, describe it", () => editDialog(lab, "lab")),
        action("reset", "Back to how it was made", async () => {
          if (!(await ask(`Put ${lab.name} back as it was made? What was done in it since is lost.`))) return;
          try { await backend.labAction("reset", lab.name, ""); flashStatus(`${lab.name} is clean again`); vm.poke(); } catch (e) { showError(error, String(e)); }
        }),
        action("destroy", "Destroy it now", async () => {
          if (!(await ask(`Destroy ${lab.name}? Everything in it goes.`))) return;
          try { await backend.labAction("destroy", lab.name, ""); vm.poke(); } catch (e) { showError(error, String(e)); }
        })));
    }
    if (!s.labs.length) labs.append(el("li", { className: "dim small note", textContent: "No lab. Pi makes one when it needs it (lab_create), or New lab… makes one for you." }));
    body.append(labs);

    if (s.machines.length) {
      body.append(el("h2", { textContent: `Machines · ${s.machines.length}` }));
      const machines = el("ul", { className: "resource-items" });
      for (const m of s.machines) {
        machines.append(line(m.name, [m.description, `${m.user}@${m.host} · ${m.policy === "auto" ? "Pi runs commands freely" : "each command waits for your approval"}`],
          action("terminal", "A shell there", () => openLabTerminal(m.name)),
          action("edit", "Rename it, describe it for Pi", () => editDialog(m, "machine"))));
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
