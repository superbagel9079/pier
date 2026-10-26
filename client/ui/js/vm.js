// What the VM tells as it changes. One watch (see api_watch in the picker) feeds every
// tab: a tab says what it follows (vm.follow) and listens (vm.on). Nothing is asked
// again and again: the picker sends a part only when it changed. While the watch is
// being reopened (the connection dropped), tabs keep what they last showed.

/** JSON with sorted keys: the same value always gives the same text. */
function canon(value) {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canon(value[k])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

const vm = (() => {
  // projects: the Pis and recent projects; activity: {project, file} of one conversation;
  // setup and checkpoints: a project; contexts: everything given to Pis; log: new lines.
  const want = { projects: true, contexts: false, activity: null, setup: null, checkpoints: null, log: false, conversations: false, approvals: true, team: true };
  const latest = {};
  const listeners = {};
  let active = false; // connected: the watch should be running
  let running = false;
  let retry = null;
  let watchId = null; // the id of the watch this side started last

  // While the window is hidden (in the tray, minimized), only the projects are followed:
  // they bring the "Pi finished" notifications. The panels' parts come back when the
  // window does, rebuilt fresh; nothing is computed on the VM for a window nobody sees.
  const quiet = () => (document.hidden ? { ...Object.fromEntries(Object.keys(want).map((k) => [k, null])), projects: want.projects, approvals: want.approvals, team: want.team } : want);
  document.addEventListener("visibilitychange", () => {
    if (running) backend.watchSet(quiet()).catch(() => {});
  });

  backend.onVmUpdate((message) => {
    if (!message?.kind) return;
    latest[message.kind] = message;
    for (const handler of listeners[message.kind] || []) {
      try {
        handler(message);
      } catch (error) {
        uiLog("error", "vm-handler", { kind: message.kind, msg: String(error), trace: error?.stack?.slice(0, 3000) });
      }
    }
  });

  backend.onWatchEnded((id) => {
    if (watchId !== null && id !== watchId) return; // an older watch, replaced: nothing to do
    running = false;
    watchId = null;
    if (!active) return;
    uiLog("info", "watch-restart");
    clearTimeout(retry);
    retry = setTimeout(start, 2000);
  });

  async function start() {
    active = true;
    clearTimeout(retry);
    try {
      const sent = canon(quiet());
      watchId = await backend.watchStart(quiet());
      running = true;
      // Followed meanwhile (a tab switched project while the watch was starting): sent now.
      if (canon(quiet()) !== sent) backend.watchSet(quiet()).catch(() => {});
    } catch (error) {
      uiLog("warn", "watch-failed", { msg: String(error) });
      if (active) retry = setTimeout(start, 5000);
    }
  }

  function stop() {
    active = false;
    running = false;
    watchId = null;
    clearTimeout(retry);
    for (const kind of Object.keys(latest)) delete latest[kind];
  }

  /** Follow something else: {activity: {project, file}}, {setup: null}... */
  function follow(changes) {
    const sent = {};
    for (const [kind, value] of Object.entries(changes)) {
      if (canon(want[kind]) === canon(value)) continue;
      want[kind] = value;
      sent[kind] = value;
      delete latest[kind];
    }
    if (running && Object.keys(sent).length && !document.hidden) backend.watchSet(sent).catch(() => {});
  }

  /** Calls handler with every message of a kind, starting with the last one if any. */
  function on(kind, handler) {
    (listeners[kind] ||= new Set()).add(handler);
    if (latest[kind]) handler(latest[kind]);
    return () => listeners[kind].delete(handler);
  }

  /** Everything again, now: after an action whose result should show at once. */
  function poke() {
    if (running) backend.watchSet({ poke: true }).catch(() => {});
  }

  /** Whether a message answers what is followed now (one for the previous may come late). */
  function current(message) {
    return canon(message.for) === canon(want[message.kind]);
  }

  return { start, stop, follow, on, poke, current, latest: (kind) => latest[kind] };
})();
