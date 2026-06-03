/**
 * End-to-end fanout-resume tests — drive `resumeWorkflow` over a fanout workflow
 * with a mock session chain. Complements the pure-fold cases in resume.test.ts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FanoutUnit, Workflow } from "../api.js";
import { appendStage, readAllStages, type WorkflowHeader, type WorkflowStage, writeHeader } from "../state/index.js";
import { resumeWorkflow } from "./runner.js";

let tmpDir: string;
beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "rpiv-workflow-fanout-resume-"));
});
afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

const header: WorkflowHeader = {
	runId: "2026-06-03_07-30-00-ab12",
	workflow: "fanout-wf",
	input: "Ship it",
	ts: "2026-06-03T07:30:00Z",
};

/** Deterministic 3-unit fanout (blind to artifact, stable across re-call). */
const threeUnits = (): readonly FanoutUnit[] =>
	[1, 2, 3].map((n) => ({ prompt: `phase ${n}`, label: `phase ${n}/3`, id: `phase-${n}` }));

const fanoutWf: Workflow = {
	name: "fanout-wf",
	start: "impl",
	stages: { impl: { kind: "produces", sessionPolicy: "fresh", fanout: threeUnits } },
	edges: { impl: "stop" },
} as Workflow;

function writeRun(stages: WorkflowStage[]): void {
	writeHeader(tmpDir, header);
	for (const s of stages) appendStage(tmpDir, header.runId, s);
}
const unitRow = (n: number, num: number, status: "completed" | "failed"): WorkflowStage => ({
	stageNumber: num,
	stage: `impl (phase-${n})`,
	skill: "impl",
	status,
	ts: `t${num}`,
	...(status === "failed" ? { errMsg: "boom" } : {}),
});

describe("fanout-resume", () => {
	it("mid-fanout failure: re-runs only the failed unit + remaining, then chains to stop", async () => {
		writeRun([unitRow(1, 1, "completed"), unitRow(2, 2, "completed"), unitRow(3, 3, "failed")]);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("unit 3 done")] }],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: fanoutWf, header, ref: "@x" });

		expect(result.success).toBe(true);
		// Only unit 3 re-ran → exactly one new dispatch.
		expect(chain.sentMessages).toEqual(["/skill:impl phase 3"]);
		// New completed row appended for unit 3; total = 3 original + 1 new.
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows).toHaveLength(4);
		expect(rows[3]).toMatchObject({ stage: "impl (phase-3)", status: "completed" });
	});

	it("process died mid-fanout (no failure row): resumes at the next unit", async () => {
		writeRun([unitRow(1, 1, "completed")]); // only unit 1 recorded
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("unit 2")] }, { branch: [mockAssistantMessage("unit 3")] }],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: fanoutWf, header, ref: "@x" });

		expect(result.success).toBe(true);
		expect(chain.sentMessages).toEqual(["/skill:impl phase 2", "/skill:impl phase 3"]);
	});

	it("fully-completed fanout: no-op route-onward — single completion notice, no re-announce", async () => {
		writeRun([unitRow(1, 1, "completed"), unitRow(2, 2, "completed"), unitRow(3, 3, "completed")]);
		const fanoutStarts: number[] = [];
		const stageStarts: string[] = [];
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });

		const result = await resumeWorkflow(chain.ctx, {
			workflow: fanoutWf,
			header,
			ref: "@x",
			lifecycle: {
				onFanoutStart: (_stage, units) => {
					fanoutStarts.push(units.length);
				},
				onStageStart: (stage) => {
					stageStarts.push(stage.name);
				},
			},
		});

		expect(result.success).toBe(true);
		expect(chain.ctx.newSession).not.toHaveBeenCalled();
		expect(readAllStages(tmpDir, header.runId)).toHaveLength(3); // no new rows

		// Short-circuit: the finished fanout is NOT re-announced (no onStageStart /
		// onFanoutStart re-fire on a no-op resume).
		expect(fanoutStarts).toEqual([]);
		expect(stageStarts).toEqual([]);
		// ...and the only completion toast is the workflow-level one — no spurious
		// per-stage "✓ impl completed" (symmetric with a finished-linear resume).
		expect(chain.notifications.filter((n) => n.msg === "✓ impl completed")).toEqual([]);
		expect(chain.notifications.filter((n) => /workflow complete/.test(n.msg))).toHaveLength(1);
	});

	it("non-deterministic FanoutFn: records a terminal failure, refuses to re-run wrong units", async () => {
		// Recorded run had `phase-1` completed; the workflow now recomputes different ids.
		const drifted: Workflow = {
			name: "fanout-wf",
			start: "impl",
			stages: {
				impl: {
					kind: "produces",
					sessionPolicy: "fresh",
					fanout: () => [{ prompt: "x", label: "task 1", id: "task-1" }],
				},
			},
			edges: { impl: "stop" },
		} as Workflow;
		writeRun([unitRow(1, 1, "completed"), unitRow(2, 2, "failed")]);
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });

		const result = await resumeWorkflow(chain.ctx, { workflow: drifted, header, ref: "@x" });

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/deterministic/);
		// In-run failure (we got far enough to start resuming) → runId present, row written.
		expect(result.runId).toBe(header.runId);
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows[rows.length - 1]).toMatchObject({ stage: "impl", status: "failed" });
		// No unit was dispatched.
		expect(chain.sentMessages).toEqual([]);
	});

	it("paren-in-label: a parenthesized completed prefix still resumes (no false mismatch)", async () => {
		// The decoration guard compares full strings — a label containing parens
		// (`impl (phase (a))`) must not be mis-parsed into a spurious mismatch.
		const parenUnits = (): readonly FanoutUnit[] => [
			{ prompt: "first", label: "phase (a)" },
			{ prompt: "second", label: "phase (b)" },
		];
		const parenWf: Workflow = {
			name: "fanout-wf",
			start: "impl",
			stages: { impl: { kind: "produces", sessionPolicy: "fresh", fanout: parenUnits } },
			edges: { impl: "stop" },
		} as Workflow;
		// Unit 1 (label "phase (a)") completed; unit 2 failed.
		writeRun([
			{ stageNumber: 1, stage: "impl (phase (a))", skill: "impl", status: "completed", ts: "t1" },
			{ stageNumber: 2, stage: "impl (phase (b))", skill: "impl", status: "failed", ts: "t2", errMsg: "boom" },
		]);
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [{ branch: [mockAssistantMessage("unit b")] }] });

		const result = await resumeWorkflow(chain.ctx, { workflow: parenWf, header, ref: "@x" });

		expect(result.success).toBe(true);
		// Prefix matched despite the parens → only unit 2 re-ran.
		expect(chain.sentMessages).toEqual(["/skill:impl second"]);
	});
});
