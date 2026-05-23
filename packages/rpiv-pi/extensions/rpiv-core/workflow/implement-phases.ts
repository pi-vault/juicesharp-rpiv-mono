/**
 * Implement-skill phase fanout. When an implement node runs against a plan
 * with `## Phase N:` headings, the runner expands into one session per
 * phase. `runner.ts` injects its primitives via `PhaseFanoutDeps` so this
 * module never imports back (cycle-free).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MSG_STAGE_COMPLETE, STATUS_KEY, STATUS_PHASE } from "./messages.js";
import type { ChainCtx, PhaseSession, RunContext } from "./types.js";

export interface PhaseFanoutDeps {
	runPhaseSession: (ctx: ChainCtx, session: PhaseSession) => Promise<void>;
	/** Hand back to the generic stage loop once all phases complete. */
	runNextStage: (curCtx: ChainCtx, nextIdx: number, run: RunContext) => Promise<void>;
}

const PHASE_HEADING_REGEX = /^## Phase (\d+):/gm;

/** Fail-soft: 0 on missing file, no headings, or read error. */
export function countPhases(planPath: string, cwd: string): number {
	const absolutePath = planPath.startsWith("/") ? planPath : join(cwd, planPath);
	try {
		const content = readFileSync(absolutePath, "utf-8");
		const matches = content.match(PHASE_HEADING_REGEX);
		return matches ? matches.length : 0;
	} catch {
		return 0;
	}
}

/**
 * `skill` is the bundled skill name (threaded by the runner), not the node id.
 * Aliased implement nodes (implement-after-revise, etc.) tag phase rows + prompts
 * with the skill body so audit consumers don't see two labels for the same work.
 * Caller verifies node + plan shape before invoking (see `runStage`).
 */
export async function runImplementPhases(
	curCtx: ChainCtx,
	stageIdx: number,
	skill: string,
	p: number,
	phaseCount: number,
	run: RunContext,
	deps: PhaseFanoutDeps,
): Promise<void> {
	const { cwd, runId, totalStages, state } = run;

	if (p > phaseCount) {
		curCtx.ui.notify(MSG_STAGE_COMPLETE(skill), "info");
		await deps.runNextStage(curCtx, stageIdx + 1, run);
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
		onSuccess: (freshCtx) => runImplementPhases(freshCtx, stageIdx, skill, p + 1, phaseCount, run, deps),
	});
}
