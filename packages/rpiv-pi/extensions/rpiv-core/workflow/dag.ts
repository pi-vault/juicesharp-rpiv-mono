/**
 * DAG definition + validation for the /rpiv workflow command. Static
 * adjacency array, `nodes` metadata table, named presets. Functions take
 * the DAG explicitly so tests can pass alternatives.
 */

import { type TSchema, Type } from "typebox";
import { BUNDLED_SKILL_NAMES } from "../paths.js";
import { gitCommitExtractor, gitHeadSnapshot } from "./extractors/index.js";
import type { ExtractorFn, SnapshotFn } from "./manifest.js";
import { predicateThreshold } from "./predicates.js";
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
	snapshot?: SnapshotFn;
	/** Defaults to artifact-md (artifact-emit) / side-effect (agent-end). */
	extractor?: ExtractorFn;
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
		snapshot?: SnapshotFn;
		extractor?: ExtractorFn;
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
	snapshot: overrides?.snapshot,
	extractor: overrides?.extractor,
	outputSchema: overrides?.outputSchema,
	onValidationFailure: overrides?.onValidationFailure,
	maxValidationRetries: overrides?.maxValidationRetries,
	validationRetryTimeoutMs: overrides?.validationRetryTimeoutMs,
	inputSchema: overrides?.inputSchema,
});

// Shared schema for every code-review node — gates the predicate edges so
// `retryUntilValid` rejects a manifest missing `severeIssueCount` before
// the routing layer ever sees it.
const CODE_REVIEW_SCHEMA = Type.Object(
	{ severeIssueCount: Type.Integer({ minimum: 0 }) },
	{ additionalProperties: true },
);

export const WORKFLOW_DAG: WorkflowDag = {
	edges: [
		{ from: "discover", to: ["research"], condition: "auto" },
		{ from: "design", to: ["plan"], condition: "auto" },
		{ from: "plan", to: ["implement"], condition: "auto" },
		{ from: "blueprint", to: ["implement"], condition: "auto" },
		{ from: "implement", to: ["validate"], condition: "auto" },
		// `validate` is the build/review boundary; its actual successor depends
		// on the preset profile (small: none, mid: code-review, large:
		// code-review-large). Choice edges fall through to `linearNextOf` in
		// `routing.ts`, so the right successor is picked from each preset's
		// linear sequence at runtime — no per-preset edge fanout needed.
		{ from: "validate", to: ["code-review", "code-review-large"], condition: "choice" },
		// The second implement in `mid` is a distinct node id (skill stays
		// "implement") so routing's Array.indexOf reaches the post-revise
		// position instead of the original first implement.
		{ from: "revise", to: ["implement-after-revise"], condition: "auto" },
		// `large`'s post-review redesign tail. Distinct node ids let routing
		// reach idx 6..8 of the large preset instead of looping back to the
		// pre-validate design at idx 1.
		{ from: "design-after-review", to: ["plan-after-review"], condition: "auto" },
		{ from: "plan-after-review", to: ["implement-after-review"], condition: "auto" },
		{ from: "outline-test-cases", to: ["write-test-cases"], condition: "auto" },
		{ from: "migrate-to-guidance", to: ["annotate-guidance"], condition: "auto" },

		{ from: "research", to: ["design", "blueprint"], condition: "choice" },
		{ from: "explore", to: ["design", "blueprint"], condition: "choice" },
		{
			from: "code-review",
			to: ["revise", "commit"],
			condition: "predicate",
			predicate: predicateThreshold("severeIssueCount", 0, "revise", "commit"),
		},
		{
			from: "code-review-large",
			to: ["design-after-review", "commit"],
			condition: "predicate",
			predicate: predicateThreshold("severeIssueCount", 0, "design-after-review", "commit"),
		},
	],

	// Review-tail sizing: small terminates at validate; mid does a surgical
	// revise loop; large re-runs design/plan for architectural findings.
	presets: {
		small: ["blueprint", "implement", "validate"],
		mid: [
			"research",
			"blueprint",
			"implement",
			"validate",
			"code-review",
			"revise",
			"implement-after-revise",
			"commit",
		],
		large: [
			"research",
			"design",
			"plan",
			"implement",
			"validate",
			"code-review-large",
			"design-after-review",
			"plan-after-review",
			"implement-after-review",
			"commit",
		],
	},

	// `*-after-revise` / `*-after-review` aliases share a skill body with the
	// pre-validate node but a distinct node id, so routing.indexOf reaches the
	// post-review position instead of looping back.
	nodes: {
		discover: skillNode("discover", "artifact-emit"),
		research: skillNode("research", "artifact-emit"),
		design: skillNode("design", "artifact-emit"),
		plan: skillNode("plan", "artifact-emit"),
		blueprint: skillNode("blueprint", "artifact-emit"),
		explore: skillNode("explore", "artifact-emit"),
		validate: skillNode("validate", "artifact-emit"),
		revise: skillNode("revise", "artifact-emit"),
		"code-review": skillNode("code-review", "artifact-emit", { outputSchema: CODE_REVIEW_SCHEMA }),
		"code-review-large": skillNode("code-review", "artifact-emit", { outputSchema: CODE_REVIEW_SCHEMA }),
		"outline-test-cases": skillNode("outline-test-cases", "artifact-emit"),
		"design-after-review": skillNode("design", "artifact-emit"),
		"plan-after-review": skillNode("plan", "artifact-emit"),

		"write-test-cases": skillNode("write-test-cases", "agent-end"),
		implement: skillNode("implement", "agent-end"),
		"implement-after-revise": skillNode("implement", "agent-end"),
		"implement-after-review": skillNode("implement", "agent-end"),
		commit: skillNode("commit", "agent-end", { snapshot: gitHeadSnapshot, extractor: gitCommitExtractor }),
		"annotate-guidance": skillNode("annotate-guidance", "agent-end"),
		"migrate-to-guidance": skillNode("migrate-to-guidance", "agent-end"),
	},
};

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
