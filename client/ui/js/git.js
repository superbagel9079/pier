// The Git page of Setup, and Pi's requests waiting for the user.

// ============================================================================
// A project connected to a forge (GitHub, GitLab, Gitea / Forgejo): Pi pushes its pi/…
// branches and opens pull requests by itself, through the picker, which holds the
// token. What Pi may do alone is chosen per repository (work locally, ask to merge, merge
// once the checks pass); creating a repository always waits for the user here. See
// "git forges" in the picker.
// ============================================================================

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
const CHECK_MARKS = { success: ["✓", "checks passed"], failure: ["✗", "checks failed"], pending: ["…", "checks running"], none: ["", "no checks"] };

function makeGitManager(box, currentProject) {
  const error = el("p", { className: "error", hidden: true });
  const notice = el("p", { className: "notice", hidden: true });
  const body = el("div");
  const refresh = el("button", { className: "link", textContent: "refresh", title: "Check the repository and its pull requests again" });
  refresh.addEventListener("click", () => load());
  const bar = el("div", { className: "toolbar resource-bar" }, el("span", { className: "dim small", textContent: "Pi works with the project's repository as you choose below." }), refresh);
  box.replaceChildren(bar, error, notice, body);
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
      return;
    }
    if (data.error) showError(error, data.error);
    render();
  }

  const action = linkButton;
  // Two lines: what it is and what can be done, then the details (a title is read whole).
  const line = itemLine;

  function render() {
    body.innerHTML = "";
    if (!data) return;
    bar.hidden = !data.link;
    // What Pi asks, first: it waits for an answer.
    if (data.approvals.length) {
      body.append(el("h2", { textContent: "Waiting for you" }));
      const ul = el("ul", { className: "resource-items" });
      for (const a of data.approvals) ul.append(approvalRow(a));
      body.append(ul);
    }

    // Nothing connected yet: only the choice of where the code lives.
    if (!data.forges.length) {
      body.append(el("p", { className: "dim small", textContent: "Let Pi push its branches and open pull requests where your code lives:" }),
        el("div", { className: "toolbar" }, ...Object.entries(FORGE_LABELS).map(([kind, label]) => {
          const b = el("button", { className: "secondary", textContent: `${label}…` });
          b.addEventListener("click", () => accountDialog(kind));
          return b;
        })),
        el("p", { className: "hint", textContent: "Pier asks for a token, which stays on the VM: Pi never sees it." }));
      worktrees();
      return;
    }

    body.append(el("h2", { textContent: "Repository" }));
    const repo = el("ul", { className: "resource-items" });
    if (data.link) {
      const forge = data.forges.find((f) => f.id === data.link.forge);
      repo.append(line(data.link.repo, `${FORGE_LABELS[forge?.kind] || "git host"} · default branch ${data.link.default_branch}`,
        `${forge?.url || ""}/${data.link.repo}`, action("disconnect", "Pi can no longer push or open pull requests for this project (nothing is deleted)", async () => {
          if (!(await ask(`Disconnect this project from ${data.link.repo}? Nothing is deleted, on ${FORGE_LABELS[forge?.kind] || "the git host"} or here.`))) return;
          try { await backend.repoUnlink(currentProject()); load(); } catch (e) { showError(error, String(e)); }
        })));
      if (data.branch) repo.append(line(`here: ${data.branch}`, data.local ? "local branch" : "", "The branch checked out in the project"));
    } else {
      repo.append(el("li", { className: "dim small note", textContent: "Not connected yet: connect a repository, or create one." }));
    }
    body.append(repo);
    if (data.link) body.append(settings(data.link));
    if (!data.link) {
      const connect = el("button", { className: "secondary", textContent: "Connect a repository…" });
      connect.addEventListener("click", () => linkDialog());
      const create = el("button", { className: "secondary", textContent: "Create a repository…" });
      create.addEventListener("click", () => createDialog());
      body.append(el("div", { className: "toolbar" }, connect, create));
    }

    if (data.link) {
      body.append(el("h2", { textContent: `Pull requests · ${data.prs.length}` }));
      const ul = el("ul", { className: "resource-items" });
      for (const pr of data.prs) ul.append(prRow(pr));
      if (!data.prs.length) ul.append(el("li", { className: "dim small note", textContent: "No open pull request." }));
      body.append(ul);
    }

    worktrees();

    body.append(el("h2", { textContent: "Accounts" }));
    const accounts = el("ul", { className: "resource-items" });
    for (const f of data.forges) {
      accounts.append(line(`${f.login} · ${FORGE_LABELS[f.kind]}`, f.url, f.id, action("×", "Forget this account (its token is deleted on the VM)", async () => {
        if (!(await ask(`Forget the ${FORGE_LABELS[f.kind]} account ${f.login}? Its token is deleted on the VM; revoke it on ${FORGE_LABELS[f.kind]} too.`))) return;
        try { await backend.forgeRemove(f.id); load(); } catch (e) { showError(error, String(e)); }
      })));
    }
    body.append(accounts);
    const addAccount = el("button", { className: "secondary", textContent: "Add an account…" });
    addAccount.addEventListener("click", () => accountDialog());
    body.append(el("div", { className: "toolbar" }, addAccount),
      el("p", { className: "hint", textContent: "The token stays on the VM, out of Pi's sandbox: Pi never sees it. Pi's git tools ask the picker, which checks each request: pi/… branches only, never forced; merges as chosen above; creating a repository only once you approve it here." }));
  }

  // Local, so shown whether a repository is connected or not.
  function worktrees() {
    if (!data.worktrees?.length) return;
    body.append(el("h2", { textContent: `Pis' worktrees · ${data.worktrees.length}` }));
    const ul = el("ul", { className: "resource-items" });
    for (const w of data.worktrees) ul.append(worktreeRow(w));
    body.append(ul, el("p", { className: "hint", textContent: "A Pi beside another in this project works in a worktree of its own, on its branch: an untouched one goes when its Pi ends, one with work stays here until you remove it. Its branch stays either way." }));
  }

  // What Pi may do alone, and how merges are made: saved as soon as it is chosen.
  function settings(link) {
    const mode = el("select", { id: "repo-mode" });
    for (const [value, [label]] of Object.entries(REPO_MODES)) mode.add(new Option(label, value));
    const method = el("select", { id: "repo-merge" });
    for (const [value, label] of Object.entries(MERGE_LABELS)) method.add(new Option(label, value));
    mode.value = link.mode || "ask";
    method.value = link.merge_method || "merge";
    const hint = el("p", { className: "hint" });
    const show = () => { hint.textContent = REPO_MODES[mode.value][1]; };
    const save = async () => {
      show();
      try {
        Object.assign(link, await backend.repoSettings(currentProject(), mode.value, method.value, link.agents || ""));
      } catch (e) {
        showError(error, String(e));
        mode.value = link.mode || "ask";
        method.value = link.merge_method || "merge";
        show();
      }
    };
    mode.addEventListener("change", save);
    method.addEventListener("change", save);
    show();
    return el("div", {},
      el("div", { className: "grid" },
        el("label", { htmlFor: "repo-mode", textContent: "Pi may" }), mode,
        el("label", { htmlFor: "repo-merge", textContent: "Merges" }), method),
      hint);
  }

  function worktreeRow(w) {
    const facts = [w.running ? "its Pi runs" : "its Pi ended", w.changed ? `${w.changed} changed file${w.changed > 1 ? "s" : ""}` : "",
      w.ahead ? `${w.ahead} commit${w.ahead > 1 ? "s" : ""} ahead` : "", w.changed === 0 && !w.ahead ? "nothing new" : ""].filter(Boolean);
    const remove = action("remove", "Remove the worktree (its branch stays)", async () => {
      const lost = w.changed ? ` Its ${w.changed} uncommitted change${w.changed > 1 ? "s are" : " is"} lost.` : "";
      if (!(await ask(`Remove the worktree ${w.name}?${lost} Its branch ${w.branch || ""} stays.`))) return;
      try { await backend.worktreeRemove(currentProject(), w.name); load(); } catch (e) { showError(error, String(e)); }
    });
    return line(w.branch || w.name, facts.join(" · "), w.path, ...(w.running ? [] : [remove]));
  }

  function approvalRow(a) {
    const what = approvalSummary(a);
    return approvalItem(a, async (yes) => {
      try {
        await backend.approvalAnswer(a.id, yes);
        say(!yes ? `Refused: ${what}.` : a.kind === "lab" ? `Approved: ${what}. Pi goes on.` : `Done: ${what}.`);
      } catch (e) { showError(error, String(e)); }
      load();
    });
  }

  function prRow(pr) {
    const [mark, label] = CHECK_MARKS[pr.checks || "none"] || CHECK_MARKS.none;
    const merge = el("button", { className: "link", textContent: "merge ▾", title: "Merge it" });
    // The repository's method first.
    merge.addEventListener("click", () => {
      const first = data.link?.merge_method || "merge";
      const methods = [["merge", "Merge"], ["squash", "Squash and merge"], ["rebase", "Rebase and merge"]]
        .sort((a, b) => (b[0] === first) - (a[0] === first));
      showMenu(merge, methods.map(([m, label]) => [label, () => doMerge(pr, m)]));
    });
    const copy = action("copy link", "Its address, to open in a browser", async () => {
      try { await backend.copyText(pr.url || ""); say(`Copied: ${pr.url}`); } catch (e) { showError(error, String(e)); }
    });
    return line(`#${pr.number} ${pr.title}`, [mark && `${mark} ${label}`, `${pr.head} → ${pr.base}`, pr.draft ? "draft" : "", pr.author].filter(Boolean).join(" · "),
      pr.url || "", copy, merge);
  }

  async function doMerge(pr, method) {
    if (!(await ask(`${method === "squash" ? "Squash and merge" : method === "rebase" ? "Rebase and merge" : "Merge"} #${pr.number} "${String(pr.title).slice(0, 80)}" into ${pr.base}?`))) return;
    try {
      await backend.prMerge(currentProject(), pr.number, method);
      say(`#${pr.number} merged into ${pr.base}.`);
      load();
    } catch (e) { showError(error, String(e)); }
  }

  function accountDialog(chosen = "github") {
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
        say(`Connected: ${forge.login} on ${FORGE_LABELS[forge.kind]}.`);
        load();
      } catch (e) { showError(problem, String(e)); } finally { go.disabled = false; }
    };
    go.addEventListener("click", connect);
    token.addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });
    token.focus();
  }

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
