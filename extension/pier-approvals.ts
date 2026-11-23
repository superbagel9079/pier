// Pier's Pi extension: every tool call that is not known read-only waits for an approval in Pier.
// Embedded in the Pier binary and loaded with `-e`; Pier only reports "Supervisé" once session_start has run.

import { isAbsolute, relative, resolve } from "node:path";

// Built-in tools that only read. Anything else (bash, write, edit, MCP and extension tools) asks.
const READ_ONLY = new Set(["read", "grep", "find", "ls"]);
// Pi auto-resolves the dialog to "not confirmed" after this; Pier shows the countdown.
const TIMEOUT_MS = 60_000;
const MAX_DETAIL = 2000;
// First line of the dialog message when a target is outside the working folder; Pier looks for this prefix.
const OUTSIDE = "⚠ Hors du dossier de travail";
// Shell paths that are not files the agent writes to.
const HARMLESS = new Set(["/dev/null", "nul", "NUL"]);

function detail(toolName: string, input: Record<string, unknown>): string {
	const text =
		toolName === "bash" && typeof input.command === "string"
			? input.command
			: typeof input.path === "string"
				? input.path
				: JSON.stringify(input);
	return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
}

/** Git Bash spells C:\x as /c/x; node's resolve would read it as a folder of the current drive. */
function nativePath(p: string): string {
	const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
	return m ? `${m[1]}:${m[2] ?? "/"}` : p;
}

function isOutside(cwd: string, target: string): boolean {
	const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
	const expanded = target.startsWith("~") ? home + target.slice(1) : nativePath(target);
	const rel = relative(resolve(cwd), resolve(cwd, expanded));
	// Different drive gives an absolute `rel`; a parent gives a leading "..".
	return rel === ".." || rel.startsWith("../") ||rel.startsWith("..\\") || isAbsolute(rel);
}

/** Words of a shell command that look like paths. A heuristic: a warning, never a guarantee. */
function bashPaths(command: string): string[] {
	return command
		.split(/[\s;|&<>()'"`=]+/)
		.filter((w) => w && !HARMLESS.has(w))
		.filter((w) => w.startsWith("/") || w.startsWith("~") || /^[a-zA-Z]:[\\/]/.test(w) || w.split(/[\\/]/).includes(".."));
}

function outsideTargets(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
	if (toolName === "bash" && typeof input.command === "string") {
		return bashPaths(input.command).filter((p) => isOutside(cwd, p));
	}
	if (typeof input.path === "string" && isOutside(cwd, input.path)) return [input.path];
	return [];
}

export default function (pi: any) {
	pi.on("session_start", async (_event: any, ctx: any) => {
		ctx.ui.setStatus("pier-supervision", "Supervisé");
	});

	pi.on("tool_call", async (event: any, ctx: any) => {
		if (READ_ONLY.has(event.toolName)) return undefined;
		try {
			const input = event.input ?? {};
			let message = detail(event.toolName, input);
			const outside = outsideTargets(event.toolName, input, ctx.cwd);
			if (outside.length > 0) {
				const how = event.toolName === "bash" ? " (possiblement, d'après la commande)" : "";
				message = `${OUTSIDE}${how} : ${outside.join(", ")}\n${message}`;
			}
			const ok = await ctx.ui.confirm(`Autoriser ${event.toolName} ?`, message, { timeout: TIMEOUT_MS });
			return ok === true ? undefined : { block: true, reason: "Refusé dans Pier (ou délai expiré)" };
		} catch (e) {
			// Fail closed: no decision means no execution.
			return { block: true, reason: `Approbation impossible : ${e}` };
		}
	});
}
