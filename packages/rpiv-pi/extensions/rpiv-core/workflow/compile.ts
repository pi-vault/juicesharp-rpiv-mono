/**
 * Compile `Workflow[]` (the TS-native source-of-truth shape) into the legacy
 * `WorkflowDag` shape that today's `routing.ts` + `runner.ts` consume.
 *
 * This module is a bridge: Phase 3 establishes the new format, the compiler
 * keeps the existing runner working unchanged. Phases 5 + 6 rewrite the
 * runner to consume `Workflow` directly, at which point this file disappears.
 *
 * Translation rules:
 * - `nodes`: union across workflows + `extraNodes`, each tagged `kind: "skill"`.
 * - `presets[w.name]`: `Object.keys(w.nodes)` (insertion order = linear order).
 * - `edges`: per-`from` aggregation across workflows.
 *   - All workflows agree on a single string target  → `condition: "auto"`.
 *   - Multiple workflows route to different targets   → `condition: "choice"` with union.
 *   - Any workflow uses an `EdgeFn` from that node    → `condition: "predicate"` with `.targets` metadata.
 *   - `"stop"` targets are omitted (legacy runner's `linearNextOf` returns undefined at end).
 */

import type { EdgeFn, NodeDef, Workflow } from "./api.js";
import type { DagEdge, DagNode, WorkflowDag } from "./dag.js";

interface CompileInput {
	workflows: readonly Workflow[];
	extraNodes?: Record<string, NodeDef>;
	extraEdges?: Record<string, import("./api.js").EdgeTarget>;
}

export function compileWorkflowsToDag(input: CompileInput): WorkflowDag {
	const nodes: Record<string, DagNode> = {};
	const presets: Record<string, string[]> = {};

	// Edge accumulator: per `from`, collect every observed target (deduped).
	// `predicate` edges win over auto/choice if any workflow uses an EdgeFn.
	type EdgeBucket = { autoTargets: string[]; predicate?: EdgeFn };
	const buckets = new Map<string, EdgeBucket>();
	const pushAuto = (from: string, to: string) => {
		const b = buckets.get(from) ?? { autoTargets: [] };
		if (!b.autoTargets.includes(to)) b.autoTargets.push(to);
		buckets.set(from, b);
	};
	const setPredicate = (from: string, fn: EdgeFn) => {
		const b = buckets.get(from) ?? { autoTargets: [] };
		b.predicate = fn;
		buckets.set(from, b);
	};

	for (const w of input.workflows) {
		presets[w.name] = Object.keys(w.nodes);
		for (const [name, node] of Object.entries(w.nodes)) {
			nodes[name] = toDagNode(node);
		}
		for (const [from, target] of Object.entries(w.edges)) {
			if (target === "stop") continue;
			if (typeof target === "string") {
				pushAuto(from, target);
			} else {
				setPredicate(from, target);
			}
		}
	}

	// Extra nodes and edges — for skills referenced by name but not currently in any preset.
	for (const [name, node] of Object.entries(input.extraNodes ?? {})) {
		if (!nodes[name]) nodes[name] = toDagNode(node);
	}
	for (const [from, target] of Object.entries(input.extraEdges ?? {})) {
		if (target === "stop") continue;
		if (typeof target === "string") {
			pushAuto(from, target);
		} else {
			setPredicate(from, target);
		}
	}

	const edges: DagEdge[] = [];
	for (const [from, bucket] of buckets) {
		if (bucket.predicate) {
			const targets = bucket.predicate.targets ?? [];
			if (targets.length === 0) {
				throw new Error(
					`compileWorkflowsToDag: predicate edge from "${from}" has no .targets metadata — ` +
						"use threshold() (or attach .targets manually) so the compiler can enumerate possible returns",
				);
			}
			edges.push({ from, to: [...targets], condition: "predicate", predicate: bucket.predicate });
		} else if (bucket.autoTargets.length === 1) {
			edges.push({ from, to: [bucket.autoTargets[0]!], condition: "auto" });
		} else {
			// Multiple distinct targets across workflows → legacy "choice" edge.
			// The runner ignores `to` for choice edges (linearNextOf wins); the
			// array order is observable via getEdge() only.
			edges.push({ from, to: [...bucket.autoTargets], condition: "choice" });
		}
	}

	return { edges, presets, nodes };
}

/** NodeDef carries the same field surface as a legacy SkillNode minus `kind`. */
function toDagNode(node: NodeDef): DagNode {
	const dagNode: DagNode = {
		kind: "skill",
		skill: node.skill,
		completionStrategy: node.completionStrategy,
		sessionPolicy: node.sessionPolicy,
		extractor: node.extractor,
		outputSchema: node.outputSchema,
		inputSchema: node.inputSchema,
		onValidationFailure: node.onValidationFailure,
		maxValidationRetries: node.maxValidationRetries,
		validationRetryTimeoutMs: node.validationRetryTimeoutMs,
	};
	return dagNode;
}
