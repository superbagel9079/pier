// Pier's Pi extension: every tool call that is not a genuine built-in read-only tool waits for an approval in Pier.
// Embedded in the Pier binary and loaded with `-e`; Pier only reports "Supervisé" while this extension is active.

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Built-in tools that only read. Skipped only when they are still Pi's own (an extension can replace one by name).
const READ_ONLY = new Set(["read", "grep", "find", "ls"]);
// Shell tools: their paths can only be guessed from the command text.
const SHELLS = new Set(["bash", "powershell"]);
// Pi auto-resolves the dialog to "not confirmed" after this; Pier shows the countdown.
const TIMEOUT_MS = 60_000;
// First line of the dialog message when a target is outside the working folder; Pier looks for this prefix.
const OUTSIDE = "⚠ Hors du dossier de travail";
// Shown when Pier cannot tell where a tool acts (MCP and extension tools).
const UNCHECKED = "ℹ Dossier non vérifié pour cet outil";
// Shell paths that are not files the agent writes to.
const HARMLESS = new Set(["/dev/null", "nul", "NUL", "$null"]);
// Same set as Pi's own path normalization.
const UNICODE_SPACES = /[  -​  　﻿]/g;

function home(): string {
	return process.env.USERPROFILE ?? process.env.HOME ?? homedir();
}

function detail(toolName: string, input: Record<string, unknown>): string {
	// The whole text, never cut: a harmless start must not hide the end.
	if (SHELLS.has(toolName) && typeof input.command === "string") return input.command;
	if (typeof input.path === "string") return input.path;
	return JSON.stringify(input, null, 2);
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
	if (typeof input.path === "string") return isOutside(cwd, input.path) ? [input.path] : [];
	return null;
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
		ctx.ui.setStatus("pier-supervision", "Supervisé");
	});

	pi.on("session_shutdown", async (_event: any, ctx: any) => {
		ctx.ui.setStatus("pier-supervision", undefined);
	});

	pi.on("tool_call", async (event: any, ctx: any) => {
		try {
			if (READ_ONLY.has(event.toolName) && isBuiltin(pi, event.toolName)) return undefined;
			const input = event.input ?? {};
			let message = detail(event.toolName, input);
			const outside = outsideTargets(event.toolName, input, ctx.cwd);
			if (outside === null) {
				message = `${UNCHECKED}\n${message}`;
			} else if (outside.length > 0) {
				const how = SHELLS.has(event.toolName) ? " (possiblement, d'après la commande)" : "";
				message = `${OUTSIDE}${how} : ${outside.join(", ")}\n${message}`;
			}
			const ok = await ctx.ui.confirm(`Autoriser ${event.toolName} ?`, message, { timeout: TIMEOUT_MS });
			if (ok !== true) return { block: true, reason: "Refusé dans Pier (ou délai expiré)" };
			deepFreeze(input);
			return undefined;
		} catch (e) {
			// Fail closed: no decision means no execution.
			return { block: true, reason: `Approbation impossible : ${e}` };
		}
	});
}
