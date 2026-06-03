/**
 * State reconstruction for resuming a failed (or cut-off) workflow run.
 * Pure fold over the JSONL audit trail — no I/O beyond `readAllStages`.
 *
 * Used by `resumeWorkflow` (runner.ts) to rebuild `RunState` from a past
 * run's stage rows, then re-enter the chain machinery at the right seam.
 * New rows **append to the same JSONL file** so the trail reads as one
 * story: *ran → failed → resumed → continued*.
 *
 * Folds `def.fanout` unit rows so fanout runs are resumable; this REQUIRES the
 * stage's FanoutFn to be deterministic w.r.t. its entry artifact (the resume
 * dispatch re-calls it and guards the unit prefix — see `resume-fanout.ts`).
 * Refuses `def.iterate` trails — partial-unit accumulation is a later phase.
 */

import type { StageDef, Workflow } from "../api.js";
import { applyCompletedStage } from "../internal-utils.js";
import { readAllStages } from "../state/index.js";
import type { WorkflowHeader, WorkflowStage } from "../state/state.js";
import type { RunState } from "../types.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Per-fanout-parent record of the COMPLETED unit rows, in trail order, as their
 * decorated `WorkflowStage.stage` strings (`"impl (phase 1/4)"`). Consumed by
 * `resumeFanoutStage` (Phase 2) to compute the resume point + guard FanoutFn
 * determinism by full-string comparison. A failed unit row is NOT recorded here
 * (it's the `k+1` that resume re-runs).
 */
export type FanoutProgress = ReadonlyMap<string, readonly string[]>;

export type ReconstructResult =
	| {
			ok: true;
			state: RunState;
			lastStageNumber: number;
			visited: Set<string>;
			rows: WorkflowStage[];
			fanoutProgress: FanoutProgress;
	  }
	| { ok: false; reason: "no-rows" | "stage-gone" | "iterate-unsupported"; detail: string };

// ---------------------------------------------------------------------------
// Fanout-decoration helpers (shared with resumeWorkflow dispatch)
// ---------------------------------------------------------------------------

/** Stage record keys whose def opts into `fanout`. */
export function fanoutStageNames(workflow: Workflow): ReadonlySet<string> {
	const names = new Set<string>();
	for (const [name, def] of Object.entries(workflow.stages)) {
		if (def.fanout) names.add(name);
	}
	return names;
}

/** Stage record keys whose def opts into `iterate`. */
function iterateStageNames(workflow: Workflow): ReadonlySet<string> {
	const names = new Set<string>();
	for (const [name, def] of Object.entries(workflow.stages)) {
		if (def.iterate) names.add(name);
	}
	return names;
}

/**
 * Recover the parent stage name from a decorated unit-row key. Matches the
 * `fanoutRowStage`/`iterateRowStage` projection (`${parent} (${id ?? label})`,
 * audit.ts:57,69) with an exact `${parent} (` prefix + `)` suffix. The space
 * before `(` disambiguates prefix-name collisions (`"build-extra (x)"` does NOT
 * start with `"build ("`); identifier-style stage names never contain `" ("`,
 * so at most one parent matches. Returns undefined for a non-decorated key.
 */
export function matchFanoutParent(stageKey: string, parents: ReadonlySet<string>): string | undefined {
	if (!stageKey.endsWith(")")) return undefined;
	for (const parent of parents) {
		if (stageKey.startsWith(`${parent} (`)) return parent;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Reconstruction fold
// ---------------------------------------------------------------------------

/**
 * Rebuild `RunState` by folding over the completed stage rows in a run's
 * JSONL audit trail. Returns a discriminated result so the entry point
 * (`resumeWorkflow`) maps refusals to error envelopes.
 *
 * Rules:
 *   - A row whose `stage` is a real `workflow.stages` key:
 *       - `def.iterate` parent → refuse `iterate-unsupported` (the runner
 *         never writes a bare iterate-parent row; its presence means an
 *         iterate run — unsupported).
 *       - otherwise → fold as a normal stage (completed rows seed via
 *         `applyCompletedStage`; non-completed rows bump counters only).
 *   - A row whose `stage` is NOT a key — a decorated unit row, a renamed
 *     stage, or a removed one:
 *       - matches a `def.fanout` parent → fold counters-only (mirror the
 *         live `recordFanoutSuccess`: bump `stagesCompleted` on a completed
 *         row, add parent to `visited`, advance `lastStageNumber`; NO
 *         `applyCompletedStage`, NO `state.output` write) + record the
 *         completed decorated string under the parent in `fanoutProgress`.
 *       - matches a `def.iterate` parent → refuse `iterate-unsupported`.
 *       - no match → refuse `stage-gone`.
 */
export function reconstructState(cwd: string, workflow: Workflow, header: WorkflowHeader): ReconstructResult {
	const rows = readAllStages(cwd, header.runId);

	if (rows.length === 0) {
		return { ok: false, reason: "no-rows", detail: header.runId };
	}

	const fanoutNames = fanoutStageNames(workflow);
	const iterateNames = iterateStageNames(workflow);

	const acc: FoldAcc = {
		state: {
			originalInput: header.input,
			primaryArtifact: undefined,
			output: undefined,
			named: {},
			stagesCompleted: 0,
			lastAllocatedStageNumber: 0,
			telemetry: { backwardJumps: 0, droppedRoutingRows: [] },
			termination: { success: false, error: undefined },
		},
		visited: new Set<string>(),
		fanoutProgress: new Map<string, string[]>(),
		lastStageNumber: 0,
	};

	for (const row of rows) {
		const def = workflow.stages[row.stage];
		const step = def ? foldKnownStage(acc, def, row) : foldDecoratedRow(acc, row, fanoutNames, iterateNames);
		if (step.refuse) return { ok: false, reason: step.reason, detail: step.detail };
	}

	acc.state.lastAllocatedStageNumber = acc.lastStageNumber; // allocator continues monotonically on append

	return {
		ok: true,
		state: acc.state,
		lastStageNumber: acc.lastStageNumber,
		visited: acc.visited,
		rows,
		fanoutProgress: acc.fanoutProgress,
	};
}

// ---------------------------------------------------------------------------
// Per-row fold helpers
// ---------------------------------------------------------------------------

/** Mutable accumulator threaded through the per-row fold. */
interface FoldAcc {
	state: RunState;
	visited: Set<string>;
	fanoutProgress: Map<string, string[]>;
	lastStageNumber: number;
}

/** A folded row either advanced the accumulator (`refuse: false`) or hit an unresumable trail. */
type FoldStep = { refuse: false } | { refuse: true; reason: "stage-gone" | "iterate-unsupported"; detail: string };

const FOLD_OK: FoldStep = { refuse: false };
const refuse = (reason: "stage-gone" | "iterate-unsupported", detail: string): FoldStep => ({
	refuse: true,
	reason,
	detail,
});

/**
 * Fold a row whose `stage` is a real `workflow.stages` key. An iterate parent
 * refuses (the runner never writes a bare iterate-parent row; its presence means
 * an iterate run). Otherwise it folds as a normal stage: completed rows seed
 * `state.output` + primary + named via `applyCompletedStage`; non-completed rows
 * bump `visited`/`lastStageNumber` only. The never-written bare fanout-parent row
 * folds harmlessly here — fanout rows carry no output, so the `!row.output` guard
 * skips `applyCompletedStage`.
 */
function foldKnownStage(acc: FoldAcc, def: StageDef, row: WorkflowStage): FoldStep {
	if (def.iterate) return refuse("iterate-unsupported", row.stage);
	acc.visited.add(row.stage);
	acc.lastStageNumber = Math.max(acc.lastStageNumber, row.stageNumber);
	if (row.status !== "completed") return FOLD_OK;
	acc.state.stagesCompleted++;
	if (!row.output) return FOLD_OK;
	acc.state.output = row.output;
	applyCompletedStage(acc.state, def, row.stage, row.output);
	return FOLD_OK;
}

/**
 * Fold a row whose `stage` is NOT a key — a decorated unit row, a renamed stage,
 * or a removed one. A fanout-parent match folds counters-only; an iterate-parent
 * match refuses `iterate-unsupported`; no match refuses `stage-gone`.
 */
function foldDecoratedRow(
	acc: FoldAcc,
	row: WorkflowStage,
	fanoutNames: ReadonlySet<string>,
	iterateNames: ReadonlySet<string>,
): FoldStep {
	const fanoutParent = matchFanoutParent(row.stage, fanoutNames);
	if (fanoutParent) {
		foldFanoutUnit(acc, fanoutParent, row);
		return FOLD_OK;
	}
	const iterateParent = matchFanoutParent(row.stage, iterateNames);
	if (iterateParent) return refuse("iterate-unsupported", iterateParent);
	return refuse("stage-gone", row.stage);
}

/**
 * Counters-only fold for one decorated fanout-unit row — mirrors the live
 * `recordFanoutSuccess` exactly: bump `stagesCompleted` on a completed row, add
 * the parent to `visited`, advance `lastStageNumber`; NO `applyCompletedStage`,
 * NO `state.output` write. The completed decorated string is recorded under the
 * parent in `fanoutProgress` (the resume point + determinism-guard input).
 */
function foldFanoutUnit(acc: FoldAcc, parent: string, row: WorkflowStage): void {
	acc.visited.add(parent);
	acc.lastStageNumber = Math.max(acc.lastStageNumber, row.stageNumber);
	if (row.status !== "completed") return;
	acc.state.stagesCompleted++;
	let progress = acc.fanoutProgress.get(parent);
	if (!progress) {
		progress = [];
		acc.fanoutProgress.set(parent, progress);
	}
	progress.push(row.stage);
}
