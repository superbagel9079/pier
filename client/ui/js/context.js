// The Context tab: what was given to each project's Pi; Hand off; paste and drop.

// ============================================================================
// Context: everything given to a project's Pi
// ============================================================================
//
// Whatever is pasted, dropped or added goes where it belongs: an image or a file is
// copied into the project and mentioned in Pi; a folder makes Pier ask whether to
// share it live (read-only, or read and write) or to copy it. The panel lists what
// each project holds, read from the VM, plus the shares remembered on this computer,
// and anything can be taken back with its ×.

const previews = new Map(); // saved path on the VM -> blob URL, for this session's pastes

function makeContext(tab) {
  tab.pane.append($("#tpl-context").content.cloneNode(true));
  const drop = $(".drop", tab.pane);
  const error = $(".error", tab.pane);
  const notice = $(".notice", tab.pane);
  const list = $(".projects", tab.pane);
  const open = new Set(); // projects whose section the user expanded

  const visible = () => !tab.pane.hidden && tab.pane.offsetParent !== null;
  const busy = async (action) => {
    drop.classList.add("busy");
    showError(error, "");
    try { return await action(); } catch (e) { showError(error, String(e)); return null; } finally { drop.classList.remove("busy"); }
  };

  /** After an action here: the VM's side comes fresh from the watch, ours now. */
  function refresh() {
    vm.poke();
    render();
  }

  async function render() {
    const message = vm.latest("contexts");
    if (!message) return;
    if (message.error) { showError(error, message.error); return; }
    if (!visible() && list.childElementCount) { stale = true; return; }
    stale = false;
    const contexts = structuredClone(message.data.contexts);
    const sshfs = message.data.sshfs !== false;
    const live = await backend.shareList();
    const kept = await backend.rememberedShares();
    // Projects known only through a remembered share still get a section.
    for (const k of kept) {
      if (!contexts.some((c) => c.project === k.project)) contexts.push({ project: k.project, label: k.label, running: running.has(k.project), images: [], files: [], copies: [], shares: [] });
    }
    contexts.sort((a, b) => (b.project === target?.path) - (a.project === target?.path) || b.running - a.running);
    list.innerHTML = "";
    for (const context of contexts) list.append(section(context, live, kept));
    if (!contexts.length) list.append(el("p", { className: "dim", textContent: "Nothing given to a Pi yet." }));
    if (!sshfs) showError(notice, "sshfs is not installed on the VM: folders can be copied, but not shared live. To share live: sudo apt install sshfs");
  }

  function section(context, live, kept) {
    const current = context.project === target?.path;
    const box = el("details");
    box.className = "context-project";
    box.open = current || open.has(context.project);
    box.addEventListener("toggle", () => { if (box.open) open.add(context.project); else open.delete(context.project); });
    const shares = mergedShares(context, live, kept);
    const count = context.images.length + context.files.length + context.copies.length + shares.length;
    const summary = el("summary");
    summary.append(
      el("span", { className: "label", textContent: context.label }),
      el("span", { className: "dim small", textContent: `${context.running ? "pi running" : "no pi"} · ${count} item${count === 1 ? "" : "s"}` }),
    );
    box.append(summary);
    const rows = el("ul");
    rows.className = "items";
    for (const image of context.images) rows.append(item("image", image.name, humanSize(image.size), image, context));
    for (const file of context.files) rows.append(item("file", file.name, humanSize(file.size), file, context));
    for (const copy of context.copies) rows.append(item("copy", copy.name, `copy · ${copy.count} file${copy.count === 1 ? "" : "s"} · ${humanSize(copy.size)}`, copy, context));
    for (const share of shares) rows.append(shareItem(share, context));
    if (!rows.childElementCount) rows.append(el("li", { className: "dim small", textContent: "nothing given yet" }));
    box.append(rows);
    const clearable = context.images.length + context.files.length + context.copies.length;
    if (clearable) {
      const clear = el("button", { className: "link small", textContent: "delete all images, files and copies" });
      clear.addEventListener("click", async () => {
        if (!(await ask(`Delete the ${clearable} image(s), file(s) and folder copies given to ${context.label}? Shares are not affected.`))) return;
        await busy(() => backend.clearProject(context.project));
        refresh();
      });
      box.append(clear);
    }
    return box;
  }

  /** Live shares (this session), handed-off copies (on the VM, in the share's place),
   *  and paused ones (remembered, neither mounted nor handed off). */
  function mergedShares(context, live, kept) {
    const result = live.filter((s) => s.project === context.project).map((s) => ({ ...s, state: "live" }));
    for (const vm of context.shares.filter((s) => s.handed_off)) {
      const origin = kept.find((k) => k.project === context.project && k.relative === vm.relative);
      result.push({ ...vm, state: "handed", local: origin?.local || vm.name, writable: vm.handed_off === "rw", origin });
    }
    for (const k of kept) {
      if (k.project === context.project && !result.some((s) => s.local === k.local || s.relative === k.relative)) result.push({ ...k, state: "paused" });
    }
    return result;
  }

  function item(kind, name, detail, info, context) {
    const li = el("li");
    const preview = previews.get(info.path);
    if (preview) li.append(el("img", { src: preview, alt: "" }));
    else li.append(el("span", { className: "kind", textContent: { image: "img", file: "file", copy: "dir" }[kind] }));
    const meta = el("div");
    meta.className = "meta";
    meta.append(
      el("span", { className: "ellipsis", textContent: name, title: info.path }),
      el("span", { className: "dim small", textContent: detail }),
    );
    const relative = info.path.slice(context.project.length + 1);
    const actions = el("div");
    actions.className = "row-actions";
    actions.append(
      link("mention", "Type its reference into Pi", () => backend.api(["type", `${kind === "copy" ? "" : "@"}${relative}${kind === "copy" ? "/" : ""} `, context.project])),
      iconLink("×", `Delete it from the VM${kind === "copy" ? " (the original folder on this computer is not touched)" : ""}`, async () => {
        await backend.removeUpload(info.path);
        previews.delete(info.path);
        notify("Deleted from the VM. If Pi's prompt still shows its reference, erase it there.");
      }),
    );
    li.append(meta, actions);
    return li;
  }

  function shareItem(share, context) {
    const li = el("li");
    li.append(el("span", { className: "kind", textContent: { live: "live", paused: "paused", handed: "copy" }[share.state] }));
    const meta = el("div");
    meta.className = "meta";
    const mode = share.writable ? "read and write" : "read-only";
    const detail = {
      live: `shared live · ${mode} · ${share.relative}`,
      paused: `paused · ${mode} · resume to share it again`,
      handed: `handed off · ${share.writable ? "a copy Pi can change" : "read-only copy"} · ${share.relative}`,
    }[share.state];
    meta.append(
      el("span", { className: "ellipsis", textContent: share.local, title: share.local }),
      el("span", { className: "dim small ellipsis", textContent: detail }),
    );
    const actions = el("div");
    actions.className = "row-actions";
    if (share.state === "handed") {
      actions.append(...takeBackActions(share, context));
    } else if (share.state === "live") {
      actions.append(
        link("mention", "Type its folder into Pi", () => backend.api(["type", `${share.relative}/ `, context.project])),
        iconLink("×", "Stop sharing (the folder on this computer is not touched)", async () => {
          await backend.shareStop(share.id, true);
          notify(`Stopped sharing ${share.local}.`);
        }),
      );
    } else {
      actions.append(
        link("resume", context.running ? "Share it again" : "Its project has no Pi running", () => backend.shareStart(share.local, share.writable, share.project), !context.running),
        iconLink("×", "Forget this share", async () => {
          await backend.forgetShare(share.local, share.project);
          notify(`Forgot ${share.local}.`);
        }),
      );
    }
    li.append(meta, actions);
    return li;
  }

  /** Take back a handed-off copy: download Pi's version (if it could write), share the
   *  original live again in its place, or delete the copy. */
  function takeBackActions(share, context) {
    const actions = [];
    if (share.origin) {
      actions.push(link("review changes", "What Pi changed, file by file, against your folder: bring back the files you choose", () => openTakeBack(share)));
    }
    if (share.writable && share.origin) {
      actions.push(link("download","Save Pi's version next to the original folder (nothing is overwritten)", async () => {
        const saved = await backend.downloadCopy(share.mountpoint, share.origin.local);
        notify(`Pi's version saved in ${saved}. Compare it with the original and keep what you want.`);
      }));
    }
    if (share.origin) {
      actions.push(link("share live", context.running ? "Replace the copy with the original folder, shared live again" : "Its project has no Pi running", async () => {
        const warning = share.writable
          ? "Replace the copy with your original folder, shared live? Changes Pi made to the copy are lost unless you downloaded them first."
          : "Replace the copy with your original folder, shared live again?";
        if (!(await ask(warning))) return;
        await backend.removeUpload(share.mountpoint);
        await backend.shareStart(share.origin.local, share.origin.writable, share.origin.project);
      }, !context.running));
    }
    actions.push(iconLink("×", "Delete the copy from the VM (your original folder is not touched)", async () => {
      if (share.writable && !(await ask("Delete the copy? Changes Pi made to it are lost unless you downloaded them."))) return;
      await backend.removeUpload(share.mountpoint);
      if (share.origin) await backend.forgetShare(share.origin.local, share.origin.project);
    }));
    return actions;
  }

  function link(text, title, action, disabled = false) {
    const b = el("button", { className: "link", textContent: text, title, disabled });
    b.addEventListener("click", async () => { await busy(action); refresh(); });
    return b;
  }

  function iconLink(text, title, action) {
    const b = el("button", { className: "icon", textContent: text, title });
    b.addEventListener("click", async () => { b.disabled = true; await busy(action); refresh(); });
    return b;
  }

  // What the last action did, for a while: an older message never stays to contradict
  // a newer state (a share said "shared" after it stopped). Not an error: not logged as one.
  let noticeTimer = null;
  function notify(text) {
    notice.textContent = text || "";
    notice.hidden = !text;
    clearTimeout(noticeTimer);
    if (text) noticeTimer = setTimeout(() => { notice.hidden = true; }, 15000);
  }

  /** Paths from a drop, the file pickers or the clipboard. */
  tab.give = async (paths) => {
    const results = (await busy(() => backend.pasteFiles(paths, ""))) || [];
    await tab.handleResults(results);
  };
  tab.handleResults = async (results) => {
    for (const result of results) {
      if (result.error) showError(error, result.error);
      else if (result.folder) await giveFolder(result.folder);
    }
    const sent = results.filter((r) => r.reference);
    if (sent.length) notify(sent.every((r) => r.typed) ? `Typed into Pi: ${sent.map((r) => r.reference).join(" ")}` : "Saved in the project: no Pi is running there to type it into.");
    refresh();
  };
  tab.sendImage = async (file) => {
    const result = await busy(() => backend.pasteImage(file, ""));
    if (result) {
      previews.set(result.saved, URL.createObjectURL(file));
      await tab.handleResults([result]);
    }
  };

  async function giveFolder(path) {
    const choice = await askFolder(path);
    if (!choice) return;
    if (choice === "copy") {
      const result = await busy(() => backend.copyFolder(path, ""));
      if (result) notify(`Copied into ${result.label}/${result.reference} (${result.count} files)${result.typed ? ", typed into Pi" : ""}.`);
    } else {
      const share = await busy(() => backend.shareStart(path, choice === "live-rw", ""));
      if (share) notify(`Shared live in ${share.label}/${share.relative}.`);
    }
  }

  $(".add-files", tab.pane).addEventListener("click", async () => {
    const paths = await backend.pickFiles();
    if (paths.length) tab.give(paths);
  });
  $(".add-folder", tab.pane).addEventListener("click", async () => {
    const path = await backend.pickFolder();
    if (path) { await giveFolder(path); refresh(); }
  });
  let stale = false;
  tab.onNote = notify;
  tab.refresh = refresh;
  tab.onShow = () => { if (stale) render(); };
  tab.onTargetChange = render;
  const unlisten = vm.on("contexts", render);
  tab.onClose = () => { unlisten(); vm.follow({ contexts: false }); };
  tab.onVisible = (shown) => vm.follow({ contexts: shown });
  vm.follow({ contexts: true });
}

/** Asks what to do with a folder: share it live (read-only, or read and write), copy it, or nothing. */
/** One question at a time: two folders dropped together are asked one after the other. */
let folderQuestions = Promise.resolve();
function askFolder(path) {
  const next = folderQuestions.then(() => askFolderNow(path));
  folderQuestions = next.catch(() => {});
  return next;
}

function askFolderNow(path) {
  const dialog = $("#give-folder");
  $("#give-folder-name").textContent = path.split(/[\\/]/).filter(Boolean).pop() || path;
  $("#give-folder-path").textContent = path;
  dialog.hidden = false;
  $("#give-folder-ro").focus();
  return new Promise((resolve) => {
    const choose = (choice) => {
      dialog.hidden = true;
      for (const [id, handler] of handlers) $(id).removeEventListener("click", handler);
      resolve(choice);
    };
    const handlers = [
      ["#give-folder-ro", () => choose("live-ro")],
      ["#give-folder-rw", async () => {
        if (await ask("Read and write: Pi will be able to change and delete the files of this folder, on this computer. Continue?")) choose("live-rw");
      }],
      ["#give-folder-copy", () => choose("copy")],
      ["#give-folder-cancel", () => choose(null)],
    ];
    for (const [id, handler] of handlers) $(id).addEventListener("click", handler);
  });
}

// ============================================================================
// Hand off: Pi keeps working with this computer off
// ============================================================================
//
// Pi runs on the VM and does not need this computer, except for live shares: those
// folders live here. Hand off turns each live share into a copy at the same path on
// the VM (read-only shares stay read-only), so Pi, even mid-task, keeps its files.

async function openHandOff() {
  const live = await backend.shareList();
  const list = $("#handoff-shares");
  list.innerHTML = "";
  for (const share of live) {
    const li = el("li");
    li.append(
      el("strong", { textContent: share.local }),
      el("span", {
        className: "dim small",
        textContent: share.writable
          ? `becomes a copy Pi can change, in ${share.label}/${share.relative}. To get Pi's changes back later: Activity > Given to Pi, then "review changes" or "download".`
          : `becomes a read-only copy in ${share.label}/${share.relative}.`,
      }),
    );
    list.append(li);
  }
  $("#handoff-none").hidden = live.length > 0;
  showError($("#handoff-error"), "");
  $("#handoff").hidden = false;
  $("#handoff-go").focus();
}

async function handOff() {
  const go = $("#handoff-go");
  go.disabled = true;
  const failed = [];
  const left = [];
  for (const share of await backend.shareList()) {
    const name = share.local.split(/[\\/]/).pop();
    go.textContent = `Copying ${name}…`;
    try {
      const done = await backend.handOff(share.id);
      if (done?.left_out?.length) left.push(`${name}: ${done.left_out.join(", ")}`);
    } catch (e) {
      failed.push(`${share.local}: ${e}`);
    }
  }
  // Rebuilt folders at a folder's top stay on this computer: said, not silent.
  const leftOut = left.length ? ` Left out (rebuilt on the VM: npm install, cargo build…): ${left.join("; ")}.` : "";
  go.disabled = false;
  go.textContent = "Hand off";
  if (failed.length) {
    showError($("#handoff-error"), `Not handed off, still live (this computer must stay on for them): ${failed.join("; ")}`);
    givenToPi()?.refresh?.();
    return;
  }
  $("#handoff").hidden = true;
  if ($("#handoff-disconnect").checked) {
    await leave();
    toLogin(`Handed off. Pi keeps working on the VM: you can turn this computer off. Log in again to see what it did.${leftOut}`);
  } else {
    givenToPi()?.refresh?.();
    if (leftOut) flashStatus(`Handed off.${leftOut}`);
  }
}

$("#btn-handoff").addEventListener("click", openHandOff);
$("#handoff-go").addEventListener("click", handOff);
$("#handoff-cancel").addEventListener("click", () => { $("#handoff").hidden = true; });
// Escape closes these two dialogs too, as it does the others.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("#give-folder").hidden) { e.preventDefault(); $("#give-folder-cancel").click(); }
  else if (!$("#handoff").hidden) { e.preventDefault(); $("#handoff").hidden = true; }
});

/** What was given to Pi: Activity's view (Activity opened if it was closed). */
function contextTab({ reveal = false } = {}) {
  const old = workspace.find("context"); // a layout from before, still holding its own tab
  if (old) {
    if (reveal) workspace.show(old);
    return old;
  }
  const project = workspace.find("project") || workspace.add("project", prefs.panelSide === "left" ? "left" : "right");
  if (reveal) project.showGiven();
  return project.given;
}

/** Given to Pi, if it is open somewhere. */
const givenToPi = () => workspace.find("context") || workspace.find("project")?.given;

// Ctrl+V anywhere in the window, terminals included. An image goes to Pi; files and
// folders copied in the file manager go through Context (folders ask first). The
// focus stays where it was, so you keep typing your question. Text pastes are left
// alone: pasting text in a terminal works as usual.
document.addEventListener("paste", async (event) => {
  if ($("#workspace").hidden) return;
  const items = [...(event.clipboardData?.items || [])];
  const image = items.find((i) => i.type.startsWith("image/"));
  const hasFiles = (event.clipboardData?.types || []).includes("Files");
  if (!image && !hasFiles) return;
  event.preventDefault();
  event.stopPropagation();
  const focused = document.activeElement;
  const paths = hasFiles ? await backend.clipboardPaths() : [];
  if (paths.length) await contextTab().give(paths);
  else if (image) await contextTab().sendImage(image.getAsFile());
  focused?.focus?.();
}, true);

backend.onClipboardSent((results) => contextTab().handleResults(results));

// ============================================================================
// Files and folders dropped on the window
// ============================================================================

backend.onDragDrop((kind, paths, position) => {
  const x = position ? position.x / devicePixelRatio : -1;
  const y = position ? position.y / devicePixelRatio : -1;
  const name = position ? workspace.dockAtPoint(x, y) : null;
  for (const d of DOCKS) workspace.docks[d].el.classList.toggle("drop-over", kind === "over" && d === name);
  if (kind !== "drop" || !paths.length || $("#workspace").hidden) return;
  // Everything dropped goes through Context, which asks about folders.
  contextTab({ reveal: true }).give(paths);
});
