// A stand-in for the Rust side, so that the interface can be tried in a browser:
// open index.html outside Pier and log in with the password "demo".

function mockBackend() {
  let saved = null;
  let mockClipboard = "";
  let trusted = false;
  let pickerVersion = "3.8"; // the demo's VM has an old picker: Pier updates it
  const logLines = [];
  const logListeners = [];
  const mockLog = (level, event, fields = {}) => {
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${event}${Object.entries(fields).map(([k, v]) => ` ${k}=${/^[^\s"=\\]+$/.test(String(v)) ? v : JSON.stringify(String(v))}`).join("")}`;
    logLines.push(line);
    for (const listener of logListeners) listener(line);
  };
  mockLog("info", "app.start", { version: "0.2.0", os: "browser", picker: "3.9" });
  const now = Date.now() / 1000;
  const point = (minutes, reason, label, prompts = []) => ({ id: String(Math.round((now - minutes * 60) * 1e9)), at: now - minutes * 60, reason, label, prompts, session: "s.jsonl", skipped: 0, tree: "t" });
  // Two Pis in ~/work, each in its own conversation.
  const SESSIONS = "/home/leo/.pi/agent/sessions/--home-leo-work--";
  let mockPis = [
    { slot: "pi-work-1a2b3c", n: 1, file: `${SESSIONS}/b.jsonl`, attached: true, last_attached: 2 },
    { slot: "pi-work-1a2b3c-2", n: 2, file: `${SESSIONS}/a.jsonl`, attached: false, last_attached: 1 },
  ];
  const pisNow = () => mockPis.map((pi) => ({ ...pi, working: pi.n === 1 && tick % 2 === 1 }));
  // The watch: the same answers as the API, sent when they change.
  let want = {};
  let sentKinds = {};
  let watching = null;
  const vmListeners = [];
  async function watchTick(self) {
    const parts = {
      projects: () => self.api(["projects"]),
      contexts: () => self.api(["contexts"]),
      activity: () => self.api(["activity", want.activity.project, want.activity.file || ""]),
      setup: () => self.api(["setup", want.setup]),
      checkpoints: () => self.api(["checkpoints", want.checkpoints]),
      conversations: () => self.api(["conversations"]),
    };
    for (const [kind, make] of Object.entries(parts)) {
      if (!want[kind]) continue;
      let message;
      try { message = { kind, for: want[kind], data: await make() }; } catch (error) { message = { kind, for: want[kind], error: String(error) }; }
      const text = JSON.stringify(message);
      if (sentKinds[kind] === text) continue;
      sentKinds[kind] = text;
      for (const listener of vmListeners) listener(structuredClone(message));
    }
  }
  let checkpoints = [
    point(2, "idle", "Pi finished working"),
    point(9, "prompt", "now add tests for the parser", ["now add tests for the parser"]),
    point(31, "prompt", "rewrite main.rs to use the new API", ["rewrite main.rs to use the new API", "read the code first"]),
    point(48, "start", "Pi started"),
  ];
  let shares = [];
  let kept = [];
  let handed = [];
  const mockLabels = {};
  const labelOf = (path) => ({ title: mockLabels[path]?.title || null, category: mockLabels[path]?.category || null,
    pinned: Boolean(mockLabels[path]?.pinned), archived: Boolean(mockLabels[path]?.archived) });
  const today = new Date().toISOString().slice(0, 10);
  const mockUsage = (turns, cost, tokens) => ({ turns, cost, input: tokens * 0.7, output: tokens * 0.1, cacheRead: tokens * 0.2, cacheWrite: 0,
    days: { [today]: [tokens / 2, cost / 2], "2026-01-01": [tokens / 2, cost / 2] } });
  const setupTexts = {
    instructions: { path: "/home/leo/work/AGENTS.md", name: "AGENTS.md", exists: true, text: "## Project\nA blog in Astro.\n\n## Commands\n- Test: `npm test`\n", history: [{ path: "/h/1", at: 1791800000, text: "## Project\nA blog.\n" }] },
    append: { path: "/home/leo/work/.pi/APPEND_SYSTEM.md", name: ".pi/APPEND_SYSTEM.md", exists: false, text: "", history: [], global: false },
    system: { path: "/home/leo/work/.pi/SYSTEM.md", name: ".pi/SYSTEM.md", exists: false, text: "", history: [], global: false },
  };
  let nextTerm = 1;
  const given = { images: [{ name: "20261012-1432-ab12.png", path: "/home/leo/work/.pi-images/20261012-1432-ab12.png", size: 48213 }],
                  files: [{ name: "20261012-1433-rapport.pdf", path: "/home/leo/work/.pi-files/20261012-1433-rapport.pdf", size: 120400 }],
                  copies: [] };
  let tick = 0;
  const echoes = {};
  const files = {
    "/home/leo/work": [
      { name: ".pi-images", kind: "dir", hidden: true },
      { name: "src", kind: "dir" },
      { name: "Cargo.toml", kind: "file", size: 812 },
      { name: "README.md", kind: "file", size: 2048 },
      { name: "notes.md", kind: "file", size: 120 },
    ],
    "/home/leo/work/src": [{ name: "main.rs", kind: "file", size: 40960 }, { name: "lib.rs", kind: "file", size: 9100 }],
  };
  return {
    loadSettings: async () => saved,
    saveSettings: async (s) => { saved = s; },
    async connect(pw) {
      await new Promise((r) => setTimeout(r, 200));
      if (pw !== "demo") throw "Password refused (demo: \"demo\")";
      if (!trusted) return { status: "unknown_host", which: "target", host: `${saved.host}:${saved.port}`, fingerprint: "SHA256:q3nT0bWcmXq6Zf2m8h0w5Yb4mJ9q1sQ7xK2pL5vR8eA" };
      mockLog("info", "ssh.connected", { ms: 212 });
      if (pickerVersion !== "3.9") return { status: "picker_outdated", remote: pickerVersion, remote_api: 7, bundled: "3.9", command: saved.remote_command, installable: true };
      return { status: "connected", bundled: "3.9" };
    },
    async installPicker() {
      await new Promise((r) => setTimeout(r, 400));
      mockLog("info", "picker.installed", { req: "d3mo-1", version: "3.9", path: "/home/leo/bin/pi-pick", ms: 380 });
      pickerVersion = "3.9";
      return { status: "connected", bundled: "3.9" };
    },
    pickerInfo: async () => ({ remote: { version: pickerVersion, api: pickerVersion === "3.9" ? 8 : 7 }, bundled: "3.9", api: 8, command: saved?.remote_command || "~/bin/pi-pick", installable: true }),
    log: async (level, event, fields) => { mockLog(level, `ui.${event}`, fields); },
    logTail: async (lines) => logLines.slice(-lines),
    logInfo: async () => ({ path: "C:\\Users\\leo\\AppData\\Local\\app.devbox.client\\logs\\pier.log", debug: prefs.debugLogs }),
    setLogLevel: async () => {},
    openLogFolder: async () => {},
    report: async (extra) => `Pier diagnostic report (demo)\n${extra}\n--- Pier log ---\n${logLines.join("\n")}`,
    copyText: async (text) => { mockClipboard = text; },
    clipboardText: async () => mockClipboard,
    saveText: async () => {},
    pickSavePath: async (name) => `C:\\Users\\leo\\Desktop\\${name}`,
    onLogLine(handler) { logListeners.push(handler); return () => logListeners.splice(logListeners.indexOf(handler), 1); },
    async checkpointCreate(project, label) {
      checkpoints.unshift(point(0, "manual", label || "saved by you"));
      mockLog("info", "vm.checkpoint", { req: "d3mo-2", ms: 140 });
      return { id: checkpoints[0].id, skipped: [] };
    },
    async checkpointRestore(project, id, files) {
      if (tick % 2 === 1) throw "Pi is working in this project: wait until it stops (or press Escape in Pi), then restore";
      checkpoints.unshift(point(0, "before-restore", "before going back"));
      mockLog("info", "vm.restore", { req: "d3mo-3", ms: 320, args: `${project} ${id} ${files.join(" ")}` });
      return { restored: files.length || 2, removed: files.length ? 0 : 1, safety: checkpoints[0].id };
    },
    trustHost: async () => { trusted = true; },
    disconnect: async () => {},
    async api(args) {
      if (args[0] === "projects") {
        const pis = pisNow();
        const work = { path: "/home/leo/work", label: "~/work", running: pis.length > 0, working: pis.some((p) => p.working), pis };
        return { running: pis.length ? [work] : [], recent: [work] };
      }
      if (args[0] === "diff") {
        return {
          file: args[1], project: args[2], untracked: false,
          diff: "diff --git a/src/main.rs b/src/main.rs\n@@ -1,3 +1,4 @@\n fn main() {\n-    println!(\"hi\");\n+    println!(\"hello\");\n+    run();\n }\n",
          edits: [{ tool: "edit", at: "2026-10-12T10:00:00Z", state: "done", changes: [{ old: "    println!(\"hi\");", new: "    println!(\"hello\");\n    run();" }] }],
        };
      }
      if (args[0] === "ls") {
        const dir = args[1];
        return { entries: (files[dir] || []).map((e) => ({ size: 0, hidden: false, ...e, path: `${dir}/${e.name}` })), truncated: false };
      }
      if (args[0] === "activity") {
        tick++;
        const busy = tick % 2 === 1;
        const pis = pisNow();
        const file = args[2] || pis[0]?.file || null;
        const second = file === `${SESSIONS}/a.jsonl`;
        return {
          session: "2026-10-12_demo.jsonl", working: busy && !second, pis, file,
          usage: { input: 48210, output: 6120, cacheRead: 120400, cacheWrite: 0, cost: 0.4213, turns: 3, model: "claude-sonnet-5-5" },
          files: {
            "src/main.rs": { state: busy ? "modifying" : "modified", reads: 1, edits: 2, at: "3" },
            "README.md": { state: "read", reads: 1, edits: 0, at: "1" },
            "Cargo.toml": { state: busy ? "reading" : "read", reads: busy ? 0 : 1, edits: 0, at: "2" },
          },
          git: { "src/main.rs": "M", "notes.md": "??" },
          events: [
            { tool: "edit", target: "src/main.rs", state: busy ? "running" : "done", at: "3" },
            { tool: "bash", target: "cargo test", state: "done", at: "2" },
            { tool: "read", target: "README.md", state: "done", at: "1" },
          ],
        };
      }
      if (args[0] === "type") return { typed: true };
      if (args[0] === "checkpoints") return { project: args[1], enabled: true, git: true, points: checkpoints, keep: 50 };
      if (args[0] === "checkpoint-diff") {
        const changes = [{ path: "src/main.rs", change: "modified" }, { path: "src/parser_test.rs", change: "created" }, { path: "notes.md", change: "deleted" }];
        return { project: args[1], id: args[2], label: "before", reason: "prompt", changes, total: changes.length, file: args[3] || null,
          diff: args[3] ? "diff --git a/src/main.rs b/src/main.rs\n@@ -1,3 +1,4 @@\n fn main() {\n-    println!(\"hi\");\n+    println!(\"hello\");\n+    run();\n }\n" : null };
      }
      if (args[0] === "log") {
        return { path: "/home/leo/.local/state/pi-dir-picker/picker.log", lines: [
          "2026-10-12T14:01:02.120Z INFO  pi.start pid=812 project=/home/leo/work sandbox=True args=[] pi=/home/leo/.npm-global/bin/pi",
          "2026-10-12T14:01:02.410Z INFO  checkpoint.create pid=812 project=/home/leo/work id=01791813662410000000 reason=start replaced=False ms=180",
          "2026-10-12T14:09:40.002Z WARN  api.share-prepare pid=990 req=d3mo-4 ms=12 err=\"sshfs is missing on the VM: sudo apt install sshfs\" args=\"[\\\"docs\\\"]\"",
          "2026-10-12T14:12:13.551Z ERROR api.activity pid=1002 req=d3mo-5 ms=33 err=\"KeyError: 'path'\"",
          "    Traceback (most recent call last):",
          "      File \"/home/leo/bin/pi-pick\", line 2012, in run_api",
          "    KeyError: 'path'",
          `${new Date().toISOString()} INFO  checkpoint.create pid=812 project=/home/leo/work id=1 reason=idle replaced=False ms=95`,
        ] };
      }
      if (args[0] === "setup") {
        return {
          project: args[1], label: "~/work", running: mockPis.length > 0, pis: pisNow(), interrupted: null, trusted: null,
          startup: [{ path: "/home/leo/.pi/agent/AGENTS.md", label: "~/.pi/agent/AGENTS.md", scope: "global", size: 1200 }, { path: "/home/leo/work/AGENTS.md", label: "~/work/AGENTS.md", scope: "project", size: 420 }],
          texts: structuredClone(setupTexts),
          conversations: 17,
          resources: { pi: { version: "1.1.0", latest: "1.2.0" },
            packages: [{ source: "npm:pi-hindsight", scope: "user", version: "0.4.2", latest: "0.5.0", description: "Long-term memory for Pi", installed: true }],
            extensions: [], skills: [{ name: "release-notes", scope: "project", from: "~/work/.pi/skills" }], prompts: [],
            mcp: [{ name: "github", scope: "user", from: "~/.pi/agent/mcp.json", kind: "http", enabled: true, description: "Issues and pull requests" }],
            model: { defaultProvider: "bifrost", defaultModel: "openrouter/anthropic/claude-haiku-5.5", defaultThinkingLevel: "medium" } },
          sessions: [
            { path: `${SESSIONS}/b.jsonl`, modified: 1791800000, name: null, prompt: "Write the release notes for 2.0", usage: mockUsage(4, 0, 182000) },
            { path: `${SESSIONS}/a.jsonl`, modified: 1791720000, name: "Dark mode", prompt: "Add a dark mode", usage: mockUsage(12, 0, 920000) },
            { path: `${SESSIONS}/c.jsonl`, modified: 1791600000, name: null, prompt: "Fix the RSS feed", usage: mockUsage(3, 0.12, 40000) },
            ...Array.from({ length: 14 }, (_, i) => ({ path: `${SESSIONS}/old${i}.jsonl`, modified: 1791000000 - i * 90000, name: null,
              prompt: `An older question number ${i + 1}`, usage: mockUsage(2, 0, 5000) })),
          ].map((session) => ({ ...session, slot: mockPis.find((p) => p.file === session.path)?.slot || null,
            ...labelOf(session.path) })),
        };
      }
      if (args[0] === "conversations") {
        const setup = await this.api(["setup", "/home/leo/work"]);
        const now = Date.now() / 1000;
        const blog = ["Write the about page", "Fix the RSS feed dates", "Add tags to posts"].map((prompt, i) => ({
          path: `/home/leo/.pi/agent/sessions/--home-leo-clients-blog--/b${i}.jsonl`, modified: now - i * 3600 * 30, name: null, prompt,
          slot: null, working: false, ...labelOf(`/home/leo/.pi/agent/sessions/--home-leo-clients-blog--/b${i}.jsonl`) }));
        return { truncated: false, projects: [
          { project: "/home/leo/work", label: "~/work", running: mockPis.length, modified: now, pis: pisNow(), interrupted: null,
            sessions: setup.sessions.map((x) => ({ ...x, working: false })) },
          { project: "/home/leo/clients/blog", label: "~/clients/blog", running: 0, modified: now - 3600, pis: [],
            interrupted: blog[0].path, sessions: blog },
        ] };
      }
      if (args[0] === "contexts") {
        return { sshfs: true, contexts: [
          { project: "/home/leo/work", label: "~/work", running: true, ...structuredClone(given), shares: structuredClone(handed) },
          { project: "/home/leo/clients/blog", label: "~/clients/blog", running: false, images: [], files: [{ name: "brief.txt", path: "/home/leo/clients/blog/.pi-files/brief.txt", size: 900 }], copies: [], shares: [] },
        ] };
      }
      throw `mock: ${args[0]}`;
    },
    pasteImage: async () => ({ label: "~/work", saved: "/home/leo/work/.pi-images/a.png", reference: "@.pi-images/20261012-1432-ab12.png", typed: true, running: true }),
    pasteFiles: async (paths) => paths.map((p) => {
      const name = p.split(/[\\/]/).pop();
      if (!name.includes(".")) return { folder: p }; // the demo calls anything without an extension a folder
      const saved = `/home/leo/work/.pi-files/20261012-1433-${name}`;
      given.files.push({ name: `20261012-1433-${name}`, path: saved, size: 1000 });
      return { label: "~/work", saved, reference: `@.pi-files/20261012-1433-${name}`, typed: true, running: true };
    }),
    async copyFolder(path) {
      const name = `20261012-1500-${path.split(/[\\/]/).pop()}`;
      given.copies.push({ name, path: `/home/leo/work/.pi-files/${name}`, size: 52000, count: 12 });
      return { label: "~/work", reference: `.pi-files/${name}/`, count: 12, typed: true };
    },
    async clearProject() { given.images = []; given.files = []; given.copies = []; return { removed: [] }; },
    rememberedShares: async () => kept,
    async forgetShare(local, project) { kept = kept.filter((k) => !(k.local === local && k.project === project)); },
    clipboardPaths: async () => [],
    async writeText(project, which, text) { setupTexts[which].text = text; setupTexts[which].exists = true; return { saved: which }; },
    async handOff(id) {
      const share = shares.find((s) => s.id === id);
      shares = shares.filter((s) => s.id !== id);
      handed.push({ name: share.relative.split("/").pop(), mountpoint: `/home/leo/work/${share.relative}`, relative: share.relative, mounted: false, handed_off: share.writable ? "rw" : "ro" });
      return { mountpoint: share.mountpoint, count: 12 };
    },
    downloadCopy: async (path, local) => `${local} (from Pi)`,
    takebackCompare: async () => ({
      changed: [{ rel: "index.html", size_pc: 1200, size_vm: 1350 }, { rel: "css/site.css", size_pc: 800, size_vm: 790 }],
      added: [{ rel: "js/menu.js", size_pc: null, size_vm: 420 }],
      deleted: [{ rel: "old/draft.txt", size_pc: 90, size_vm: null }],
      same: 31, links: [], truncated: false,
    }),
    takebackDiff: async (path, local, rel) => ({ rel, diff: `--- PC/${rel}
+++ Pi/${rel}
@@ -1,3 +1,3 @@
 <header>
-  <h1>Mockups</h1>
+  <h1>Mockups, revised</h1>
 </header>
` }),
    takebackApply: async (path, local, take, remove) => ({ taken: take, deleted: remove, skipped: [], backup: take.length || remove.length ? `${local} (before Pi's changes 2026-10-16 10-32)` : null }),
    async removeUpload(path) {
      for (const key of ["images", "files", "copies"]) given[key] = given[key].filter((i) => i.path !== path);
      handed = handed.filter((h) => h.mountpoint !== path);
      return { removed: path };
    },
    notify: async (title, body) => { console.log("notification:", title, body); },
    setShortcut: async () => {},
    async termOpen(kind, cols, rows, onBytes) {
      const id = nextTerm++;
      echoes[id] = onBytes;
      setTimeout(() => onBytes(new TextEncoder().encode(`demo: ${kind} terminal ${cols}x${rows}\r\n$ `)), 50);
      return id;
    },
    termWrite(id, data) { echoes[id]?.(new TextEncoder().encode(data === "\r" ? "\r\n$ " : data)); },
    termResize() {},
    termClose() {},
    async shareStart(path, writable) {
      const share = { id: shares.length + 1, local: path, mountpoint: "/home/leo/work/.pi-shared/x", relative: `.pi-shared/${path.split(/[\\/]/).pop()}`, project: "/home/leo/work", label: "~/work", writable };
      shares.push(share);
      kept = kept.filter((k) => k.local !== path).concat([{ local: path, project: share.project, label: share.label, relative: share.relative, writable }]);
      return share;
    },
    async shareStop(id, forget = true) {
      const share = shares.find((s) => s.id === id);
      shares = shares.filter((s) => s.id !== id);
      if (share && forget) kept = kept.filter((k) => k.local !== share.local);
    },
    shareList: async () => shares,
    pickFolder: async () => "C:\\Users\\leo\\Documents\\mockups",
    pickFiles: async () => ["C:\\Users\\leo\\Documents\\notes.pdf"],
    onDragDrop() {},
    onClipboardSent() {},
    onConnectionLost() {},
    onConnectionRetrying() {},
    onConnectionBack() {},
    sharesCleanup: async () => {},
    onTermExit() {},
    async watchStart(initial) {
      want = { ...initial };
      sentKinds = {};
      clearInterval(watching);
      watching = setInterval(() => watchTick(this), 1500);
      watchTick(this);
      return 1;
    },
    async watchSet(changes) {
      if (changes.poke) sentKinds = {};
      for (const [kind, value] of Object.entries(changes)) {
        if (kind === "poke") continue;
        want[kind] = value;
        delete sentKinds[kind];
      }
      watchTick(this);
    },
    onVmUpdate(handler) { vmListeners.push(handler); },
    onWatchEnded() {},
    async sessionLabel(project, file, title, category) {
      mockLabels[file] = { ...mockLabels[file], title: title.trim() || null, category: category.trim() || null };
      mockLog("info", "vm.label", { args: `${file} ${category}` });
      return { file, title, category };
    },
    shortcutStatus: async () => false,
    async sessionMark(project, file, what, on) {
      mockLabels[file] = { ...mockLabels[file], [what]: on, ...(what === "archived" && on ? { pinned: false } : {}) };
      mockLog("info", "vm.mark", { args: `${file} ${what} ${on}` });
      return { file, [what]: on };
    },
    async stopPi(project, slot) {
      mockPis = mockPis.filter((pi) => slot && pi.slot !== slot);
      mockLog("info", "vm.stop", { args: `${project} ${slot || ""}` });
      return { stopped: 1 };
    },
  };
}
