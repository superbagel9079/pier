// Self-check of pier-approvals.ts: `node --experimental-strip-types extension/check.mjs` (Node 22+).
// Drives the extension's tool_call handler with a fake Pi and prints what the approval dialog would say.
const mod = await import(new URL("./pier-approvals.ts", import.meta.url));
const handlers = {};
mod.default({ on: (name, fn) => (handlers[name] = fn) });
const cwd = String.raw`C:\Users\leo\Downloads\brainstorming`;
const cases = [
  ["write", { path: "notes.txt" }, false],
  ["write", { path: String.raw`sub\dir\x.txt` }, false],
  ["write", { path: String.raw`..\outside.txt` }, true],
  ["edit", { path: String.raw`C:\Windows\win.ini` }, true],
  ["write", { path: String.raw`D:\x.txt` }, true],
  ["write", { path: cwd + String.raw`\inside.txt` }, false],
  ["write", { path: String.raw`c:\users\leo\downloads\brainstorming\lower.txt` }, false],
  ["bash", { command: "ls -la 2>/dev/null" }, false],
  ["bash", { command: "cat ../secret > out.txt" }, true],
  ["bash", { command: "rm -rf /c/Users/leo/Documents" }, true],
  ["bash", { command: "cp a.txt ~/b.txt" }, true],
  ["bash", { command: "echo hi > ./pier/x.txt" }, false],
  ["bash", { command: "ls /c/Users/leo/Downloads/brainstorming/pier" }, false],
];
let bad = 0;
for (const [toolName, input, expect] of cases) {
  let message = "";
  const ctx = { cwd, ui: { confirm: async (_t, m) => { message = m; return false; } } };
  const r = await handlers.tool_call({ toolName, input }, ctx);
  const warned = message.startsWith("⚠ Hors du dossier de travail");
  const ok = warned === expect && r?.block === true;
  if (!ok) bad++;
  console.log(ok ? "ok  " : "FAIL", toolName, JSON.stringify(input), "->", message.split("\n")[0]);
}
process.exit(bad);
