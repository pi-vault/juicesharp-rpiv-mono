/**
 * Prompt-dispatch tests — the third dispatch (raw text → session) alongside
 * skill (`/skill:<name>`) and script `run`.
 *
 * Exercised end-to-end through `runWorkflow` + a scripted mock chain. The
 * dispatch is policy-agnostic: `runStage` builds the same string whether the
 * stage is fresh or continue, and `CONTINUE_HANDLER` sends its `prompt` arg
 * verbatim (existing, unchanged code). So these FRESH-mode tests fully cover
 * the new dispatch code; continue is the same session machinery with a
 * different prompt source. (The shared mock chain doesn't grow the transcript
 * on a continue `sendUserMessage` turn, so a continue stage can't be run
 * end-to-end here — a harness limitation, not a dispatch one.)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockPi, createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acts, defineWorkflow, produces } from "./api.js";
import { fs as fsHandle, handleToString } from "./handle.js";
import type { OutputSpec } from "./output.js";
import { runWorkflow } from "./runner/index.js";

const PATTERN = /\.rpiv\/artifacts\/[\w.-]+\/[\w.-]+\.md/g;

/** Transcript-scan outcome (no disk read) — publishes under `name`. */
const makeOutcome = (name: string): OutputSpec<unknown, "artifact-md", Record<string, unknown>> => ({
	name,
	collector: {
		collect: (ctx) => {
			const matches: string[] = [];
			for (let i = Math.max(ctx.branchOffset ?? 0, 0); i < ctx.branch.length; i++) {
				const entry = ctx.branch[i]!;
				if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
				const content = entry.message.content;
				if (!Array.isArray(content)) continue;
				for (const part of content) {
					if (part.type === "text" && typeof part.text === "string") {
						const m = part.text.match(PATTERN);
						if (m) matches.push(...m);
					}
				}
			}
			if (matches.length === 0) return { kind: "fatal", message: `${ctx.skill} produced no artifact path` };
			return { kind: "ok", artifacts: matches.map((p) => ({ handle: fsHandle(p), role: "primary" as const })) };
		},
	},
	parser: { parse: () => ({ kind: "ok", payload: { kind: "artifact-md", data: {} } }) },
});

describe("prompt dispatch", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-prompt-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("dispatches the raw prompt text — no /skill: prefix, no appended arg", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("low risk")] }],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: defineWorkflow({
				name: "ask",
				start: "classify",
				stages: { classify: acts({ prompt: "Classify the diff risk as low/medium/high." }) },
				edges: { classify: "stop" },
			}),
			input: "ignored — a prompt stage owns its whole message",
		});

		expect(result.success).toBe(true);
		expect(result.stagesCompleted).toBe(1);
		expect(chain.sentMessages).toEqual(["Classify the diff risk as low/medium/high."]);
	});

	it("produces + prompt runs the outcome collector and publishes to state.named", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/summary/s.md")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: defineWorkflow({
				name: "sum",
				start: "produce",
				stages: {
					produce: produces({
						prompt: "Write a summary to .rpiv/artifacts/summary/s.md",
						outcome: makeOutcome("summary"),
					}),
					consume: acts({ reads: ["summary"] }),
				},
				edges: { produce: "consume", consume: "stop" },
			}),
			input: "x",
		});

		expect(result.success).toBe(true);
		expect(chain.sentMessages).toEqual([
			"Write a summary to .rpiv/artifacts/summary/s.md",
			// consume read state.named["summary"] — proving the prompt produces stage published.
			"/skill:consume --summary .rpiv/artifacts/summary/s.md",
		]);
		expect(result.lastArtifact).toBe(".rpiv/artifacts/summary/s.md");
	});

	it("dynamic PromptFn receives ScriptContext (ctx.input = upstream Output)", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/x/seed.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/x/refined.md")] },
			],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: defineWorkflow({
				name: "refine",
				start: "seed",
				stages: {
					seed: produces({ outcome: makeOutcome("seed") }),
					transform: produces({
						prompt: ({ input }) => `Refine ${handleToString(input!.artifacts[0]!.handle)} for clarity.`,
						outcome: makeOutcome("refined"),
					}),
				},
				edges: { seed: "transform", transform: "stop" },
			}),
			input: "x",
		});

		expect(result.success).toBe(true);
		// seed's skill dispatch, then the dynamic prompt woven with seed's artifact path.
		expect(chain.sentMessages).toEqual(["/skill:seed x", "Refine .rpiv/artifacts/x/seed.md for clarity."]);
	});

	it("skips the skill-registry preflight (a prompt stage names no skill to register)", async () => {
		// A host IS present, so registeredSkills is populated and does NOT include
		// "classify". A skill stage would halt here; a prompt stage must run.
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const host = createMockPi({ skills: ["something-else"] }).pi;

		const result = await runWorkflow(chain.ctx, {
			workflow: defineWorkflow({
				name: "ask",
				start: "classify",
				stages: { classify: acts({ prompt: "Just answer." }) },
				edges: { classify: "stop" },
			}),
			input: "x",
			host,
		});

		expect(result.success).toBe(true);
		expect(chain.sentMessages).toEqual(["Just answer."]);
	});
});
