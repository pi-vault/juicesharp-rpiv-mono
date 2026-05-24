/**
 * DAG definition + validation for the /rpiv workflow command. Static
 * adjacency array, `nodes` metadata table, named presets. Functions take
 * the DAG explicitly so tests can pass alternatives.
 */

import type { TSchema } from "typebox";
import { BUNDLED_SKILL_NAMES } from "../paths.js";
import { builtInWorkflows, extraEdges, extraNodes } from "./built-in.js";
import { compileWorkflowsToDag } from "./compile.js";
import type { Extractor } from "./manifest.js";
import {
	MAX_VALIDATION_RETRIES,
	MAX_VALIDATION_RETRY_TIMEOUT_MS,
	MIN_VALIDATION_RETRIES,
	MIN_VALIDATION_RETRY_TIMEOUT_MS,
} from "./validation.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EdgeCondition = "auto" | "choice" | "predicate";

export interface DagEdge {
	from: string;
	/** "auto": one target. "choice"/"predicate": two or more. */
	to: string[];
	condition: EdgeCondition;
	/** Required when `condition === "predicate"`. */
	predicate?: import("./predicates.js").EdgePredicate;
}

export type PresetName = string;

/**
 * - `"artifact-emit"` — protocol skills that write `.rpiv/artifacts/<bucket>/<file>.md`.
 *   Runner halts the chain if the path doesn't appear in the transcript.
 * - `"agent-end"` — action skills (commit, implement) where the side effect IS
 *   the work; the chain inherits the prior `state.artifactPath`.
 */
export type CompletionStrategy = "artifact-emit" | "agent-end";

/**
 * - `"fresh"` — wraps the stage in `ctx.newSession({ withSession })`.
 * - `"continue"` — reuses the prior session via `pi.sendUserMessage()` +
 *   `ctx.waitForIdle()`; branch sliced by `branchOffset`.
 */
export type SessionPolicy = "fresh" | "continue";

interface NodeCommon {
	completionStrategy: CompletionStrategy;
	sessionPolicy: SessionPolicy;
	/** Defaults to artifact-md (artifact-emit) / side-effect (agent-end). */
	extractor?: Extractor;
	outputSchema?: TSchema;
	/** Default: "retry". */
	onValidationFailure?: "retry" | "halt";
	/** Default: 1, hard cap: MAX_VALIDATION_RETRIES. */
	maxValidationRetries?: number;
	/** Default: DEFAULT_VALIDATION_RETRY_TIMEOUT_MS, clamped to MIN/MAX. */
	validationRetryTimeoutMs?: number;
	inputSchema?: TSchema;
}

export interface SkillNode extends NodeCommon {
	kind: "skill";
	/** Must exist under `packages/rpiv-pi/skills/` (validated via BUNDLED_SKILL_NAMES). */
	skill: string;
}

/** Phase 1 has one variant; chat/script kinds slot in additively later. */
export type DagNode = SkillNode;

export interface WorkflowDag {
	edges: DagEdge[];
	presets: Record<string, string[]>;
	/** Every id used in `edges` or `presets` MUST exist here — validateDag enforces this. */
	nodes: Record<string, DagNode>;
}

// ---------------------------------------------------------------------------
// DAG edge map
// ---------------------------------------------------------------------------

/** Factory for skill nodes — defaults `kind` to "skill", `sessionPolicy` to "fresh". */
export const skillNode = (
	skill: string,
	completionStrategy: CompletionStrategy,
	overrides?: {
		sessionPolicy?: SessionPolicy;
		extractor?: Extractor;
		outputSchema?: TSchema;
		onValidationFailure?: "retry" | "halt";
		maxValidationRetries?: number;
		validationRetryTimeoutMs?: number;
		inputSchema?: TSchema;
	},
): SkillNode => ({
	kind: "skill",
	skill,
	completionStrategy,
	sessionPolicy: overrides?.sessionPolicy ?? "fresh",
	extractor: overrides?.extractor,
	outputSchema: overrides?.outputSchema,
	onValidationFailure: overrides?.onValidationFailure,
	maxValidationRetries: overrides?.maxValidationRetries,
	validationRetryTimeoutMs: overrides?.validationRetryTimeoutMs,
	inputSchema: overrides?.inputSchema,
});

/**
 * The legacy `WorkflowDag` is now a derived view computed from `builtInWorkflows`
 * (defined in TS-native form in `built-in.ts`). The compiler translates each
 * Workflow's `(nodes, edges, start)` graph into the parallel `(nodes, edges,
 * presets)` shape this module's consumers (routing.ts, runner.ts, loadConfig.ts)
 * still expect.
 *
 * `extraNodes` + `extraEdges` round out the node lexicon with skills that no
 * built-in preset reaches today (discover, explore, outline-test-cases,
 * migrate-to-guidance) — kept so `getEdge` and `isValidNode` continue to
 * resolve those names. They'll be folded into proper Workflows in Phase 5.
 *
 * This translator goes away in Phase 5 when the runner consumes `Workflow`
 * directly.
 */
export const WORKFLOW_DAG: WorkflowDag = compileWorkflowsToDag({
	workflows: builtInWorkflows,
	extraNodes,
	extraEdges,
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_COMPLETION_STRATEGIES: ReadonlySet<CompletionStrategy> = new Set(["artifact-emit", "agent-end"] as const);
const VALID_SESSION_POLICIES: ReadonlySet<SessionPolicy> = new Set(["fresh", "continue"] as const);

/** Errors gate startup; warnings are advisory. */
export interface DagValidation {
	errors: string[];
	warnings: string[];
}

export function validateDag(dag: WorkflowDag): DagValidation {
	const errors: string[] = [];
	const warnings: string[] = [];

	collectReferenceErrors(dag, errors);
	collectEdgeIssues(dag, errors, warnings);
	collectNodeErrors(dag, errors);

	return { errors, warnings };
}

function collectReferenceErrors(dag: WorkflowDag, errors: string[]): void {
	for (const edge of dag.edges) {
		if (!(edge.from in dag.nodes)) errors.push(`Edge source "${edge.from}" has no entry in nodes`);
		for (const target of edge.to) {
			if (!(target in dag.nodes)) errors.push(`Edge target "${target}" (from "${edge.from}") has no entry in nodes`);
		}
	}
	for (const [presetName, nodeIds] of Object.entries(dag.presets)) {
		for (const id of nodeIds) {
			if (!(id in dag.nodes)) errors.push(`Preset "${presetName}" references "${id}" which has no entry in nodes`);
		}
	}
}

function collectEdgeIssues(dag: WorkflowDag, errors: string[], warnings: string[]): void {
	for (const edge of dag.edges) {
		if (edge.condition !== "predicate") continue;

		if (typeof edge.predicate !== "function") {
			errors.push(
				`Edge "${edge.from} → [${edge.to.join(", ")}]" has condition "predicate" but no predicate function`,
			);
		}
		const sourceNode = dag.nodes[edge.from];
		if (sourceNode && !sourceNode.outputSchema) {
			warnings.push(
				`Predicate edge "${edge.from} → [${edge.to.join(", ")}]" reads from manifest.data but source node "${edge.from}" has no outputSchema — predicate decisions will fire on un-validated frontmatter`,
			);
		}
	}
}

function collectNodeErrors(dag: WorkflowDag, errors: string[]): void {
	for (const [id, node] of Object.entries(dag.nodes)) {
		checkCompletionStrategy(id, node, errors);
		checkSessionPolicy(id, node, errors);
		checkValidationConfig(id, node, errors);
		checkNodeKind(id, node, errors);
	}
}

function checkCompletionStrategy(id: string, node: DagNode, errors: string[]): void {
	if (!VALID_COMPLETION_STRATEGIES.has(node.completionStrategy)) {
		errors.push(`Node "${id}" has invalid completionStrategy: "${node.completionStrategy}"`);
	}
}

function checkSessionPolicy(id: string, node: DagNode, errors: string[]): void {
	if (!VALID_SESSION_POLICIES.has(node.sessionPolicy)) {
		errors.push(`Node "${id}" has invalid sessionPolicy: "${node.sessionPolicy}"`);
	}
}

function checkValidationConfig(id: string, node: DagNode, errors: string[]): void {
	if (
		node.onValidationFailure !== undefined &&
		node.onValidationFailure !== "retry" &&
		node.onValidationFailure !== "halt"
	) {
		errors.push(`Node "${id}" has invalid onValidationFailure: "${node.onValidationFailure}"`);
	}

	if (
		node.maxValidationRetries !== undefined &&
		(node.maxValidationRetries < MIN_VALIDATION_RETRIES || node.maxValidationRetries > MAX_VALIDATION_RETRIES)
	) {
		errors.push(
			`Node "${id}" has maxValidationRetries: ${node.maxValidationRetries} — must be ${MIN_VALIDATION_RETRIES}..${MAX_VALIDATION_RETRIES}`,
		);
	}

	if (
		node.validationRetryTimeoutMs !== undefined &&
		(node.validationRetryTimeoutMs < MIN_VALIDATION_RETRY_TIMEOUT_MS ||
			node.validationRetryTimeoutMs > MAX_VALIDATION_RETRY_TIMEOUT_MS)
	) {
		errors.push(
			`Node "${id}" has validationRetryTimeoutMs: ${node.validationRetryTimeoutMs} — must be ${MIN_VALIDATION_RETRY_TIMEOUT_MS}..${MAX_VALIDATION_RETRY_TIMEOUT_MS}`,
		);
	}
}

function checkNodeKind(id: string, node: DagNode, errors: string[]): void {
	switch (node.kind) {
		case "skill":
			if (!BUNDLED_SKILL_NAMES.has(node.skill)) {
				errors.push(`Node "${id}" (kind=skill) references unknown bundled skill: "${node.skill}"`);
			}
			return;
		default: {
			// Can't `assertNever(node)` yet — DagNode is a union of one, so TS won't narrow.
			const unknownKind = (node as { kind?: unknown }).kind;
			errors.push(`Node "${id}" has unknown kind: ${String(unknownKind)}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Edge traversal
// ---------------------------------------------------------------------------

export function getEdge(dag: WorkflowDag, from: string): DagEdge | undefined {
	return dag.edges.find((e) => e.from === from);
}

export function resolvePreset(dag: WorkflowDag, name: PresetName): string[] | undefined {
	return dag.presets[name];
}

/** True iff `skillName` is a real bundled skill directory. */
export function isValidNode(skillName: string): boolean {
	return BUNDLED_SKILL_NAMES.has(skillName);
}
