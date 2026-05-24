/**
 * Built-in workflows expressed in the TS-native format.
 *
 * `builtInWorkflows` is the source of truth; `dag.ts:WORKFLOW_DAG` is now
 * a derived value computed by `compile.ts`. Each workflow's `nodes`
 * insertion order IS its linear stage order (the compiler preserves it
 * when emitting the legacy `presets[name]` list).
 *
 * Predicate edges use `threshold(...)` from `api.ts`, which attaches
 * `.targets` metadata so the compiler can emit the legacy choice/predicate
 * edge shape without probing.
 *
 * Additional nodes (discover, explore, outline-test-cases, etc.) live
 * outside `builtInWorkflows` in `extraNodes` / `extraEdges` — they remain
 * in `WORKFLOW_DAG.nodes` for `getEdge` and `isValidNode` consumers but
 * aren't reachable from any executable preset. They'll fold into proper
 * Workflows when the user-config format change lands.
 */

import { Type } from "typebox";
import { action, defineWorkflow, type EdgeTarget, type NodeDef, skill, threshold, type Workflow } from "./api.js";
import { gitCommitExtractor } from "./extractors/index.js";

const CODE_REVIEW_SCHEMA = Type.Object(
	{ severeIssueCount: Type.Integer({ minimum: 0 }) },
	{ additionalProperties: true },
);

// ===========================================================================
// small — blueprint → implement → validate
// ===========================================================================

const smallWorkflow = defineWorkflow({
	name: "small",
	start: "blueprint",
	nodes: {
		blueprint: skill("blueprint"),
		implement: action("implement"),
		validate: skill("validate"),
	},
	edges: {
		blueprint: "implement",
		implement: "validate",
		validate: "stop",
	},
});

// ===========================================================================
// mid — research → blueprint → implement → validate → code-review →
//       (revise → implement-after-revise → commit) | commit
// ===========================================================================

const midWorkflow = defineWorkflow({
	name: "mid",
	start: "research",
	nodes: {
		research: skill("research"),
		blueprint: skill("blueprint"),
		implement: action("implement"),
		validate: skill("validate"),
		"code-review": skill("code-review", { outputSchema: CODE_REVIEW_SCHEMA }),
		revise: skill("revise"),
		"implement-after-revise": action("implement-after-revise", { skill: "implement" }),
		commit: action("commit", { extractor: gitCommitExtractor }),
	},
	edges: {
		research: "blueprint",
		blueprint: "implement",
		implement: "validate",
		validate: "code-review",
		"code-review": threshold("severeIssueCount", 0, "revise", "commit"),
		revise: "implement-after-revise",
		"implement-after-revise": "commit",
		commit: "stop",
	},
});

// ===========================================================================
// large — research → design → plan → implement → validate → code-review-large →
//         (design-after-review → plan-after-review → implement-after-review → commit) | commit
// ===========================================================================

const largeWorkflow = defineWorkflow({
	name: "large",
	start: "research",
	nodes: {
		research: skill("research"),
		design: skill("design"),
		plan: skill("plan"),
		implement: action("implement"),
		validate: skill("validate"),
		"code-review-large": skill("code-review-large", { skill: "code-review", outputSchema: CODE_REVIEW_SCHEMA }),
		"design-after-review": skill("design-after-review", { skill: "design" }),
		"plan-after-review": skill("plan-after-review", { skill: "plan" }),
		"implement-after-review": action("implement-after-review", { skill: "implement" }),
		commit: action("commit", { extractor: gitCommitExtractor }),
	},
	edges: {
		research: "design",
		design: "plan",
		plan: "implement",
		implement: "validate",
		validate: "code-review-large",
		"code-review-large": threshold("severeIssueCount", 0, "design-after-review", "commit"),
		"design-after-review": "plan-after-review",
		"plan-after-review": "implement-after-review",
		"implement-after-review": "commit",
		commit: "stop",
	},
});

// ===========================================================================
// Exports
// ===========================================================================

// Workflow ordering affects compile-to-legacy-DAG output: when multiple
// workflows define edges from the same node to different targets, the legacy
// "choice" edge merges them — and the merged `to[]` array reflects the
// order in which workflows were processed. Order = [small, large, mid] so
// e.g. research's choice edge resolves to ["design" (from large), "blueprint"
// (from mid)] — matches the legacy hand-authored ordering.
export const builtInWorkflows: readonly Workflow[] = [smallWorkflow, largeWorkflow, midWorkflow];

/**
 * Skill nodes available for reference by name but not currently reachable
 * from any built-in preset. Preserved so `getEdge(WORKFLOW_DAG, "discover")`
 * and `isValidNode("discover")` continue to work. Folded into proper
 * Workflows when the user-config format lands.
 */
export const extraNodes: Record<string, NodeDef> = {
	discover: skill("discover"),
	explore: skill("explore"),
	"outline-test-cases": skill("outline-test-cases"),
	"write-test-cases": action("write-test-cases"),
	"annotate-guidance": action("annotate-guidance"),
	"migrate-to-guidance": skill("migrate-to-guidance"),
};

/**
 * Edges originating from `extraNodes` — matches the previous global edge
 * table so `getEdge(WORKFLOW_DAG, "discover")` etc. still resolve.
 */
export const extraEdges: Record<string, EdgeTarget> = {
	discover: "research",
	"outline-test-cases": "write-test-cases",
	"migrate-to-guidance": "annotate-guidance",
};
