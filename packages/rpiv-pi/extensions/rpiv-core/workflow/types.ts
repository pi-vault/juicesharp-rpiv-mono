/**
 * Shared types for the /rpiv workflow modules.
 *
 * Lives separately from `runner.ts` and `implement-phases.ts` so both
 * modules can reference the same canonical shapes without creating a
 * runtime import cycle (implement-phases.ts is a value-dependency of
 * runner.ts; type-only references back via this module are cycle-free).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DagNode, WorkflowDag } from "./dag.js";
import type { Manifest } from "./manifest.js";

/**
 * A ctx that can spawn the next session. Either the original handler ctx or
 * a `freshCtx` from `withSession` — both extend `ExtensionCommandContext`,
 * which is all we need (`ui.notify` + `newSession`).
 * `ReplacedSessionContext` is not publicly exported from `pi-coding-agent`,
 * so we lean on the base type.
 */
export type ChainCtx = ExtensionCommandContext;

/** Mutable per-run bookkeeping threaded through the chain by reference. */
export interface RunState {
	/** Frozen — the user's `/rpiv` argument. */
	originalInput: string;
	/** Last `.rpiv/artifacts/...` path emitted by any stage so far.
	 * @deprecated Mirror of `manifest.artifact_path` retained for legacy callers
	 *   (prompt construction, countPhases). Prefer `state.manifest?.artifact_path`. */
	artifactPath: string | undefined;
	/** Last successfully validated manifest. Mirrors the JSONL manifest field. */
	manifest: Manifest | undefined;
	/** Successful-stage counter (success only — not failed/skipped). */
	stagesCompleted: number;
	/** Last successfully-written JSONL stage number (for contiguous numbering). */
	jsonlStage: number;
	/** Whether the chain finished cleanly. Set by the terminal stage of `runStage`. */
	success: boolean;
	/** Set when a stage halts the chain — surfaces in `RunWorkflowResult`. */
	error: string | undefined;
}

/** Per-run context that the chain carries from stage to stage. */
export interface RunContext {
	cwd: string;
	runId: string;
	/** The DAG being executed — used to look up per-node metadata at dispatch time. */
	dag: WorkflowDag;
	/** Linear sequence of node ids resolved from `dag.presets[preset]`. */
	stageIds: string[];
	totalStages: number;
	state: RunState;
	/** ExtensionAPI instance — needed for "continue" stages that call pi.sendUserMessage(). */
	pi?: ExtensionAPI;
}

/**
 * Fields every session execution shares: provenance, prompt, and the label
 * that appears in the status line and JSONL audit row.
 */
interface SessionContext {
	cwd: string;
	runId: string;
	state: RunState;
	/** The `/skill:<name> <args>` line sent into the session. */
	prompt: string;
	/** Status-line + audit-row label. Stage = node skill; phase = parent skill ("implement"). */
	skill: string;
}

/**
 * Execute one DAG stage in its own Pi session. The node carries everything
 * stage-specific (sessionPolicy, extractor, schemas) — the runner derives
 * spawn policy and post-stage handling from it.
 */
export interface StageSession extends SessionContext {
	/** The DAG node being executed. sessionPolicy + extractor + schemas derive from it. */
	node: DagNode;
	/** 0-based index in the preset's stageIds sequence. */
	stageIndex: number;
	/** Result of `node.snapshot(...)` if declared, undefined otherwise. Caller pre-invokes. */
	snapshot: unknown;
	/** Required iff `node.sessionPolicy === "continue"`. */
	pi?: ExtensionAPI;
	/** Branch offset for slicing — only set for continue stages. */
	branchOffset?: number;
	/** Recap hook invoked on failure (e.g. partial-artifacts notice). */
	onFailure?: (ctx: ChainCtx) => void;
	/** Chain advance — called on success with the artifact this stage produced. */
	onSuccess: (ctx: ChainCtx, artifact: string | undefined) => Promise<void>;
}

/**
 * Execute one `## Phase N:` iteration of an implement stage. Always fresh,
 * no manifest extraction, inherits the parent stage's artifact.
 */
export interface PhaseSession extends SessionContext {
	/** 1-based phase index within the parent stage. */
	phaseIndex: number;
	/** Total phase count — used to format "phase N/total" labels. */
	phaseCount: number;
	/** Parent stage's 0-based index — drives the status-line position. */
	stageIndex: number;
	/** Hand back to the next phase iteration or next stage. */
	onSuccess: (ctx: ChainCtx) => Promise<void>;
}
