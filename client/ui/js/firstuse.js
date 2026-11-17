// What a newcomer needs first: "Is the VM ready?" (vm_checks, each gap with its fix),
// "Open a folder" (a VM folder from the ls API), "Waiting for you" (every Pi request).

const READY_SEEN = "pier.vmReady.seen";

// What the VM lacks (the proposals' C): no window, a banner at the top of the middle, with
// the command, Copy and Install (typed in a new shell); gone once there, or closed for that
// set of missing things.
let vmChecks = null; // the picker's checks: [{ name, ok, detail, fix }]

function drawVmReady() {
  let box = $("#vm-ready");
  if (!box) {
    box = el("div", { id: "vm-ready", className: "vm-ready", role: "status", hidden: true });
    $(".panes", $("#dock-center")).before(box);
  }
  const missing = (vmChecks || []).filter((c) => !c.ok);
  const key = missing.map((c) => c.name).sort().join("|");
  let seen = "";
  try { seen = localStorage.getItem(READY_SEEN) || ""; } catch { /* shown each time then */ }
  box.hidden = !online || !missing.length || seen === key;
  if (box.hidden) { box.replaceChildren(); return; }
  const fix = missing.map((c) => c.fix).filter(Boolean).join(" && ");
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const title = missing.length === 1
    ? (missing[0].detail ? `${cap(missing[0].detail)} needs ${missing[0].name} on the VM` : `${missing[0].name} is missing on the VM`)
    : `${missing.length} things are missing on the VM: ${missing.map((c) => c.name).join(", ")}`;
  const button = (icon, text, title, run, primary = false) => {
    const b = el("button", { type: "button", className: primary ? "vr-go" : "vr-btn", title }, svgIcon(icon), text ? el("span", { textContent: text }) : null);
    if (!text) b.setAttribute("aria-label", title);
    b.addEventListener("click", run);
    return b;
  };
  const copy = button("copy", "Copy", "The command, to paste in a shell on the VM", async () => {
    try { await navigator.clipboard.writeText(fix); } catch (e) { flashStatus(`could not copy: ${e}`); return; }
    $("use", copy).setAttribute("href", "#i-check");
    setTimeout(() => $("use", copy)?.setAttribute("href", "#i-copy"), 1200);
  });
  const install = button("terminal", "Install", "Run it in a new shell on the VM (sudo asks your password there)", () => {
    workspace.add("shell", "center", { params: { typeFirst: `${fix}\r` } });
  }, true);
  const again = button("refresh-cw", "", "Check again", () => checkVmReady());
  const close = button("x", "", "Hide this until something else is missing", () => {
    try { localStorage.setItem(READY_SEEN, key); } catch { /* hidden for this run only */ }
    box.hidden = true;
  });
  box.replaceChildren(el("span", { className: "vr-dot", "aria-hidden": "true" }),
    el("div", { className: "vr-text" }, el("span", { textContent: title }), fix ? el("code", { textContent: fix }) : null),
    ...(fix ? [copy, install] : []), again, close);
}

/** The checks asked again; on demand (the palette, the conversations' link) the banner comes
 *  back even if it was closed, and "all there" is said. */
async function checkVmReady(asked = false) {
  try { vmChecks = (await backend.api(["version"])).checks; } catch (e) { flashStatus(`could not ask the VM: ${e}`); return; }
  if (!Array.isArray(vmChecks)) { flashStatus("this picker does not say what the VM has: update it (Settings > Connection)"); return; }
  if (asked) { try { localStorage.removeItem(READY_SEEN); } catch { /* fine */ } }
  drawVmReady();
  if (!vmChecks.some((c) => !c.ok)) flashStatus("Everything Pier needs is on the VM");
}
const openVmReady = () => checkVmReady(true);

/** After a connection: the banner, if something is missing (once closed, until the missing set changes). */
function vmReadyAfterConnect(version) {
  vmChecks = Array.isArray(version?.checks) ? version.checks : null;
  drawVmReady();
}

/** A folder of the VM, then a Pi started in it (the proposals' D): the folders Pi worked in
 *  first, as the rail's squares; then the VM's folders, from home, by a clickable path. A
 *  click chooses a folder, a double click (or →) goes in; the button says where Pi starts. */
function openFolderPicker(start = null) {
  if (!online) { flashStatus("Connect first: the folders are on your VM"); return; }
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
    if (!pending.length) { bubbleBy(button, "Nothing waits for you"); return; }
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
