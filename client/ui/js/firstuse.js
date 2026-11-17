// What a newcomer needs first: "Is the VM ready?" (vm_checks, each gap with its fix),
// "Open a folder" (a VM folder from the ls API), "Waiting for you" (every Pi request).

const READY_SEEN = "pier.vmReady.seen";

/** The checks, in a dialog: what is there, what is missing and how to get it. */
async function openVmReady(version = null) {
  let checks = version?.checks;
  if (!checks) {
    try { checks = (await backend.api(["version"])).checks; } catch (e) { flashStatus(`could not ask the VM: ${e}`); return; }
  }
  if (!Array.isArray(checks)) { flashStatus("this picker does not say what the VM has: update it (Settings > General)"); return; }
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

/** A folder of the VM, then a Pi started in it (the proposals' D): the folders Pi worked in
 *  first, as the rail's squares; then the VM's folders, from home, by a clickable path. A
 *  click chooses a folder, a double click (or →) goes in; the button says where Pi starts. */
function openFolderPicker(start = null) {
  let home = lastProjects?.home || ""; // else learnt from the first answer (ls "" is home)
  let here = start || home;
  let chosen = null; // a folder chosen in the list or the recent ones; else here
  const problem = dialogError();
  const go = el("button", { type: "button" });
  const crumbs = el("nav", { className: "folder-crumbs", "aria-label": "Where" });
  const list = el("div", { className: "folder-box", role: "listbox", "aria-label": "Folders" });
  const name = (path) => (path === home ? "~" : visibleText(String(path).replace(/\/+$/, "").split("/").pop() || "~"));
  const label = () => { go.textContent = `Start Pi in ${name(chosen || here)}`; };
  const mark = () => {
    for (const n of document.querySelectorAll(".folder-dialog [data-path]")) n.setAttribute("aria-selected", String(n.dataset.path === chosen));
    label();
  };
  const choose = (path) => { chosen = path; mark(); };

  // The recent ones: the projects Pi ran in, the latest first, with their conversations' age.
  const looks = (() => { try { return JSON.parse(localStorage.getItem("devbox.conversations.v1"))?.looks || {}; } catch { return {}; } })();
  const latest = new Map();
  for (const p of vm.latest("conversations")?.data?.projects || []) latest.set(p.project, Math.max(0, ...p.sessions.map((x) => x.modified || 0)));
  const recentPaths = [...new Set([...(lastProjects?.running || []), ...(lastProjects?.recent || [])].map((x) => x.path).concat([...latest.keys()]))]
    .sort((a, b) => (latest.get(b) || 0) - (latest.get(a) || 0)).slice(0, 4);
  const recent = recentPaths.length ? el("div", { className: "folder-recent" }, ...recentPaths.map((path) => {
    const when = latest.get(path);
    const card = el("button", { type: "button", className: "folder-card", title: path },
      projectBadge(path, looks[path]),
      el("span", { className: "tx" }, el("span", { textContent: name(path) }), el("small", { textContent: [projectLabel(path), when ? relTime(when) : ""].filter(Boolean).join(" · ") })));
    card.dataset.path = path;
    card.addEventListener("click", () => choose(path));
    card.addEventListener("dblclick", start_);
    return card;
  })) : null;

  const dialog = resourceDialog("Open a folder", [
    ...(recent ? [el("p", { className: "folder-label", textContent: "Recent" }), recent, el("p", { className: "folder-label", textContent: "Browse" })] : []),
    crumbs, list, problem], [go]);
  dialog.box.classList.add("folder-dialog");

  async function show(path) {
    showError(problem, "");
    let data;
    try { data = await backend.api(["ls", path]); } catch (e) { showError(problem, String(e)); return; }
    here = data.path || path;
    if (!home && !path) home = here;
    if (!recentPaths.includes(chosen)) chosen = null;
    // The path from home, each step a button back to it.
    const steps = [{ label: "~", path: home }];
    if (home && here.startsWith(home) && here !== home) {
      let at = home;
      for (const part of here.slice(home.length).split("/").filter(Boolean)) { at = `${at}/${part}`; steps.push({ label: part, path: at }); }
    } else if (here !== home) steps.splice(0, 1, { label: visibleText(data.label || here), path: here });
    crumbs.replaceChildren(svgIcon("folder"), ...steps.flatMap((st, i) => {
      const b = el("button", { type: "button", className: i === steps.length - 1 ? "here" : "", textContent: st.label });
      b.addEventListener("click", () => show(st.path));
      return i ? [el("span", { className: "sep", textContent: "/", "aria-hidden": "true" }), b] : [b];
    }));
    const dirs = (data.entries || []).filter((e) => e.kind === "dir" && !e.hidden);
    list.replaceChildren(...dirs.map((d) => {
      const path = d.path || `${here}/${d.name}`;
      const row = el("button", { type: "button", className: "folder-row", role: "option", title: "Double click to go in" }, svgIcon("folder"), el("span", { textContent: visibleText(d.name) }));
      row.dataset.path = path;
      row.addEventListener("click", () => choose(path));
      row.addEventListener("dblclick", () => show(path));
      row.addEventListener("keydown", (e) => { if (e.key === "ArrowRight") { e.preventDefault(); show(path); } });
      return row;
    }));
    if (!dirs.length) list.append(el("p", { className: "dim small folder-none", textContent: "No folder inside." }));
    mark();
  }
  function start_() {
    dialog.close();
    const path = chosen || here;
    openPiTerminal(path, projectLabel(path), []);
  }
  list.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" && here !== home) { e.preventDefault(); show(here.replace(/\/[^/]+\/?$/, "") || home); }
  });
  go.addEventListener("click", start_);
  label();
  show(here);
}

/** Every request of Pi waiting for the user, in one list, and the top bar's count. */
const waiting = (() => {
  const button = $("#btn-waiting");
  let pending = [];
  let open = null; // the list in the dialog, while it is open
  const unfolded = new Set(); // the requests unfolded by a click

  // The list of Details' card, in a window (the proposals' 3A): a line each, ✕ and ✓, a
  // click unfolds exactly what will be done; the oldest is open.
  function render() {
    if (!open) return;
    const sorted = [...pending].sort((x, y) => (x.at || 0) - (y.at || 0));
    open.replaceChildren(...sorted.map((a, i) => waitRow(a, i === 0 || unfolded.has(a.id), unfolded)));
    if (!pending.length) open.append(el("p", { className: "dim small wait-none", textContent: "Nothing waits for you." }));
  }

  vm.on("approvals", (message) => {
    pending = (message.data?.approvals || []).filter((a) => a.state === "pending" || a.state === undefined);
    $(".badge", button).hidden = !pending.length;
    $(".badge", button).textContent = pending.length;
    button.setAttribute("aria-label", `${pending.length} waiting for you`);
    render();
  });

  function show() {
    open = el("div", { className: "wait-list" });
    const dialog = resourceDialog("Waiting for you", [
      el("p", { className: "hint", textContent: "Shown exactly as it will be done. Nothing happens until you approve it." }), open], []);
    dialog.box.classList.add("waiting-dialog");
    $(".actions .secondary", dialog.box).textContent = "Close"; // a list: nothing to cancel
    const close = dialog.close;
    dialog.close = () => { open = null; close(); };
    render();
  }

  button.addEventListener("click", show);
  return { show };
})();
