/**
 * State reconstruction for resuming a failed (or cut-off) workflow run.
 * Pure fold over the JSONL audit trail — no I/O beyond `readAllStages`.
 *
 * Used by `resumeWorkflow` (runner.ts) to rebuild `RunState` from a past
 * run's stage rows, then re-enter the chain machinery at the right seam.
 * New rows **append to the same JSONL file** so the trail reads as one
 * story: *ran → failed → resumed → continued*.
 *
 * Refuses fanout/iterate trails — partial-unit reconstruction is a later
 * phase.
 */

import type { Workflow } from "../api.js";
import { applyCompletedStage } from "../internal-utils.js";
import { readAllStages } from "../state/index.js";
import type { WorkflowHeader, WorkflowStage } from "../state/state.js";
import type { RunState } from "../types.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type ReconstructResult =
	| { ok: true; state: RunState; lastStageNumber: number; visited: Set<string>; rows: WorkflowStage[] }
	| { ok: false; reason: "no-rows" | "stage-gone" | "fanout-unsupported"; detail: string };

// ---------------------------------------------------------------------------
// Reconstruction fold
// ---------------------------------------------------------------------------

/**
 * Rebuild `RunState` by folding over the completed stage rows in a run's
 * JSONL audit trail. Returns a discriminated result so the entry point
 * (`resumeWorkflow`) maps refusals to error envelopes.
 *
 * Rules:
 *   - Completed rows seed state (output, primary, named, stagesCompleted).
 *   - Failed/aborted/skipped rows DO NOT seed state, but ARE counted in
 *     `lastStageNumber` and `visited`.
 *   - Refuses fanout/iterate trails up front — the `stage` key for a
 *     fanout/iterate unit row won't match `workflow.stages`, and a parent
 *     stage def with `fanout`/`iterate` is caught by the `def.fanout ||
 *     def.iterate` guard.
 *   - Refuses when a row's `stage` key isn't in `workflow.stages` (renamed,
 *     removed, or a decorated fanout-unit key).
 */
export function reconstructState(cwd: string, workflow: Workflow, header: WorkflowHeader): ReconstructResult {
	const rows = readAllStages(cwd, header.runId);

	if (rows.length === 0) {
		return { ok: false, reason: "no-rows", detail: header.runId };
	}

	// Refuse fanout/iterate up front — partial-unit reconstruction is out of v1 scope.
	for (const row of rows) {
		const def = workflow.stages[row.stage];
		if (!def) {
			return { ok: false, reason: "stage-gone", detail: row.stage };
		}
		if (def.fanout || def.iterate) {
			return { ok: false, reason: "fanout-unsupported", detail: row.stage };
		}
	}

	const state: RunState = {
		originalInput: header.input,
		primaryArtifact: undefined,
		output: undefined,
		named: {},
		stagesCompleted: 0,
		lastAllocatedStageNumber: 0,
		telemetry: { backwardJumps: 0, droppedRoutingRows: [] },
		termination: { success: false, error: undefined },
	};
	const visited = new Set<string>();
	let lastStageNumber = 0;

	for (const row of rows) {
		visited.add(row.stage);
		lastStageNumber = Math.max(lastStageNumber, row.stageNumber);
		if (row.status !== "completed") continue; // failed/aborted/skipped rows DO NOT seed state
		state.stagesCompleted++;
		if (!row.output) continue;
		state.output = row.output; // rolling slot read by nextStage predicates + ensureInputValid
		const def = workflow.stages[row.stage]!;
		applyCompletedStage(state, def, row.stage, row.output); // primary + named
	}
	state.lastAllocatedStageNumber = lastStageNumber; // allocator continues monotonically on append

	return { ok: true, state, lastStageNumber, visited, rows };
}
