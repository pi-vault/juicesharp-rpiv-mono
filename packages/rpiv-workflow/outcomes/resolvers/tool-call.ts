/**
 * Tool-call resolver — observes assistant tool_use parts in the branch
 * and turns each into an Artifact via the author-supplied mappers.
 *
 * Universal: knows nothing about specific tool names. Authors wire
 * `match(tc)` to pick which calls are interesting (often
 * `tc.name === "write_file"`) and `toHandle(tc)` to extract the
 * Artifact (most commonly an `fs` handle pulled from the tool input).
 * Multiple matching calls produce multiple artifacts in branch order.
 *
 * Far more reliable than transcript-text scanning: tool-use blocks
 * are the agent's actual recorded actions, not its narration of them.
 *
 * Returns `ok` with an empty list when no matching calls fire — the
 * runner's `enforceCompletionContract` then halts for artifact-emit
 * (the stage promised an output and didn't deliver) or passes through
 * for agent-end (chain inherits prior). The resolver itself doesn't
 * second-guess that policy.
 */

import type { Artifact } from "../../handle.js";
import type { ArtifactResolver } from "../../outcome-types.js";
import { defineResolver } from "../../outcome-types.js";
import { iterToolUses } from "../../transcript.js";

export interface ToolCall {
	name: string;
	input: Record<string, unknown>;
}

export interface ToolCallResolverOpts {
	/**
	 * Predicate over the tool call. Return true to consider this call,
	 * false to skip. No default — match semantics are entirely
	 * caller-defined (e.g. `(tc) => tc.name === "write_file"`).
	 */
	match(tc: ToolCall): boolean;
	/**
	 * Map a matched tool call to an Artifact. Return undefined to skip
	 * (useful when the tool's input doesn't carry a path, or the path
	 * fails a sanity check). The returned Artifact's handle is what
	 * downstream stages see on `manifest.artifacts`.
	 */
	toHandle(tc: ToolCall): Artifact | undefined;
}

export function toolCallResolver(opts: ToolCallResolverOpts): ArtifactResolver {
	if (typeof opts.match !== "function" || typeof opts.toHandle !== "function") {
		throw new Error("toolCallResolver: `match` and `toHandle` are required functions");
	}
	const { match, toHandle } = opts;
	return defineResolver({
		resolve: (ctx) => {
			const artifacts: Artifact[] = [];
			for (const tc of iterToolUses(ctx.branch, ctx.branchOffset)) {
				if (!match(tc)) continue;
				const artifact = toHandle(tc);
				if (artifact) artifacts.push(artifact);
			}
			return { kind: "ok", artifacts };
		},
	});
}
