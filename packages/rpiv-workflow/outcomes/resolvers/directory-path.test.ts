import { describe, expect, it } from "vitest";
import type { BranchEntry } from "../../transcript.js";
import { directoryPathResolver } from "./directory-path.js";

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

describe("directoryPathResolver", () => {
	it("throws when dir is missing or empty", () => {
		// @ts-expect-error — intentional misuse
		expect(() => directoryPathResolver({})).toThrow(/dir.*required/);
		expect(() => directoryPathResolver({ dir: "" })).toThrow(/dir.*required/);
	});

	it("matches files under the directory with any extension when ext omitted", async () => {
		const resolver = directoryPathResolver({ dir: "docs/adr" });
		const ctx = ctxOf([asst("Wrote docs/adr/0042-init.md and docs/adr/notes.txt")]);
		const result = await resolver.resolve(ctx);
		expect(result.kind === "ok" && result.artifacts[0]?.handle).toEqual({
			kind: "fs",
			path: "docs/adr/notes.txt",
		});
	});

	it("narrows by extension when supplied", async () => {
		const resolver = directoryPathResolver({ dir: "docs/adr", ext: "md" });
		const ctx = ctxOf([asst("Wrote docs/adr/0042-init.md and docs/adr/notes.txt")]);
		const result = await resolver.resolve(ctx);
		expect(result.kind === "ok" && result.artifacts[0]?.handle).toEqual({
			kind: "fs",
			path: "docs/adr/0042-init.md",
		});
	});

	it("escapes regex metacharacters in dir (e.g. dots in subfolder names)", async () => {
		const resolver = directoryPathResolver({ dir: ".rpiv/artifacts/research.v2", ext: "md" });
		const ctx = ctxOf([asst("Result: .rpiv/artifacts/research.v2/topic.md")]);
		const result = await resolver.resolve(ctx);
		expect(result.kind === "ok" && result.artifacts[0]?.handle).toEqual({
			kind: "fs",
			path: ".rpiv/artifacts/research.v2/topic.md",
		});
	});

	it("fatals when nothing matches the directory", async () => {
		const resolver = directoryPathResolver({ dir: "docs/adr", ext: "md" });
		const ctx = ctxOf([asst("Wrote elsewhere/file.md")]);
		const result = await resolver.resolve(ctx);
		expect(result.kind).toBe("fatal");
	});
});
