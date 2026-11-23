// Self-check of pier-approvals.ts: `node --experimental-strip-types extension/check.mjs` (Node 22+).
// Drives the extension's handlers with a fake Pi and checks what the approval dialog would say and decide.
"use strict";
const mod = await import(new URL("./pier-approvals.ts", import.meta.url));
const handlers = {};
let toolSource = "builtin";
mod.default({
  on: (name, fn) => (handlers[name] = fn),
  getAllTools: () => ["read", "grep", "find", "ls", "bash", "write"].map((name) => ({ name, sourceInfo: { source: toolSource } })),
});
const cwd = String.raw`C:\Users\leo\Downloads\brainstorming`;
const OUT = "⚠ Hors du dossier de travail";
const UNCHECKED = "ℹ Dossier non vérifié pour cet outil";
let bad = 0;
const check = (ok, what) => {
  if (!ok) bad++;
  console.log(ok ? "ok  " : "FAIL", what);
};

// [tool, input, expected first line kind: "out" | "in" | "unchecked"]
const cases = [
  ["write", { path: "notes.txt" }, "in"],
  ["write", { path: String.raw`sub\dir\x.txt` }, "in"],
  ["write", { path: String.raw`..\outside.txt` }, "out"],
  ["edit", { path: String.raw`C:\Windows\win.ini` }, "out"],
  ["write", { path: String.raw`D:\x.txt` }, "out"],
  ["write", { path: cwd + String.raw`\inside.txt` }, "in"],
  ["write", { path: String.raw`c:\users\leo\downloads\brainstorming\lower.txt` }, "in"],
  ["write", { path: "@C:/Users/leo/.ssh/authorized_keys" }, "out"],
  ["write", { path: "@notes.txt" }, "in"],
  ["write", { path: "file:///C:/Windows/x.txt" }, "out"],
  ["write", { path: "/mnt/c/Windows/x.txt" }, "out"],
  ["write", { path: String.raw`\\server\share\x.txt` }, "out"],
  ["write", { path: "~/x.txt" }, "out"],
  ["bash", { command: "ls -la 2>/dev/null" }, "in"],
  ["bash", { command: "cat ../secret > out.txt" }, "out"],
  ["bash", { command: "rm -rf /c/Users/leo/Documents" }, "out"],
  ["bash", { command: "cp a.txt ~/b.txt" }, "out"],
  ["bash", { command: "cp a.txt $HOME/b.txt" }, "out"],
  ["bash", { command: "echo hi > ./pier/x.txt" }, "in"],
  ["bash", { command: "ls /c/Users/leo/Downloads/brainstorming/pier" }, "in"],
  ["powershell", { command: String.raw`Remove-Item $env:USERPROFILE\Documents -Recurse` }, "out"],
  ["powershell", { command: String.raw`Copy-Item a.txt %USERPROFILE%\b.txt` }, "out"],
  ["powershell", { command: "Get-ChildItem . > $null" }, "in"],
  ["mcp__github__create_issue", { title: "x" }, "unchecked"],
];

async function call(toolName, input, answer = false) {
  let title = null;
  let message = "";
  const ctx = {
    cwd,
    ui: {
      confirm: async (t, m) => {
        title = t;
        message = m;
        return answer;
      },
    },
  };
  const result = await handlers.tool_call({ toolName, input }, ctx);
  return { title, message, result };
}

for (const [tool, input, expect] of cases) {
  const { message, result } = await call(tool, input);
  const first = message.split("\n")[0];
  const kind = first.startsWith(OUT) ? "out" : first === UNCHECKED ? "unchecked" : "in";
  check(kind === expect && result?.block === true, `${tool} ${JSON.stringify(input)} -> ${kind} (${first})`);
}

// Genuine read-only built-ins pass without a dialog; a replaced one asks.
let r = await call("read", { path: "x" });
check(r.title === null && r.result === undefined, "built-in read: no dialog");
toolSource = "extension";
r = await call("read", { path: "x" });
check(r.title === "Autoriser read ?" && r.result?.block === true, "read replaced by an extension: asks");
toolSource = "builtin";

// The whole command is shown, however long.
const long = "echo " + "a".repeat(3000) + " ; rm -rf important";
r = await call("bash", { command: long });
check(r.message.endsWith("rm -rf important"), "a 3000-character command is shown whole");

// After approval, a later handler cannot change what runs.
const input = { command: "ls" };
r = await call("bash", input, true);
check(r.result === undefined, "approved call runs");
let mutated = true;
try {
  input.command = "rm -rf /";
  mutated = input.command !== "ls";
} catch {
  mutated = false;
}
check(!mutated, "approved input is frozen");

// A thrown error blocks (fail closed).
const boom = await handlers.tool_call({ toolName: "bash", input: { command: "x" } }, { cwd, ui: { confirm: async () => { throw new Error("ui gone"); } } });
check(boom?.block === true, "an error in the dialog blocks the call");

// Supervision status is set on start and removed on shutdown.
const statuses = [];
const sctx = { ui: { setStatus: (k, v) => statuses.push([k, v]) } };
await handlers.session_start({}, sctx);
await handlers.session_shutdown({}, sctx);
check(JSON.stringify(statuses) === JSON.stringify([["pier-supervision", "Supervisé"], ["pier-supervision", null]]) || (statuses[1]?.[1] === undefined && statuses[0][1] === "Supervisé"), "Supervisé set on start, cleared on shutdown");

console.log(bad === 0 ? "all checks passed" : `${bad} check(s) failed`);
process.exit(bad);
