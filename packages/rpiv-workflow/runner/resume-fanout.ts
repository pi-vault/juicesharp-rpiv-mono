/**
 * Fanout-resume dispatch. When a resumed run's trail trailer is a `def.fanout`
 * unit row, `resumeWorkflow` routes here instead of the single-stage arms.
 *
 * Re-calls the stage's `FanoutFn` against the reconstructed entry artifact +
 * state (units never move the primary, so `reconstructState` rebuilt the
 * pre-fanout artifact exactly), guards that the completed-unit prefix still
 * matches the recomputed unit list, then re-enters `runFanout` at the first
 * not-yet-completed unit. The fanout's own continuation loop + `advanceAfter`
 * carry the chain onward from there.
 *
 * REQUIRES the FanoutFn to be deterministic w.r.t. its entry artifact: resume
 * trusts it to reproduce the same unit prefix. A divergence (FanoutFn read
 * mutable external state, or the entry artifact changed under it) is caught by
 * the prefix guard and recorded as a terminal failure — resume refuses to
 * re-run the wrong units rather than guess.
 *
 * `deps` are injected by `resumeWorkflow` (the same `runFanoutSession` +
 * `advanceChain`-backed `advanceAfter` that `tryFanout` injects), so this
 * module mirrors `runFanout`'s primitive-injection shape and imports no cycle
 * back into the session layer.
 */

import type { FanoutUnit, StageDef } from "../api.js";
import { auditCtxFor, recordTerminalFailure } from "../audit.js";
import type { FanoutDeps } from "../fanout.js";
import { runFanout } from "../fanout.js";
import { currentPrimaryArtifact } from "../internal-utils.js";
import { skillStageRef } from "../lifecycle.js";
import { ERR_RESUME_FANOUT_MISMATCH, MSG_RESUME_FANOUT_MISMATCH } from "../messages.js";
import type { RunContext, WorkflowHostContext } from "../types.js";
import { lifecycleCtxFor } from "./runner.js";

/**
 * Resume a fanout stage whose units are a completed prefix `1..k` (with the
 * failure/cutoff at `k+1`). `completedDecorated` is the ordered list of
 * completed unit `WorkflowStage.stage` strings for this parent, from
 * `reconstructState`'s `fanoutProgress`.
 *
 * `idx` is the display/audit index (the trailer unit row's `stageNumber - 1`),
 * consistent with the approximation `resumeWorkflow` already uses for the
 * single-stage arms. Routing correctness keys on the parent NAME, not `idx`.
 */
export async function resumeFanoutStage(
	ctx: WorkflowHostContext,
	parent: string,
	idx: number,
	completedDecorated: readonly string[],
	run: RunContext,
	deps: FanoutDeps,
): Promise<void> {
	const def = run.workflow.stages[parent]!; // caller verified parent is a fanout stage
	const skill = def.skill ?? parent; // mirror resolveStage; aliased nodes tag rows with the skill body
	const units = await recomputeUnits(def, run);

	if (fanoutPrefixDrifted(parent, completedDecorated, units)) {
		await recordFanoutDriftFailure(ctx, run, parent, skill);
		return;
	}

	// All units already completed → pure route-onward, no re-announce, no toast
	// (see `reannounceFanout` for why the no-op path stays silent).
	if (completedDecorated.length === units.length) {
		await deps.advanceAfter(ctx, parent, idx, run);
		return;
	}

	await reannounceFanout(ctx, run, parent, idx, skill, units);
	// p is 1-based: completedDecorated.length completed units ⇒ next is +1.
	await runFanout(ctx, idx, parent, skill, completedDecorated.length + 1, units, run, deps);
}

/**
 * Re-derive the unit list from the reconstructed entry context — the same call
 * `tryFanout` makes on the live path. Units never move the primary, so
 * `reconstructState` rebuilt the pre-fanout artifact exactly; the FanoutFn sees
 * the same input it saw originally (the determinism contract).
 */
function recomputeUnits(def: StageDef, run: RunContext): Promise<readonly FanoutUnit[]> | readonly FanoutUnit[] {
	return def.fanout!({ cwd: run.cwd, artifact: currentPrimaryArtifact(run.state), state: run.state });
}

/**
 * Determinism guard: the completed prefix must still line up with the recomputed
 * units, by full decorated-string equality (no tag-parsing — a label/id
 * containing parens stays unambiguous). A divergence means the FanoutFn read
 * mutable external state or the entry artifact changed under it; resume refuses
 * rather than re-run the wrong units.
 */
function fanoutPrefixDrifted(
	parent: string,
	completedDecorated: readonly string[],
	units: readonly FanoutUnit[],
): boolean {
	if (completedDecorated.length > units.length) return true;
	return completedDecorated.some((decorated, i) => decorated !== `${parent} (${units[i]!.id ?? units[i]!.label})`);
}

/** Record the terminal failure for a non-deterministic FanoutFn (drift caught by the prefix guard). */
function recordFanoutDriftFailure(
	ctx: WorkflowHostContext,
	run: RunContext,
	parent: string,
	skill: string,
): Promise<void> {
	return recordTerminalFailure(ctx, auditCtxFor(run, parent, skill), {
		status: "failed",
		notifyMsg: MSG_RESUME_FANOUT_MISMATCH(parent),
		notifyLevel: "error",
		errMsg: ERR_RESUME_FANOUT_MISMATCH(parent),
	});
}

/**
 * Re-fire onStageStart + onFanoutStart for listener coherence (mirror tryFanout)
 * before re-entering the loop. The full unit list is replayed; onFanoutUnitStart/End
 * then fire only for the resumed units (runFanout starts at p), so listeners see
 * the remaining work. NOT fired on the all-complete no-op path — re-announcing a
 * fanout with no units left to run would mislead listeners and double the
 * completion notice (keeps a finished-fanout resume symmetric with a
 * finished-linear one: a single "workflow complete" via finalizeWorkflow).
 */
async function reannounceFanout(
	ctx: WorkflowHostContext,
	run: RunContext,
	parent: string,
	idx: number,
	skill: string,
	units: readonly FanoutUnit[],
): Promise<void> {
	const ref = skillStageRef(parent, idx + 1, skill);
	await run.lifecycle.fire(ctx, "onStageStart", ref, lifecycleCtxFor(run));
	await run.lifecycle.fire(ctx, "onFanoutStart", ref, units, lifecycleCtxFor(run));
}
