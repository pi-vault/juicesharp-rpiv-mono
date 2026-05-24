import { describe, expect, it } from "vitest";
import {
	type DagNode,
	getEdge,
	isValidNode,
	resolvePreset,
	skillNode,
	validateDag,
	WORKFLOW_DAG,
	type WorkflowDag,
} from "./dag.js";

describe("DAG types and constants", () => {
	it("WORKFLOW_DAG has 16 edges (12 auto + 2 choice + 2 predicate)", () => {
		// Compiled from `built-in.ts`. Two `*-after-*` → commit edges that were
		// implicit in the old hand-authored linear lists now appear as explicit
		// auto edges (behavior identical via `linearNextOf` fallback either way).
		// The legacy `explore → [design, blueprint]` choice edge is dropped —
		// no built-in preset reaches it.
		expect(WORKFLOW_DAG.edges).toHaveLength(16);
		expect(WORKFLOW_DAG.edges.filter((e) => e.condition === "auto")).toHaveLength(12);
		expect(WORKFLOW_DAG.edges.filter((e) => e.condition === "choice")).toHaveLength(2);
		expect(WORKFLOW_DAG.edges.filter((e) => e.condition === "predicate")).toHaveLength(2);
	});

	it("WORKFLOW_DAG has 3 presets", () => {
		const presetNames = Object.keys(WORKFLOW_DAG.presets);
		// Order is whatever `built-in.ts:builtInWorkflows` declares — set, not list.
		expect(new Set(presetNames)).toEqual(new Set(["small", "mid", "large"]));
	});

	it("mid preset has 8 nodes (Path A tail: code-review → revise → implement → commit)", () => {
		expect(WORKFLOW_DAG.presets.mid).toHaveLength(8);
	});

	it("large preset has 10 nodes (Path B tail: code-review → design → plan → implement → commit)", () => {
		expect(WORKFLOW_DAG.presets.large).toHaveLength(10);
	});

	it("every preset includes validate as its verification stage", () => {
		// small ends at validate; mid/large continue into code-review after validate.
		for (const [name, stageIds] of Object.entries(WORKFLOW_DAG.presets)) {
			expect(stageIds, `preset ${name} should include validate`).toContain("validate");
		}
	});

	it("every preset reaches implement before validate (so there is code to validate)", () => {
		for (const [name, stageIds] of Object.entries(WORKFLOW_DAG.presets)) {
			expect(stageIds, `preset ${name} should include implement`).toContain("implement");
		}
	});

	it("every auto edge has exactly one target; every choice edge has >= 2", () => {
		for (const edge of WORKFLOW_DAG.edges) {
			if (edge.condition === "auto") {
				expect(edge.to).toHaveLength(1);
			} else {
				expect(edge.to.length).toBeGreaterThanOrEqual(2);
			}
		}
	});

	it("no duplicate edge sources", () => {
		const froms = WORKFLOW_DAG.edges.map((e) => e.from);
		expect(new Set(froms).size).toBe(froms.length);
	});
});

describe("getEdge", () => {
	it("returns edge for known source", () => {
		const edge = getEdge(WORKFLOW_DAG, "discover");
		expect(edge).toBeDefined();
		expect(edge!.to).toEqual(["research"]);
		expect(edge!.condition).toBe("auto");
	});

	it("returns undefined for leaf node", () => {
		expect(getEdge(WORKFLOW_DAG, "commit")).toBeUndefined();
	});

	it("returns choice edge for research", () => {
		const edge = getEdge(WORKFLOW_DAG, "research");
		expect(edge).toBeDefined();
		expect(edge!.condition).toBe("choice");
		expect(edge!.to).toEqual(["design", "blueprint"]);
	});
});

describe("resolvePreset", () => {
	it("resolves small to blueprint → implement → validate", () => {
		expect(resolvePreset(WORKFLOW_DAG, "small")).toEqual(["blueprint", "implement", "validate"]);
	});

	it("resolves mid to Path A sequence (revise loop after code-review)", () => {
		// Second implement is aliased to "implement-after-revise" so routing
		// can reach it via Array.indexOf rather than looping back to idx 2.
		expect(resolvePreset(WORKFLOW_DAG, "mid")).toEqual([
			"research",
			"blueprint",
			"implement",
			"validate",
			"code-review",
			"revise",
			"implement-after-revise",
			"commit",
		]);
	});

	it("resolves large to Path B sequence (design/plan redesign tail after code-review)", () => {
		// Post-review stages are aliased (code-review-large, design-after-review,
		// plan-after-review, implement-after-review) so routing reaches each
		// distinct position rather than looping back to the pre-validate run.
		expect(resolvePreset(WORKFLOW_DAG, "large")).toEqual([
			"research",
			"design",
			"plan",
			"implement",
			"validate",
			"code-review-large",
			"design-after-review",
			"plan-after-review",
			"implement-after-review",
			"commit",
		]);
	});

	it("returns undefined for unknown preset", () => {
		expect(resolvePreset(WORKFLOW_DAG, "nonexistent")).toBeUndefined();
	});
});

describe("validateDag", () => {
	const nodeOf = (skill: string, overrides: Partial<DagNode> = {}): DagNode => ({
		kind: "skill",
		skill,
		completionStrategy: "agent-end",
		sessionPolicy: "fresh",
		...overrides,
	});

	it("returns no errors and no warnings for the default WORKFLOW_DAG", () => {
		// code-review carries an outputSchema, so the predicate-edge warning is
		// no longer emitted. If a future built-in node grows a predicate edge
		// without a schema, the warning would resurface here.
		const { errors, warnings } = validateDag(WORKFLOW_DAG);
		expect(errors).toEqual([]);
		expect(warnings).toEqual([]);
	});

	it("reports edge source that's not in nodes map", () => {
		const badDag: WorkflowDag = {
			edges: [{ from: "nonexistent", to: ["commit"], condition: "auto" }],
			presets: {},
			nodes: { commit: nodeOf("commit") },
		};
		const { errors } = validateDag(badDag);
		expect(errors).toEqual([expect.stringContaining(`Edge source "nonexistent" has no entry in nodes`)]);
	});

	it("reports edge target that's not in nodes map", () => {
		const badDag: WorkflowDag = {
			edges: [{ from: "discover", to: ["nonexistent"], condition: "auto" }],
			presets: {},
			nodes: { discover: nodeOf("discover") },
		};
		const { errors } = validateDag(badDag);
		expect(errors).toEqual([
			expect.stringContaining(`Edge target "nonexistent" (from "discover") has no entry in nodes`),
		]);
	});

	it("reports preset entry that's not in nodes map", () => {
		const badDag: WorkflowDag = {
			edges: [],
			presets: { small: ["nonexistent", "implement"] },
			nodes: { implement: nodeOf("implement") },
		};
		const { errors } = validateDag(badDag);
		expect(errors).toEqual([
			expect.stringContaining(`Preset "small" references "nonexistent" which has no entry in nodes`),
		]);
	});

	it("reports skill-kind node referencing a non-bundled skill", () => {
		const badDag: WorkflowDag = {
			edges: [],
			presets: { tiny: ["custom"] },
			nodes: { custom: nodeOf("not-a-real-skill") },
		};
		const { errors } = validateDag(badDag);
		expect(errors).toEqual([
			expect.stringContaining(`Node "custom" (kind=skill) references unknown bundled skill: "not-a-real-skill"`),
		]);
	});

	it("accepts sessionPolicy: 'continue' as a valid runtime value", () => {
		const dag: WorkflowDag = {
			edges: [],
			presets: { tiny: ["research"] },
			nodes: { research: nodeOf("research", { sessionPolicy: "continue" }) },
		};
		const { errors } = validateDag(dag);
		expect(errors).toEqual([]);
	});

	it("skillNode() override produces correct sessionPolicy", () => {
		const fresh = skillNode("research", "artifact-emit");
		expect(fresh.sessionPolicy).toBe("fresh");

		const cont = skillNode("research", "artifact-emit", { sessionPolicy: "continue" });
		expect(cont.sessionPolicy).toBe("continue");
		expect(cont.kind).toBe("skill");
		expect(cont.completionStrategy).toBe("artifact-emit");
	});

	it("skillNode() propagates inputSchema from overrides", () => {
		const schema = { type: "object" as const, properties: { topic: { type: "string" as const } } };
		const node = skillNode("design", "artifact-emit", { inputSchema: schema });
		expect(node.inputSchema).toBe(schema);
	});

	it("skillNode() defaults inputSchema to undefined", () => {
		const node = skillNode("research", "artifact-emit");
		expect(node.inputSchema).toBeUndefined();
	});

	it("rejects invalid completionStrategy value", () => {
		const badDag: WorkflowDag = {
			edges: [],
			presets: { tiny: ["research"] },
			nodes: {
				research: { ...nodeOf("research"), completionStrategy: "garbage" as never },
			},
		};
		const { errors } = validateDag(badDag);
		expect(errors).toEqual([expect.stringContaining(`Node "research" has invalid completionStrategy: "garbage"`)]);
	});

	it("reports multiple errors at once", () => {
		const badDag: WorkflowDag = {
			edges: [{ from: "nonexistent", to: ["also-bad"], condition: "auto" }],
			presets: {},
			nodes: {},
		};
		expect(validateDag(badDag).errors.length).toBeGreaterThanOrEqual(2);
	});

	it("rejects predicate edge without predicate function", () => {
		const dag: WorkflowDag = {
			edges: [{ from: "research", to: ["design", "blueprint"], condition: "predicate" }],
			presets: { tiny: ["research"] },
			nodes: { research: nodeOf("research"), design: nodeOf("design"), blueprint: nodeOf("blueprint") },
		};
		const { errors, warnings } = validateDag(dag);
		expect(errors).toEqual([expect.stringContaining('has condition "predicate" but no predicate function')]);
		expect(warnings.length).toBeGreaterThan(0);
	});

	it("warns on predicate edge whose source node lacks outputSchema", () => {
		const predicate = () => "design";
		const dag: WorkflowDag = {
			edges: [{ from: "research", to: ["design", "blueprint"], condition: "predicate", predicate }],
			presets: { tiny: ["research"] },
			nodes: { research: nodeOf("research"), design: nodeOf("design"), blueprint: nodeOf("blueprint") },
		};
		const { warnings } = validateDag(dag);
		expect(warnings).toEqual([expect.stringContaining("no outputSchema")]);
	});

	it("does NOT warn on predicate edge whose source node has outputSchema", () => {
		const predicate = () => "design";
		const schema = { type: "object" as const, properties: {} };
		const dag: WorkflowDag = {
			edges: [{ from: "research", to: ["design", "blueprint"], condition: "predicate", predicate }],
			presets: { tiny: ["research"] },
			nodes: {
				research: nodeOf("research", { outputSchema: schema }),
				design: nodeOf("design"),
				blueprint: nodeOf("blueprint"),
			},
		};
		const { warnings } = validateDag(dag);
		expect(warnings).toEqual([]);
	});

	it("rejects invalid onValidationFailure values", () => {
		const dag: WorkflowDag = {
			edges: [],
			presets: { tiny: ["research"] },
			nodes: { research: { ...nodeOf("research"), onValidationFailure: "bad" as never } },
		};
		const { errors } = validateDag(dag);
		expect(errors).toEqual([expect.stringContaining('invalid onValidationFailure: "bad"')]);
	});

	it("rejects maxValidationRetries outside 1..3", () => {
		const dag0: WorkflowDag = {
			edges: [],
			presets: { tiny: ["research"] },
			nodes: { research: { ...nodeOf("research"), maxValidationRetries: 0 } },
		};
		expect(validateDag(dag0).errors).toEqual([expect.stringContaining("maxValidationRetries: 0 — must be 1..3")]);

		const dag5: WorkflowDag = {
			edges: [],
			presets: { tiny: ["research"] },
			nodes: { research: { ...nodeOf("research"), maxValidationRetries: 5 } },
		};
		expect(validateDag(dag5).errors).toEqual([expect.stringContaining("maxValidationRetries: 5 — must be 1..3")]);
	});
});

describe("isValidNode", () => {
	it("returns true for known skills", () => {
		expect(isValidNode("discover")).toBe(true);
		expect(isValidNode("research")).toBe(true);
		expect(isValidNode("commit")).toBe(true);
	});

	it("returns false for unknown skills", () => {
		expect(isValidNode("nonexistent-skill")).toBe(false);
		expect(isValidNode("")).toBe(false);
	});
});
