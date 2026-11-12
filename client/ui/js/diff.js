// Diff tabs.

// ============================================================================
// Diff: what changed in a file, from git and from Pi's own edits
// ============================================================================

const DIFF_LINES_MAX = 5000; // a lockfile or a minified file would freeze the page
const DIFF_LINE_MAX = 4000;   // characters of one line: a minified line of 2 MB would be one block

/** The class of a line of a unified diff: hunk, add, del or none. */
const diffKind = (line) => (line.startsWith("@@") ? "hunk" : line.startsWith("+") && !line.startsWith("+++") ? "add"
  : line.startsWith("-") && !line.startsWith("---") ? "del" : "");

/** A diff drawn line by line (the diff tabs, Pi's work): at most max lines, each cut at
 *  DIFF_LINE_MAX characters; kindOf gives each line its class. */
function diffBlock(text, { max = DIFF_LINES_MAX, kindOf = diffKind } = {}) {
  const pre = el("div", { className: "diff" });
  const all = text.split("\n");
  for (const line of all.slice(0, max)) {
    if (line === "" && pre.lastChild?.textContent === "") continue;
    const shown = line.length > DIFF_LINE_MAX ? `${line.slice(0, DIFF_LINE_MAX)} … (${(line.length - DIFF_LINE_MAX).toLocaleString()} more characters)` : line;
    pre.append(el("div", { className: kindOf(line), textContent: shown }));
  }
  if (all.length > max) {
    pre.append(el("div", { className: "dim", textContent: `… ${(all.length - max).toLocaleString()} more lines not shown` }));
  }
  return pre;
}

/** Opens (or shows) the diff of a project file, next to the main terminal: against
 *  git and Pi's edits, or, given a restore point, against the file as it was then. */
function openDiff(rel, project, point = null) {
  const open = workspace.tabs().find((t) => t.kind === "diff" && t.params.rel === rel && t.params.project === project && t.params.point?.id === point?.id);
  if (open) {
    workspace.show(open);
    open.reload();
    return;
  }
  workspace.add("diff", workspace.find("main")?.dock || "center", { params: { rel, project, point } });
}

function makeDiff(tab) {
  const { rel, project, point } = tab.params;
  tab.title = `Δ ${rel.split("/").pop()}${point ? ` · since ${point.when}` : ""}`;
  const head = el("div", { className: "diff-head" });
  const path = el("span", { className: "path", textContent: rel, title: `${project}/${rel}` });
  const refresh = el("button", { className: "link", textContent: "refresh" });
  const mention = el("button", { className: "link", textContent: "mention in Pi" });
  const whole = el("button", { className: "link", textContent: "file", title: "The whole file, as it is now" });
  whole.addEventListener("click", () => openFile(rel, project));
  head.append(path, whole, refresh, mention);
  const error = el("p", { className: "error", hidden: true });
  const body = el("div");
  tab.pane.append(head, error, body);

  async function reloadSincePoint() {
    let result;
    try {
      result = await backend.api(["checkpoint-diff", project, point.id, rel]);
    } catch (e) {
      showError(error, String(e));
      return;
    }
    body.replaceChildren();
    if (result.diff) {
      body.append(el("p", { className: "edit-title", textContent: `changes since ${point.when} (${result.label || result.reason}), - then, + now` }));
      body.append(diffBlock(result.diff.trimEnd()));
      const undo = el("button", { className: "secondary", textContent: `Put it back as it was at ${point.when}` });
      undo.addEventListener("click", async () => {
        if (!(await ask(`Put ${rel} back as it was at ${point.when}? What is there now is saved first, as a restore point.`))) return;
        try {
          await backend.checkpointRestore(project, point.id, [rel]);
          uiLog("info", "restore", { project, point: point.id, files: 1 });
          reload();
          workspace.find("project")?.onShow?.();
        } catch (e) {
          showError(error, String(e));
        }
      });
      body.append(undo);
    } else {
      body.append(el("p", { className: "dim", textContent: `No difference: ${rel} is as it was at ${point.when}.` }));
    }
  }

  async function reload() {
    showError(error, "");
    if (point) return reloadSincePoint();
    let result;
    try {
      result = await backend.api(["diff", rel, project]);
    } catch (e) {
      showError(error, String(e));
      return;
    }
    body.replaceChildren();
    if (result.diff) {
      body.append(el("p", { className: "edit-title", textContent: result.untracked ? "new file, not yet in git" : "git diff against the last commit" }));
      body.append(diffBlock(result.diff.trimEnd()));
    } else if (result.diff === "") {
      body.append(el("p", { className: "dim", textContent: "No difference with the last commit." }));
    }
    if (result.edits.length) {
      body.append(el("p", { className: "edit-title", textContent: `Pi's ${result.edits.length} most recent change${result.edits.length > 1 ? "s" : ""} to this file, newest last` }));
      for (const edit of result.edits) {
        const when = edit.at ? new Date(edit.at).toLocaleTimeString() : "";
        body.append(el("p", { className: "edit-title", textContent: `${edit.tool} · ${edit.state} · ${when}` }));
        if (edit.tool === "write") body.append(diffBlock(String(edit.content ?? "").split("\n").map((l) => `+${l}`).join("\n"), { kindOf: () => "add" }));
        for (const change of edit.changes || []) {
          const text = [...change.old.split("\n").map((l) => `-${l}`), ...change.new.split("\n").map((l) => `+${l}`)].join("\n");
          body.append(diffBlock(text));
        }
      }
    }
    if (!body.childElementCount) {
      body.append(el("p", { className: "dim", textContent: "Nothing to show: not a git repository, and Pi has not edited this file." }));
    }
  }

  refresh.addEventListener("click", reload);
  mention.addEventListener("click", () => backend.api(["type", `@${rel} `, project]).catch((e) => showError(error, String(e))));
  tab.reload = reload;
  reload();
}
