/**
 * Iterative session runner for the /rpiv workflow command.
 *
 * Each DAG node (one "stage" in the preset sequence) runs in its own session.
 * The session policy controls how that session is created:
 *
 *   - `sessionPolicy: "fresh"` — wraps the node in `ctx.newSession({ withSession })`.
 *     Inside withSession, `freshCtx.sendUserMessage()` awaits the full agent loop.
 *     The next stage's `newSession()` is invoked **on freshCtx** — never on the
 *     outer ctx, which is invalidated by Pi the moment a session is replaced.
 *
 *   - `sessionPolicy: "continue"` — reuses the prior stage's session (no newSession).
 *     Sends the prompt via `pi.sendUserMessage()` (sync, fire-and-forget) then
 *     awaits `ctx.waitForIdle()` with a bounded macrotask poll. Branch entries
 *     accumulate from the prior stage; the runner slices with `branchOffset` to
 *     inspect only entries produced by this stage.
 *
 * Each level of the chain only ever touches the ctx it was handed:
 *   - On `cancelled === true` no replacement happened — the level's curCtx
 *     is still valid for the final notify/append.
 *   - On `cancelled === false` curCtx is stale after newSession returns; all
 *     further work was already performed inside the withSession callback on
 *     freshCtx, and the function simply unwinds.
 *   - On "continue" there is no newSession — curCtx remains valid throughout.
 *
 * The session-spawn body itself lives in `spawnSession`; `runStageSession`
 * and `runPhaseSession` wrap it with stage- and phase-specific
 * post-processing. `runStage` and `runImplementPhases` build the prompts
 * + labels and hand them off.
 *
 * Vocabulary:
 *   - "stage" = one position in a preset's node sequence (a DAG node).
 *   - "phase" = one `## Phase N:` subdivision *inside an implement plan
 *     artifact* — only meaningful for the `implement` stage.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { clearChildSession, markChildSession } from "./child-session.js";
import type { DagNode, SessionPolicy, WorkflowDag } from "./dag.js";
import { WORKFLOW_DAG } from "./dag.js";
import { artifactMdExtractor, sideEffectExtractor } from "./extractors/index.js";
import { countPhases, runImplementPhases } from "./implement-phases.js";
import {
	type ExtractorCtx,
	type ExtractorFn,
	type ExtractorPayload,
	finalizeManifest,
	type Manifest,
} from "./manifest.js";
import { resolveNextStageId } from "./routing.js";
import {
	appendRoutingDecision,
	appendStage,
	generateRunId,
	readAllStages,
	type WorkflowStage,
	writeHeader,
} from "./state.js";
import { type BranchEntry, extractArtifactPath, hasAssistantMessage, lastAssistantStopReason } from "./transcript.js";
import type { ChainCtx, PhaseSession, RunContext, StageSession } from "./types.js";
import {
	DEFAULT_VALIDATION_RETRIES,
	formatValidationFailuresForAgent,
	MAX_VALIDATION_RETRIES,
	validateManifestData,
} from "./validation.js";

// Re-export so existing imports of `extractArtifactPath` and `countPhases`
// from "./runner.js" keep working — production callers and tests both rely
// on this surface.
export { countPhases } from "./implement-phases.js";
export { extractArtifactPath } from "./transcript.js";

// ---------------------------------------------------------------------------
// Extractor resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the extractor for a node. Priority:
 * 1. Node-declared extractor → use it.
 * 2. stopStrategy "artifact-emit" → artifactMdExtractor.
 * 3. stopStrategy "agent-end" → sideEffectExtractor.
 */
function resolveExtractor(node: DagNode): ExtractorFn {
	if (node.extractor) return node.extractor;
	return node.stopStrategy === "artifact-emit" ? artifactMdExtractor : sideEffectExtractor;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for running a workflow. */
export interface RunWorkflowOptions {
	/** Preset name (resolved to a linear sequence). */
	preset: string;
	/** User's input text — passed as argument to the first skill. */
	input: string;
	/** The DAG to traverse. Defaults to WORKFLOW_DAG. */
	dag?: WorkflowDag;
	/** ExtensionAPI — needed for "continue" stages that call pi.sendUserMessage(). */
	pi?: ExtensionAPI;
}

/** Result of a completed workflow run. */
export interface RunWorkflowResult {
	/** Total number of stages completed. */
	stagesCompleted: number;
	/** Whether the workflow completed all stages successfully. */
	success: boolean;
	/** The last artifact path produced, if any. */
	lastArtifact?: string;
	/** Error message if the workflow stopped due to failure. */
	error?: string;
}

// ---------------------------------------------------------------------------
// Message constants
// ---------------------------------------------------------------------------

// Persistent status-line state — written via ctx.ui.setStatus, cleared at the
// end of every workflow regardless of outcome. Pi's `notify` is a one-shot
// channel that the `newSession` transition repaints away (see
// session-hooks.ts:120/127 for the canonical setStatus pattern in rpiv-core).
const STATUS_KEY = "rpiv-workflow";

const STATUS_STAGE = (stage: number, total: number, skill: string) => `rpiv: stage ${stage}/${total} — ${skill}`;

// One-shot announcements via `ui.notify` — best-effort visibility; some may be
// repainted by Pi's session transition, but the persistent status line above
// guarantees the user always knows where the workflow currently is.
const MSG_STAGE_COMPLETE = (skill: string) => `✓ ${skill} completed`;

const MSG_STAGE_FAILED = (skill: string) => `✗ ${skill} failed — stopping workflow`;

const MSG_WORKFLOW_COMPLETE = (stages: number) => `rpiv: workflow complete (${stages} stages)`;

const MSG_WORKFLOW_CANCELLED = "rpiv: workflow cancelled";

const MSG_STAGE_ABORTED = (skill: string) => `⏸ ${skill} aborted (ESC) — stopping workflow`;

const MSG_VALIDATION_RETRY = (skill: string, attempt: number) =>
	`rpiv: ${skill} output validation failed — asking agent to fix (attempt ${attempt})`;
const MSG_VALIDATION_EXHAUSTED = (skill: string) => `rpiv: ${skill} output validation exhausted retries`;
const ERR_VALIDATION_FAILED = (skill: string, failures: string) =>
	`${skill} output validation failed after retries: ${failures}`;

const MSG_INPUT_VALIDATION_FAILED = (currentSkill: string, prevSkill: string) =>
	`✗ ${currentSkill} input validation failed — upstream ${prevSkill} produced invalid data`;
const ERR_INPUT_VALIDATION_FAILED = (currentSkill: string, prevSkill: string, failures: string) =>
	`Input validation failed for '${currentSkill}': upstream '${prevSkill}' produced invalid data: ${failures}`;

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const nowIso = () => new Date().toISOString();

/**
 * Send a user message into the session and block until the agent finishes
 * responding. Branches on session policy:
 * - "fresh": ctx is inside withSession, so sendUserMessage awaits the agent loop.
 * - "continue": uses pi.sendUserMessage (sync) + bounded macrotask poll on isIdle().
 */
async function sendAndAwaitIdle(
	ctx: ChainCtx,
	msg: string,
	opts: { sessionPolicy?: SessionPolicy; pi?: ExtensionAPI },
): Promise<void> {
	if (opts.sessionPolicy === "continue") {
		if (!opts.pi) throw new Error("sendAndAwaitIdle: continue requires pi");
		opts.pi.sendUserMessage(msg);
		const MAX_POLLS = 100;
		let polls = 0;
		while (!(ctx as unknown as { isIdle(): boolean }).isIdle()) {
			if (++polls > MAX_POLLS) throw new Error("sendAndAwaitIdle: timed out");
			await new Promise<void>((r) => setTimeout(r, 0));
		}
	} else {
		// Inside withSession, ctx is ReplacedSessionContext which has sendUserMessage.
		await (ctx as unknown as { sendUserMessage(msg: string): Promise<void> }).sendUserMessage(msg);
	}
}

/**
 * Run a workflow: iterate through a preset's skill sequence, creating a new
 * session for each stage, extracting artifact paths, and advancing.
 *
 * The chain is structured so that each subsequent `newSession()` is invoked
 * on the freshCtx returned from the previous withSession — never on a captured
 * outer ctx (which Pi invalidates as soon as the session is replaced).
 */
export async function runWorkflow(
	ctx: ExtensionCommandContext,
	options: RunWorkflowOptions,
): Promise<RunWorkflowResult> {
	const dag = options.dag ?? WORKFLOW_DAG;
	const stageIds = dag.presets[options.preset];
	if (!stageIds || stageIds.length === 0) {
		return { stagesCompleted: 0, success: false, error: `Unknown preset: ${options.preset}` };
	}

	const cwd = ctx.cwd;
	const runId = generateRunId();
	const totalStages = stageIds.length;

	writeHeader(cwd, {
		runId,
		preset: options.preset,
		input: options.input,
		ts: nowIso(),
	});

	// Mutable state closed-over by the chain. Per-level closures update these
	// while their ctx is still valid; the top-level await returns the snapshot.
	// `originalInput` is frozen — the user's `/rpiv` argument. `artifactPath`
	// starts undefined and only takes a value once a stage actually produces a
	// `.rpiv/artifacts/...` path, so `countPhases` is never handed raw user
	// text masquerading as a file path.
	const state = {
		originalInput: options.input,
		artifactPath: undefined as string | undefined,
		manifest: undefined as Manifest | undefined,
		stagesCompleted: 0,
		jsonlStage: 0,
		success: false,
		error: undefined as string | undefined,
	};

	// Mark every session_start fired by an inner stage as a "child" of this
	// workflow so handlers in rpiv-core and rpiv-advisor can suppress the
	// cosmetic banner that the parent session already printed. Cleared in a
	// finally so a thrown stage doesn't strand the flag.
	markChildSession();
	try {
		await runStage(ctx, 0, { cwd, runId, dag, stageIds, totalStages, state, pi: options.pi });
	} finally {
		clearChildSession();
	}
	return {
		stagesCompleted: state.stagesCompleted,
		success: state.success,
		lastArtifact: state.artifactPath,
		error: state.error,
	};
}

/**
 * Record a stage on disk and bump the in-memory counter only on a successful
 * write — keeps stage numbers in the JSONL file contiguous even if a write
 * silently fails (see `appendStage`'s boolean return).
 */
function recordStage(
	cwd: string,
	runId: string,
	stage: Omit<WorkflowStage, "stageNumber">,
	state: RunContext["state"],
): void {
	const nextStageNumber = state.jsonlStage + 1;
	if (appendStage(cwd, runId, { stageNumber: nextStageNumber, ...stage })) {
		state.jsonlStage = nextStageNumber;
	}
}

/**
 * After a stage fails, surface every artifact recorded so far so the user
 * doesn't have to grep the JSONL to see what survived.
 */
function notifyPartialArtifacts(ctx: ChainCtx, cwd: string, runId: string): void {
	const artifactPaths = readAllStages(cwd, runId)
		.filter((s) => s.artifact)
		.map((s) => `  • ${s.skill}: ${s.artifact}`)
		.join("\n");
	if (artifactPaths) {
		ctx.ui.notify(`Artifacts produced before failure:\n${artifactPaths}`, "info");
	}
}

// ---------------------------------------------------------------------------
// Shared post-stage building blocks
//
// The two session entries (`runStageSession`, `runPhaseSession`) share a
// small kit of helpers that take only what they need — never the full
// session struct. Helpers operate on a primitive `Audit` shape (cwd/runId/
// state/skill) so they don't care whether the caller was a stage or a phase.
// ---------------------------------------------------------------------------

/** Minimal bookkeeping context: what every failure/success row needs to write. */
interface Audit {
	cwd: string;
	runId: string;
	state: RunContext["state"];
	/** Label written to the JSONL "skill" field for failed/skipped rows. */
	skill: string;
}

/**
 * Record a stage as terminally failed (status, audit row, status-line clear,
 * user-visible notify, and `state.error`), then optionally invoke `onFailure`
 * for the partial-artifacts recap. Shared between stage- and phase-mode.
 */
function recordTerminalFailure(
	ctx: ChainCtx,
	audit: Audit,
	args: {
		status: "failed" | "aborted";
		notifyMsg: string;
		notifyLevel: "warning" | "error";
		errMsg: string;
	},
	onFailure?: (ctx: ChainCtx) => void,
): void {
	recordStage(audit.cwd, audit.runId, { skill: audit.skill, status: args.status, ts: nowIso() }, audit.state);
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.notify(args.notifyMsg, args.notifyLevel);
	onFailure?.(ctx);
	audit.state.error = args.errMsg;
}

/** What kind of terminal outcome (if any) the branch shows after the agent stops. */
type StopOutcome = "ok" | "aborted" | "failed";

function classifyStopOutcome(branch: BranchEntry[]): StopOutcome {
	const stopReason = lastAssistantStopReason(branch);
	if (stopReason === "aborted") return "aborted";
	if (!hasAssistantMessage(branch) || stopReason === "error") return "failed";
	return "ok";
}

/** Snapshot of the agent's output for the just-finished session. */
interface SessionOutcome {
	branch: BranchEntry[];
	artifact: string | undefined;
	stop: StopOutcome;
}

/**
 * Read the branch for this session. "continue" policies inherit prior-stage
 * entries and must be sliced by `branchOffset`; fresh sessions start at 0.
 */
function readSessionOutcome(
	ctx: ChainCtx,
	opts: { sessionPolicy?: "fresh" | "continue"; branchOffset?: number },
): SessionOutcome {
	const fullBranch = ctx.sessionManager.getBranch() as unknown as BranchEntry[];
	const branch = opts.sessionPolicy === "continue" ? fullBranch.slice(opts.branchOffset ?? 0) : fullBranch;
	return {
		branch,
		artifact: extractArtifactPath(branch),
		stop: classifyStopOutcome(branch),
	};
}

/**
 * Halt the chain because the agent stopped abnormally (ESC abort or empty /
 * errored response). `errorMessage` is the caller-formatted text stored in
 * `state.error` for the "failed" case (stages and phases format differently).
 */
function recordStopFailure(
	ctx: ChainCtx,
	audit: Audit,
	stop: Exclude<StopOutcome, "ok">,
	errorMessage: string,
	onFailure?: (ctx: ChainCtx) => void,
): void {
	if (stop === "aborted") {
		recordTerminalFailure(
			ctx,
			audit,
			{
				status: "aborted",
				notifyMsg: MSG_STAGE_ABORTED(audit.skill),
				notifyLevel: "warning",
				errMsg: `${audit.skill} aborted by user (ESC)`,
			},
			onFailure,
		);
		return;
	}
	recordTerminalFailure(
		ctx,
		audit,
		{
			status: "failed",
			notifyMsg: MSG_STAGE_FAILED(audit.skill),
			notifyLevel: "error",
			errMsg: errorMessage,
		},
		onFailure,
	);
}

// ---------------------------------------------------------------------------
// Manifest extraction + output validation
// ---------------------------------------------------------------------------

/** Discriminated result of `extractAndValidateManifest`. */
type ExtractionOutcome =
	| { kind: "ok"; manifest: Manifest | undefined }
	| { kind: "fatal"; message: string }
	| { kind: "validation-exhausted"; failureSummary: string };

/**
 * Run the extractor, finalize the envelope with runner-owned `meta`, then
 * run the output-validation retry loop (if the node declares a schema). The
 * retry loop re-invokes the extractor against the most recent branch after
 * each agent reply, hence the `freshBranch` thunk.
 */
async function extractAndValidateManifest(
	ctx: ChainCtx,
	s: StageSession,
	branch: BranchEntry[],
	freshBranch: () => BranchEntry[],
): Promise<ExtractionOutcome> {
	const node = s.node;
	const extractor = resolveExtractor(node);
	const extractorBranchOffset = node.sessionPolicy === "continue" ? undefined : s.branchOffset;

	const extractorCtx: ExtractorCtx = {
		cwd: s.cwd,
		runId: s.runId,
		stageIndex: s.stageIndex,
		state: s.state,
		branch,
		branchOffset: extractorBranchOffset,
		snapshot: s.snapshot,
		skill: s.skill,
	};

	const wrap = (payload: ExtractorPayload): Manifest =>
		finalizeManifest(payload, {
			skill: s.skill,
			stage: s.state.jsonlStage + 1,
			ts: nowIso(),
			runId: s.runId,
		});

	const first = await extractor(extractorCtx);
	if (first.fatal) return { kind: "fatal", message: first.fatal };
	let manifest: Manifest | undefined = first.payload ? wrap(first.payload) : undefined;

	if (!node.outputSchema || !manifest?.data) return { kind: "ok", manifest };

	const maxRetries = Math.min(node.maxValidationRetries ?? DEFAULT_VALIDATION_RETRIES, MAX_VALIDATION_RETRIES);
	let result = validateManifestData(node.outputSchema, manifest.data);
	let attempts = 0;

	while (!result.valid && attempts < maxRetries) {
		if (node.onValidationFailure === "halt") break;
		attempts++;
		ctx.ui.notify(MSG_VALIDATION_RETRY(s.skill, attempts), "warning");
		await sendAndAwaitIdle(ctx, formatValidationFailuresForAgent(s.skill, result.failures), {
			sessionPolicy: node.sessionPolicy,
			pi: s.pi,
		});

		const reExtract = await extractor({ ...extractorCtx, branch: freshBranch() });
		if (!reExtract.payload) {
			return {
				kind: "fatal",
				message: reExtract.fatal ?? `${s.skill}: extractor returned no manifest on retry ${attempts}`,
			};
		}
		manifest = wrap(reExtract.payload);
		result = validateManifestData(node.outputSchema, manifest.data);
	}

	if (!result.valid) {
		const failureSummary = result.failures.map((f) => `${f.path}: ${f.message}`).join("; ");
		return { kind: "validation-exhausted", failureSummary };
	}
	return { kind: "ok", manifest };
}

// ---------------------------------------------------------------------------
// Stage + phase post-processing
// ---------------------------------------------------------------------------

/**
 * Commit a successful stage to disk + in-memory state: dual-write artifact
 * path, update `state.manifest`, append the JSONL row.
 */
function persistStageSuccess(s: StageSession, artifact: string | undefined, manifest: Manifest | undefined): void {
	if (manifest?.artifact_path) s.state.artifactPath = manifest.artifact_path;
	else if (artifact) s.state.artifactPath = artifact;
	if (manifest) s.state.manifest = manifest;

	recordStage(s.cwd, s.runId, { skill: s.skill, artifact, status: "completed", ts: nowIso(), manifest }, s.state);
}

/** Stage post-processing: extract → validate → persist → notify → chain. */
async function postStage(ctx: ChainCtx, s: StageSession): Promise<void> {
	const audit: Audit = { cwd: s.cwd, runId: s.runId, state: s.state, skill: s.skill };
	const outcome = readSessionOutcome(ctx, { sessionPolicy: s.node.sessionPolicy, branchOffset: s.branchOffset });

	if (outcome.stop !== "ok") {
		recordStopFailure(ctx, audit, outcome.stop, `${s.skill} failed`, s.onFailure);
		return;
	}

	const result = await extractAndValidateManifest(
		ctx,
		s,
		outcome.branch,
		() => ctx.sessionManager.getBranch() as unknown as BranchEntry[],
	);
	if (result.kind === "fatal") {
		recordTerminalFailure(
			ctx,
			audit,
			{
				status: "failed",
				notifyMsg: MSG_STAGE_FAILED(s.skill),
				notifyLevel: "error",
				errMsg: result.message,
			},
			s.onFailure,
		);
		return;
	}
	if (result.kind === "validation-exhausted") {
		recordTerminalFailure(
			ctx,
			audit,
			{
				status: "failed",
				notifyMsg: MSG_VALIDATION_EXHAUSTED(s.skill),
				notifyLevel: "error",
				errMsg: ERR_VALIDATION_FAILED(s.skill, result.failureSummary),
			},
			s.onFailure,
		);
		return;
	}

	persistStageSuccess(s, outcome.artifact, result.manifest);
	ctx.ui.notify(MSG_STAGE_COMPLETE(s.skill), "info");
	s.state.stagesCompleted++;
	await s.onSuccess(ctx, outcome.artifact);
}

/** Per-phase JSONL row label, e.g. "implement (phase 2/4)". */
const phaseRowLabel = (s: PhaseSession) => `${s.skill} (phase ${s.phaseIndex}/${s.phaseCount})`;

/** Phase post-processing: no extraction; persist bare row + chain. */
async function postPhase(ctx: ChainCtx, s: PhaseSession): Promise<void> {
	const audit: Audit = { cwd: s.cwd, runId: s.runId, state: s.state, skill: s.skill };
	const outcome = readSessionOutcome(ctx, { sessionPolicy: "fresh" });

	if (outcome.stop !== "ok") {
		recordStopFailure(ctx, audit, outcome.stop, `${s.skill} phase ${s.phaseIndex} failed`);
		return;
	}

	if (outcome.artifact) s.state.artifactPath = outcome.artifact;
	recordStage(
		s.cwd,
		s.runId,
		{ skill: phaseRowLabel(s), artifact: outcome.artifact, status: "completed", ts: nowIso() },
		s.state,
	);
	// Phases hold the MSG_STAGE_COMPLETE notify until the parent stage finishes.
	s.state.stagesCompleted++;
	await s.onSuccess(ctx);
}

// ---------------------------------------------------------------------------
// Session spawn primitive + public entries
// ---------------------------------------------------------------------------

/** Discriminator + payload for `spawnSession`. */
type SessionSpawn = { kind: "fresh" } | { kind: "continue"; pi: ExtensionAPI };

/**
 * Drive one Pi session: send the prompt + await idle, then run `body` on the
 * ctx that's valid for the spawned session — `freshCtx` inside `withSession`
 * for fresh policies, the supplied `ctx` for continue policies.
 *
 * `onCancelled` fires only when a fresh session is cancelled before
 * `withSession` returned.
 */
async function spawnSession(
	ctx: ChainCtx,
	prompt: string,
	spawn: SessionSpawn,
	body: (sessionCtx: ChainCtx) => Promise<void>,
	onCancelled?: () => void,
): Promise<void> {
	if (spawn.kind === "continue") {
		await sendAndAwaitIdle(ctx, prompt, { sessionPolicy: "continue", pi: spawn.pi });
		await body(ctx);
		return;
	}

	const { cancelled } = await ctx.newSession({
		withSession: async (freshCtx) => {
			await freshCtx.sendUserMessage(prompt);
			await body(freshCtx);
		},
	});

	if (cancelled && onCancelled) onCancelled();
}

/** Bookkeeping for a user-cancelled fresh session — JSONL row + notify + state.error. */
function recordCancellation(ctx: ChainCtx, audit: Audit): void {
	recordStage(audit.cwd, audit.runId, { skill: audit.skill, status: "skipped", ts: nowIso() }, audit.state);
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.notify(MSG_WORKFLOW_CANCELLED, "info");
	// Distinguish "user cancelled" from "workflow never started" — both land
	// in the caller as `success: false`; the error string is the only signal
	// that disambiguates the two cases.
	audit.state.error = `${audit.skill} cancelled by user`;
}

/** Execute one DAG stage in its own session. */
export async function runStageSession(ctx: ChainCtx, s: StageSession): Promise<void> {
	const spawn: SessionSpawn =
		s.node.sessionPolicy === "continue" ? { kind: "continue", pi: s.pi! } : { kind: "fresh" };
	const audit: Audit = { cwd: s.cwd, runId: s.runId, state: s.state, skill: s.skill };
	await spawnSession(
		ctx,
		s.prompt,
		spawn,
		(sessionCtx) => postStage(sessionCtx, s),
		() => recordCancellation(ctx, audit),
	);
}

/** Execute one phase iteration of an implement stage. Always fresh. */
export async function runPhaseSession(ctx: ChainCtx, s: PhaseSession): Promise<void> {
	const audit: Audit = { cwd: s.cwd, runId: s.runId, state: s.state, skill: s.skill };
	await spawnSession(
		ctx,
		s.prompt,
		{ kind: "fresh" },
		(sessionCtx) => postPhase(sessionCtx, s),
		() => recordCancellation(ctx, audit),
	);
}

/**
 * Build the prompt + status label + audit label for a node based on its kind.
 * Phase 1 only implements `kind: "skill"`; future variants slot in here.
 *
 * The returned `skillLabel` is what gets surfaced in the status line and the
 * JSONL audit row — for skill-kind nodes that's the underlying skill name
 * (matches pre-refactor labels), for future kinds it'll be a kind-specific
 * label derived from the node body.
 */
function dispatchNode(node: DagNode, inputForStage: string): { prompt: string; skillLabel: string } {
	switch (node.kind) {
		case "skill":
			return {
				prompt: `/skill:${node.skill} ${inputForStage}`,
				skillLabel: node.skill,
			};
		default: {
			// Last-resort guard — validateDag should have rejected unknown
			// kinds at config-load time. With only one variant in `DagNode`
			// today the TypeScript exhaustiveness check via `const x: never =
			// node` can't be expressed without an error; once chat/script
			// kinds land, add their cases and switch this default to
			// `assertNever(node)` to get type-level narrowing.
			const unknownKind = (node as { kind?: unknown }).kind;
			throw new Error(`runStage: unsupported node kind: ${String(unknownKind)}`);
		}
	}
}

/**
 * Run a single workflow stage at index `idx`, then chain into the next stage
 * (or finalize) using whichever ctx is valid inside withSession.
 */
async function runStage(curCtx: ChainCtx, idx: number, run: RunContext): Promise<void> {
	const { cwd, runId, dag, stageIds, totalStages, state } = run;

	if (idx >= stageIds.length) {
		curCtx.ui.setStatus(STATUS_KEY, undefined);
		curCtx.ui.notify(MSG_WORKFLOW_COMPLETE(state.stagesCompleted), "info");
		state.success = true;
		return;
	}

	const id = stageIds[idx]!;
	const node = dag.nodes[id];
	if (!node) {
		// validateDag should have caught this — defensive throw for runtime
		// guarantee. Bypassing validation (e.g. via test fixture) lands here.
		throw new Error(`runStage: node id "${id}" referenced by preset but missing from dag.nodes`);
	}
	const stageNumber = idx + 1;

	// Multi-phase expand: when an implement *skill* runs against a plan artifact
	// with `## Phase N:` headings, fan out one session per phase. Keyed on the
	// underlying skill name (not the node id) so any skill-node pointing at
	// "implement" gets the same behavior. Phase-iteration logic lives in
	// implement-phases.ts; we inject the runner's primitives as deps so that
	// module never imports back from runner.ts (cycle-free).
	if (node.kind === "skill" && node.skill === "implement" && state.artifactPath) {
		const phaseCount = countPhases(state.artifactPath, cwd);
		if (phaseCount > 0) {
			await runImplementPhases(curCtx, idx, 1, phaseCount, run, {
				runPhaseSession,
				runNextStage: runStage,
			});
			return;
		}
	}

	// First stage has no prior artifact yet — fall back to the original brief
	// so /skill:<name> gets a meaningful argument.
	const inputForStage = state.artifactPath ?? state.originalInput;
	const { prompt, skillLabel } = dispatchNode(node, inputForStage);

	// Update the persistent status line — survives the `newSession` transition
	// in a way `ui.notify` does not.
	curCtx.ui.setStatus(STATUS_KEY, STATUS_STAGE(stageNumber, totalStages, skillLabel));

	// Block implement + continue — phase fanout assumes per-phase session isolation.
	if (node.kind === "skill" && node.skill === "implement" && node.sessionPolicy === "continue") {
		throw new Error(
			`runStage: implement node "${id}" cannot use sessionPolicy "continue" — ` +
				"phase fanout requires per-phase session isolation",
		);
	}

	// Validate pi is available for continue stages.
	if (node.sessionPolicy === "continue" && !run.pi) {
		throw new Error(
			`runStage: node "${id}" uses sessionPolicy "continue" but no pi (ExtensionAPI) was provided to runWorkflow`,
		);
	}

	// Compute branch offset — entries before this index belong to prior stages.
	const branchOffset =
		node.sessionPolicy === "continue"
			? (curCtx.sessionManager.getBranch() as unknown as BranchEntry[]).length
			: undefined;

	// --- Input validation (Phase 5) ---
	// `node.skill` is only present on SkillNode; narrow before access. Future
	// node kinds (chat/script) get a placeholder label until they grow real ones.
	const nodeLabel = node.kind === "skill" ? node.skill : id;

	if (node.inputSchema && state.manifest?.data !== undefined) {
		const result = validateManifestData(node.inputSchema, state.manifest.data);
		if (!result.valid) {
			const failureSummary = result.failures.map((f) => `${f.path}: ${f.message}`).join("; ");
			const prevSkill = state.manifest.meta.skill || "unknown";

			// Inline halt — input validation runs before the session opens, so
			// runStage's locals (curCtx, cwd, runId, state) are still the valid
			// surface; building a StageSession just to call recordTerminalFailure
			// would obscure the early-exit shape.
			recordStage(cwd, runId, { skill: nodeLabel, status: "failed", ts: nowIso() }, state);
			curCtx.ui.setStatus(STATUS_KEY, undefined);
			curCtx.ui.notify(MSG_INPUT_VALIDATION_FAILED(nodeLabel, prevSkill), "error");
			notifyPartialArtifacts(curCtx, cwd, runId);
			state.error = ERR_INPUT_VALIDATION_FAILED(nodeLabel, prevSkill, failureSummary);
			return;
		}
	}

	// Pre-stage snapshot (if node declares one)
	let snapshotResult: unknown;
	if (node.snapshot) {
		try {
			snapshotResult = await node.snapshot({ cwd, runId, stageIndex: idx, state, pi: run.pi });
		} catch {
			// Fail-soft: snapshot failure doesn't prevent stage execution
		}
	}

	await runStageSession(curCtx, {
		cwd,
		runId,
		state,
		prompt,
		skill: skillLabel,
		node,
		stageIndex: idx,
		snapshot: snapshotResult,
		pi: run.pi,
		branchOffset,
		onFailure: (freshCtx) => notifyPartialArtifacts(freshCtx, cwd, runId),
		onSuccess: async (freshCtx) => {
			try {
				const nextId = resolveNextStageId(dag, id, stageIds, idx, state);
				if (!nextId) {
					freshCtx.ui.setStatus(STATUS_KEY, undefined);
					freshCtx.ui.notify(MSG_WORKFLOW_COMPLETE(state.stagesCompleted), "info");
					state.success = true;
					return;
				}
				const nextIdx = stageIds.indexOf(nextId);
				if (nextIdx < 0) throw new Error(`resolveNextStageId returned "${nextId}" not in preset`);

				// Log routing decision if different from linear advance
				const linearNext = stageIds[idx + 1];
				if (nextId !== linearNext) {
					appendRoutingDecision(cwd, runId, {
						type: "routing",
						fromStage: idx + 1,
						fromNode: id,
						decision: nextId,
						ts: nowIso(),
					});
				}

				await runStage(freshCtx, nextIdx, run);
			} catch (e) {
				freshCtx.ui.setStatus(STATUS_KEY, undefined);
				state.error = e instanceof Error ? e.message : String(e);
			}
		},
	});
}
