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
import { basename, isAbsolute, join } from "node:path";
import {
	acts,
	defineRoute,
	defineWorkflow,
	eq,
	type FanoutFn,
	type FanoutUnit,
	gate,
	gitCommitOutcome,
	gt,
	handleToString,
	type IterateFn,
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
 * Status discriminator for the vet workflow's code-review stage.
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
	if (primary?.handle.kind !== "fs") return [];
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
// ship — blueprint → implement → validate → commit
// ===========================================================================

const shipWorkflow = defineWorkflow({
	name: "ship",
	description:
		"Fast path with no research or review. Best when the change is small and the approach is obvious. Chain: blueprint → implement → validate → commit.",
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
// build — research → blueprint → implement → validate → code-review →
//         (revise → implement → loop) | commit
//         Loops until code-review reports zero blockers, bounded by the
//         runner's maxBackwardJumps (default 2 → up to 3 review iterations).
// ===========================================================================

const buildWorkflow = defineWorkflow({
	name: "build",
	description:
		"Research-backed feature work with a review loop. Best for medium changes where you want a second pass before committing. Chain: research → blueprint → implement → validate → code-review → (revise loop) → commit.",
	start: "research",
	stages: {
		research: produces({ outcome: rpivBucketOutcome("research") }),
		blueprint: produces({ outcome: rpivBucketOutcome("plans") }),
		implement: acts({ fanout: PHASE_FANOUT }),
		validate: produces({ outcome: rpivBucketOutcome("validation") }),
		"code-review": produces({ outcome: rpivBucketOutcome("reviews"), outputSchema: CODE_REVIEW_SCHEMA }),
		revise: produces({ outcome: rpivBucketOutcome("plans"), reads: ["plans", "reviews"] }),
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
// arch — research → design → plan → implement → validate → code-review →
//        (design → loop) | commit
//        Loops the full design/plan/implement/validate/review chain until
//        code-review reports zero blockers, bounded by the runner's
//        maxBackwardJumps (default 2 → up to 3 review iterations).
// ===========================================================================

const archWorkflow = defineWorkflow({
	name: "arch",
	description:
		"Design-led pipeline for complex changes touching many files or layers. Best when the approach itself needs to be worked out before planning. Chain: research → design → plan → implement → validate → code-review → (design loop) → commit.",
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
// vet — code-review → (blueprint → implement → validate → loop) | commit
//       Examine existing changes; if not approved, blueprint a fix plan,
//       implement it, validate, and re-review. Loops until approved.
// ===========================================================================

const vetWorkflow = defineWorkflow({
	name: "vet",
	description:
		"Examine existing changes for approval; loop a fix cycle if not approved. Best when a diff already exists (yours or a teammate's) and you want a structured review with optional repair. Chain: code-review → (blueprint → implement → validate → loop) → commit.",
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
// polish — architecture-review → blueprint (iterate, per review phase) →
//          implement → validate → code-review → (blueprint loop) | commit
//          For a large architecture review that can't be planned in one pass:
//          plan each review phase sequentially, each plan building on the
//          ones before it, then implement/validate/review the lot.
// ===========================================================================

/** `### Phase N — name` headings define the review's dependency-ordered phases. */
const REVIEW_PHASE_RE = /^### Phase (\d+) — (.+)$/gm;

/**
 * Per-review-phase blueprint generator (the `iterate` dual of PHASE_FANOUT).
 * One blueprint pass per review phase, each seeing the plans already produced
 * so it builds on them instead of duplicating. blueprint writes its own
 * natural `.rpiv/artifacts/plans/<slug>_<topic>.md` file — the iterate stage's
 * `plans` collector captures whatever path it announces, so no output-path
 * plumbing is needed (this is exactly the per-phase invocation the
 * architecture-review skill documents as its next step).
 */
const REVIEW_PHASE_ITERATE: IterateFn = ({ artifact, state, accumulated, cwd }) => {
	// Source the review from the named registry — robust to corrective re-entry,
	// where the rolling primary is the latest code-review doc, not the review.
	const review =
		state.named["architecture-reviews"]?.at(-1)?.artifacts.find((a) => a.handle.kind === "fs") ?? artifact;
	if (review?.handle.kind !== "fs") return null;
	const abs = isAbsolute(review.handle.path) ? review.handle.path : join(cwd, review.handle.path);
	const phases = [...readFileSync(abs, "utf-8").matchAll(REVIEW_PHASE_RE)];
	const i = accumulated.length;
	if (i >= phases.length) return null; // every phase planned → terminate
	const phaseName = phases[i]![2]!.trim();

	const prior = accumulated
		.flatMap((o) => o.artifacts)
		.filter((a) => a.handle.kind === "fs")
		.map((a) => handleToString(a.handle));
	// On a corrective pass the latest code-review is in `reviews`; fold its blockers in.
	const feedback = state.named.reviews?.at(-1)?.artifacts.find((a) => a.handle.kind === "fs");

	let prompt = `${handleToString(review.handle)} Implement Phase ${phases[i]![1]}: ${phaseName}`;
	if (prior.length) prompt += `\nPrior phase plans (read first; build on them, don't duplicate): ${prior.join(", ")}`;
	if (feedback?.handle.kind === "fs")
		prompt += `\nAddress the blockers in the latest code review: ${handleToString(feedback.handle)}`;
	return { prompt, label: `phase ${i + 1}/${phases.length} — ${phaseName}`, id: `phase-${phases[i]![1]}` };
};

/**
 * Fan implement out over the `## Phase N:` headings of EVERY plan the iterate
 * stage produced. On a corrective loop the iterate stage re-plans all review
 * phases, so `state.named["plans"]` accumulates one plan per review phase PER
 * pass; we take only the latest pass (the most recent `phaseCount` plans) so a
 * re-plan supersedes the stale generation rather than double-implementing it.
 * This is the dedup the design's deterministic-filename scheme bought — done
 * here in the fanout instead, so blueprint keeps its natural timestamped
 * filenames and needs no change.
 */
const PLANS_PHASE_FANOUT: FanoutFn = ({ state, cwd }) => {
	const plans = state.named.plans ?? [];
	const review = state.named["architecture-reviews"]?.at(-1)?.artifacts.find((a) => a.handle.kind === "fs");
	let latest = plans;
	if (review?.handle.kind === "fs") {
		const abs = isAbsolute(review.handle.path) ? review.handle.path : join(cwd, review.handle.path);
		const phaseCount = [...readFileSync(abs, "utf-8").matchAll(REVIEW_PHASE_RE)].length;
		if (phaseCount > 0 && plans.length > phaseCount) latest = plans.slice(-phaseCount);
	}

	const units: FanoutUnit[] = [];
	for (const out of latest) {
		for (const a of out.artifacts) {
			if (a.handle.kind !== "fs") continue;
			const abs = isAbsolute(a.handle.path) ? a.handle.path : join(cwd, a.handle.path);
			for (const m of readFileSync(abs, "utf-8").matchAll(/^## Phase (\d+):/gm)) {
				units.push({
					prompt: `${handleToString(a.handle)} Phase ${m[1]}`,
					label: `${basename(a.handle.path)} P${m[1]}`,
				});
			}
		}
	}
	if (units.length > MAX_PHASES) {
		throw new Error(`PLANS_PHASE_FANOUT: ${units.length} phases exceeds MAX_PHASES (${MAX_PHASES})`);
	}
	return units;
};

const polishWorkflow = defineWorkflow({
	name: "polish",
	description:
		"Architecture-review-driven polish: review → per-phase blueprint (sequential, accumulating) → implement → validate → code-review → commit. Best when a large architecture review can't be planned in one pass and each phase's plan must build on the ones before it.",
	start: "architecture-review",
	stages: {
		"architecture-review": produces({ outcome: rpivBucketOutcome("architecture-reviews") }),
		blueprint: produces({ outcome: rpivBucketOutcome("plans"), iterate: REVIEW_PHASE_ITERATE }),
		implement: acts({ fanout: PLANS_PHASE_FANOUT }),
		validate: produces({ outcome: rpivBucketOutcome("validation") }),
		"code-review": produces({ outcome: rpivBucketOutcome("reviews"), outputSchema: CODE_REVIEW_SCHEMA }),
		commit: acts({ outcome: gitCommitOutcome }),
	},
	edges: {
		"architecture-review": "blueprint",
		blueprint: "implement",
		implement: "validate",
		validate: "code-review",
		// Backward edge: code-review → blueprint re-plans (implement needs a plan).
		// The iterate stage re-runs over every review phase; bounded by the
		// runner's default maxBackwardJumps (2 → up to 3 review iterations).
		"code-review": gate("blockers_count", { commit: eq(0), blueprint: gt(0) }),
		commit: "stop",
	},
});

// ===========================================================================
// Exports
// ===========================================================================

export const builtInWorkflows: readonly Workflow[] = [
	shipWorkflow,
	buildWorkflow,
	archWorkflow,
	vetWorkflow,
	polishWorkflow,
];
