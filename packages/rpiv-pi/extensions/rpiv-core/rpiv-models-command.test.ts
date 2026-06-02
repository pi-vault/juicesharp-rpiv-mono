import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadModelsConfig } from "./models-config.js";
import { registerRpivModelsCommand } from "./rpiv-models-command.js";

vi.mock("./models-picker.js", () => ({
	showFilterablePicker: vi.fn(),
}));

const { showFilterablePicker } = await import("./models-picker.js");

function makePi() {
	let cmdHandler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	const registerCommand = vi.fn(
		(name: string, opts: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
			if (name === "rpiv-models") cmdHandler = opts.handler;
		},
	);
	// Provide a minimal sourceInfo stub on each mock entry so a future read of
	// `sourceInfo` in skillCommandNames doesn't silently pass tests while
	// failing production (Plan Review row #concern-G).
	const stubSourceInfo = { path: "/stub/SKILL.md", baseDir: "/stub" };
	const getCommands = vi.fn(() => [
		{ name: "skill:commit", description: "Commit changes", source: "skill", sourceInfo: stubSourceInfo },
		{ name: "skill:research", description: "Research a topic", source: "skill", sourceInfo: stubSourceInfo },
		{ name: "rpiv-models", description: "Configure models", source: "extension", sourceInfo: stubSourceInfo },
	]);
	return {
		pi: { registerCommand, getCommands } as unknown as ExtensionAPI,
		handler: () => cmdHandler!,
		getCommands,
	};
}

function makeCtx(hasUI = true) {
	const models = [
		{ name: "GLM-4.7", provider: "zai", id: "glm-4-7", reasoning: false },
		{ name: "GPT-5.5", provider: "openai", id: "gpt-5.5", reasoning: true },
	];
	return {
		hasUI,
		cwd: process.cwd(),
		ui: { notify: vi.fn() },
		modelRegistry: { getAvailable: () => models },
	} as unknown as ExtensionContext;
}

const CONFIG_PATH = join(process.env.HOME!, ".config", "rpiv-pi", "models.json");

beforeEach(() => {
	vi.restoreAllMocks();
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("/rpiv-models — guards", () => {
	it("errors when ctx.hasUI is false", async () => {
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		const ctx = makeCtx(false);
		await handler()("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
	});

	it("cancels gracefully when scope picker returns null", async () => {
		vi.mocked(showFilterablePicker).mockResolvedValueOnce(null);
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		const ctx = makeCtx();
		await handler()("", ctx);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(existsSync(CONFIG_PATH)).toBe(false);
	});
});

describe("/rpiv-models — defaults flow", () => {
	it("writes defaults entry via slash-canonical model key", async () => {
		vi.mocked(showFilterablePicker).mockResolvedValueOnce("defaults").mockResolvedValueOnce("zai/glm-4-7");
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		const ctx = makeCtx();
		await handler()("", ctx);

		expect(existsSync(CONFIG_PATH)).toBe(true);
		const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(stored.defaults).toBe("zai/glm-4-7");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Saved defaults"), "info");
	});
});

describe("/rpiv-models — skills flow (live registry)", () => {
	it("pulls skill names from pi.getCommands() filtered by source==='skill'", async () => {
		vi.mocked(showFilterablePicker)
			.mockResolvedValueOnce("skills")
			.mockResolvedValueOnce("commit")
			.mockResolvedValueOnce("zai/glm-4-7");
		const { pi, handler, getCommands } = makePi();
		registerRpivModelsCommand(pi);
		const ctx = makeCtx();
		await handler()("", ctx);

		expect(getCommands).toHaveBeenCalled();
		const skillPickerCall = vi.mocked(showFilterablePicker).mock.calls[1];
		expect((skillPickerCall[1] as { items: { value: string }[] }).items.map((i) => i.value)).toEqual([
			"commit",
			"research",
		]);

		const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(stored.skills.commit).toBe("zai/glm-4-7");
	});
});

describe("/rpiv-models — effort picker for reasoning models", () => {
	it("calls effort picker only when reasoning is true", async () => {
		vi.mocked(showFilterablePicker)
			.mockResolvedValueOnce("defaults")
			.mockResolvedValueOnce("openai/gpt-5.5")
			.mockResolvedValueOnce("high");
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		const ctx = makeCtx();
		await handler()("", ctx);

		const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(stored.defaults).toEqual({ model: "openai/gpt-5.5", thinking: "high" });
	});
});

describe("/rpiv-models — cache invalidation", () => {
	it("resets cache after successful save (next loadModelsConfig sees new value)", async () => {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify({ defaults: "anthropic/old" }), "utf-8");
		const before = loadModelsConfig();
		expect(before.defaults?.model).toBe("anthropic/old");

		vi.mocked(showFilterablePicker).mockResolvedValueOnce("defaults").mockResolvedValueOnce("zai/glm-4-7");
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		await handler()("", makeCtx());

		const after = loadModelsConfig();
		expect(after.defaults?.model).toBe("zai/glm-4-7");
	});
});

describe("/rpiv-models — checkmark display", () => {
	it("passes currentKey to buildModelItems when defaults override exists", async () => {
		rmSync(CONFIG_PATH, { force: true });
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify({ defaults: "zai/glm-4-7" }), "utf-8");

		vi.mocked(showFilterablePicker).mockResolvedValueOnce("defaults").mockResolvedValueOnce("zai/glm-4-7");
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		await handler()("", makeCtx());

		const modelPickerCall = vi.mocked(showFilterablePicker).mock.calls[1];
		const items = (modelPickerCall[1] as { items: SelectItem[] }).items;
		const glmItem = items.find((i: SelectItem) => i.value === "zai/glm-4-7");
		expect(glmItem?.label).toContain("✓");
	});

	it("does not show checkmark when no override is configured", async () => {
		rmSync(CONFIG_PATH, { force: true });

		vi.mocked(showFilterablePicker).mockResolvedValueOnce("defaults").mockResolvedValueOnce("zai/glm-4-7");
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		await handler()("", makeCtx());

		const modelPickerCall = vi.mocked(showFilterablePicker).mock.calls[1];
		const items = (modelPickerCall[1] as { items: SelectItem[] }).items;
		const glmItem = items.find((i: SelectItem) => i.value === "zai/glm-4-7");
		expect(glmItem?.label).not.toContain("✓");
	});
});

describe("/rpiv-models — per-entry reset", () => {
	it("removes agents entry when reset sentinel is chosen", async () => {
		rmSync(CONFIG_PATH, { force: true });
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify({ agents: { "codebase-analyst": "zai/glm-4-7" } }), "utf-8");

		vi.mocked(showFilterablePicker)
			.mockResolvedValueOnce("agents")
			.mockResolvedValueOnce("codebase-analyst")
			.mockResolvedValueOnce("__reset__");
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		const ctx = makeCtx();
		await handler()("", ctx);

		const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(stored.agents).toBeUndefined();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Removed"), "info");
	});
});

describe("/rpiv-models — global reset", () => {
	it("clears entire config when reset-all scope is chosen", async () => {
		rmSync(CONFIG_PATH, { force: true });
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(
			CONFIG_PATH,
			JSON.stringify({
				defaults: "zai/glm-4-7",
				agents: { "codebase-analyst": "anthropic/opus" },
				skills: { commit: "zai/glm-4-7" },
			}),
			"utf-8",
		);

		vi.mocked(showFilterablePicker).mockResolvedValueOnce("__reset_all__");
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		const ctx = makeCtx();
		await handler()("", ctx);

		const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(stored).toEqual({});
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("cleared"), "info");
	});
});

describe("/rpiv-models — save failure", () => {
	it("notifies error AND does NOT reset cache on saveJsonConfig=false", async () => {
		if (process.platform === "win32") return;

		// Pre-seed BOTH disk AND cache with a known sentinel.
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify({ defaults: "anthropic/seed" }), "utf-8");
		const seeded = loadModelsConfig();
		expect(seeded.defaults?.model).toBe("anthropic/seed");

		// Force EISDIR by replacing the file with a directory at the config path.
		rmSync(CONFIG_PATH);
		mkdirSync(CONFIG_PATH);

		vi.mocked(showFilterablePicker).mockResolvedValueOnce("defaults").mockResolvedValueOnce("zai/glm-4-7");
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		const ctx = makeCtx();
		await handler()("", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to save"), "error");

		// Tightened (per slice-verifier WARNING): cache MUST NOT have been reset.
		// The seeded sentinel persists — proving __resetModelsConfigCache was NOT
		// called (early return on saveJsonConfig=false).
		const afterFail = loadModelsConfig();
		expect(afterFail.defaults?.model).toBe("anthropic/seed");
	});
});
