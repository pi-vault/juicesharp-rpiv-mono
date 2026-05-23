/**
 * Manifest types — the inter-stage data channel. A manifest is extracted
 * by the runner (not authored by the agent), flows through RunState, and
 * is persisted to the JSONL audit log.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BranchEntry } from "./transcript.js";
import type { RunState } from "./types.js";

// ---------------------------------------------------------------------------
// Manifest envelope
// ---------------------------------------------------------------------------

export interface ManifestMeta {
	skill: string;
	/** 1-based; matches `WorkflowStage.stageNumber`. */
	stageNumber: number;
	/** ISO-8601. */
	ts: string;
	/** Duplicated from header for ergonomic JSONL reads. */
	runId: string;
}

export interface Manifest<K extends string = string, D = unknown> {
	kind: K;
	/** Present when the stage produced a file consumable by downstream stages. */
	artifact_path?: string;
	data: D;
	meta: ManifestMeta;
}

// ---------------------------------------------------------------------------
// Built-in manifest kinds
// ---------------------------------------------------------------------------

export type ArtifactMdManifest = Manifest<"artifact-md", Record<string, unknown>>;
export type SideEffectManifest = Manifest<"side-effect", Record<string, never>>;

export interface GitCommitData {
	sha: string;
	prevSha: string;
	subject: string;
	filesChanged: number;
	noOp?: boolean;
}
export type GitCommitManifest = Manifest<"git-commit", GitCommitData>;

// ---------------------------------------------------------------------------
// Snapshot + extractor function signatures
// ---------------------------------------------------------------------------

export interface SnapshotCtx {
	cwd: string;
	runId: string;
	stageIndex: number;
	state: Readonly<RunState>;
	/** Optional — not all snapshots need pi; may be absent in tests. */
	pi?: ExtensionAPI;
}

/** Fail-soft: implementations catch and return undefined rather than throwing. */
export type SnapshotFn = (ctx: SnapshotCtx) => Promise<unknown> | unknown;

export interface ExtractorCtx extends SnapshotCtx {
	branch: BranchEntry[];
	/** Entries before this index belong to prior stages (continue policies). */
	branchOffset?: number;
	snapshot: unknown | undefined;
	/** Filled by the runner; extractors must NOT set `manifest.meta.skill` themselves. */
	skill: string;
}

export interface ExtractorPayload<K extends string = string, D = unknown> {
	kind: K;
	artifact_path?: string;
	data: D;
}

/**
 * `payload: undefined` → stage complete, chain inherits prior manifest
 * (agent-end nodes). `fatal` set → runner halts with this message.
 */
export interface ExtractorResult {
	payload: ExtractorPayload | undefined;
	fatal?: string;
}

/**
 * Contract — when must `fatal` be set? If the protocol REQUIRES a structural
 * output (artifact-emit nodes that promise an `.rpiv/artifacts/...` path) and
 * that output is absent, the extractor MUST set `fatal`. Agent-end / side-
 * effect extractors never set `fatal` — success follows from `classifyStop`.
 *
 * Missing `fatal` records as success regardless of payload, so every concrete
 * extractor must declare which side of the contract it sits on.
 */
export type ExtractorFn = (ctx: ExtractorCtx) => Promise<ExtractorResult> | ExtractorResult;

/** Single source of manifest metadata authorship. */
export function finalizeManifest(
	payload: ExtractorPayload,
	ctx: { skill: string; stageNumber: number; ts: string; runId: string },
): Manifest {
	return {
		kind: payload.kind,
		artifact_path: payload.artifact_path,
		data: payload.data,
		meta: { skill: ctx.skill, stageNumber: ctx.stageNumber, ts: ctx.ts, runId: ctx.runId },
	};
}
