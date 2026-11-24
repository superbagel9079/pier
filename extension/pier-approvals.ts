// Pier's Pi extension: every tool call that is not a genuine built-in read-only tool waits for an approval in Pier.
// Embedded in the Pier binary and loaded with `-e`; Pier only reports "Supervised" while this extension is active.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Built-in tools that only read. Skipped only when they are still Pi's own (an extension can replace one by name).
const READ_ONLY = new Set(["read", "grep", "find", "ls"]);
// Shell tools: their paths can only be guessed from the command text.
const SHELLS = new Set(["bash", "powershell"]);
// Pi auto-resolves the dialog to "not confirmed" after this; Pier shows the countdown.
const TIMEOUT_MS = 60_000;
// Version of the structured message Pier reads (the dialog message is this JSON, not decorated text).
const ENVELOPE_VERSION = 1;
// Shell paths that are not files the agent writes to.
const HARMLESS = new Set(["/dev/null", "nul", "NUL", "$null"]);
// Bigger files get no preview (they may be binary, and the dialog must stay responsive).
const PREVIEW_MAX_BYTES = 2_000_000;
// Pi's whole-file diff is synchronous and slows down sharply on large rewrites (3 s at 5000 lines, 63 s at 20000):
// past this many lines on either side, write gets no preview and edit is previewed around its changes only.
const DIFF_MAX_FILE_LINES = 2000;
// A longer diff is cut, and says so: the rest is not shown, never silently dropped.
const PREVIEW_MAX_LINES = 3000;
// Same set as Pi's own path normalization.
const UNICODE_SPACES = /[  -​  　﻿]/g;

function home(): string {
	return process.env.USERPROFILE ?? process.env.HOME ?? homedir();
}

/** What the user reads to decide. The whole text, never cut: a harmless start must not hide the end.
 *  The path alone only for a write/edit whose real diff is shown next to it; any other tool shows all its arguments. */
function detail(toolName: string, input: Record<string, unknown>, hasDiff: boolean): string {
	if (SHELLS.has(toolName) && typeof input.command === "string") return input.command;
	if ((toolName === "write" || toolName === "edit") && hasDiff && typeof input.path === "string") return input.path;
	return JSON.stringify(input, null, 2);
}

/** UNC shares and device paths (`\\server\x`, `\\.\pipe\x`, `//server/x`). Never touched on disk: probing one
 *  makes Windows connect to the share (and may send the user's credentials) before the user has decided. */
function isNetworkPath(p: string): boolean {
	return p.startsWith("\\\\") || p.startsWith("//");
}

/** Mirrors Pi's normalizePath (dist/utils/paths.js), plus home variables used in shells. */
function normalize(p: string): string {
	let n = p.trim().replace(UNICODE_SPACES, " ");
	if (n.startsWith("@")) n = n.slice(1);
	n = n.replace(/^(\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%|%HOME%)(?=$|[\\/])/i, "~");
	const drive = /^\/(?:mnt\/|cygdrive\/)?([a-zA-Z])(\/.*)?$/.exec(n); // Git Bash, MSYS, Cygwin, WSL
	if (drive && !n.startsWith("//")) n = `${drive[1].toUpperCase()}:${drive[2] ?? "/"}`;
	if (n === "~") return home();
	if (n.startsWith("~/") || n.startsWith("~\\")) return join(home(), n.slice(2));
	if (/^file:\/\//.test(n)) return fileURLToPath(n);
	return n;
}

/** Real location, following junctions and links through the part of the path that exists. */
function real(p: string): string {
	let head = p;
	const tail: string[] = [];
	while (!existsSync(head)) {
		const parent = dirname(head);
		if (parent === head) return p;
		tail.unshift(basename(head));
		head = parent;
	}
	try {
		return join(realpathSync.native(head), ...tail);
	} catch {
		return p;
	}
}

function isOutside(cwd: string, target: string): boolean {
	if (isNetworkPath(normalize(target))) return true; // outside by definition, and not probed
	const base = real(resolve(cwd));
	const rel = relative(base, real(resolve(base, normalize(target))));
	// Different drive or UNC share gives an absolute `rel`; a parent gives a leading "..".
	return rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel);
}

/** Words of a shell command that look like paths. A heuristic: a warning, never a guarantee. */
function shellPaths(command: string): string[] {
	return command
		.split(/[\s;|&<>()'"`=,]+/)
		.filter((w) => w && !HARMLESS.has(w))
		.filter(
			(w) =>
				w.startsWith("/") ||
				w.startsWith("\\\\") ||
				w.startsWith("~") ||
				w.startsWith("@") ||
				w.startsWith("file://") ||
				/^[a-zA-Z]:[\\/]/.test(w) ||
				/^(\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%|%HOME%)/i.test(w) ||
				w.split(/[\\/]/).includes(".."),
		);
}

/** `null` when the tool's targets cannot be checked at all. */
function outsideTargets(toolName: string, input: Record<string, unknown>, cwd: string): string[] | null {
	if (SHELLS.has(toolName) && typeof input.command === "string") {
		return shellPaths(input.command).filter((p) => isOutside(cwd, p));
	}
	// Only Pi's write/edit are known to act on `path`; another tool's `path` says nothing about what it does.
	if ((toolName === "write" || toolName === "edit") && typeof input.path === "string") {
		return isOutside(cwd, input.path) ? [input.path] : [];
	}
	return null;
}

type Patcher = (path: string, oldContent: string, newContent: string) => string;
let patcher: Promise<Patcher | null> | undefined;

/** Pi's own diff (the same format as the patch Pi reports after an edit). Inside Pi this import maps to Pi's copy. */
function loadPatcher(): Promise<Patcher | null> {
	patcher ??= import("@earendil-works/pi-coding-agent")
		.then((m: any) => (typeof m.generateUnifiedPatch === "function" ? m.generateUnifiedPatch : null))
		.catch(() => null);
	return patcher;
}

const lf = (text: string) => text.replaceAll("\r\n", "\n");

/** Current content of the target, `""` for a new file. Throws when it must not or cannot be previewed. */
function currentContent(cwd: string, path: string): string {
	const target = normalize(path);
	if (isNetworkPath(target)) throw new Error("network path, not read before your decision");
	const abs = resolve(cwd, target);
	if (!existsSync(abs)) return "";
	const stat = statSync(abs);
	if (!stat.isFile()) throw new Error("not a regular file");
	if (stat.size > PREVIEW_MAX_BYTES) throw new Error("file too big for a preview");
	return lf(readFileSync(abs, "utf8"));
}

const lineCount = (text: string) => text.split("\n").length;

/** Diff preview of a write or edit, or `null` for other tools. Never throws: a failed preview must not block the dialog. */
async function preview(toolName: string, input: Record<string, any>, cwd: string): Promise<string | null> {
	if (toolName !== "write" && toolName !== "edit") return null;
	if (typeof input.path !== "string") return null;
	try {
		const patch = await loadPatcher();
		if (!patch) return "(preview unavailable: Pi's diff not found)";
		const before = currentContent(cwd, input.path);
		if (toolName === "write") {
			if (typeof input.content !== "string") return null;
			const after = lf(input.content);
			if (after === before) return "(same content as the current file)";
			if (Math.max(lineCount(before), lineCount(after)) > DIFF_MAX_FILE_LINES) {
				return `(preview skipped: large file, ${lineCount(before)} → ${lineCount(after)} lines)`;
			}
			return cut(patch(input.path, before, after));
		}
		// edit: Pi's current argument shape is `edits[]`; the legacy one is a single oldText/newText.
		const edits: { oldText: string; newText: string }[] = Array.isArray(input.edits)
			? input.edits
			: typeof input.oldText === "string"
				? [{ oldText: input.oldText, newText: input.newText ?? "" }]
				: [];
		let after = before;
		const exact = edits.every((e) => {
			const old = lf(String(e.oldText));
			const at = after.indexOf(old);
			if (at < 0 || after.indexOf(old, at + 1) >= 0) return false; // missing or not unique: Pi will search fuzzily
			after = after.slice(0, at) + lf(String(e.newText)) + after.slice(at + old.length);
			return true;
		});
		const small = Math.max(lineCount(before), lineCount(after)) <= DIFF_MAX_FILE_LINES;
		if (exact && small) return cut(patch(input.path, before, after));
		const note = exact
			? "(preview around the changes only: the file is large)"
			: "(approximate preview: text to replace not found as is, Pi will search for it)";
		const parts = edits.map((e) => {
			const [o, n] = [lf(String(e.oldText)), lf(String(e.newText))];
			if (Math.max(lineCount(o), lineCount(n)) > DIFF_MAX_FILE_LINES) return `(one change of ${lineCount(o)} → ${lineCount(n)} lines not previewed)`;
			return patch(input.path, o, n);
		});
		return cut([note, ...parts].join("\n"));
	} catch (e) {
		return `(preview unavailable: ${e instanceof Error ? e.message : e})`;
	}
}

function cut(diff: string): string {
	const lines = diff.split("\n");
	if (lines.length <= PREVIEW_MAX_LINES) return diff;
	const hidden = lines.length - PREVIEW_MAX_LINES;
	return [...lines.slice(0, PREVIEW_MAX_LINES), `… preview cut: ${hidden} lines not shown`].join("\n");
}

/** After approval, nothing may change what runs: later `tool_call` handlers see the input but cannot mutate it. */
function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
	}
	return value;
}

/** Pi's own built-in, not an extension tool registered under the same name. */
function isBuiltin(pi: any, name: string): boolean {
	const tool = (pi.getAllTools?.() ?? []).find((t: any) => t.name === name);
	return tool?.sourceInfo?.source === "builtin";
}

export default function (pi: any) {
	pi.on("session_start", async (_event: any, ctx: any) => {
		ctx.ui.setStatus("pier-supervision", "Supervised");
	});

	pi.on("session_shutdown", async (_event: any, ctx: any) => {
		ctx.ui.setStatus("pier-supervision", undefined);
	});

	pi.on("tool_call", async (event: any, ctx: any) => {
		try {
			if (READ_ONLY.has(event.toolName) && isBuiltin(pi, event.toolName)) return undefined;
			const input = event.input ?? {};
			const diff = await preview(event.toolName, input, ctx.cwd);
			// Structured, so no text in a command (a marker, a fake warning line) can pass for something else.
			const message = JSON.stringify({
				pier: ENVELOPE_VERSION,
				tool: event.toolName,
				path: typeof input.path === "string" ? input.path : null,
				detail: detail(event.toolName, input, diff !== null && /^@@/m.test(diff)),
				// null: this tool's targets cannot be checked (MCP and extension tools).
				outside: outsideTargets(event.toolName, input, ctx.cwd),
				outsideGuessed: SHELLS.has(event.toolName),
				diff,
			});
			const ok = await ctx.ui.confirm(`Allow ${event.toolName}?`, message, { timeout: TIMEOUT_MS });
			if (ok !== true) return { block: true, reason: "Denied in Pier (or timed out)" };
			deepFreeze(input);
			return undefined;
		} catch (e) {
			// Fail closed: no decision means no execution.
			return { block: true, reason: `Approval failed: ${e}` };
		}
	});
}
