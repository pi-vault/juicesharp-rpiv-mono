/**
 * Implement-skill phase fanout. When an implement node runs against a plan
 * with `## Phase N:` headings, the runner expands into one session per
 * phase. `runner.ts` injects its primitives via `PhaseFanoutDeps` so this
 * module never imports back (cycle-free).
 */

import { readFileSync } from "node:fs";
import { resolveUnderCwd } from "./internal-utils.js";
import { MSG_STAGE_COMPLETE, STATUS_KEY, STATUS_PHASE } from "./messages.js";
import type { PhaseSession, RunContext, RunnerCtx } from "./types.js";

export interface PhaseFanoutDeps {
	runPhaseSession: (ctx: RunnerCtx, session: PhaseSession) => Promise<void>;
	/**
	 * Resume the chain after the implement node's phases finish. Receives
	 * the implement node's name so the routing layer can look up the
	 * outgoing edge from it.
	 */
	advanceAfter: (curCtx: RunnerCtx, completedName: string, completedIdx: number, run: RunContext) => Promise<void>;
}

const PHASE_HEADING_REGEX = /^## Phase (\d+):/gm;

/**
 * Hard cap on phases fanout. Plans authored by `plan` cap around 8 phases in
 * practice; 32 leaves headroom for stretch plans without letting a
 * pathological plan (or a hostile one) drive the runner into unbounded
 * recursion via `runImplementPhases`' continuation-style self-call.
 */
export const MAX_PHASES = 32;

/**
 * Returns the number of `## Phase N:` headings in the plan file. 0 means
 * "no fanout"; the caller treats that as single-stage. ENOENT/EACCES and
 * other read errors are NOT collapsed to 0 — they throw, so `advanceChain`'s
 * catch records a failure row and halts the run rather than silently
 * degrading a multi-phase plan into one implement session. A plan with
 * more than `MAX_PHASES` headings throws so the chain halts with an
 * actionable error rather than recursing 100+ times.
 */
export function countPhases(planPath: string, cwd: string): number {
	const absolutePath = resolveUnderCwd(cwd, planPath);
	const content = readFileSync(absolutePath, "utf-8");
	const matches = content.match(PHASE_HEADING_REGEX);
	const count = matches ? matches.length : 0;
	if (count > MAX_PHASES) {
		throw new Error(
			`countPhases: plan ${planPath} declares ${count} phases — exceeds MAX_PHASES (${MAX_PHASES}); split into smaller plans`,
		);
	}
	return count;
}

/**
 * `skill` is the bundled skill body (threaded by the runner), not the node
 * name. Aliased implement nodes (implement-after-revise, etc.) tag phase
 * rows + prompts with the skill body so audit consumers don't see two
 * labels for the same work. Caller verifies node + plan shape before
 * invoking (see `runStage`).
 *
 * `currentName` is the implement node's name in the workflow — passed to
 * `advanceAfter` once the final phase completes so the routing layer can
 * look up the outgoing edge from it.
 */
export async function runImplementPhases(
	curCtx: RunnerCtx,
	stageIdx: number,
	currentName: string,
	skill: string,
	p: number,
	phaseCount: number,
	run: RunContext,
	deps: PhaseFanoutDeps,
): Promise<void> {
	const { cwd, runId, totalStages, state } = run;

	if (p > phaseCount) {
		curCtx.ui.notify(MSG_STAGE_COMPLETE(skill), "info");
		await deps.advanceAfter(curCtx, currentName, stageIdx, run);
		return;
	}

	curCtx.ui.setStatus(STATUS_KEY, STATUS_PHASE(stageIdx + 1, totalStages, p, phaseCount));

	await deps.runPhaseSession(curCtx, {
		cwd,
		runId,
		state,
		prompt: `/skill:${skill} ${state.artifactPath} Phase ${p}`,
		skill,
		phaseIndex: p,
		phaseCount,
		stageIndex: stageIdx,
		onSuccess: (freshCtx) => runImplementPhases(freshCtx, stageIdx, currentName, skill, p + 1, phaseCount, run, deps),
	});
}
