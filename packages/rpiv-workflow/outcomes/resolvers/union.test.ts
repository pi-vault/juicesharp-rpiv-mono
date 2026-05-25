import { describe, expect, it } from "vitest";
import { fs } from "../../handle.js";
import type { ArtifactResolver } from "../../outcome-types.js";
import { unionResolvers } from "./union.js";

const ctxOf = () => ({
	cwd: "/tmp",
	runId: "test",
	stageIndex: 0,
	state: {} as never,
	branch: [],
	branchOffset: undefined,
	baseline: undefined,
	skill: "test",
});

const okResolver = (paths: string[]): ArtifactResolver => ({
	resolve: () => ({ kind: "ok", artifacts: paths.map((p) => ({ handle: fs(p) })) }),
});

const fatalResolver = (msg: string): ArtifactResolver => ({
	resolve: () => ({ kind: "fatal", message: msg }),
});

describe("unionResolvers", () => {
	it("throws when constructed with zero resolvers", () => {
		expect(() => unionResolvers()).toThrow(/at least one resolver/);
	});

	it("concatenates artifacts in resolver order", async () => {
		const union = unionResolvers(okResolver(["a.ts", "b.ts"]), okResolver(["c.ts"]));
		const result = await union.resolve(ctxOf());
		expect(
			result.kind === "ok" && result.artifacts.map((a) => (a.handle.kind === "fs" ? a.handle.path : "")),
		).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	it("returns ok+empty when every sub-resolver yielded ok+empty", async () => {
		const union = unionResolvers(okResolver([]), okResolver([]));
		const result = await union.resolve(ctxOf());
		expect(result.kind === "ok" && result.artifacts).toEqual([]);
	});

	it("returns ok when at least one sub-resolver succeeds (even if others fatal)", async () => {
		const union = unionResolvers(fatalResolver("transcript: no match"), okResolver(["b.ts"]));
		const result = await union.resolve(ctxOf());
		expect(
			result.kind === "ok" && result.artifacts.map((a) => (a.handle.kind === "fs" ? a.handle.path : "")),
		).toEqual(["b.ts"]);
	});

	it("returns fatal carrying the LAST fatal message when every sub-resolver fataled", async () => {
		const union = unionResolvers(fatalResolver("first failure"), fatalResolver("second failure"));
		const result = await union.resolve(ctxOf());
		expect(result.kind).toBe("fatal");
		if (result.kind !== "fatal") return;
		expect(result.message).toBe("second failure");
	});
});
