/**
 * Next-node lookup over a `Workflow`'s edge graph.
 *
 * `nextNode` is the single chokepoint: given the current node name + the
 * runtime context, it returns the next node name or `null` (terminal).
 * Edge targets that resolve to the string `"stop"` collapse to `null` so
 * the runner only has to check one terminator.
 *
 * EdgeFn invocation is wrapped to surface a clear error when a user
 * predicate throws — the caller (runner) decides whether to halt the
 * workflow or re-raise.
 */

import type { EdgeContext, EdgeFn, Workflow } from "./api.js";

const STOP = "stop";

/**
 * Returns the next node name, or `null` if `current` is a terminal (no
 * outgoing edge OR explicit `"stop"`).
 *
 * Throws if an `EdgeFn` returns a target that isn't a declared node and
 * isn't `"stop"` — that means the predicate's contract was violated at
 * runtime. Load-time `validateWorkflow` should catch this for predicates
 * with `.targets` metadata; the runtime check is the last line of defense.
 */
export function nextNode(workflow: Workflow, current: string, ctx: EdgeContext): string | null {
	const target = workflow.edges[current];
	if (target === undefined || target === STOP) return null;
	if (typeof target === "string") return assertKnownTarget(workflow, current, target);

	const picked = invokeEdgeFn(target, ctx, current);
	if (picked === STOP) return null;
	return assertKnownTarget(workflow, current, picked);
}

/**
 * True iff the current node's edge is an `EdgeFn` — i.e., a routing decision
 * was made. The runner uses this to decide whether to write a routing-audit
 * row. String edges are deterministic and not worth auditing.
 */
export function edgeIsDecision(workflow: Workflow, current: string): boolean {
	return typeof workflow.edges[current] === "function";
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function invokeEdgeFn(fn: EdgeFn, ctx: EdgeContext, current: string): string {
	try {
		return fn(ctx);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`workflow edge function at "${current}" threw: ${msg}`);
	}
}

function assertKnownTarget(workflow: Workflow, current: string, target: string): string {
	if (workflow.nodes[target]) return target;
	throw new Error(
		`workflow edge from "${current}" returned "${target}" which is not a declared node in workflow "${workflow.name}"`,
	);
}
