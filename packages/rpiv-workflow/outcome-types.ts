/**
 * Outcome authoring surface — the contract a stage's data-channel
 * implementation satisfies. Decomposed into two orthogonal halves so
 * authors can mix-and-match:
 *
 *   - `ArtifactResolver<B>`        — ENUMERATE: which artifacts did the
 *                                    stage produce? (text scan, tool-call
 *                                    observation, fs diff, git, custom.)
 *   - `ArtifactReader<B, K, D>`    — INTERPRET: given the artifacts, what
 *                                    typed data does downstream see?
 *
 * `Outcome` is the wired-up pair — `{ resolver, reader? }` — that nodes
 * declare via `NodeDef.outcome`. When `reader` is omitted the manifest
 * data IS the artifact list (kind = `"artifacts"`).
 *
 * Companion to `manifest.ts` (the envelope `Manifest<K, D>` that flows
 * to downstream stages, predicates, and the JSONL audit log). The split:
 * outcome authors implement the producer side here; manifest consumers
 * read the envelope shape there.
 */

import type { Artifact } from "./handle.js";
import type { BranchEntry } from "./transcript.js";
import type { RunState } from "./types.js";

// ---------------------------------------------------------------------------
// Baseline — pre-stage reference capture (shared by resolver + reader)
// ---------------------------------------------------------------------------

export interface BaselineCtx {
	cwd: string;
	runId: string;
	stageIndex: number;
	state: Readonly<RunState>;
}

/** Fail-soft: implementations catch and return undefined rather than throwing. */
export type BaselineFn<Baseline = unknown> = (ctx: BaselineCtx) => Promise<Baseline> | Baseline;

// ---------------------------------------------------------------------------
// Resolver — discover what the stage produced
// ---------------------------------------------------------------------------

/**
 * Context handed to a resolver's `resolve`. Includes the full unsliced
 * branch (`branch`) plus a policy-derived `branchOffset` — for
 * continue-policy stages the offset lets the resolver ignore prior-stage
 * prefix without re-materialising a slice. `baseline` is whatever the
 * resolver's optional `baseline` hook returned.
 */
export interface ResolveCtx<Baseline = unknown> extends BaselineCtx {
	branch: BranchEntry[];
	branchOffset?: number;
	baseline: Baseline;
	/** Filled by the runner; resolvers MUST NOT set this themselves. */
	skill: string;
}

/**
 * Three-way return from `resolve`:
 *
 *   `kind: "ok"` + `artifacts: []`               — stage produced nothing.
 *                                                   For artifact-emit nodes the runner halts;
 *                                                   for agent-end nodes the chain inherits
 *                                                   the upstream artifact list forward.
 *   `kind: "ok"` + `artifacts: [...]`            — N>=1 artifacts; reader (or default) shapes the data.
 *   `kind: "fatal"`                              — resolver cannot satisfy its contract;
 *                                                   runner halts with the carried message.
 */
export type ResolveResult = { kind: "ok"; artifacts: readonly Artifact[] } | { kind: "fatal"; message: string };

/**
 * The user-supplyable primitive. A resolver enumerates artifacts; that's
 * its single job. Authors compose `baseline?` (pre-stage snapshot) +
 * `resolve` (post-stage enumeration). Side-effect-only stages use a
 * resolver that always returns `{ kind: "ok", artifacts: [] }` — see
 * `outcomes/side-effect.ts`.
 *
 * Method shorthand (vs. function-property) so specialised
 * `ArtifactResolver<MyBaseline>` is assignable to the runner's
 * `ArtifactResolver` (default `Baseline = unknown`) without explicit
 * widening at every call site.
 */
export interface ArtifactResolver<Baseline = unknown> {
	baseline?(ctx: BaselineCtx): Promise<Baseline> | Baseline;
	resolve(ctx: ResolveCtx<Baseline>): Promise<ResolveResult> | ResolveResult;
}

// ---------------------------------------------------------------------------
// Reader — interpret resolved artifacts into a typed data channel
// ---------------------------------------------------------------------------

/**
 * Context handed to a reader's `read`. Extends `ResolveCtx` with the
 * `artifacts` the matching resolver just returned, so readers can
 * narrow on `artifacts[0].handle.kind` and inspect any `meta` the
 * resolver attached. `baseline` flows through unchanged.
 */
export interface ReadCtx<Baseline = unknown> extends ResolveCtx<Baseline> {
	artifacts: readonly Artifact[];
}

/**
 * Two-way return from `read`. `ok` produces the typed data channel
 * downstream stages see on `manifest.data`; `fatal` halts the stage
 * with the carried message — same posture as `ResolveResult`.
 */
export type ReadResult<Kind extends string = string, Data = unknown> =
	| { kind: "ok"; payload: { kind: Kind; data: Data } }
	| { kind: "fatal"; message: string };

/**
 * Optional companion to a resolver. When omitted, the manifest's
 * `data` is the artifact list itself and `kind` is the literal
 * `"artifacts"` — a node that only needs to enumerate files doesn't
 * have to write a reader.
 *
 * Method shorthand for the same bivariance reason as `ArtifactResolver`.
 */
export interface ArtifactReader<Baseline = unknown, Kind extends string = string, Data = unknown> {
	read(ctx: ReadCtx<Baseline>): Promise<ReadResult<Kind, Data>> | ReadResult<Kind, Data>;
}

// ---------------------------------------------------------------------------
// Outcome — wired-up pair on `NodeDef.outcome`
// ---------------------------------------------------------------------------

/**
 * A stage's resolver+reader bundle. `reader` is optional; when omitted
 * the manifest emits `kind: "artifacts"` with `data = artifacts`.
 *
 * Generic over `<Baseline, Kind, Data>` so specialised outcomes
 * (`Outcome<GitHeadSnapshot, "git-commit", GitCommitData>`) flow types
 * end-to-end from baseline through resolve into the downstream
 * `manifest.data`.
 */
export interface Outcome<Baseline = unknown, Kind extends string = string, Data = unknown> {
	resolver: ArtifactResolver<Baseline>;
	reader?: ArtifactReader<Baseline, Kind, Data>;
}

// ---------------------------------------------------------------------------
// Author helpers — `define*` shorthands match `defineWorkflow` /
// `definePredicate` / `defineStatePredicate` in api.ts. Pure passthroughs:
// they exist for type inference + uniform shape at the call site.
// ---------------------------------------------------------------------------

/** Identity passthrough; lets authors annotate baseline-generic resolvers without re-stating `<Baseline>`. */
export function defineResolver<Baseline = unknown>(spec: ArtifactResolver<Baseline>): ArtifactResolver<Baseline> {
	return spec;
}

/** Identity passthrough; same idiom as `defineResolver`. */
export function defineReader<Baseline = unknown, Kind extends string = string, Data = unknown>(
	spec: ArtifactReader<Baseline, Kind, Data>,
): ArtifactReader<Baseline, Kind, Data> {
	return spec;
}
