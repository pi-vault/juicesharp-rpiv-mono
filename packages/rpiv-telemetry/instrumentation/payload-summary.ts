import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const SUBAGENT_TYPE_PATTERN = /<active_agent\s+name="([^"]+)"\s*\/?>/;

/** Read the active sub-agent type from a Pi system prompt's `<active_agent name="..."/>` tag. */
export function detectSubAgentType(systemPrompt: string | undefined): string | undefined {
	if (!systemPrompt) return undefined;
	const m = SUBAGENT_TYPE_PATTERN.exec(systemPrompt);
	return m?.[1];
}

/**
 * Read the parent session ID from Pi's native lineage. `SessionHeader.parentSession`
 * is the parent session's file path (set by pi-subagents when it spawns the sub-agent's
 * session); Pi names session files by `<sessionId>.jsonl`, so the basename minus the
 * extension is the parent session ID. Returns undefined for user-facing parent sessions
 * that have no parent of their own.
 */
export function parentSessionIdFromCtx(ctx: ExtensionContext): string | undefined {
	const parentPath = ctx.sessionManager.getHeader()?.parentSession;
	if (!parentPath) return undefined;
	const base = parentPath.split(/[\\/]/).pop() ?? parentPath;
	return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

/**
 * Reduce a provider-shaped request body down to a small inspectable summary.
 * Duck-typed: covers Anthropic-messages, OpenAI-responses, and similar shapes.
 */
export function summarizeLlmPayload(payload: unknown): Record<string, unknown> {
	if (!payload || typeof payload !== "object") return { type: typeof payload };
	const p = payload as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	if (typeof p.model === "string") out.model = p.model;
	if (Array.isArray(p.messages)) out.messageCount = p.messages.length;
	if (Array.isArray(p.tools)) out.toolCount = p.tools.length;
	if (typeof p.system === "string") out.systemBytes = (p.system as string).length;
	else if (Array.isArray(p.system)) out.systemBytes = JSON.stringify(p.system).length;
	if (typeof p.temperature === "number") out.temperature = p.temperature;
	if (typeof p.max_tokens === "number") out.maxTokens = p.max_tokens;
	if (typeof p.stream === "boolean") out.stream = p.stream;
	return out;
}
