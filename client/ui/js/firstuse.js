// What a newcomer needs first, and what waits for the user, in one place each:
// - "Is the VM ready?": what Pier needs on the VM, checked by the picker (vm_checks),
//   each missing thing with the command that puts it right. Shown after a connection
//   when something is missing, and from the palette at any time.
// - "Open a folder…": a folder of the VM chosen from a list (the ls API), then a Pi in it.
// - "Waiting for you": every request of Pi in one list, from the top bar, wherever it
//   comes from (a merge, a review, a repository, a command on a machine, a lab).

const READY_SEEN = "pier.vmReady.seen";

/** The checks, in a dialog: what is there, what is missing and how to get it. */
async function openVmReady(version = null) {
  let checks = version?.checks;
  if (!checks) {
    try { checks = (await backend.api(["version"])).checks; } catch (e) { flashStatus(`could not ask the VM: ${e}`); return; }
  }
  if (!Array.isArray(checks)) { flashStatus("this picker does not say what the VM has: update it (Settings > Picker)"); return; }
  const missing = checks.filter((c) => !c.ok);
  const rows = el("ul", { className: "resource-items" });
  for (const c of checks) {
    const row = el("li", { className: "two-lines" },
      el("div", { className: "line" },
        el("span", { className: "name", textContent: `${c.ok ? "✓︎" : "✗︎"} ${c.name}` }),
        el("span", { className: "dim small", textContent: c.ok ? "there" : "missing" })),
      el("div", { className: "desc dim small", textContent: c.detail || "" }));
    if (!c.ok && c.fix) {
      const copy = el("button", { className: "link", textContent: "copy", title: "The command, to paste in a shell on the VM" });
      copy.addEventListener("click", async () => {
        try { await backend.copyText(c.fix); flashStatus("command copied"); } catch (e) { flashStatus(String(e)); }
      });
      row.append(el("div", { className: "line" }, el("code", { className: "small", textContent: c.fix }), copy));
    }
    rows.append(row);
  }
  const summary = missing.length
    ? `${missing.length} thing${missing.length > 1 ? "s" : ""} missing on the VM: run the commands in a shell there (a "New shell" tab), then check again.`
    : "Everything Pier needs is there.";
  const again = el("button", { className: "secondary", textContent: "Check again" });
  const dialog = resourceDialog("Is the VM ready?", [el("p", { className: "hint", textContent: summary }), rows], [again], true);
  again.addEventListener("click", () => { dialog.close(); openVmReady(); });
}

/** After a connection: the checks shown once for each new set of missing things. */
function vmReadyAfterConnect(version) {
  const missing = (version?.checks || []).filter((c) => !c.ok).map((c) => c.name).sort().join("|");
  if (!missing) return;
  let seen = "";
  try { seen = localStorage.getItem(READY_SEEN) || ""; } catch { /* asked each time then */ }
  if (seen === missing) return;
  try { localStorage.setItem(READY_SEEN, missing); } catch { /* the same */ }
  openVmReady(version);
}

/** A folder of the VM, chosen by walking down from home, then a Pi started in it. */
function openFolderPicker(start = null) {
  let home = lastProjects?.home || ""; // else learnt from the first answer (ls "" is home)
  let here = start || home;
  const where = el("div", { className: "path small" });
  const list = el("ul", { className: "resource-items folder-list" });
  const problem = dialogError();
  const go = el("button", { textContent: "Start Pi here" });
  const up = el("button", { className: "secondary", textContent: "Up" });
  const dialog = resourceDialog("Open a folder", [where, list, problem], [up, go], true);

  async function show(path) {
    showError(problem, "");
    let data;
    try { data = await backend.api(["ls", path]); } catch (e) { showError(problem, String(e)); return; }
    here = data.path || path;
    if (!home && !path) home = here;
    where.textContent = visibleText(data.label || here);
    up.disabled = !home || here === home;
    const dirs = (data.entries || []).filter((e) => e.kind === "dir" && !e.hidden);
    list.replaceChildren(...dirs.map((d) => {
      const b = el("button", { className: "link", textContent: `▸︎ ${visibleText(d.name)}/`, title: "Open this folder" });
      b.addEventListener("click", () => show(d.path || `${here}/${d.name}`));
      return el("li", {}, b);
    }));
    if (!dirs.length) list.append(el("li", { className: "dim small note", textContent: "No folder inside: start Pi here, or go up." }));
  }
  up.addEventListener("click", () => { if (here !== home) show(here.replace(/\/[^/]+\/?$/, "") || home); });
  go.addEventListener("click", () => {
    dialog.close();
    openPiTerminal(here, projectLabel(here), []);
  });
  show(here);
}

/** Every request of Pi waiting for the user, in one list, and the top bar's count. */
const waiting = (() => {
  const button = $("#btn-waiting");
  let pending = [];
  let open = null; // the list in the dialog, while it is open

  function render() {
    if (!open) return;
    open.replaceChildren(...pending.map((a) => approvalItem(a, async (yes) => {
      try {
        await backend.approvalAnswer(a.id, yes);
        flashStatus(yes ? "Approved: done as shown" : "Refused: Pi is told");
        vm.poke();
      } catch (e) { flashStatus(String(e)); }
    })));
    if (!pending.length) open.append(el("li", { className: "dim small note", textContent: "Nothing waits for you." }));
  }

  vm.on("approvals", (message) => {
    pending = (message.data?.approvals || []).filter((a) => a.state === "pending" || a.state === undefined);
    button.hidden = !pending.length;
    button.textContent = `${pending.length} waiting`;
    render();
  });

  function show() {
    open = el("ul", { className: "resource-items" });
    const dialog = resourceDialog("Waiting for you", [
      el("p", { className: "hint", textContent: "What Pi asks, shown exactly as it will be done. Nothing happens until you approve it." }), open], [], true);
    const close = dialog.close;
    dialog.close = () => { open = null; close(); };
    render();
  }

  button.addEventListener("click", show);
  return { show };
})();
