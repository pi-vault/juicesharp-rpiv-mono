/**
 * Declarative skill-name remapping, applied once at load time.
 *
 * `aliasSkills(w, aliases)` rewrites every dispatching stage whose effective
 * skill (`stage.skill ?? stageName`) has an alias entry, materialising the
 * `skill` field on stages that relied on the stage-key default. Because the
 * remap happens in the loader — before validation and before the runner ever
 * sees the workflow — `/wf` preview, JSONL audit, and the runtime
 * skill-registry preflight all observe the final skill for free; the runner
 * needs no change.
 *
 * Invariants:
 *   - One hop only — looks up `aliases[effective]`, never `aliases[target]`.
 *     No transitive chains, no cycles.
 *   - `run` / `prompt` stages are skipped — they don't dispatch a `/skill:`.
 *     (`fanout` / `iterate` stages carry neither `run` nor `prompt`, so they
 *     ARE dispatching stages and get aliased.)
 *   - Never mutates its input. Returns `w` by reference when nothing changed,
 *     so the shared process-wide built-in registry (anchored on a `globalThis`
 *     slot) is never mutated in place; a changed workflow is a new frozen copy.
 */

import type { StageDef, Workflow } from "../api.js";

/**
 * A stage dispatches a `/skill:<name>` exactly when it carries neither a `run`
 * (script body) nor a `prompt` (raw-text body). `fanout`/`iterate` stages carry
 * neither, so they ARE dispatching stages. Single source of truth shared by the
 * alias remap below (which stages to rewrite) and the no-op-alias warning in
 * `load/index.ts` (which skills count as "dispatched") — the two must agree.
 */
export function isDispatchingStage(stage: StageDef): boolean {
	return stage.run == null && stage.prompt == null;
}

export function aliasSkills(w: Workflow, aliases: Record<string, string>): Workflow {
	if (!aliases || Object.keys(aliases).length === 0) return w;
	let changed = false;
	const stages: typeof w.stages = {};
	for (const [name, stage] of Object.entries(w.stages)) {
		const dispatches = isDispatchingStage(stage); // only /skill: stages
		const effective = stage.skill ?? name;
		const target = aliases[effective];
		if (dispatches && target && target !== effective) {
			stages[name] = { ...stage, skill: target }; // materialise implicit skill
			changed = true;
		} else {
			stages[name] = stage;
		}
	}
	return changed ? Object.freeze({ ...w, stages }) : w; // never mutate shared built-ins
}
