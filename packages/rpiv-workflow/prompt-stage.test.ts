/**
 * Prompt-dispatch tests — the third dispatch (raw text → session) alongside
 * skill (`/skill:<name>`) and script `run`.
 *
 * Exercised end-to-end through `runWorkflow` + a scripted mock chain, in both
 * session policies. Fresh stages read their step's scripted branch; continue
 * stages reuse the prior stage's session — modelled (per the runner.test.ts
 * pattern) with a SHARED MUTABLE branch that the continue stage's
 * `sendUserMessageFn` override grows on send, so the new turn's reply lands
 * after `branchOffset` for `classifyStop` + the collector to see.
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

describe("prompt builders (produces.prompt / acts.prompt)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-prompt-build-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("set the right dispatch fields and defaults", () => {
		const p = produces.prompt({ prompt: "x", outcome: makeOutcome("p"), sessionPolicy: "continue" });
		expect(p).toMatchObject({ kind: "produces", sessionPolicy: "continue", prompt: "x" });
		expect(p.outcome?.name).toBe("p");
		expect(p.skill).toBeUndefined();
		expect(p.run).toBeUndefined();

		const a = acts.prompt({ prompt: "y" });
		expect(a).toMatchObject({ kind: "side-effect", sessionPolicy: "fresh", prompt: "y" });
		expect(a.outcome).toBeUndefined();
	});

	it("produces.prompt builds a working raw-prompt produces stage end-to-end", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/summary/s.md")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: defineWorkflow({
				name: "built",
				start: "produce",
				stages: {
					produce: produces.prompt({
						prompt: "Write to .rpiv/artifacts/summary/s.md",
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
			"Write to .rpiv/artifacts/summary/s.md",
			"/skill:consume --summary .rpiv/artifacts/summary/s.md",
		]);
	});

	it("reject dispatch-conflicting options at compile time", () => {
		// Each `@ts-expect-error` asserts the narrowed options type rejects the
		// combo — `tsc` (via `npm run check`) fails if any line stops erroring.
		// At runtime the builders ignore the excess field and still return a
		// valid StageDef, so the expectations pass.

		// @ts-expect-error — a prompt builder cannot also name a skill
		expect(produces.prompt({ prompt: "x", outcome: makeOutcome("p"), skill: "implement" })).toBeDefined();
		// @ts-expect-error — a prompt builder cannot fanout
		expect(acts.prompt({ prompt: "x", fanout: () => [] })).toBeDefined();
		// @ts-expect-error — a prompt builder cannot iterate
		expect(produces.prompt({ prompt: "x", outcome: makeOutcome("p"), iterate: () => null })).toBeDefined();
		// @ts-expect-error — a prompt builder cannot read named slots (use the PromptFn)
		expect(acts.prompt({ prompt: "x", reads: ["plans"] })).toBeDefined();
		// @ts-expect-error — produces.prompt requires an outcome
		expect(produces.prompt({ prompt: "x" })).toBeDefined();
	});
});

describe("prompt dispatch — continue follow-up turn", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-prompt-cont-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	/**
	 * Wire a continue chain: a shared mutable branch the fresh stage reads as-is,
	 * grown by the continue stage's send so its reply lands after `branchOffset`.
	 * `grow` decides what (if anything) each sent message appends.
	 */
	const continueChain = (firstEntry: string, grow: (text: string, branch: unknown[]) => void) => {
		const sharedBranch: unknown[] = [mockAssistantMessage(firstEntry)];
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: sharedBranch }],
			pi: createMockPi({ skills: ["lead"] }).pi,
		});
		chain.sendUserMessageFn.mockImplementation((content: unknown) => {
			const text = typeof content === "string" ? content : JSON.stringify(content);
			chain.sentMessages.push(text);
			grow(text, sharedBranch);
		});
		return chain;
	};

	it("a side-effect continue prompt stage reuses the prior session and sends raw text", async () => {
		const chain = continueChain("wrote .rpiv/artifacts/research/r.md", (text, branch) => {
			if (text === "Summarise the research above in three bullets.")
				branch.push(mockAssistantMessage("- a\n- b\n- c"));
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: defineWorkflow({
				name: "leadfollow",
				start: "lead",
				stages: {
					lead: produces({ outcome: makeOutcome("research") }),
					followup: acts.prompt({
						prompt: "Summarise the research above in three bullets.",
						sessionPolicy: "continue",
					}),
				},
				edges: { lead: "followup", followup: "stop" },
			}),
			input: "x",
			host: chain.pi,
		});

		expect(result.success).toBe(true);
		expect(result.stagesCompleted).toBe(2);
		// One newSession (lead, fresh); followup reused the live inner ctx, not the host.
		expect(chain.ctx.newSession).toHaveBeenCalledTimes(1);
		expect(chain.pi?.sendUserMessage).not.toHaveBeenCalled();
		expect(chain.sentMessages).toEqual(["/skill:lead x", "Summarise the research above in three bullets."]);
	});

	it("a produces continue prompt stage collects from the NEW turn (branch-offset slicing)", async () => {
		const chain = continueChain("wrote .rpiv/artifacts/research/r.md", (text, branch) => {
			if (text.startsWith("Refine")) branch.push(mockAssistantMessage("wrote .rpiv/artifacts/summary/s.md"));
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: defineWorkflow({
				name: "leadrefine",
				start: "lead",
				stages: {
					lead: produces({ outcome: makeOutcome("research") }),
					refine: produces.prompt({
						prompt: "Refine the research into a summary.",
						outcome: makeOutcome("summary"),
						sessionPolicy: "continue",
					}),
				},
				edges: { lead: "refine", refine: "stop" },
			}),
			input: "x",
			host: chain.pi,
		});

		expect(result.success).toBe(true);
		expect(result.stagesCompleted).toBe(2);
		// The collector scanned from branchOffset — it saw the refine turn's
		// artifact (s.md), NOT lead's r.md, proving the slice is correct.
		expect(result.lastArtifact).toBe(".rpiv/artifacts/summary/s.md");
		expect(chain.sentMessages).toEqual(["/skill:lead x", "Refine the research into a summary."]);
	});
});
