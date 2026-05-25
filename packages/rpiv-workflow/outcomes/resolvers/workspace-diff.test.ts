import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselineCtx, ResolveCtx } from "../../outcome-types.js";
import { type WorkspaceDiffBaseline, workspaceDiffResolver } from "./workspace-diff.js";

const hasGit = (() => {
	try {
		execSync("git --version", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

const initRepo = (cwd: string): void => {
	execSync("git init -q", { cwd });
	execSync("git config user.email test@example.com", { cwd });
	execSync("git config user.name Test", { cwd });
	execSync("git commit --allow-empty -q -m initial", { cwd });
};

const baselineCtxOf = (cwd: string): BaselineCtx => ({
	cwd,
	runId: "test",
	stageIndex: 0,
	state: {} as never,
});

const resolveCtxOf = (
	cwd: string,
	baseline: WorkspaceDiffBaseline | undefined,
): ResolveCtx<WorkspaceDiffBaseline | undefined> => ({
	...baselineCtxOf(cwd),
	branch: [],
	branchOffset: undefined,
	baseline,
	skill: "test",
});

describe.runIf(hasGit)("workspaceDiffResolver", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-wd-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("emits one fs artifact per file written during the stage", async () => {
		initRepo(tmpDir);
		const resolver = workspaceDiffResolver();
		const baseline = await resolver.baseline?.(baselineCtxOf(tmpDir));
		// Write two files post-baseline.
		writeFileSync(join(tmpDir, "a.txt"), "hello");
		writeFileSync(join(tmpDir, "b.txt"), "world");

		const result = await resolver.resolve(resolveCtxOf(tmpDir, baseline));
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		const paths = result.artifacts.map((a) => (a.handle.kind === "fs" ? a.handle.path : "")).sort();
		expect(paths).toEqual(["a.txt", "b.txt"]);
		// Every artifact's role and meta hint come from the resolver, not the user.
		expect(result.artifacts[0]?.role).toBe("changed");
		expect(result.artifacts[0]?.meta?.gitStatus).toBe("??");
	});

	it("skips files whose status was unchanged from baseline (untouched files don't count)", async () => {
		initRepo(tmpDir);
		// Pre-baseline file — already untracked.
		writeFileSync(join(tmpDir, "preexisting.txt"), "x");
		const resolver = workspaceDiffResolver();
		const baseline = await resolver.baseline?.(baselineCtxOf(tmpDir));

		// Write a NEW file during the "stage."
		writeFileSync(join(tmpDir, "new.txt"), "y");

		const result = await resolver.resolve(resolveCtxOf(tmpDir, baseline));
		expect(
			result.kind === "ok" && result.artifacts.map((a) => (a.handle.kind === "fs" ? a.handle.path : "")),
		).toEqual(["new.txt"]);
	});

	it("applies the optional filter", async () => {
		initRepo(tmpDir);
		const resolver = workspaceDiffResolver({ filter: (p) => p.endsWith(".md") });
		const baseline = await resolver.baseline?.(baselineCtxOf(tmpDir));
		writeFileSync(join(tmpDir, "a.txt"), "x");
		writeFileSync(join(tmpDir, "b.md"), "y");

		const result = await resolver.resolve(resolveCtxOf(tmpDir, baseline));
		expect(
			result.kind === "ok" && result.artifacts.map((a) => (a.handle.kind === "fs" ? a.handle.path : "")),
		).toEqual(["b.md"]);
	});

	it("fail-soft: cwd is not a git repo → baseline undefined → resolve returns empty", async () => {
		const resolver = workspaceDiffResolver();
		const baseline = await resolver.baseline?.(baselineCtxOf(tmpDir));
		expect(baseline).toBeUndefined();
		const result = await resolver.resolve(resolveCtxOf(tmpDir, baseline));
		expect(result.kind === "ok" && result.artifacts).toEqual([]);
	});
});
