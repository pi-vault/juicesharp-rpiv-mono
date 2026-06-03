/**
 * Parity tests for `applyCompletedStage` — the single authority for
 * "a completed produces stage mutates the rolling artifact state."
 *
 * Covers the four stage-kind cases that were previously duplicated across
 * `runner/script-stage.ts:advancePrimaryForScript` and
 * `sessions/sessions.ts:maybeAdvancePrimary`:
 *   1. produces-with-artifacts  → primary advances, named appends
 *   2. produces with empty artifacts → primary unchanged, named still appends
 *   3. side-effect (acts)       → primary + named untouched
 *   4. terminal (inheritsArtifacts: false) → primary cleared
 *
 * Plus named-slot append-order (array history preserved across repeated
 * calls to the same key).
 */

import { describe, expect, it } from "vitest";
import type { StageDef } from "./api.js";
import type { Artifact } from "./handle.js";
import { fs as fsHandle } from "./handle.js";
import { applyCompletedStage } from "./internal-utils.js";
import type { Output } from "./output.js";
import type { RunState } from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakeArtifact = (path: string): Artifact => ({ handle: fsHandle(path), role: "primary" });

const fakeOutput = (artifacts: readonly Artifact[] = []): Output => ({
	kind: "artifacts",
	artifacts,
	data: {},
	meta: { stage: "test", stageNumber: 1, ts: "", runId: "" },
});

const freshState = (): RunState => ({
	originalInput: "",
	primaryArtifact: undefined,
	output: undefined,
	named: {},
	stagesCompleted: 0,
	lastAllocatedStageNumber: 0,
	telemetry: { backwardJumps: 0, droppedRoutingRows: [] },
	termination: { success: false, error: undefined },
});

/** Minimal produces stage def — `applyCompletedStage` only reads `kind` and `outcome?.name`. */
const producesDef = (outcomeName?: string): StageDef =>
	({
		kind: "produces",
		sessionPolicy: "fresh",
		...(outcomeName !== undefined
			? { outcome: { name: outcomeName, collector: { collect: () => ({ kind: "ok", artifacts: [] }) } } }
			: {}),
	}) as StageDef;

/** Minimal side-effect stage def — `applyCompletedStage` only reads `kind`. */
const actsDef = (overrides: Partial<StageDef> = {}): StageDef =>
	({ kind: "side-effect", sessionPolicy: "fresh", ...overrides }) as StageDef;

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe("applyCompletedStage", () => {
	it("produces stage with artifacts: advances primary and appends to named", () => {
		const state = freshState();
		const def = producesDef();
		const art = fakeArtifact("plans/p1.md");
		const output = fakeOutput([art]);

		applyCompletedStage(state, def, "blueprint", output);

		expect(state.primaryArtifact).toBe(art);
		expect(state.named.blueprint).toEqual([output]);
	});

	it("produces stage with empty artifacts: primary unchanged, named still appends the Output", () => {
		const state = freshState();
		const existing = fakeArtifact("old.md");
		state.primaryArtifact = existing;

		const def = producesDef();
		const output = fakeOutput([]); // no artifacts

		applyCompletedStage(state, def, "blueprint", output);

		// Primary stays as-is — no artifact[0] to advance to
		expect(state.primaryArtifact).toBe(existing);
		// Named still records the Output
		expect(state.named.blueprint).toEqual([output]);
	});

	it("produces stage uses outcome.name as named key when set", () => {
		const state = freshState();
		const def = producesDef("plans");
		const art = fakeArtifact("plans/p1.md");
		const output = fakeOutput([art]);

		applyCompletedStage(state, def, "blueprint", output);

		expect(state.primaryArtifact).toBe(art);
		// Key is "plans" (outcome.name), not "blueprint" (stage record key)
		expect(state.named.plans).toEqual([output]);
		expect(state.named.blueprint).toBeUndefined();
	});

	it("side-effect stage (acts): primary and named left untouched", () => {
		const existing = fakeArtifact("old.md");
		const state = freshState();
		state.primaryArtifact = existing;
		state.named = { "prior-stage": [fakeOutput([existing])] };

		const def = actsDef();
		const output = fakeOutput();

		applyCompletedStage(state, def, "commit", output);

		expect(state.primaryArtifact).toBe(existing);
		expect(state.named).toEqual({ "prior-stage": [expect.any(Object)] });
	});

	it("terminal stage (inheritsArtifacts: false): clears primary, named untouched", () => {
		const existing = fakeArtifact("old.md");
		const state = freshState();
		state.primaryArtifact = existing;
		state.named = { "prior-stage": [fakeOutput([existing])] };

		// `terminal()` sets `inheritsArtifacts: false`
		const def = actsDef({ inheritsArtifacts: false });
		const output = fakeOutput();

		applyCompletedStage(state, def, "cleanup", output);

		expect(state.primaryArtifact).toBeUndefined();
		// Named is never cleared — it's an additive history channel
		expect(state.named).toEqual({ "prior-stage": [expect.any(Object)] });
	});

	it("named slot accumulates across repeated calls (append order preserved)", () => {
		const state = freshState();
		const def = producesDef("plans");

		const art1 = fakeArtifact("plans/p1.md");
		const output1 = fakeOutput([art1]);
		const art2 = fakeArtifact("plans/p2.md");
		const output2 = fakeOutput([art2]);

		applyCompletedStage(state, def, "blueprint", output1);
		applyCompletedStage(state, def, "blueprint", output2);

		// Primary tracks the latest (second call)
		expect(state.primaryArtifact).toBe(art2);
		// Named is an array preserving history order
		expect(state.named.plans).toEqual([output1, output2]);
	});

	it("does not mutate state.output or stagesCompleted (those stay at call sites)", () => {
		const state = freshState();
		state.output = fakeOutput();
		state.stagesCompleted = 5;

		const def = producesDef();
		const art = fakeArtifact("plans/p1.md");
		const output = fakeOutput([art]);

		applyCompletedStage(state, def, "blueprint", output);

		// output and stagesCompleted are NOT changed by the reducer
		expect(state.output).not.toBe(output);
		expect(state.stagesCompleted).toBe(5);
	});
});
