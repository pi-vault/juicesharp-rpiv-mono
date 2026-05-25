/**
 * Shared types for the workflow modules. Lives apart from runner.ts /
 * implement-phases.ts so both can reference the same shapes without a
 * runtime import cycle (type-only refs back via this module are cycle-free).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { NodeDef, Workflow } from "./api.js";
import type { Manifest } from "./manifest.js";

/**
 * Extends `ExtensionCommandContext` with `isIdle`/`waitForIdle` which the SDK
 * guarantees on every event ctx but doesn't surface on the public base type —
 * call sites use plain method syntax instead of an `as` cast each time.
 */
export type RunnerCtx = ExtensionCommandContext & {
	isIdle(): boolean;
	waitForIdle(): Promise<void>;
};

/** Mutable per-run bookkeeping threaded through the chain by reference. */
export interface RunState {
	/** Frozen — the user's `/wf` argument. */
	originalInput: string;
	/**
	 * Denormalised mirror of `manifest.artifact_path` — load-bearing for the
	 * prompt builder and `countPhases`, which need the path at idx 0 before
	 * any manifest exists. Always equal to the most recently set
	 * `manifest.artifact_path` (or the bare path extracted from the transcript
	 * when the manifest is absent).
	 */
	artifactPath: string | undefined;
	manifest: Manifest | undefined;
	/** Stages whose JSONL row landed on disk. */
	stagesCompleted: number;
	/** Most recently allocated stageNumber. Advances on every recordStage call. */
	lastAllocatedStageNumber: number;
	success: boolean;
	error: string | undefined;
	backwardJumps: number;
	/**
	 * Routing rows whose JSONL append failed mid-run. The chain advanced past
	 * them (routing rows are write-only telemetry, not reconstruction inputs),
	 * but the final result envelope surfaces this so post-hoc readers can
	 * distinguish "deterministic edge — no row written by design" from
	 * "decision made — write was dropped." Empty in the common case.
	 */
	droppedRoutingRows: Array<{ fromStage: number; fromNode: string; decision: string }>;
}

/** Per-run context the chain carries from stage to stage. */
export interface RunContext {
	cwd: string;
	runId: string;
	workflow: Workflow;
	/**
	 * Upper bound for stage status display — count of nodes reachable from
	 * `workflow.start`, computed once at run start. The actual stage count
	 * is path-dependent (a predicate edge may short-circuit), so this is
	 * the denominator users see; the numerator is the live stage index.
	 */
	totalStages: number;
	state: RunState;
	/**
	 * Node names already executed in this run. The backward-jump guard
	 * increments `state.backwardJumps` on every re-entry; revise → implement
	 * loops legitimately revisit nodes, but unbounded loops trip the cap.
	 */
	visited: Set<string>;
	/** Required for "continue"-policy stages. */
	pi?: ExtensionAPI;
	maxBackwardJumps: number;
}

interface SessionContext {
	cwd: string;
	runId: string;
	state: RunState;
	/** `/skill:<name> <args>`. */
	prompt: string;
	/** Status-line + JSONL "skill" label. */
	skill: string;
}

export interface StageSession extends SessionContext {
	node: NodeDef;
	/** 0-based stage index within this run — for status display + JSONL stage number. */
	stageIndex: number;
	/** Pre-stage snapshot result (undefined if the node's extractor has no `before`). */
	snapshot: unknown;
	/** Required iff `node.sessionPolicy === "continue"`. */
	pi?: ExtensionAPI;
	/** Only set for continue stages — branch slice offset. */
	branchOffset?: number;
	onFailure?: (ctx: RunnerCtx) => void;
	onSuccess: (ctx: RunnerCtx, artifact: string | undefined) => Promise<void>;
}

/** One `## Phase N:` iteration of an implement stage. */
export interface PhaseSession extends SessionContext {
	/** 1-based. */
	phaseIndex: number;
	phaseCount: number;
	/** Parent stage's 0-based index. */
	stageIndex: number;
	onSuccess: (ctx: RunnerCtx) => Promise<void>;
}
