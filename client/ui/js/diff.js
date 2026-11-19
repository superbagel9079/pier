// Diff tabs.

// Diff: what changed in a file, from git and from Pi's own edits

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

/** A part of a diff tab: a frame with its head (an icon, what it is, when on the right),
 *  then its diffs. */
function diffCard(icon, title, when, ...blocks) {
  return el("section", { className: "diff-card" },
    el("div", { className: "diff-card-head" }, svgIcon(icon), el("span", { textContent: title }), when ? el("span", { className: "when", textContent: when }) : null),
    ...blocks);
}
/** git's diff without its file header (diff --git, index, ---, +++): the tab names the file. */
const withoutHeader = (diff) => { const lines = diff.split("\n"); const at = lines.findIndex((l) => l.startsWith("@@")); return (at > 0 ? lines.slice(at) : lines).join("\n"); };

/** Opens (or shows) the diff of a project file, next to the main terminal: against
 *  git and Pi's edits, or, given a restore point, against the file as it was then. */
function openDiff(rel, project, point = null) {
  const open = workspace.tabs().find((t) => t.kind === "diff" && t.params.rel === rel && t.params.project === project && t.params.point?.id === point?.id);
  if (open) {
    workspace.show(open);
    open.reload();
    return;
  }
  workspace.add("diff", "center", { params: { rel, project, point }, replace: true });
}

function makeDiff(tab) {
  const { rel, project, point } = tab.params;
  tab.title = `${rel.split("/").pop()}${point ? ` · since ${point.when}` : ""}`;
  const head = el("div", { className: "file-head" });
  const iconButton = (icon, title) => el("button", { type: "button", className: "icon-btn", title, ariaLabel: title }, svgIcon(icon));
  const refresh = iconButton("refresh-cw", "Read it again");
  const mention = iconButton("at-sign", "Mention it in Pi's prompt");
  mention.hidden = !prefs.piTerminal;
  const whole = iconButton("file-text", "The whole file, as it is now");
  whole.addEventListener("click", () => openFile(rel, project));
  head.append(el("span", { className: "file-facts", title: `${project}/${rel}` }), el("span", { className: "file-acts" }, whole, refresh, mention)); // its name is the tab's
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
      body.append(diffCard("history", `Since the restore point (${result.label || result.reason})`, point.when, diffBlock(withoutHeader(result.diff.trimEnd()))));
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
      body.append(diffCard("git-compare", result.untracked ? "New file, not yet in git" : "Since the last commit", "", diffBlock(withoutHeader(result.diff.trimEnd()))));
    } else if (result.diff === "") {
      body.append(el("p", { className: "dim", textContent: "No difference with the last commit." }));
    }
    if (result.edits.length) {
      // Pi's changes, the newest first: a card each, its kind and time in its head.
      for (const edit of [...result.edits].reverse()) {
        const when = edit.at ? new Date(edit.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
        const write = edit.tool === "write";
        const state = edit.state === "done" ? "" : edit.state === "error" ? " · failed" : ` · ${edit.state}`;
        const blocks = write ? [diffBlock(String(edit.content ?? "").split("\n").map((l) => `+${l}`).join("\n"), { kindOf: () => "add" })]
          : (edit.changes || []).map((change) => diffBlock([...change.old.split("\n").map((l) => `-${l}`), ...change.new.split("\n").map((l) => `+${l}`)].join("\n")));
        const card = diffCard(write ? "file-plus" : "pencil", `${write ? "Pi wrote the whole file" : "Pi edited it"}${state}`, when, ...blocks);
        card.classList.toggle("failed", edit.state === "error");
        body.append(card);
      }
    }
    if (!body.childElementCount) {
      // Nothing to compare: said in the middle, as the empty panels, with the way to the file.
      const open = el("button", { type: "button", className: "secondary", textContent: "Open the file" });
      open.addEventListener("click", () => openFile(rel, project));
      body.append(el("div", { className: "diff-empty" }, svgIcon("git-compare"), el("p", { textContent: "No change to show" }),
        el("p", { textContent: "This folder is not a git repository, and Pi has not edited this file." }), open));
    }
  }

  refresh.addEventListener("click", reload);
  mention.addEventListener("click", () => backend.api(["type", `@${rel} `, project]).catch((e) => showError(error, String(e))));
  tab.reload = reload;
  reload();
}
