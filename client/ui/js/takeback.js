// Take back tabs.

// ============================================================================
// Take back, file by file: what Pi changed in a handed-off copy, brought back into the
// original folder only for the files chosen (see takeback.rs)
// ============================================================================

/** Opens (or shows) the review of a handed-off copy against its original folder. */
function openTakeBack(share) {
  const open = workspace.tabs().find((t) => t.kind === "takeback" && t.params.path === share.mountpoint);
  if (open) {
    workspace.show(open);
    open.reload();
    return;
  }
  workspace.add("takeback", workspace.find("main")?.dock || "center", {
    params: { path: share.mountpoint, local: share.origin.local, project: share.origin.project },
  });
}

function makeTakeBack(tab) {
  const { path, local } = tab.params;
  const name = local.split(/[\\/]/).filter(Boolean).pop() || local;
  tab.title = `⇣ ${name}`;
  const head = el("div", { className: "diff-head" });
  head.append(
    el("span", { className: "path", textContent: `Pi's copy → ${local}`, title: `${path} → ${local}` }),
  );
  const refresh = el("button", { className: "link", textContent: "compare again" });
  head.append(refresh);
  const hint = el("p", {
    className: "hint",
    textContent: "Check what to bring back into your folder. Changed and new files are checked; files Pi deleted are not. "
      + "Whatever is replaced or deleted is moved first to a folder next to yours, \"(before Pi's changes …)\": nothing is lost.",
  });
  const error = el("p", { className: "error", hidden: true });
  const notice = el("p", { className: "notice", hidden: true });
  const body = el("div", { className: "takeback" });
  const bar = el("div", { className: "actions" });
  const apply = el("button", { textContent: "Bring back the checked files" });
  const all = el("button", { className: "secondary", textContent: "Check all" });
  const none = el("button", { className: "secondary", textContent: "Uncheck all" });
  bar.append(apply, all, none);
  tab.pane.append(head, hint, error, notice, body, bar);

  let result = null;
  const boxes = new Map(); // rel -> {box, kind}

  function size(bytes) {
    return bytes == null ? "" : humanSize(bytes);
  }

  function section(kind, title, rows, checked) {
    if (!rows.length) return;
    const box = el("details", { open: true });
    box.className = "takeback-section";
    box.append(el("summary", { textContent: `${title} (${rows.length})` }));
    const list = el("ul", { className: "takeback-list" });
    for (const change of rows) {
      const li = el("li");
      const check = el("input", { type: "checkbox", checked });
      boxes.set(change.rel, { box: check, kind });
      const label = el("button", { className: "link rel", textContent: visibleText(change.rel), title: `${visibleText(change.rel)}\n${kind === "deleted" ? "Deleted by Pi" : "Show the difference"}` });
      const sizes = el("span", {
        className: "dim small",
        textContent: kind === "changed" ? `${size(change.size_pc)} → ${size(change.size_vm)}` : size(change.size_pc ?? change.size_vm),
      });
      const detail = el("div", { className: "takeback-diff", hidden: true });
      label.addEventListener("click", () => toggleDiff(change.rel, detail, kind));
      li.append(check, label, sizes, detail);
      list.append(li);
    }
    box.append(list);
    body.append(box);
  }

  async function toggleDiff(rel, detail, kind) {
    if (!detail.hidden) { detail.hidden = true; return; }
    detail.hidden = false;
    if (detail.childElementCount) return;
    if (kind === "deleted") {
      detail.append(el("p", { className: "dim small", textContent: "Pi deleted this file in its copy. Checked, it is moved out of your folder (into the backup folder)." }));
      return;
    }
    detail.append(el("p", { className: "dim small", textContent: "loading…" }));
    let answer;
    try {
      answer = await backend.takebackDiff(path, local, rel);
    } catch (e) {
      detail.innerHTML = "";
      detail.append(el("p", { className: "error", textContent: String(e) }));
      return;
    }
    detail.innerHTML = "";
    if (answer.too_big) detail.append(el("p", { className: "dim small", textContent: "Too big to show (over 1 MB)." }));
    else if (answer.binary) detail.append(el("p", { className: "dim small", textContent: "Not text: no difference to show." }));
    else detail.append(diffLines(answer.diff || "", 3000));
  }

  /** A unified diff, "-" your version, "+" Pi's, at most max lines. */
  function diffLines(text, max) {
    const pre = el("div", { className: "diff" });
    const all = text.replace(/\n$/, "").split("\n");
    for (const line of all.slice(0, max)) {
      const kind = line.startsWith("@@") ? "hunk" : line.startsWith("+") && !line.startsWith("+++") ? "add"
        : line.startsWith("-") && !line.startsWith("---") ? "del" : "";
      pre.append(el("div", { className: kind, textContent: line.length > 2000 ? `${line.slice(0, 2000)}…` : line }));
    }
    if (all.length > max) pre.append(el("div", { className: "dim", textContent: `… ${(all.length - max).toLocaleString()} more lines` }));
    if (!text) pre.append(el("div", { className: "dim", textContent: "No difference in the text (only line ends or spaces at the end?)." }));
    return pre;
  }

  function render() {
    body.innerHTML = "";
    boxes.clear();
    if (!result) return;
    const { changed, added, deleted, same } = result;
    section("changed", "Changed by Pi", changed, true);
    section("added", "New, made by Pi", added, true);
    section("deleted", "Deleted by Pi", deleted, false);
    const extra = [];
    if (same) extra.push(`${same} file${same > 1 ? "s" : ""} unchanged`);
    if (result.links?.length) extra.push(`${result.links.length} link${result.links.length > 1 ? "s" : ""} in the copy, never brought back`);
    if (result.truncated) extra.push("only the first 20,000 files (or 2 GB) were compared");
    if (!changed.length && !added.length && !deleted.length) body.append(el("p", { className: "dim", textContent: "Pi's copy is the same as your folder: nothing to bring back." }));
    if (extra.length) body.append(el("p", { className: "dim small", textContent: extra.join(" · ") }));
    apply.disabled = !changed.length && !added.length && !deleted.length;
  }

  async function reload() {
    showError(error, "");
    body.innerHTML = "";
    body.append(el("p", { className: "dim", textContent: "Comparing (each file's fingerprint, on both sides)…" }));
    try {
      result = await backend.takebackCompare(path, local);
    } catch (e) {
      body.innerHTML = "";
      showError(error, String(e));
      return;
    }
    render();
  }

  apply.addEventListener("click", async () => {
    const take = [];
    const remove = [];
    for (const [rel, { box, kind }] of boxes) {
      if (!box.checked) continue;
      (kind === "deleted" ? remove : take).push(rel);
    }
    if (!take.length && !remove.length) { showError(error, "Nothing is checked."); return; }
    const what = [take.length && `bring back ${take.length} file${take.length > 1 ? "s" : ""}`, remove.length && `delete ${remove.length}`].filter(Boolean).join(" and ");
    if (!(await ask(`${what[0].toUpperCase()}${what.slice(1)} in ${local}? What is replaced or deleted is kept in a folder next to it.`))) return;
    apply.disabled = true;
    try {
      const done = await backend.takebackApply(path, local, take, remove);
      const parts = [`${done.taken.length} brought back`, `${done.deleted.length} deleted`];
      if (done.skipped.length) parts.push(`${done.skipped.length} skipped (a link or a name not allowed here)`);
      notice.hidden = false;
      notice.textContent = `${parts.join(", ")}.${done.backup ? ` The previous versions are in ${done.backup}.` : ""}`;
      uiLog("info", "takeback-applied", { taken: done.taken.length, deleted: done.deleted.length, skipped: done.skipped.length });
      await reload();
    } catch (e) {
      showError(error, String(e));
    } finally {
      apply.disabled = false;
    }
  });
  all.addEventListener("click", () => { for (const { box } of boxes.values()) box.checked = true; });
  none.addEventListener("click", () => { for (const { box } of boxes.values()) box.checked = false; });
  refresh.addEventListener("click", reload);
  tab.reload = reload;
  reload();
}
