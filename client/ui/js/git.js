// The Git page of Repository, and Pi's requests waiting for the user.

// A project on a forge (GitHub, GitLab, Gitea / Forgejo): Pi pushes its pi/ branches and opens
// pull requests through the picker, which holds the token. Creating a repository always waits.

const FORGE_LABELS = { github: "GitHub", gitlab: "GitLab", gitea: "Gitea / Forgejo" };
const FORGE_HINTS = {
  github: "A fine-grained token (github.com > Settings > Developer settings), limited to the repositories Pi works on, with Contents and Pull requests in read and write. Add Administration to let Pi create repositories.",
  gitlab: "A personal access token with the api scope (GitLab > Preferences > Access tokens). A project access token limits it to one project.",
  gitea: "An access token with read and write on repository (Settings > Applications).",
};
const REPO_MODES = {
  local: ["Work locally", "Pi commits and branches in the project; nothing is pushed."],
  ask: ["Push, ask to merge", "Pi pushes its pi/… branches and opens pull requests; a merge waits for your approval here."],
  auto: ["Push and merge", "Pi pushes, opens pull requests and merges its own (pi/… branches of this repository) itself once their checks ran and passed. Its approvals of a review still wait for you."],
};
const MERGE_LABELS = { merge: "Merge commit", squash: "Squash", rebase: "Rebase" };
const CHECK_MARKS = { success: ["checks passed"], failure: ["checks failed"], pending: ["checks running"], none: [""] };

/** Connect an account of a forge: its token checked by the picker, kept on the VM, never
 *  seen by Pi. From Settings > Git & forges, and from a project not connected yet. */
function forgeAccountDialog(chosen = "github", done = () => {}) {
  const kind = el("select");
  for (const [value, label] of Object.entries(FORGE_LABELS)) kind.add(new Option(label, value));
  kind.value = chosen;
  const url = el("input", { spellcheck: false });
  const token = el("input", { type: "password", placeholder: "the token", autocomplete: "off" });
  const hint = el("p", { className: "hint" });
  const problem = dialogError();
  const go = el("button", { textContent: "Connect" });
  const dialog = resourceDialog("Connect an account", [
    el("div", { className: "grid fields" }, el("label", { textContent: "Service" }), kind, el("label", { textContent: "Address" }), url,
      el("label", { textContent: "Token" }), token), hint, problem], [go]);
  const chose = () => {
    url.value = kind.value === "github" ? "https://github.com" : kind.value === "gitlab" ? "https://gitlab.com" : "https://";
    hint.textContent = FORGE_HINTS[kind.value];
  };
  kind.addEventListener("change", chose);
  chose();
  const connect = async () => {
    go.disabled = true;
    try {
      const forge = await backend.forgeAdd(kind.value, url.value.trim(), token.value);
      token.value = "";
      dialog.close();
      done(forge);
    } catch (e) { showError(problem, String(e)); } finally { go.disabled = false; }
  };
  go.addEventListener("click", connect);
  token.addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });
  token.focus();
}

function makeGitManager(box, currentProject, onLoad = null) {
  const error = el("p", { className: "error", hidden: true });
  const notice = el("p", { className: "notice", hidden: true });
  const body = el("div");
  const refresh = el("button", { className: "icon-btn", type: "button", title: "Check the repository and its pull requests again" }, svgIcon("refresh-cw"));
  refresh.setAttribute("aria-label", refresh.title);
  refresh.addEventListener("click", () => load());
  box.replaceChildren(error, notice, body);
  const opened = new Set(); // the requests unfolded by a click, kept over redraws
  const say = noticeSetter(notice);
  let data = null;

  async function load() {
    const project = currentProject();
    if (!project) return;
    showError(error, "");
    try {
      data = await backend.api(["repo", project]);
      data.worktrees = (await backend.api(["worktrees", project]).catch(() => ({ worktrees: [] }))).worktrees;
    } catch (e) {
      showError(error, String(e));
      onLoad?.(null, String(e));
      return;
    }
    if (data.error) showError(error, data.error);
    render();
    onLoad?.(data);
  }


  /** As an inbox (the proposals' A): the repository on top, what waits for you in short
   *  lines (a click unfolds one, ✕ and ✓ on the right), then the pull requests and the Pis'
   *  worktrees. What Pi may do and how it merges: Settings > Projects > Repository. */
  function render() {
    body.replaceChildren();
    if (!data) return;
    const forge = data.link && data.forges.find((f) => f.id === data.link.forge);
    const logo = el("span", { className: "avatar", "aria-hidden": "true" },
      svgIcon(/forgejo|codeberg/i.test(forge?.url || "") ? "logo-forgejo" : FORGE_ICONS[forge?.kind] || "git-branch"));
    if (data.link) {
      body.append(el("div", { className: "repo-head" }, logo,
        el("div", { className: "what" }, el("span", { textContent: data.link.repo }),
          el("span", { textContent: [data.link.default_branch, data.branch ? `here ${data.branch}` : ""].filter(Boolean).join(" · ") })), refresh));
    } else {
      // Its sentence, then what to do on a line of its own (the panel is narrow).
      const button = (text, run) => { const b = el("button", { type: "button", className: "secondary", textContent: text }); b.addEventListener("click", () => run(b)); return b; };
      const actions = data.forges.length
        ? [button("Connect…", () => linkDialog()), button("Create…", () => createDialog())]
        : [button("Add an account", (b) => showMenu(b, Object.entries(FORGE_LABELS).map(([kind, label]) => [label, () => accountDialog(kind), false, { icon: FORGE_ICONS[kind] || "git-branch" }])))];
      body.append(el("div", { className: "repo-head" }, logo,
        el("div", { className: "what" }, el("span", { textContent: "Not connected yet" }),
          el("span", { className: "wrap", textContent: data.forges.length ? "Where Pi pushes its pi/… branches and opens pull requests." : "Pi pushes its branches and opens pull requests through an account on a forge; its token stays on the VM." }))),
        el("div", { className: "repo-actions" }, ...actions));
    }
    const group = (label, count, rows) => {
      body.append(el("h3", { className: count && label === "Waiting for you" ? "repo-label hot" : "repo-label" },
        el("span", { textContent: label }), el("span", { className: "n", textContent: String(count) })), el("div", { className: "repo-list" }, ...rows));
    };
    if (data.approvals.length) group("Waiting for you", data.approvals.length, data.approvals.map((a) => waitRow(a, opened.has(a.id), opened)));
    if (data.link) {
      group("Pull requests", data.prs.length, data.prs.length ? data.prs.map(prRow) : [el("p", { className: "dim small repo-none", textContent: "No open pull request." })]);
    }
    worktrees();
  }

  // Local, so shown whether a repository is connected or not.
  function worktrees() {
    if (!data.worktrees?.length) return;
    body.append(el("h3", { className: "repo-label", title: "A Pi beside another in this project works in a worktree of its own, on its branch: an untouched one goes when its Pi ends, one with work stays until you remove it. Its branch stays either way." },
      el("span", { textContent: "Pis' worktrees" }), el("span", { className: "n", textContent: String(data.worktrees.length) })),
      el("div", { className: "repo-list" }, ...data.worktrees.map(worktreeRow)));
  }

  /** A line of the panel: what, under it its facts, ⋯ for what can be done. */
  const repoRow = (lead, name, facts, title, items) => {
    let more = null;
    if (items.length) {
      more = el("button", { type: "button", className: "icon-btn", title: `${name}: more` }, svgIcon("ellipsis"));
      more.setAttribute("aria-label", more.title);
      more.setAttribute("aria-haspopup", "menu");
      more.addEventListener("click", () => showMenu(more, items));
    }
    return el("div", { className: "repo-row", title: title || "" }, lead,
      el("div", { className: "what" }, el("span", { textContent: name }), el("span", { textContent: facts })), more);
  };

  function worktreeRow(w) {
    const facts = [w.running ? "its Pi runs" : "its Pi ended", w.changed ? `${w.changed} changed file${w.changed > 1 ? "s" : ""}` : "",
      w.ahead ? `${w.ahead} commit${w.ahead > 1 ? "s" : ""} ahead` : "", w.changed === 0 && !w.ahead ? "nothing new" : ""].filter(Boolean);
    const remove = ["Remove the worktree", async () => {
      const lost = w.changed ? ` Its ${w.changed} uncommitted change${w.changed > 1 ? "s are" : " is"} lost.` : "";
      if (!(await ask(`Remove the worktree ${w.name}?${lost} Its branch ${w.branch || ""} stays.`))) return;
      try { await backend.worktreeRemove(currentProject(), w.name); load(); } catch (e) { showError(error, String(e)); }
    }, false, { icon: "trash", danger: true }];
    return repoRow(null, w.branch || w.name, facts.join(" · "), w.path, w.running ? [] : [remove]);
  }

  function prRow(pr) {
    const [label] = CHECK_MARKS[pr.checks || "none"] || CHECK_MARKS.none;
    // Its checks as a chip; merging (the repository's method first) and its link behind ⋯.
    const chip = el("span", { className: `repo-chip ${pr.checks || "none"}`, textContent: label || (pr.draft ? "draft" : "open") });
    const first = data.link?.merge_method || "merge";
    const methods = [["merge", "Merge"], ["squash", "Squash and merge"], ["rebase", "Rebase and merge"]]
      .sort((a, b) => (b[0] === first) - (a[0] === first));
    return repoRow(chip, `#${pr.number} ${pr.title}`, [`${pr.head} → ${pr.base}`, pr.draft && label ? "draft" : "", pr.author].filter(Boolean).join(" · "), pr.url || "", [
      ...methods.map(([m, text]) => [text, () => doMerge(pr, m), false, { icon: "git-branch" }]),
      null,
      ["Copy its link", async () => {
        try { await backend.copyText(pr.url || ""); say(`Copied: ${pr.url}`); } catch (e) { showError(error, String(e)); }
      }, false, { icon: "copy" }],
    ]);
  }

  async function doMerge(pr, method) {
    if (!(await ask(`${method === "squash" ? "Squash and merge" : method === "rebase" ? "Rebase and merge" : "Merge"} #${pr.number} "${String(pr.title).slice(0, 80)}" into ${pr.base}?`))) return;
    try {
      await backend.prMerge(currentProject(), pr.number, method);
      say(`#${pr.number} merged into ${pr.base}.`);
      load();
    } catch (e) { showError(error, String(e)); }
  }

  const accountDialog = (kind) => forgeAccountDialog(kind, (forge) => { say(`Connected: ${forge.login} on ${FORGE_LABELS[forge.kind]}.`); load(); });

  const accountChoice = () => {
    const select = el("select");
    for (const f of data.forges) select.add(new Option(`${f.login} · ${FORGE_LABELS[f.kind]}`, f.id));
    return select;
  };

  function linkDialog() {
    const forge = accountChoice();
    const repo = el("input", { placeholder: "owner/name", spellcheck: false });
    const problem = dialogError();
    const go = el("button", { textContent: "Connect" });
    const dialog = resourceDialog("Connect a repository", [
      el("div", { className: "grid fields" }, el("label", { textContent: "Account" }), forge, el("label", { textContent: "Repository" }), repo),
      el("p", { className: "hint", textContent: "The project becomes a git repository if it is not one yet. Nothing is pushed until Pi pushes a branch." }), problem], [go]);
    const connect = async () => {
      try {
        await backend.repoLink(currentProject(), forge.value, repo.value.trim());
        dialog.close();
        say(`Connected to ${repo.value.trim()}.`);
        load();
      } catch (e) { showError(problem, String(e)); }
    };
    go.addEventListener("click", connect);
    repo.addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });
    repo.focus();
  }

  function createDialog() {
    const forge = accountChoice();
    const name = el("input", { placeholder: "name", spellcheck: false, value: (currentProject() || "").split("/").pop() || "" });
    const description = el("input", { placeholder: "what it is (optional)", spellcheck: false });
    const visibility = el("select");
    visibility.add(new Option("private", "1"));
    visibility.add(new Option("public", "0"));
    const problem = dialogError();
    const go = el("button", { textContent: "Create" });
    const dialog = resourceDialog("Create a repository", [
      el("div", { className: "grid fields" }, el("label", { textContent: "Account" }), forge, el("label", { textContent: "Name" }), name,
        el("label", { textContent: "Visibility" }), visibility, el("label", { textContent: "Description" }), description), problem], [go]);
    go.addEventListener("click", async () => {
      try {
        const made = await backend.repoCreate(currentProject(), forge.value, name.value.trim(), visibility.value === "1", description.value.trim());
        dialog.close();
        say(`Created and connected: ${made.repo}. Pi can now push its first branch.`);
        load();
      } catch (e) { showError(problem, String(e)); }
    });
    name.focus();
  }

  let loadedFor = null;
  return {
    load,
    linkDialog: () => linkDialog(),
    createDialog: () => createDialog(),
    shown() { if (currentProject() !== loadedFor) { loadedFor = currentProject(); load(); } },
  };
}

// Pi's requests, wherever the user is: a notification for each new one, and the Git
// page of Setup shows them with approve / refuse.
(() => {
  const seen = new Set();
  let first = true;
  vm.on("approvals", (message) => {
    const pending = message.data?.approvals || [];
    for (const a of pending) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      if (first) continue; // those from before this window opened: shown in Setup, not announced
      // A short line only: the request is read whole where it is answered.
      const what = approvalSummary(a);
      const where = "the top bar's \u201cwaiting\u201d";
      backend.notify("Pi asks for your approval", `${projectLabel(a.project)}: ${what}. Answer in ${where}.`).catch(() => {});
      flashStatus(`Pi asks to ${what}: ${where}`);
    }
    first = false;
  });
})();
