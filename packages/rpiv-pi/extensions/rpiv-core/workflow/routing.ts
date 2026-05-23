/**
 * Edge-aware next-stage lookup. Strict-preset: predicate targets must
 * appear at or after the linear successor in the preset.
 */

import { type DagEdge, getEdge, type WorkflowDag } from "./dag.js";
import type { EdgePredicate, PredicateContext } from "./predicates.js";
import { assertNever } from "./transcript.js";
import type { RunState } from "./types.js";

/**
 * - no edge → linear advance
 * - auto → `edge.to[0]`
 * - predicate → evaluate + assert forward
 * - choice → linear advance (preset linearity disambiguates aliased targets;
 *            user-prompt routing not yet wired)
 */
export function resolveNextStageId(
	dag: WorkflowDag,
	currentNodeId: string,
	preset: string[],
	idx: number,
	state: Readonly<RunState>,
): string | undefined {
	if (atEndOfPreset(preset, idx)) return undefined;

	const edge = getEdge(dag, currentNodeId);
	if (!edge) return linearNextOf(preset, idx);

	switch (edge.condition) {
		case "auto":
			return edge.to[0];
		case "predicate":
			return evaluatePredicateEdge(edge, preset, idx, state);
		case "choice":
			return linearNextOf(preset, idx);
		default:
			return assertNever(edge.condition);
	}
}

const atEndOfPreset = (preset: string[], idx: number): boolean => idx + 1 >= preset.length;
const linearNextOf = (preset: string[], idx: number): string | undefined => preset[idx + 1];

function evaluatePredicateEdge(edge: DagEdge, preset: string[], idx: number, state: Readonly<RunState>): string {
	const target = invokePredicate(edge, state);
	assertForwardTarget(target, preset, idx);
	return target;
}

function invokePredicate(edge: DagEdge, state: Readonly<RunState>): string {
	const predicate = (edge as { predicate: EdgePredicate }).predicate;
	const ctx: PredicateContext = { manifest: state.manifest, state };
	try {
		return predicate(ctx);
	} catch {
		throw new Error(`resolveNextStageId: predicate on edge "${edge.from} → [${edge.to.join(", ")}]" threw an error`);
	}
}

function assertForwardTarget(target: string, preset: string[], idx: number): void {
	const targetIdx = preset.indexOf(target);
	if (targetIdx < 0 || targetIdx < idx + 1) {
		throw new Error(
			`resolveNextStageId: predicate returned "${target}" which is not a valid forward target in preset ` +
				`(must be one of: ${preset.slice(idx + 1).join(", ")})`,
		);
	}
}
