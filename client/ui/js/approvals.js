// Pi's requests waiting for the user: a merge, a review, a repository to create, a command
// on a machine. Setup > Git and the Labs tab show them the same way.

// ============================================================================
// Each request shows exactly what will be done: the command whole, the pull request with
// the commit it is at, the account a repository goes to. Then what Pi says, marked as
// Pi's, then Refuse and Approve. The picker does what the request holds and nothing else:
// a pull request that moved on since is not merged (see "approvals" in the picker).
// ============================================================================

const MERGE_NAMES = { merge: "merge commit", squash: "squash", rebase: "rebase" };

/** What a request asks, in one line: a notification, the toast. */
function approvalSummary(a) {
  const args = a.args || {};
  const short = (text) => visibleText(text).slice(0, 120);
  if (a.kind === "merge") return `merge pull request #${args.number}${args.title ? ` "${short(args.title)}"` : ""}`;
  if (a.kind === "review") return `post a review of #${args.number} (${String(args.verdict || "").replace("_", " ")})`;
  if (a.kind === "create_repo") return `create the repository ${short(args.name)}${args.account ? ` on ${short(args.account)}` : ""}`;
  if (a.kind === "lab") return `${short(args.what || args.op)} on ${short(args.machine)}`;
  return short(a.kind);
}

/** A command as the user approves it: whole, with what could hide a part of it made
 *  plain (a long run of spaces or of empty lines is counted instead of drawn). */
function commandShown(command) {
  return visibleText(command, { lines: true })
    .replace(/ {8,}/g, (run) => ` ⟨${run.length} spaces⟩ `)
    .replace(/\t{4,}/g, (run) => ` ⟨${run.length} tabs⟩ `)
    .replace(/\n{3,}/g, (run) => `\n⟨${run.length - 1} empty lines⟩\n`);
}

/** The pull request a request is about: its title, its branches, the commit. */
function prFacts(args, method) {
  const facts = [];
  if (args.title) facts.push(`#${args.number} ${args.title}`);
  if (args.head) facts.push(`${args.head} → ${args.base} · by ${args.author || "?"}${args.draft ? " · draft" : ""}`);
  facts.push(args.sha
    ? `at commit ${String(args.sha).slice(0, 12)} of ${args.repo}${method ? ` · ${MERGE_NAMES[method] || method}` : ""}`
    : "asked by an older picker, without the commit it is for: approving it does nothing; ask Pi again");
  return facts;
}

/** One request, in a list: what it asks, what exactly will be done, what Pi says, then
 *  Refuse and Approve. answer(yes) does it; both buttons wait for it. */
function approvalItem(a, answer) {
  const args = a.args || {};
  let what = a.kind;
  let facts = [];
  let whole = null; // what will be done, in full: a command, a review
  let note = "";
  if (a.kind === "merge") {
    what = `merge pull request #${args.number}`;
    facts = prFacts(args, args.method);
  } else if (a.kind === "review") {
    what = `post a review of #${args.number}: ${String(args.verdict || "").replace("_", " ")}`;
    facts = prFacts(args);
    whole = args.body || "";
  } else if (a.kind === "create_repo") {
    what = `create the repository ${args.name} (${args.private === false ? "public" : "private"})`;
    facts = [args.account ? `on ${args.account} · ${FORGE_LABELS[args.forge_kind] || args.forge_kind} · ${args.forge_url}` : "on an account the request does not name (asked by an older picker)",
      args.description || ""];
  } else if (a.kind === "lab") {
    facts = [args.where || ""];
    if (args.op === "lab_run") {
      what = `run a command on ${args.machine}`;
      whole = args.command ?? args.what ?? "";
      if (args.command === undefined) note = "shortened by an older picker: refuse it, and ask Pi again";
    } else if (args.op === "lab_push") {
      what = `copy ${args.path ?? "the project"} of the project to ${args.machine}`;
    } else if (args.op === "lab_pull") {
      what = `bring ${args.path ?? "a file"} back from ${args.machine}`;
    } else {
      what = `${args.what || args.op} on ${args.machine}`;
    }
  } else {
    whole = JSON.stringify(args, null, 2);
  }
  const refuse = el("button", { className: "secondary", textContent: "Refuse", title: "Pi is told no" });
  const approve = el("button", { textContent: "Approve", title: "Do exactly this, now" });
  const go = (yes) => async () => {
    refuse.disabled = approve.disabled = true;
    try { await answer(yes); } finally { refuse.disabled = approve.disabled = false; }
  };
  refuse.addEventListener("click", go(false));
  approve.addEventListener("click", go(true));
  const size = whole === null ? "" : `${[...whole].length} characters${whole.includes("\n") ? ` · ${whole.split("\n").length} lines` : ""}`;
  return el("li", { className: "approval" },
    el("div", { className: "approval-what", textContent: `Pi asks to ${visibleText(what)}` }),
    ...facts.filter(Boolean).map((text) => el("div", { className: "approval-fact", textContent: visibleText(text) })),
    whole === null ? null : a.kind === "lab"
      ? el("pre", { className: "approval-whole command", textContent: commandShown(whole) })
      : el("pre", { className: "approval-whole", textContent: visibleText(whole, { lines: true }) }),
    size && a.kind === "lab" ? el("div", { className: "dim small", textContent: size }) : null,
    note ? el("div", { className: "error small", textContent: note }) : null,
    a.reason ? el("div", { className: "approval-reason", textContent: `Pi says: ${visibleText(a.reason)}` }) : null,
    el("div", { className: "approval-asked dim small", textContent: `${projectLabel(a.project)} · asked ${new Date(a.at * 1000).toLocaleString()}` }),
    el("div", { className: "approval-actions" }, refuse, approve));
}
