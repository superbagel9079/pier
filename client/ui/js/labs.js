// Labs: machines where Pi may do anything. Settings > Labs turns them on and sets their
// limits and the machines; the Labs tab shows them, with a terminal in each.

// ============================================================================
// An option, off until turned on: Pi's sandbox does not change. Labs are made on lab
// hosts the user adds (another VM with Incus, reached over SSH, or Pi's own VM when
// chosen): none, no lab. A lab is a disposable Incus container (or a VM), made by Pi or
// by you; a machine is a computer Pi drives directly over SSH. See "labs" in the picker.
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
  ["network", "Network of a new lab, by default", "select"],
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
  const hosts = s.hosts || [];
  const ready = hosts.filter((h) => h.incus);
  $("#labs-state").textContent = !hosts.length
    ? "No lab host yet: no lab can be made. Add one below (another VM with Incus), or use Pi's VM."
    : `${hosts.length} lab host${hosts.length === 1 ? "" : "s"}, ${ready.length} ready · default: ${s.default_host || "none"} · ${s.labs.length} lab${s.labs.length === 1 ? "" : "s"} now`;
  $("#labs-install").hidden = true;
  $("#labs-relogin").hidden = true;
  renderLabHosts(s);
  for (const section of document.querySelectorAll(".labs-on")) section.hidden = !s.settings.enabled;

  const grid = $("#labs-limits");
  grid.innerHTML = "";
  for (const [key, label, type, min, max] of LAB_LIMITS) {
    let input;
    if (type === "select") {
      input = el("select");
      input.add(new Option("Incus's NAT: the internet through the host", "open"));
      input.add(new Option("your VLAN: an address from your firewall", "vlan"));
      input.add(new Option("none: nothing in or out", "none"));
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
  renderLabNetworks(s);
  $("#labs-key").hidden = !s.public_key;
  $("#labs-key-text").textContent = s.public_key || "";
}

/** Settings > Labs > Lab hosts: where labs are made, whether Incus answers there. */
function renderLabHosts(s) {
  const list = $("#labs-hosts");
  list.innerHTML = "";
  const hosts = s.hosts || [];
  const link = (text, title, run) => {
    const b = el("button", { className: "link", textContent: text, title });
    b.addEventListener("click", run);
    return b;
  };
  for (const h of hosts) {
    const state = h.incus ? (h.kvm ? "ready: containers and virtual machines" : "ready: containers (virtual machines need /dev/kvm there)") : `not ready: ${h.why}`;
    const actions = [
      link("test", "Ask its Incus", async () => {
        try { const r = await backend.hostTest(h.name); flashStatus(`${h.name}: ${r.answer}`); } catch (e) { showError($("#labs-error"), `${h.name}: ${e}`); }
        fillLabsPrefs();
      }),
      h.default ? null : link("make default", "New labs go there when none is named", () => saveLabsSettings({ default_host: h.name })),
      h.kind === "ssh" ? link("edit", "Rename it, describe it for Pi", () => labHostEdit(h)) : null,
      link("×", h.kind === "local" ? "Pi's VM no longer makes labs" : "No more labs made there", async () => {
        if (!(await ask(`Stop making labs on ${h.name}? Its labs must be destroyed first.`))) return;
        try { await (h.kind === "local" ? backend.hostLocal(false, "") : backend.hostRemove(h.name)); fillLabsPrefs(); } catch (e) { showError($("#labs-error"), String(e)); }
      }),
    ].filter(Boolean);
    const li = el("li", { className: "two-lines" },
      el("div", { className: "line" }, el("span", { className: "name", textContent: `${h.name}${h.default ? " · default" : ""}` }), el("span", { className: "dim" }), ...actions),
      h.description ? el("div", { className: "desc dim small", textContent: h.description }) : null,
      el("div", { className: "desc dim small", textContent: `${h.where} · ${state}` }));
    if (!h.incus) {
      li.append(el("p", { className: "hint", textContent: `To make it ready, on ${h.kind === "local" ? "Pi's VM" : h.where.split(":")[0]} (then test it again):` }),
        el("pre", { className: "labs-host-install", textContent: LABS_INSTALL }));
    }
    list.append(li);
  }
  if (!hosts.length) list.append(el("li", { className: "dim small note", textContent: "None. Labs are made on a lab host: another VM where Incus runs (Add a lab host…), or Pi's own VM if you choose it." }));
  const local = hosts.some((h) => h.kind === "local");
  $("#labs-host-local").textContent = local ? "" : "Use Pi's VM as a lab host";
  $("#labs-host-local").hidden = local;
}

function labHostEdit(h) {
  const name = el("input", { value: h.name, spellcheck: false });
  const description = el("input", { value: h.description || "", placeholder: "what it is for: fast disks, a GPU, near the database…", spellcheck: false });
  const problem = dialogError();
  const go = el("button", { textContent: "Save" });
  const dialog = resourceDialog(`Edit ${h.name}`, [
    el("div", { className: "grid fields" }, el("label", { textContent: "Name" }), name, el("label", { textContent: "Description" }), description),
    el("p", { className: "hint", textContent: "Pi reads the description in lab_list when it chooses where to make a lab." }), problem], [go]);
  go.addEventListener("click", async () => {
    try { await backend.labEdit(h.name, name.value.trim(), description.value.trim()); dialog.close(); fillLabsPrefs(); } catch (e) { showError(problem, String(e)); }
  });
  description.focus();
}

/** Settings > Labs > Networks: those a lab may be plugged into on each host, what each is for. */
function renderLabNetworks(s) {
  const list = $("#labs-networks");
  list.innerHTML = "";
  const all = (s.hosts || []).flatMap((h) => h.networks.map((n) => ({ ...n, host: h.name })));
  const several = (s.hosts || []).length > 1;
  for (const n of all) {
    const facts = [n.kind_label, n.address, n.vlan ? `VLAN ${n.vlan}` : "", n.parent ? `on ${n.parent}` : ""].filter(Boolean).join(" · ");
    const describe = el("button", { className: "link", textContent: "describe", title: "Say what it is for: Pi reads it when it chooses a lab's networks" });
    describe.addEventListener("click", () => {
      const text = el("input", { value: n.description || "", placeholder: "what it is for, e.g. the DMZ of the firewall tests", spellcheck: false });
      const problem = dialogError();
      const go = el("button", { textContent: "Save" });
      const dialog = resourceDialog(`The network ${n.name}`, [
        el("div", { className: "grid fields" }, el("label", { textContent: "Description" }), text),
        el("p", { className: "hint", textContent: "Shown here, in New lab…, and to Pi in lab_list." }), problem], [go]);
      go.addEventListener("click", async () => {
        try { await backend.labNetworkDescribe(n.name, text.value.trim()); dialog.close(); fillLabsPrefs(); } catch (e) { showError(problem, String(e)); }
      });
      text.focus();
    });
    list.append(el("li", { className: "two-lines" },
      el("div", { className: "line" }, el("span", { className: "name", textContent: several ? `${n.host} · ${n.name}` : n.name }), el("span", { className: "dim" }), describe),
      n.description ? el("div", { className: "desc dim small", textContent: n.description }) : null,
      el("div", { className: "desc dim small", textContent: facts })));
  }
  if (!all.length) list.append(el("li", { className: "dim small note", textContent: (s.hosts || []).length ? "No ready lab host shows a network yet." : "Add a lab host first." }));
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
$("#labs-host-local").addEventListener("click", async () => {
  if (!(await ask("Make labs on Pi's own VM too? They are Incus containers there, beside Pi, cut off from its files. Incus must be installed on it."))) return;
  try { await backend.hostLocal(true, ""); fillLabsPrefs(); } catch (e) { showError($("#labs-error"), String(e)); }
});
$("#labs-host-add").addEventListener("click", () => {
  const name = el("input", { placeholder: "lab-box", spellcheck: false });
  const host = el("input", { placeholder: "192.168.1.40 or labs.example.org", spellcheck: false });
  const port = el("input", { type: "number", value: 22, min: 1, max: 65535 });
  const user = el("input", { placeholder: "leo", spellcheck: false });
  const description = el("input", { placeholder: "what it is for (optional)", spellcheck: false });
  const problem = dialogError();
  const go = el("button", { textContent: "Add" });
  const dialog = resourceDialog("A lab host", [
    el("div", { className: "grid fields" },
      el("label", { textContent: "Name" }), name, el("label", { textContent: "Address" }), host,
      el("label", { textContent: "Port" }), port, el("label", { textContent: "User" }), user,
      el("label", { textContent: "Description" }), description),
    el("p", { className: "hint", textContent: "A VM where labs are made. On it: Incus installed, the user in its incus group, and Pier's key (copied when you add it) in that user's ~/.ssh/authorized_keys. Then test it here." }),
    problem], [go]);
  go.addEventListener("click", async () => {
    go.disabled = true;
    try {
      const added = await backend.hostAdd(name.value.trim(), host.value.trim(), Number(port.value) || 22, user.value.trim(), description.value.trim());
      dialog.close();
      try { await backend.copyText(added.public_key); } catch { /* shown anyway */ }
      flashStatus(`${added.host} added: Pier's key copied, put it in ~/.ssh/authorized_keys there`);
      fillLabsPrefs();
    } catch (e) { showError(problem, String(e)); } finally { go.disabled = false; }
  });
  name.focus();
});
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
  // Pi's requests about labs (a lab to make, a command on a machine set to ask), answered here.
  const waiting = el("div");
  tab.pane.append(el("div", { className: "pane-labs" }, bar, error, waiting, body));
  function renderWaiting(message) {
    const asks = (message?.data?.approvals || []).filter((a) => a.kind === "lab_create" || a.kind === "lab");
    waiting.innerHTML = "";
    if (!asks.length) return;
    waiting.append(el("h2", { textContent: "Waiting for you" }));
    const list = el("ul", { className: "resource-items" });
    for (const a of asks) {
      const nets = a.args.networks === null || a.args.networks === undefined ? "Incus's NAT" : a.args.networks.length ? a.args.networks.join(" + ") : "no network";
      const what = a.kind === "lab_create"
        ? `Pi asks for a lab: ${a.args.name}`
        : `Pi asks to ${String(a.args.what || "").slice(0, 200)}`;
      const detail = a.kind === "lab_create"
        ? [`${a.args.vm ? "VM" : "container"} · ${a.args.image} · ${nets}`, a.args.description, a.reason ? `why: ${a.reason}` : "", projectLabel(a.project)]
        : [`on ${a.args.machine}`, a.reason ? `why: ${a.reason}` : "", projectLabel(a.project)];
      const answer = (yes) => async () => {
        try { await backend.approvalAnswer(a.id, yes); flashStatus(yes ? "Approved: Pi goes on" : "Refused: Pi is told"); vm.poke(); } catch (e) { showError(error, String(e)); }
      };
      list.append(line(what, detail.filter(Boolean), action("approve", "Pi goes on", answer(true)), action("refuse", "Pi is told no", answer(false))));
    }
    waiting.append(list);
  }
  settings.addEventListener("click", () => { openPrefs(); showPrefsPage("labs"); fillLabsPrefs(); });
  make.addEventListener("click", () => newLabDialog());

  /** A lab of your own: a name, what it is for, a container or a VM. */
  function newLabDialog() {
    const name = el("input", { placeholder: "lab-N when left empty", spellcheck: false });
    const description = el("input", { placeholder: "what it is for (optional)", spellcheck: false });
    const readyHosts = (labsStatus?.hosts || []).filter((h) => h.incus);
    const hostPick = el("select");
    for (const h of readyHosts) hostPick.add(new Option(`${h.name}${h.default ? " (default)" : ""}${h.description ? ` · ${h.description}` : ""}`, h.name));
    hostPick.value = (readyHosts.find((h) => h.default) || readyHosts[0])?.name || "";
    const kind = el("select");
    const netBox = el("div");
    let boxes = [];
    // Its networks, on the host chosen: one interface on each ticked one (eth0, eth1…),
    // the default ones ticked.
    const showHost = () => {
      const h = readyHosts.find((x) => x.name === hostPick.value);
      kind.innerHTML = "";
      kind.add(new Option("container (seconds to make)", ""));
      if (h?.kvm) kind.add(new Option("virtual machine (a minute or two)", "vm"));
      boxes = networkBoxes(h?.networks || []);
      netBox.replaceChildren(...(boxes.length ? boxes : [el("p", { className: "dim small", textContent: "This host shows no network: the lab will have none." })]));
    };
    hostPick.addEventListener("change", showHost);
    const problem = dialogError();
    const go = el("button", { textContent: "Make it" });
    const dialog = resourceDialog("A new lab", [
      el("div", { className: "grid fields" }, el("label", { textContent: "Name" }), name, el("label", { textContent: "Description" }), description,
        el("label", { textContent: "Host" }), hostPick, el("label", { textContent: "Kind" }), kind),
      el("h3", { textContent: "Networks" }), netBox,
      el("p", { className: "hint", textContent: "One interface on each network ticked, in this order: eth0, eth1… Several make a lab that sits between them (a router, a firewall, a VPN). None ticked: a lab cut from everything. The kinds: the internet through the host (Incus's NAT, unseen by your firewall); a VLAN of your firewall (it gives the address and applies its rules); between labs only (no way out)." }),
      el("p", { className: "hint", textContent: "Yours: no project's Pi uses it. Open a terminal in it from the list once it is ready." }), problem], [go]);
    showHost();
    go.addEventListener("click", async () => {
      go.disabled = true;
      go.textContent = "Making it…";
      try {
        const chosen = boxes.map((b) => b.querySelector("input")).filter((b) => b.checked).map((b) => b.value);
        const made = await backend.labNew(name.value.trim(), kind.value === "vm", description.value.trim(), boxes.length ? chosen : null, hostPick.value || null);
        dialog.close();
        flashStatus(`${made.lab} is ready`);
        vm.poke();
      } catch (e) { showError(problem, String(e)); } finally { go.disabled = false; go.textContent = "Make it"; }
    });
    name.focus();
  }

  function networkBoxes(nets) {
    const defaults = labsStatus?.default_networks;
    return nets.map((n) => {
      const box = el("input", { type: "checkbox" });
      box.checked = defaults === null || defaults === undefined ? n.kind === "nat" && n === nets.find((x) => x.kind === "nat") : defaults.includes(n.name);
      box.value = n.name;
      return el("label", { className: "check net-choice" }, box,
        el("span", {}, el("strong", { textContent: n.name }), ` · ${n.kind_label}${n.description ? ` · ${n.description}` : ""}`));
    });
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
    bar.hidden = !s.settings.enabled || !(s.hosts || []).some((h) => h.incus);
    if (!s.settings.enabled) {
      body.append(el("p", { className: "dim small", textContent: "Labs are off. They let Pi make disposable machines where it may do anything (install packages, run services, Docker) and use your machines over SSH, without changing its own sandbox." }));
      const on = el("button", { className: "secondary", textContent: "Turn them on in Settings…" });
      on.addEventListener("click", () => { openPrefs(); showPrefsPage("labs"); fillLabsPrefs(); });
      body.append(on);
      return;
    }
    if (!(s.hosts || []).length) body.append(el("p", { className: "notice", textContent: "No lab host yet, so no lab can be made, by you or by Pi. Add one in Settings > Labs: another VM with Incus, or Pi's own VM." }));
    else if (!(s.hosts || []).some((h) => h.incus)) body.append(el("p", { className: "notice", textContent: "No lab host is ready: see Settings > Labs > Lab hosts." }));

    body.append(el("h2", { textContent: `Labs · ${s.labs.length} of ${s.settings.max}` }));
    const labs = el("ul", { className: "resource-items" });
    for (const lab of s.labs) {
      const owner = lab.project ? projectLabel(lab.project) : "yours";
      const nets = lab.networks === undefined || lab.networks === null ? null : lab.networks;
      const nics = (lab.interfaces || []).map((i, k) => `${i.name}${nets?.[k] ? ` ${nets[k]}` : ""} ${i.address || "(no address yet)"}`);
      const facts = [owner, `on ${lab.host}`, lab.vm ? "VM" : "container", lab.image, lab.status?.toLowerCase(),
        nets && !nets.length ? "no network" : nics.join(" · ") || (nets ? nets.join(", ") : lab.address),
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
  const unlistenApprovals = vm.on("approvals", renderWaiting);
  tab.onClose = () => { unlisten(); unlistenApprovals(); vm.follow({ labs: false }); };
}
