// How a conversation opens: Pier's conversation view, or Pi's own screen in tmux; and
// moving one from a view to the other.

/** What the conversation view takes (see rpc_command in Rust): a new Pi, the last
 *  conversation, a conversation file, or a Pi running in RPC mode ("…-r1"). */
const chatArgs = (args) => args.length === 0 || (args.length === 1 && ["--new", "--continue"].includes(args[0]))
  || (args.length === 2 && args[0] === "--session") || (args.length === 2 && args[0] === "--slot" && /-r\d+$/.test(args[1]));

/** A terminal on a Pi of project. args: nothing (the Pi used last there, or a new one),
 *  ["--new"], ["--slot", NAME] (a running Pi), ["--continue"] or ["--session", FILE]
 *  (that conversation: its Pi if one runs it, else a new Pi on it). A tab already open
 *  on the same Pi is shown instead; n numbers the project's Pis in the tab's title. */
function openPiTerminal(project, label, args = [], n = 1) {
  // Pier's conversation view, unless Settings > Terminals asks for Pi's own screen in
  // tmux; a Pi already running in tmux, an orchestrator or a task still open there.
  if (!prefs.piTerminal && chatArgs(args)) return openChat(project, label, args);
  // The same Pi: the tab that shows that tmux session (it learns it when attached), or
  // one opened the same way.
  const slot = args[0] === "--slot" ? args[1] : null;
  const same = (t) => t.kind === "pi" && t.params?.project === project && args[0] !== "--new"
    && ((slot && t.slot === slot) || canon(t.params.args) === canon(args));
  const existing = workspace.tabs().find(same);
  if (existing) { workspace.show(existing); return existing; }
  const suffix = args[0] === "--new" ? " · new" : n > 1 ? ` #${n}` : "";
  return workspace.add("pi", "center", { params: { project, label: label + suffix, args } });
}

/** The same conversation in the other view: Pi's own screen in tmux, or Pier's conversation
 *  view. A Pi runs in one of them only: the one running is stopped (its conversation stays
 *  saved), then the conversation goes on in the other, from its file. */
async function switchPiView(tab) {
  const project = tab.params?.project;
  const toChat = tab.kind === "pi";
  const slot = toChat ? tab.slot : tab.params.args?.[0] === "--slot" ? tab.params.args[1] : null;
  const sessions = (vm.latest("conversations")?.data?.projects || []).find((p) => p.project === project)?.sessions || [];
  const file = tab.sessionFile || (slot && sessions.find((s) => s.slot === slot)?.path) || tab.params.file
    || (tab.params.args?.[0] === "--session" ? tab.params.args[1] : null);
  if (!project || !file) { flashStatus("Its conversation is not saved yet: say something to Pi first"); return; }
  const where = toChat ? "in Pier's conversation view" : "in Pi's own screen (tmux)";
  if (slot && !(await ask(`Continue this conversation ${where}? Pi stops here first: what it is doing right now is lost, the conversation is kept.`))) return;
  if (slot) {
    try { await backend.stopPi(project, slot); } catch (e) { flashStatus(String(e)); return; }
    await new Promise((r) => setTimeout(r, 800)); // its session gone from the VM's list
  }
  const label = tab.params.label?.replace(/ · new$| #\d+$/, "") || projectLabel(project);
  tab.keepPi = true; // stopped above already; its name may go to the Pi opened next
  workspace.close(tab);
  if (toChat) openChat(project, label, ["--session", file]);
  else workspace.add("pi", "center", { params: { project, label, args: ["--session", file] } });
  vm.poke();
}
