// Pi's requests waiting for the user: a merge, a review, a repository to create, a command
// on a machine. the top bar, Repository > Git and the Labs tab show them the same way.

// Each request shows exactly what will be done, then what Pi says, marked as Pi's. The picker
// does only what the request holds: a pull request that moved on is not merged.

const MERGE_NAMES = { merge: "merge commit", squash: "squash", rebase: "rebase" };

/** What a request asks, in one line: a notification, the toast. */
function approvalSummary(a) {
  const args = a.args || {};
  const short = (text) => visibleText(text).slice(0, 120);
  if (a.kind === "merge") return `merge pull request #${args.number}${args.title ? ` "${short(args.title)}"` : ""}`;
  if (a.kind === "review") return `post a review of #${args.number} (${String(args.verdict || "").replace("_", " ")})`;
  if (a.kind === "create_repo") return `create the repository ${short(args.name)}${args.account ? ` on ${short(args.account)}` : ""}`;
  if (a.kind === "lab") return `${short(args.what || args.op)} on ${short(args.machine)}`;
  if (a.kind === "workers") return `start up to ${args.max} worker Pis (Pi #${args.orchestrator})`;
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

/** A request in one sentence, for the Details card ("Pi asks to merge #12, ... into main."). */
function approvalSentence(a) {
  const args = a.args || {};
  if (a.kind === "merge") return `Pi asks to merge #${args.number}${args.title ? `, "${visibleText(args.title)}",` : ""} into ${args.base || "its base"}.`;
  if (a.kind === "review") return `Pi asks to post a review of #${args.number}: ${String(args.verdict || "").replace("_", " ")}.`;
  if (a.kind === "create_repo") return `Pi asks to create the repository ${visibleText(args.name || "")}${args.private === false ? " (public)" : ""}.`;
  if (a.kind === "workers") return `Pi asks to start worker Pis, up to ${args.max} at once.`;
  if (a.kind === "lab") return args.op === "lab_run" ? `Pi asks to run a command on ${args.machine}.` : `Pi asks to ${visibleText(args.what || args.op || "act")} on ${args.machine}.`;
  return `Pi asks: ${visibleText(String(a.kind))}.`;
}

/** A line of a command to approve: its words kept whole (a line breaks between words,
 *  never after "--"), the spaces as they are, so what is copied is the command itself. */
function commandLine(line) {
  return el("span", { className: "cl" }, ...(line ? line.split(/(\s+)/).filter(Boolean).map((part) => (/^\s+$/.test(part) ? part : el("span", { className: "w", textContent: part }))) : [" "]));
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
  } else if (a.kind === "workers") {
    what = `start worker Pis: up to ${args.max} at once, while it runs`;
    facts = [`orchestrator: Pi #${args.orchestrator}`,
      `models: ${(args.models || []).join(", ")}`,
      `first: "${args.first}" (${args.first_model})`,
      "each a Pi of its own, in a git worktree of its own, visible in Conversations; they cost tokens like any Pi"];
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
      ? el("pre", { className: "approval-whole command" }, ...commandShown(whole).split("\n").map(commandLine))
      : el("pre", { className: "approval-whole", textContent: visibleText(whole, { lines: true }) }),
    size && a.kind === "lab" ? el("div", { className: "dim small", textContent: size }) : null,
    note ? el("div", { className: "error small", textContent: note }) : null,
    a.reason ? el("div", { className: "approval-reason", textContent: `Pi says: ${visibleText(a.reason)}` }) : null,
    el("div", { className: "approval-asked dim small", textContent: `${projectLabel(a.project)} · asked ${new Date(a.at * 1000).toLocaleString()}` }),
    el("div", { className: "approval-actions" }, refuse, approve));
}

/** A request waiting, as a line (Details' card, the Waiting window): its dot, what it
 *  asks, where and when, ✕ (refuse) and ✓ (approve); its detail under it when open.
 *  openSet: the ids unfolded by a click, kept so on redraws. */
function waitRow(a, open, openSet = null) {
  const answer = async (yes) => {
    try {
      await backend.approvalAnswer(a.id, yes);
      flashStatus(yes ? "Approved: done as shown" : "Refused: Pi is told");
      vm.poke();
    } catch (e) { flashStatus(String(e)); }
  };
  const full = approvalItem(a, answer);
  const [refuse, approve] = $(".approval-actions", full).children;
  for (const sel of [".approval-what", ".approval-actions", ".approval-asked"]) $(sel, full)?.remove();
  const icon = (b, name, label) => { b.className = "icon-btn wait-answer"; b.replaceChildren(svgIcon(name)); b.setAttribute("aria-label", label); b.title = label; return b; };
  const said = approvalSentence(a).replace(/^Pi asks(?: to|:) /, "").replace(/\.$/, "");
  const when = a.at ? new Date(a.at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const head = el("button", { type: "button", className: "wait-head" },
    el("span", { className: "wait-dot", "aria-hidden": "true" }),
    el("span", { className: "what" }, el("span", { textContent: said[0].toUpperCase() + said.slice(1) }), el("span", { textContent: [projectLabel(a.project), when].filter(Boolean).join(" · ") })));
  head.setAttribute("aria-expanded", String(open));
  const detail = el("div", { className: "wait-detail", hidden: !open }, ...full.childNodes);
  head.addEventListener("click", () => {
    const now = detail.hidden;
    detail.hidden = !now;
    head.setAttribute("aria-expanded", String(now));
    if (now) openSet?.add(a.id); else openSet?.delete(a.id);
  });
  return el("div", { className: "wait-row" },
    el("div", { className: "wait-line" }, head, icon(refuse, "x", "Refuse"), icon(approve, "check", "Approve")), detail);
}
