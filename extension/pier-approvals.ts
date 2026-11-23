// Pier's Pi extension: every tool call that is not known read-only waits for an approval in Pier.
// Embedded in the Pier binary and loaded with `-e`; Pier only reports "Supervisé" once session_start has run.

// Built-in tools that only read. Anything else (bash, write, edit, MCP and extension tools) asks.
const READ_ONLY = new Set(["read", "grep", "find", "ls"]);
// Pi auto-resolves the dialog to "not confirmed" after this; Pier shows the countdown.
const TIMEOUT_MS = 60_000;
const MAX_DETAIL = 2000;

function detail(toolName: string, input: Record<string, unknown>): string {
	const text =
		toolName === "bash" && typeof input.command === "string"
			? input.command
			: typeof input.path === "string"
				? input.path
				: JSON.stringify(input);
	return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
}

export default function (pi: any) {
	pi.on("session_start", async (_event: any, ctx: any) => {
		ctx.ui.setStatus("pier-supervision", "Supervisé");
	});

	pi.on("tool_call", async (event: any, ctx: any) => {
		if (READ_ONLY.has(event.toolName)) return undefined;
		try {
			const ok = await ctx.ui.confirm(`Autoriser ${event.toolName} ?`, detail(event.toolName, event.input ?? {}), {
				timeout: TIMEOUT_MS,
			});
			return ok === true ? undefined : { block: true, reason: "Refusé dans Pier (ou délai expiré)" };
		} catch (e) {
			// Fail closed: no decision means no execution.
			return { block: true, reason: `Approbation impossible : ${e}` };
		}
	});
}
