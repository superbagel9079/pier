// Self-check of pier-approvals.ts: `node --experimental-strip-types extension/check.mjs` (Node 22+).
// Drives the extension's handlers with a fake Pi and checks what the approval dialog would say and decide.
"use strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Inside Pi, `@earendil-works/pi-coding-agent` maps to Pi's own copy. Here, point it at the installed Pi (newest release).
const releases = join(process.env.USERPROFILE ?? homedir(), ".pi/agent/install/releases");
const pkg = (existsSync(releases) ? readdirSync(releases) : [])
  .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  .map((v) => join(releases, v, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"))
  .find(existsSync);
if (!pkg) {
  console.log("FAIL Pi install not found under", releases);
  process.exit(1);
}
const piUrl = JSON.stringify(pathToFileURL(pkg).href);
register(
  "data:text/javascript," +
    encodeURIComponent(
      `export async function resolve(s, c, next) { return s === "@earendil-works/pi-coding-agent" ? { url: ${piUrl}, shortCircuit: true } : next(s, c); }`,
    ),
);

const mod = await import(new URL("./pier-approvals.ts", import.meta.url));
const handlers = {};
let toolSource = "builtin";
mod.default({
  on: (name, fn) => (handlers[name] = fn),
  getAllTools: () => ["read", "grep", "find", "ls", "bash", "write"].map((name) => ({ name, sourceInfo: { source: toolSource } })),
});
const cwd = String.raw`C:\Users\leo\Downloads\brainstorming`;
const OUT = "⚠ Outside the working folder";
const UNCHECKED = "ℹ Folder not checked for this tool";
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
check(r.title === "Allow read?" && r.result?.block === true, "read replaced by an extension: asks");
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

// Diff previews for write and edit, in a throwaway folder.
const MARK = "⟦planned changes⟧";
const work = mkdtempSync(join(tmpdir(), "pier-check-"));
const inWork = async (toolName, input) => {
  let message = "";
  await handlers.tool_call({ toolName, input }, { cwd: work, ui: { confirm: async (_t, m) => ((message = m), false) } });
  const [, diff = null] = message.split(`\n${MARK}\n`);
  return diff;
};
let d = await inWork("write", { path: "new.txt", content: "hello\nworld\n" });
check(d?.includes("+hello") && d.includes("+world"), "write, new file: every line added");
writeFileSync(join(work, "old.txt"), "a\nb\nc\n");
d = await inWork("write", { path: "old.txt", content: "a\nB\nc\n" });
check(d?.includes("-b") && d.includes("+B") && !d.includes("-a"), "write, existing file: only the changed line");
d = await inWork("write", { path: "old.txt", content: "a\nb\nc\n" });
check(d?.startsWith("(same content"), "write, same content: said so");
writeFileSync(join(work, "crlf.txt"), "one\r\ntwo\r\nthree\r\n");
d = await inWork("edit", { path: "crlf.txt", edits: [{ oldText: "two\n", newText: "TWO\n" }] });
check(d?.includes("-two") && d.includes("+TWO") && !d.includes("approximate"), "edit on a CRLF file: exact diff");
d = await inWork("edit", { path: "crlf.txt", oldText: "two", newText: "2" });
check(d?.includes("-two") && d.includes("+2") && !d.includes("approximate"), "edit, legacy oldText/newText: exact diff");
d = await inWork("edit", { path: "crlf.txt", edits: [{ oldText: "absent", newText: "x" }] });
check(d?.startsWith("(approximate preview") && d.includes("-absent") && d.includes("+x"), "edit, text not found: approximate, said so");
d = await inWork("write", { path: "big.txt", content: Array.from({ length: 4000 }, (_, i) => `l${i}`).join("\n") });
check(d?.includes("preview cut") && d.includes("lines not shown"), "a 4000-line diff is cut and says so");
d = await inWork("bash", { command: "ls" });
check(d === null, "bash: no diff preview");
rmSync(work, { recursive: true, force: true });

// Supervision status is set on start and removed on shutdown.
const statuses = [];
const sctx = { ui: { setStatus: (k, v) => statuses.push([k, v]) } };
await handlers.session_start({}, sctx);
await handlers.session_shutdown({}, sctx);
check(JSON.stringify(statuses) === JSON.stringify([["pier-supervision", "Supervised"], ["pier-supervision", null]]) || (statuses[1]?.[1] === undefined && statuses[0][1] === "Supervised"), "Supervisé set on start, cleared on shutdown");

console.log(bad === 0 ? "all checks passed" : `${bad} check(s) failed`);
process.exit(bad);
