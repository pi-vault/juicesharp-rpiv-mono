/**
 * Named contract between the MLflow provider and pi-subagents' `Agent` tool.
 *
 * pi-subagents emits a tool execution whose result carries a `details` object
 * with sub-agent identity. We lift those fields onto the parent tool span so
 * MLflow's trace list surfaces them without expanding `outputs`. If pi-subagents
 * renames the tool or restructures `details`, the contract is centralised here.
 */

export const AGENT_TOOL_NAME = "Agent";

export interface AgentToolDetails {
	agentId?: string;
	type?: string;
	status?: string;
}

/** Extract the typed sub-agent identity from an `Agent` tool result envelope. */
export function extractAgentToolDetails(result: unknown): AgentToolDetails | null {
	if (typeof result !== "object" || result === null) return null;
	const details = (result as { details?: unknown }).details;
	if (typeof details !== "object" || details === null) return null;
	const d = details as Record<string, unknown>;
	const out: AgentToolDetails = {};
	if (d.agentId !== undefined) out.agentId = String(d.agentId);
	if (d.type !== undefined) out.type = String(d.type);
	if (d.status !== undefined) out.status = String(d.status);
	return out;
}
