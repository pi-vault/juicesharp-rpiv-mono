/**
 * Git commit outcome + pre-stage git HEAD snapshot.
 *
 * Split into a resolver (detects the commit and emits an `opaque(sha)`
 * handle) and a reader (parses commit metadata into `GitCommitData`).
 * `gitCommitOutcome` is the wired-up pair authors plug into a node;
 * `gitCommitResolver` and `gitCommitReader` are individually exposed
 * so authors can compose them with other readers / resolvers.
 *
 * Shells out asynchronously via `execFile` so a slow `git` invocation
 * (network-backed working tree, hung FS, large `--shortstat`) can't
 * pin the event loop.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type Artifact, opaque } from "../handle.js";
import type { ArtifactReader, ArtifactResolver, BaselineCtx, Outcome, ReadCtx, ResolveCtx } from "../outcome-types.js";

const execFileAsync = promisify(execFile);

/**
 * Manifest data shape produced by `gitCommitReader` — co-located with
 * the outcome that emits it. The `GitCommitManifest` alias in
 * `manifest.ts` re-imports this type so downstream nodes can narrow on
 * `manifest.kind === "git-commit"` without reaching into per-outcome
 * paths.
 */
export interface GitCommitData {
	sha: string;
	prevSha: string;
	subject: string;
	filesChanged: number;
	noOp?: boolean;
}

/** Baseline snapshot captured before the stage runs. */
export interface GitHeadSnapshot {
	baselineSha: string;
}

/** Per git command. 5 s is generous for `rev-parse` / `log -1` / `diff --shortstat` on local repos. */
const GIT_EXEC_TIMEOUT_MS = 5_000;

/** Run a git command from `cwd`, returning trimmed stdout. */
async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		encoding: "utf-8",
		timeout: GIT_EXEC_TIMEOUT_MS,
	});
	return stdout.trim();
}

/**
 * Pre-stage snapshot: capture the current HEAD SHA via async `execFile`.
 *
 * Async — keeps the event loop responsive even if `git` is slow (network
 * FS, hung mount, contended index). Fail-soft: returns undefined on any
 * failure (not a git repo, git missing, non-zero exit, timeout).
 * `gitCommitResolver` handles `undefined` snapshot gracefully by
 * emitting an artifact carrying a `noOp: true` payload.
 */
export async function gitHeadSnapshot(ctx: BaselineCtx): Promise<GitHeadSnapshot | undefined> {
	try {
		const sha = await git(ctx.cwd, "rev-parse", "HEAD");
		return sha ? { baselineSha: sha } : undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Resolver — detect "did HEAD move during this stage?"
// ---------------------------------------------------------------------------

/**
 * Resolver always emits exactly one artifact — even on no-op (HEAD
 * unchanged) or git-unavailable, with the handle's `id` carrying the
 * post-stage SHA (or empty string). The reader interprets the
 * `noOp` flag from the artifact's `meta`. This shape keeps the
 * resolver's contract uniform (always one fact) while letting the
 * reader produce the rich `GitCommitData` downstream consumers expect.
 */
export const gitCommitResolver: ArtifactResolver<GitHeadSnapshot | undefined> = {
	baseline: gitHeadSnapshot,
	async resolve(ctx: ResolveCtx<GitHeadSnapshot | undefined>) {
		const baselineSha = ctx.baseline?.baselineSha ?? "";
		const headSha = await safeHead(ctx.cwd);
		const artifact: Artifact = {
			handle: opaque(headSha || baselineSha),
			role: "commit",
			meta: { baselineSha, headSha, baselineMissing: !ctx.baseline },
		};
		return { kind: "ok", artifacts: [artifact] };
	},
};

async function safeHead(cwd: string): Promise<string> {
	try {
		return await git(cwd, "rev-parse", "HEAD");
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// Reader — turn the resolved commit handle into typed GitCommitData
// ---------------------------------------------------------------------------

export const gitCommitReader: ArtifactReader<GitHeadSnapshot | undefined, "git-commit", GitCommitData> = {
	async read(ctx: ReadCtx<GitHeadSnapshot | undefined>) {
		const artifact = ctx.artifacts[0];
		if (!artifact) {
			// Defensive — gitCommitResolver always emits one, but a composed
			// resolver may not. Treat as no-op against the baseline.
			return { kind: "ok", payload: { kind: "git-commit", data: noOpData(ctx.baseline?.baselineSha ?? "") } };
		}
		const meta = artifact.meta as { baselineSha: string; headSha: string; baselineMissing: boolean } | undefined;
		const baselineSha = meta?.baselineSha ?? "";
		const headSha = meta?.headSha ?? "";

		if (meta?.baselineMissing) {
			return { kind: "ok", payload: { kind: "git-commit", data: noOpData("") } };
		}

		const data = (await collectCommitData(ctx.cwd, baselineSha, headSha)) ?? noOpData(baselineSha);
		return { kind: "ok", payload: { kind: "git-commit", data } };
	},
};

// ---------------------------------------------------------------------------
// Outcome — the wired-up pair
// ---------------------------------------------------------------------------

/**
 * Git commit outcome — composes `gitCommitResolver` (which carries the
 * `gitHeadSnapshot` baseline internally) with `gitCommitReader`.
 *
 * Concrete generics: baseline is `GitHeadSnapshot | undefined`
 * (undefined when not in a git repo), manifest kind is `"git-commit"`,
 * data is `GitCommitData`.
 */
export const gitCommitOutcome: Outcome<GitHeadSnapshot | undefined, "git-commit", GitCommitData> = {
	resolver: gitCommitResolver,
	reader: gitCommitReader,
};

// ---------------------------------------------------------------------------
// Commit-data collection
// ---------------------------------------------------------------------------

/**
 * Build `GitCommitData` given pre/post SHAs already gathered by the
 * resolver. Returns `null` if any follow-up git call throws — caller
 * substitutes a baseline-aware no-op payload so the workflow keeps
 * moving.
 */
async function collectCommitData(cwd: string, baselineSha: string, headSha: string): Promise<GitCommitData | null> {
	try {
		if (!headSha || headSha === baselineSha) return noOpData(baselineSha, headSha);
		const [subject, filesChanged] = await Promise.all([
			git(cwd, "log", "-1", "--format=%s", headSha),
			countFilesChanged(cwd, baselineSha, headSha),
		]);
		return { sha: headSha, prevSha: baselineSha, subject, filesChanged };
	} catch {
		return null;
	}
}

/** Parse `git diff --shortstat` output for the "N files changed" count. */
async function countFilesChanged(cwd: string, baselineSha: string, headSha: string): Promise<number> {
	const diffStat = await git(cwd, "diff", "--shortstat", baselineSha, headSha);
	const match = diffStat.match(/^(\d+) files? changed/);
	return match ? parseInt(match[1]!, 10) : 0;
}

const noOpData = (prevSha: string, sha = ""): GitCommitData => ({
	sha,
	prevSha,
	subject: "",
	filesChanged: 0,
	noOp: true,
});
