// What the VM tells as it changes. One watch (api_watch in the picker) feeds every tab: a tab
// says what it follows (vm.follow) and listens (vm.on).

/** JSON with sorted keys: the same value always gives the same text. */
function canon(value) {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canon(value[k])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

const vm = (() => {
  // projects: the Pis and recent projects; activity: {project, file} of one conversation;
  // setup and checkpoints: a project; contexts: everything given to Pis; log: new lines.
  const want = { projects: true, contexts: false, activity: null, setup: null, checkpoints: null, log: false, conversations: false, approvals: true, team: true, labs: false };
  const latest = {}; // what the tabs see
  const raw = {};    // what the VM sent (patches go on it)
  const listeners = {};
  // Conversations deleted and Pis stopped here, kept out of the lists at once and while a
  // late answer of the VM still has them (a Pi takes a moment to end): path or slot -> when.
  const gone = new Map();
  const GONE_FOR = 60000;
  function shown(message) {
    if (message.kind !== "conversations" || !message.data || !gone.size) return message;
    const now = Date.now();
    for (const [key, at] of gone) if (now - at > GONE_FOR) gone.delete(key);
    const projects = (message.data.projects || []).map((p) => ({ ...p,
      sessions: (p.sessions || []).filter((s) => !gone.has(s.path)).map((s) => (s.slot && gone.has(s.slot) ? { ...s, slot: null } : s)),
      pis: (p.pis || []).filter((pi) => !gone.has(pi.slot)) }));
    return { ...message, data: { ...message.data, projects } };
  }
  function dispatch(message) {
    latest[message.kind] = message;
    for (const handler of listeners[message.kind] || []) {
      try {
        handler(message);
      } catch (error) {
        uiLog("error", "vm-handler", { kind: message.kind, msg: String(error), trace: error?.stack?.slice(0, 3000) });
      }
    }
  }
  let active = false; // connected: the watch should be running
  let running = false;
  let retry = null;
  let watchId = null; // the id of the watch this side started last

  // Window hidden: only projects are followed (for "Pi finished" notices);
  // the panels' parts come back, rebuilt, with the window.
  const quiet = () => (document.hidden ? { ...Object.fromEntries(Object.keys(want).map((k) => [k, null])), projects: want.projects, approvals: want.approvals, team: want.team } : want);
  // A message to the watch that fails is said in the log, not dropped in silence.
  const sent = (what) => (error) => uiLog("warn", "watch-set-failed", { what, msg: String(error) });
  document.addEventListener("visibilitychange", () => {
    if (running) backend.watchSet(quiet()).catch(sent("visibility"));
  });

  backend.onVmUpdate((message) => {
    if (!message?.kind) return;
    if (message.patch) {
      // Only what changed (WATCH_PATCHED in the picker), on top of the last whole one.
      const before = raw[message.kind];
      if (!before?.data || canon(before.for) !== canon(message.for)) {
        backend.watchSet({ poke: true }).catch(() => {}); // nothing to put it on: the whole again
        return;
      }
      const old = new Map((before.data.projects || []).map((p) => [p.project, p]));
      const edit = (key) => {
        // A project known before: its fields, and its conversations from the old ones
        // but those that changed.
        const was = old.get(key);
        const change = message.patch.edited?.[key];
        if (!change || !was) return was;
        const sessions = new Map((was.sessions || []).map((s) => [s.path, s]));
        return { ...change.fields, sessions: change.order.map((path) => change.changed[path] ?? sessions.get(path)).filter(Boolean) };
      };
      const projects = message.patch.order.map((key) => message.patch.changed[key] ?? edit(key)).filter(Boolean);
      message = { kind: message.kind, for: message.for, data: { ...message.patch.rest, projects } };
    }
    raw[message.kind] = message;
    dispatch(shown(message));
  });

  // A word to the watch at least every 30 s: one that hears nothing for a while knows
  // its connection is gone (a sleeping PC, Wi-Fi lost) and ends (WATCH_SILENCE).
  setInterval(() => {
    if (running) backend.watchSet({ ping: 1 }).catch(() => {});
  }, 30000);

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
      if (canon(quiet()) !== sent) backend.watchSet(quiet()).catch((error) => uiLog("warn", "watch-set-failed", { what: "start", msg: String(error) }));
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
    for (const kind of Object.keys(raw)) delete raw[kind];
  }

  /** Follow something else: {activity: {project, file}}, {setup: null}... */
  function follow(changes) {
    const sent = {};
    for (const [kind, value] of Object.entries(changes)) {
      if (canon(want[kind]) === canon(value)) continue;
      want[kind] = value;
      sent[kind] = value;
      delete latest[kind];
      delete raw[kind];
    }
    if (running && Object.keys(sent).length && !document.hidden) backend.watchSet(sent).catch((error) => uiLog("warn", "watch-set-failed", { what: "follow", msg: String(error) }));
  }

  /** Calls handler with every message of a kind, starting with the last one if any. */
  function on(kind, handler) {
    (listeners[kind] ||= new Set()).add(handler);
    if (latest[kind]) handler(latest[kind]);
    return () => listeners[kind].delete(handler);
  }

  /** Everything again, now: after an action whose result should show at once. */
  function poke() {
    if (running) backend.watchSet({ poke: true }).catch(sent("poke"));
  }

  /** Whether a message answers what is followed now (one for the previous may come late). */
  function current(message) {
    return canon(message.for) === canon(want[message.kind]);
  }

  /** A conversation deleted ({path}) or a Pi stopped ({slot}): out of the lists now, and the
   *  VM asked again at once. */
  function forget({ path, slot }) {
    if (path) gone.set(path, Date.now());
    if (slot) gone.set(slot, Date.now());
    if (raw.conversations) dispatch(shown(raw.conversations));
    poke();
  }

  return { start, stop, follow, on, poke, forget, current, latest: (kind) => latest[kind] };
})();
