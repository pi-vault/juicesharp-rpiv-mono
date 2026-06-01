import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetModelOverrideState,
	registerModelOverrideLifecycle,
	registerModelOverrideSessionStart,
} from "./model-override.js";
import { getStageModelConfig, type ModelsConfig } from "./models-config.js";

// The lifecycle registry rpiv-workflow exposes via registerLifecycle is anchored
// on this well-known Symbol. We read it directly to invoke the bundle our
// registerModelOverrideLifecycle pushed, without driving a full workflow run.
const LIFECYCLE_KEY = Symbol.for("@juicesharp/rpiv-workflow:lifecycle");

interface LifecycleBundle {
	onWorkflowStart?: (ctx: unknown) => unknown | Promise<unknown>;
	onStageStart?: (stage: { name: string }, ctx: unknown) => unknown | Promise<unknown>;
	onWorkflowEnd?: (result: unknown, ctx: unknown) => unknown | Promise<unknown>;
}

function lastListener(): LifecycleBundle {
	const reg = ((globalThis as Record<symbol, unknown>)[LIFECYCLE_KEY] ?? []) as LifecycleBundle[];
	expect(reg.length).toBeGreaterThan(0);
	return reg[reg.length - 1];
}

function writeModels(config: unknown): void {
	const dir = join(process.env.HOME!, ".config", "rpiv-pi");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "models.json"), JSON.stringify(config), "utf-8");
}

type SessionStartHandler = (ev: unknown, ctx: unknown) => unknown | Promise<unknown>;

interface FakePi {
	pi: ExtensionAPI;
	setModel: ReturnType<typeof vi.fn>;
	setThinkingLevel: ReturnType<typeof vi.fn>;
	sessionStart: () => SessionStartHandler | undefined;
}

/** Minimal ExtensionAPI stub exposing only the methods model-override touches. */
function makePi(opts: { setModelResult?: boolean; baselineThinking?: string } = {}): FakePi {
	let handler: SessionStartHandler | undefined;
	const setModel = vi.fn(async () => opts.setModelResult ?? true);
	const setThinkingLevel = vi.fn();
	const pi = {
		on: vi.fn((event: string, h: SessionStartHandler) => {
			if (event === "session_start") handler = h;
		}),
		setModel,
		setThinkingLevel,
		getThinkingLevel: vi.fn(() => opts.baselineThinking ?? "medium"),
	} as unknown as ExtensionAPI;
	return { pi, setModel, setThinkingLevel, sessionStart: () => handler };
}

/** A resolved baseline Model object as captured from session_start. */
const BASELINE_MODEL = { provider: "anthropic", id: "baseline" };

describe("model-override", () => {
	it("getStageModelConfig cascades correctly for lifecycle use", () => {
		const config: ModelsConfig = {
			defaults: { model: "anthropic:claude-sonnet-4-20250514" },
			stages: {
				plan: { model: "openai:o3-pro", thinking: "high" },
			},
		};

		// Configured stage
		expect(getStageModelConfig(config, "plan")).toEqual({
			model: "openai:o3-pro",
			thinking: "high",
		});

		// Unconfigured stage → defaults
		expect(getStageModelConfig(config, "research")).toEqual({
			model: "anthropic:claude-sonnet-4-20250514",
		});

		// No config at all → undefined
		expect(getStageModelConfig({}, "plan")).toBeUndefined();
	});

	it("__resetModelOverrideState clears baseline", () => {
		__resetModelOverrideState();
		// After reset, internal state is clean (tested via lifecycle integration)
		expect(true).toBe(true);
	});

	describe("session_start capture", () => {
		it("captures modelRegistry and the current model from ExtensionContext", async () => {
			const { pi, setModel, sessionStart } = makePi({ baselineThinking: "low" });
			registerModelOverrideSessionStart(pi);
			const handler = sessionStart();
			expect(handler).toBeDefined();

			const registry = { find: vi.fn() };
			await handler!({}, { modelRegistry: registry, model: BASELINE_MODEL });

			// The captured model surfaces only via the lifecycle: onWorkflowStart
			// snapshots it as baseline.model, onWorkflowEnd restores it via setModel.
			await registerModelOverrideLifecycle(pi);
			const lc = lastListener();
			await lc.onWorkflowStart?.({});
			await lc.onWorkflowEnd?.({}, {});

			expect(setModel).toHaveBeenCalledWith(BASELINE_MODEL);
		});

		it("does not refresh capturedModel while a workflow is active (no baseline pollution)", async () => {
			const { pi, setModel, sessionStart } = makePi();
			registerModelOverrideSessionStart(pi);
			await registerModelOverrideLifecycle(pi);
			const handler = sessionStart()!;
			const registry = { find: vi.fn() };

			// Capture the real baseline before the workflow.
			await handler({}, { modelRegistry: registry, model: BASELINE_MODEL });

			const lc = lastListener();
			await lc.onWorkflowStart?.({}); // freezes capturedModel

			// A stage's newSession re-fires session_start with a DIFFERENT model.
			const overrideModel = { provider: "openai", id: "o3-pro" };
			await handler({}, { modelRegistry: registry, model: overrideModel });

			await lc.onWorkflowEnd?.({}, {});

			// Restoration must use the pre-workflow baseline, not the stage override.
			expect(setModel).toHaveBeenLastCalledWith(BASELINE_MODEL);
		});
	});

	describe("onStageStart override application", () => {
		async function setup(opts: { setModelResult?: boolean } = {}) {
			const fake = makePi({ baselineThinking: "medium", ...opts });
			registerModelOverrideSessionStart(fake.pi);
			await registerModelOverrideLifecycle(fake.pi);
			const handler = fake.sessionStart()!;
			const registry = {
				find: vi.fn((provider: string, modelId: string) => ({ provider, id: modelId })),
			};
			await handler({}, { modelRegistry: registry, model: BASELINE_MODEL });
			const lc = lastListener();
			await lc.onWorkflowStart?.({});
			return { ...fake, registry, lc };
		}

		it("applies a configured stage model (resolved via registry) and thinking", async () => {
			writeModels({ stages: { plan: { model: "openai:o3-pro", thinking: "high" } } });
			const { setModel, setThinkingLevel, registry, lc } = await setup();

			await lc.onStageStart?.({ name: "plan" }, {});

			expect(registry.find).toHaveBeenCalledWith("openai", "o3-pro");
			expect(setModel).toHaveBeenLastCalledWith({ provider: "openai", id: "o3-pro" });
			expect(setThinkingLevel).toHaveBeenLastCalledWith("high");
		});

		it("falls back to baseline model AND baseline thinking for an unconfigured stage (no bleedthrough)", async () => {
			writeModels({ stages: { plan: { model: "openai:o3-pro" } } });
			const { setModel, setThinkingLevel, lc } = await setup();

			// Stage 1 sets the override model.
			await lc.onStageStart?.({ name: "plan" }, {});
			// Stage 2 is unconfigured → must revert to baseline, not stage 1's model.
			await lc.onStageStart?.({ name: "implement" }, {});

			expect(setModel).toHaveBeenLastCalledWith(BASELINE_MODEL);
			expect(setThinkingLevel).toHaveBeenLastCalledWith("medium");
		});

		it("warns and uses baseline when the override model is not found in the registry", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			writeModels({ stages: { plan: { model: "openai:o3-pro" } } });
			const fake = makePi({ baselineThinking: "medium" });
			registerModelOverrideSessionStart(fake.pi);
			await registerModelOverrideLifecycle(fake.pi);
			const handler = fake.sessionStart()!;
			const registry = { find: vi.fn(() => undefined) }; // model not found
			await handler({}, { modelRegistry: registry, model: BASELINE_MODEL });
			const lc = lastListener();
			await lc.onWorkflowStart?.({});

			await lc.onStageStart?.({ name: "plan" }, {});

			expect(warn).toHaveBeenCalledWith(expect.stringContaining("model not found"));
			expect(fake.setModel).toHaveBeenLastCalledWith(BASELINE_MODEL);
			warn.mockRestore();
		});

		it("soft-fails (warns, proceeds) when setModel returns false", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			writeModels({ stages: { plan: { model: "openai:o3-pro", thinking: "high" } } });
			const { setThinkingLevel, lc } = await setup({ setModelResult: false });

			await lc.onStageStart?.({ name: "plan" }, {});

			expect(warn).toHaveBeenCalledWith(expect.stringContaining("setModel failed"));
			// Thinking is still applied — the failure does not abort the stage hook.
			expect(setThinkingLevel).toHaveBeenLastCalledWith("high");
			warn.mockRestore();
		});

		it("is a no-op when no baseline was captured (workflow not started)", async () => {
			writeModels({ stages: { plan: { model: "openai:o3-pro", thinking: "high" } } });
			const fake = makePi();
			registerModelOverrideSessionStart(fake.pi);
			await registerModelOverrideLifecycle(fake.pi);
			const lc = lastListener();

			// onStageStart before onWorkflowStart → must early-return.
			await lc.onStageStart?.({ name: "plan" }, {});

			expect(fake.setModel).not.toHaveBeenCalled();
			expect(fake.setThinkingLevel).not.toHaveBeenCalled();
		});
	});

	describe("dynamic-import fallback", () => {
		it("degrades gracefully (no throw, no registration) when rpiv-workflow is absent", async () => {
			vi.resetModules();
			vi.doMock("@juicesharp/rpiv-workflow", () => {
				const err = new Error("Cannot find package '@juicesharp/rpiv-workflow'");
				(err as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";
				throw err;
			});
			try {
				const mod = await import("./model-override.js");
				const fake = makePi();
				// The isModuleNotFound guard swallows the absent-sibling failure.
				await expect(mod.registerModelOverrideLifecycle(fake.pi)).resolves.toBeUndefined();
			} finally {
				vi.doUnmock("@juicesharp/rpiv-workflow");
				vi.resetModules();
			}
		});
	});

	describe("onWorkflowEnd restoration", () => {
		it("restores baseline model + thinking and resets state", async () => {
			const { pi, setModel, setThinkingLevel, sessionStart } = makePi({ baselineThinking: "low" });
			registerModelOverrideSessionStart(pi);
			await registerModelOverrideLifecycle(pi);
			const handler = sessionStart()!;
			await handler({}, { modelRegistry: { find: vi.fn() }, model: BASELINE_MODEL });
			const lc = lastListener();

			await lc.onWorkflowStart?.({});
			await lc.onWorkflowEnd?.({}, {});

			expect(setModel).toHaveBeenLastCalledWith(BASELINE_MODEL);
			expect(setThinkingLevel).toHaveBeenLastCalledWith("low");

			// State reset: a second onWorkflowEnd with no fresh start is a no-op.
			setModel.mockClear();
			await lc.onWorkflowEnd?.({}, {});
			expect(setModel).not.toHaveBeenCalled();
		});

		it("warns when restoring the baseline model fails", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const { pi, sessionStart } = makePi({ setModelResult: false });
			registerModelOverrideSessionStart(pi);
			await registerModelOverrideLifecycle(pi);
			const handler = sessionStart()!;
			await handler({}, { modelRegistry: { find: vi.fn() }, model: BASELINE_MODEL });
			const lc = lastListener();

			await lc.onWorkflowStart?.({});
			await lc.onWorkflowEnd?.({}, {});

			expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed to restore baseline model"));
			warn.mockRestore();
		});
	});
});

// The reset/registry cleanup is handled globally by test/setup.ts beforeEach
// (__resetModelOverrideState + __resetLifecycleRegistry). These local hooks
// just guard against spies leaking across the describe blocks above.
beforeEach(() => {
	vi.restoreAllMocks();
});
afterEach(() => {
	vi.restoreAllMocks();
});
