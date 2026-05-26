/**
 * Built-in workflows shipped with rpiv-pi. Each workflow's `stages`
 * insertion order IS its linear stage order — `Object.keys(stages)` gives
 * the natural read order for previews and traversal alike.
 *
 * Route edges use `gate(...)` from `@juicesharp/rpiv-workflow`, which
 * attaches `.targets` metadata so reachability checks and graph
 * introspectors can enumerate possible branches without probing.
 *
 * These workflows name skills bundled by rpiv-pi (research, design, plan,
 * implement, validate, code-review, revise, commit). Installing
 * rpiv-workflow without rpiv-pi means these workflows aren't loaded —
 * users author their own over their own skills.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	acts,
	defineRoute,
	defineWorkflow,
	eq,
	type FanoutFn,
	gate,
	gitCommitOutcome,
	gt,
	handleToString,
	produces,
	typeboxSchema,
	type Workflow,
} from "@juicesharp/rpiv-workflow";
import { Type } from "typebox";
import { rpivBucketOutcome } from "./artifact-collector.js";

const CODE_REVIEW_SCHEMA = typeboxSchema(
	Type.Object({ blockers_count: Type.Integer({ minimum: 0 }) }, { additionalProperties: true }),
);

/**
 * Status discriminator for the review-loop workflow's code-review stage.
 *
 * Three statuses are emitted by the code-review skill:
 *   - "approved"           — review passed, route to commit
 *   - "needs_changes"      — issues found, route to blueprint (fix loop)
 *   - "requesting_changes" — criticals > 3, route to blueprint (fix loop)
 *
 * The routing predicate collapses "needs_changes" and "requesting_changes"
 * into the same "blueprint" branch — both mean "not approved, go fix it".
 */
const REVIEW_STATUS_SCHEMA = typeboxSchema(
	Type.Object(
		{
			status: Type.Union([
				Type.Literal("approved"),
				Type.Literal("needs_changes"),
				Type.Literal("requesting_changes"),
			]),
		},
		{ additionalProperties: true },
	),
);

/**
 * Markdown `## Phase N:` headings in the inherited plan artifact define
 * fanout units for the bundled `implement` skill. The convention lives
 * here — rpiv-workflow knows nothing about phases.
 *
 * Cap: a plan declaring more than 32 phases throws. The rpiv-pi `plan`
 * skill caps around 8 phases in practice; 32 leaves headroom for stretch
 * plans without letting a pathological (or hostile) plan drive an
 * unbounded fanout loop.
 */
const MAX_PHASES = 32;

const PHASE_FANOUT: FanoutFn = ({ artifact: primary, cwd }) => {
	if (!primary || primary.handle.kind !== "fs") return [];
	const path = primary.handle.path;
	const abs = isAbsolute(path) ? path : join(cwd, path);
	const content = readFileSync(abs, "utf-8");
	const matches = [...content.matchAll(/^## Phase (\d+):/gm)];
	if (matches.length > MAX_PHASES) {
		throw new Error(
			`PHASE_FANOUT: plan ${path} declares ${matches.length} phases — exceeds MAX_PHASES (${MAX_PHASES}); split into smaller plans`,
		);
	}
	const promptPath = handleToString(primary.handle);
	return matches.map((m, i) => ({
		prompt: `${promptPath} Phase ${m[1]}`,
		label: `phase ${i + 1}/${matches.length}`,
	}));
};

// ===========================================================================
// feat — blueprint → implement → validate → commit
// ===========================================================================

const featWorkflow = defineWorkflow({
	name: "feat",
	description:
		"Quick implementation: plan → implement → validate → commit. Best for small to medium features (up to ~7 files).",
	start: "blueprint",
	stages: {
		blueprint: produces({ outcome: rpivBucketOutcome("plans") }),
		implement: acts({ fanout: PHASE_FANOUT }),
		validate: produces({ outcome: rpivBucketOutcome("validation") }),
		commit: acts({ outcome: gitCommitOutcome }),
	},
	edges: {
		blueprint: "implement",
		implement: "validate",
		validate: "commit",
		commit: "stop",
	},
});

// ===========================================================================
// mid — research → blueprint → implement → validate → code-review →
//       (revise → implement → loop) | commit
//       Loops until code-review reports zero blockers, bounded by the
//       runner's maxBackwardJumps (default 2 → up to 3 review iterations).
// ===========================================================================

const midWorkflow = defineWorkflow({
	name: "mid",
	start: "research",
	stages: {
		research: produces({ outcome: rpivBucketOutcome("research") }),
		blueprint: produces({ outcome: rpivBucketOutcome("plans") }),
		implement: acts({ fanout: PHASE_FANOUT }),
		validate: produces({ outcome: rpivBucketOutcome("validation") }),
		"code-review": produces({ outcome: rpivBucketOutcome("reviews"), outputSchema: CODE_REVIEW_SCHEMA }),
		revise: produces({ outcome: rpivBucketOutcome("plans") }),
		commit: acts({ outcome: gitCommitOutcome }),
	},
	edges: {
		research: "blueprint",
		blueprint: "implement",
		implement: "validate",
		validate: "code-review",
		"code-review": gate("blockers_count", { revise: gt(0), commit: eq(0) }),
		// Backward edge: revise → implement re-enters the implement/validate/
		// code-review cycle. Bounded by the runner's default maxBackwardJumps
		// (2), permitting at most 3 review iterations before the guard halts.
		revise: "implement",
		commit: "stop",
	},
});

// ===========================================================================
// large — research → design → plan → implement → validate → code-review →
//         (design → loop) | commit
//         Loops the full design/plan/implement/validate/review chain until
//         code-review reports zero blockers, bounded by the runner's
//         maxBackwardJumps (default 2 → up to 3 review iterations).
// ===========================================================================

const largeWorkflow = defineWorkflow({
	name: "large",
	start: "research",
	stages: {
		research: produces({ outcome: rpivBucketOutcome("research") }),
		design: produces({ outcome: rpivBucketOutcome("designs") }),
		plan: produces({ outcome: rpivBucketOutcome("plans") }),
		implement: acts({ fanout: PHASE_FANOUT }),
		validate: produces({ outcome: rpivBucketOutcome("validation") }),
		"code-review": produces({ outcome: rpivBucketOutcome("reviews"), outputSchema: CODE_REVIEW_SCHEMA }),
		commit: acts({ outcome: gitCommitOutcome }),
	},
	edges: {
		research: "design",
		design: "plan",
		plan: "implement",
		implement: "validate",
		validate: "code-review",
		// Backward edge: code-review → design re-enters the full
		// design/plan/implement/validate/review cycle. Bounded by the
		// runner's default maxBackwardJumps (2), permitting at most 3
		// review iterations before the guard halts.
		"code-review": gate("blockers_count", { design: gt(0), commit: eq(0) }),
		commit: "stop",
	},
});

// ===========================================================================
// review-loop — code-review → (blueprint → implement → validate → loop) | commit
//              Review existing changes; if not approved, blueprint a fix plan,
//              implement it, validate, and re-review. Loops until approved.
// ===========================================================================

const reviewLoopWorkflow = defineWorkflow({
	name: "review-loop",
	start: "code-review",
	stages: {
		"code-review": produces({ outcome: rpivBucketOutcome("reviews"), outputSchema: REVIEW_STATUS_SCHEMA }),
		blueprint: produces({ outcome: rpivBucketOutcome("plans") }),
		implement: acts({ fanout: PHASE_FANOUT }),
		validate: produces({ outcome: rpivBucketOutcome("validation") }),
		commit: acts({ outcome: gitCommitOutcome }),
	},
	edges: {
		// Uses defineRoute (not gate()) because the routing decision is based
		// on a string status discriminator, not a numeric threshold — gate()
		// is designed for numeric comparisons (e.g., blockers_count > 0).
		// The `outputSchema` on the code-review stage guarantees `data.status`
		// is validated before this predicate runs, so the undefined/null case
		// is unreachable in practice (the predicate's fallback to "blueprint"
		// is defensive only).
		"code-review": defineRoute(["blueprint", "commit"], ({ output }) => {
			const data = output?.data as Record<string, unknown> | undefined;
			return data?.status === "approved" ? "commit" : "blueprint";
		}),
		blueprint: "implement",
		implement: "validate",
		// Backward edge: validate → code-review creates the review-fix loop.
		// Bounded by the runner's default maxBackwardJumps (2), permitting at
		// most 3 review iterations (initial + 2 retries) before the guard halts.
		validate: "code-review",
		commit: "stop",
	},
});

// ===========================================================================
// Exports
// ===========================================================================

export const builtInWorkflows: readonly Workflow[] = [featWorkflow, midWorkflow, largeWorkflow, reviewLoopWorkflow];
