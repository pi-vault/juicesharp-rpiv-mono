import { describe, expect, it } from "vitest";
import type { BranchEntry } from "../../transcript.js";
import { transcriptPathResolver } from "./transcript-path.js";

const asst = (text: string): BranchEntry => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }] },
});

const ctxOf = (branch: BranchEntry[]) => ({
	cwd: "/tmp",
	runId: "test",
	stageIndex: 0,
	state: {} as never,
	branch,
	branchOffset: undefined,
	baseline: undefined,
	skill: "test",
});

describe("transcriptPathResolver", () => {
	it("throws at construction when pattern is missing", () => {
		// @ts-expect-error — intentional misuse
		expect(() => transcriptPathResolver({})).toThrow(/pattern.*required/);
	});

	it("emits one fs artifact for the last regex match in assistant text", async () => {
		const resolver = transcriptPathResolver({ pattern: /docs\/adr\/[\w-]+\.md/g });
		const ctx = ctxOf([asst("Wrote docs/adr/0001-init.md, see docs/adr/0002-types.md")]);
		const result = await resolver.resolve(ctx);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(result.artifacts).toEqual([{ handle: { kind: "fs", path: "docs/adr/0002-types.md" }, role: "primary" }]);
	});

	it("fatals when no match is found (artifact-emit contract)", async () => {
		const resolver = transcriptPathResolver({ pattern: /docs\/adr\/[\w-]+\.md/g });
		const ctx = ctxOf([asst("nothing here")]);
		const result = await resolver.resolve(ctx);
		expect(result.kind).toBe("fatal");
		if (result.kind !== "fatal") return;
		expect(result.message).toMatch(/finished without producing a path matching/);
	});

	it("scans reverse — returns the match from the latest assistant message", async () => {
		const resolver = transcriptPathResolver({ pattern: /docs\/[\w-]+\.md/g });
		const ctx = ctxOf([asst("first: docs/old.md"), asst("final: docs/new.md")]);
		const result = await resolver.resolve(ctx);
		expect(result.kind === "ok" && result.artifacts[0]?.handle).toEqual({ kind: "fs", path: "docs/new.md" });
	});

	it("respects branchOffset (continue-policy: skips prior-stage prefix)", async () => {
		const resolver = transcriptPathResolver({ pattern: /docs\/[\w-]+\.md/g });
		const branch = [asst("prior: docs/old.md"), asst("current: docs/new.md")];
		const ctx = { ...ctxOf(branch), branchOffset: 1 };
		const result = await resolver.resolve(ctx);
		expect(result.kind === "ok" && result.artifacts[0]?.handle).toEqual({ kind: "fs", path: "docs/new.md" });
	});

	it("ignores user messages and non-message entries", async () => {
		const resolver = transcriptPathResolver({ pattern: /docs\/[\w-]+\.md/g });
		const ctx = ctxOf([
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "see docs/from-user.md" }] } },
			{ type: "thinking_level_change" },
			asst("agent: docs/from-agent.md"),
		]);
		const result = await resolver.resolve(ctx);
		expect(result.kind === "ok" && result.artifacts[0]?.handle).toEqual({ kind: "fs", path: "docs/from-agent.md" });
	});
});
