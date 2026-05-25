/**
 * Load-time graph validation for `Workflow` objects.
 *
 * Catches the wiring mistakes a TS type system can't reach on its own:
 * unknown edge sources/targets, unreachable nodes, missing terminals,
 * predicate functions that return targets outside the node set.
 *
 * `validateWorkflow` returns a flat array of `WorkflowValidationIssue`s — errors
 * for problems that would crash the runner, warnings for shapes that
 * work but probably aren't what the author intended (unreachable nodes,
 * implicit terminals via missing edges). The load pipeline can choose
 * to halt on any error and surface warnings non-fatally.
 *
 * No I/O, no throws — purely a graph walk + predicate probe.
 */

import { type EdgeTarget, marksFrontmatter, STOP, type Workflow } from "./api.js";
import type { ConfigLayer } from "./layers.js";
import {
	MAX_VALIDATION_RETRIES,
	MAX_VALIDATION_RETRY_TIMEOUT_MS,
	MIN_VALIDATION_RETRIES,
	MIN_VALIDATION_RETRY_TIMEOUT_MS,
} from "./validate-manifest.js";

// ===========================================================================
// Issue shape
// ===========================================================================

export interface WorkflowValidationIssue {
	workflow: string;
	node?: string;
	severity: "error" | "warning";
	message: string;
	/**
	 * Populated by `load.ts` after aggregation — the layer the workflow came
	 * from. `validateWorkflow` itself doesn't know about layers; the loader
	 * is the seam that has both `workflowSources` and the issue list in scope.
	 */
	layer?: ConfigLayer;
	/** Source path (rpiv.config.ts) when the layer is user or project. */
	path?: string;
}

// ===========================================================================
// Public — validateWorkflow
// ===========================================================================

/**
 * Validate one workflow. Aggregates all issues; never short-circuits. Caller
 * decides what's fatal — `severity === "error"` is the runner-blocking set.
 */
export function validateWorkflow(workflow: Workflow): WorkflowValidationIssue[] {
	const issues: WorkflowValidationIssue[] = [];

	checkWorkflowName(workflow, issues);

	if (!workflow.nodes[workflow.start]) {
		issues.push(error(workflow.name, undefined, `start node "${workflow.start}" is not declared in nodes`));
	}

	checkEdgeKeys(workflow, issues);
	checkEdgeTargets(workflow, issues);
	checkMissingEdges(workflow, issues);
	// Skip reachability when an EdgeFn lacks `.targets` — the BFS would emit
	// "unreachable from start" cascades whose root cause is the upstream error
	// already reported by checkEdgeTargets.
	const hasUnenumerableEdge = issues.some((i) => /\.targets` metadata/.test(i.message));
	if (!hasUnenumerableEdge) checkReachability(workflow, issues);
	checkNodeSemantics(workflow, issues);
	checkPredicateSchemas(workflow, issues);

	return issues;
}

// ===========================================================================
// Individual checks
// ===========================================================================

/** `name` is what users type as `/wf <name>` — empty string makes the workflow unreachable. */
function checkWorkflowName(w: Workflow, issues: WorkflowValidationIssue[]): void {
	if (typeof w.name !== "string" || w.name.length === 0) {
		issues.push(error("(anonymous)", undefined, "workflow name must be a non-empty string"));
	}
}

/** Every key in `edges` must be a declared node. */
function checkEdgeKeys(w: Workflow, issues: WorkflowValidationIssue[]): void {
	for (const from of Object.keys(w.edges)) {
		if (!w.nodes[from]) {
			issues.push(error(w.name, from, `edges["${from}"] references a node that's not declared in nodes`));
		}
	}
}

/**
 * Every edge target must resolve to a declared node or the `"stop"` sentinel.
 * String targets are checked directly. `EdgeFn` targets are checked via
 * `.targets` metadata when present, or by probing — see `enumerateEdgeFnTargets`.
 */
function checkEdgeTargets(w: Workflow, issues: WorkflowValidationIssue[]): void {
	for (const [from, target] of Object.entries(w.edges)) {
		for (const candidate of enumerateTargets(target, w.name, from, issues)) {
			if (candidate === STOP) continue;
			if (!w.nodes[candidate]) {
				issues.push(
					error(w.name, from, `edges["${from}"] resolves to "${candidate}" which is not declared in nodes`),
				);
			}
		}
	}
}

/** Nodes with no outgoing edge are implicit terminals — usually a missing connection. */
function checkMissingEdges(w: Workflow, issues: WorkflowValidationIssue[]): void {
	for (const name of Object.keys(w.nodes)) {
		if (!(name in w.edges)) {
			issues.push(
				warning(
					w.name,
					name,
					`node "${name}" has no edge — treated as terminal; declare \`${name}: "stop"\` to be explicit`,
				),
			);
		}
	}
}

/**
 * BFS from `start`; every declared node should be reachable. Orphans aren't
 * a runner error (they can't fire) but they're almost always a mistake worth
 * surfacing.
 */
function checkReachability(w: Workflow, issues: WorkflowValidationIssue[]): void {
	if (!w.nodes[w.start]) return; // already reported by start-check

	const reachable = new Set<string>();
	const frontier: string[] = [w.start];
	while (frontier.length > 0) {
		const cur = frontier.shift()!;
		if (reachable.has(cur)) continue;
		reachable.add(cur);

		const target = w.edges[cur];
		if (target === undefined || target === STOP) continue;

		for (const next of enumerateTargets(target, w.name, cur, [])) {
			if (next !== STOP && w.nodes[next] && !reachable.has(next)) frontier.push(next);
		}
	}

	for (const name of Object.keys(w.nodes)) {
		if (!reachable.has(name)) {
			issues.push(warning(w.name, name, `node "${name}" is unreachable from start "${w.start}"`));
		}
	}
}

/**
 * Per-node semantic checks — bounds and enums that the TS type system narrows
 * at edit time but jiti erases at runtime. A user-authored config can ship any
 * numeric `maxValidationRetries` or any string for `onValidationFailure`; this
 * pass catches them at load time.
 */
function checkNodeSemantics(w: Workflow, issues: WorkflowValidationIssue[]): void {
	for (const [name, node] of Object.entries(w.nodes)) {
		if (
			node.maxValidationRetries !== undefined &&
			(node.maxValidationRetries < MIN_VALIDATION_RETRIES || node.maxValidationRetries > MAX_VALIDATION_RETRIES)
		) {
			issues.push(
				error(
					w.name,
					name,
					`maxValidationRetries: ${node.maxValidationRetries} — must be in [${MIN_VALIDATION_RETRIES}, ${MAX_VALIDATION_RETRIES}]`,
				),
			);
		}
		if (
			node.validationRetryTimeoutMs !== undefined &&
			(node.validationRetryTimeoutMs < MIN_VALIDATION_RETRY_TIMEOUT_MS ||
				node.validationRetryTimeoutMs > MAX_VALIDATION_RETRY_TIMEOUT_MS)
		) {
			issues.push(
				error(
					w.name,
					name,
					`validationRetryTimeoutMs: ${node.validationRetryTimeoutMs} — must be in [${MIN_VALIDATION_RETRY_TIMEOUT_MS}, ${MAX_VALIDATION_RETRY_TIMEOUT_MS}]`,
				),
			);
		}
		if (
			node.onValidationFailure !== undefined &&
			node.onValidationFailure !== "retry" &&
			node.onValidationFailure !== "halt"
		) {
			issues.push(
				error(w.name, name, `onValidationFailure: "${node.onValidationFailure}" — must be "retry" or "halt"`),
			);
		}
		if (node.completionStrategy !== "artifact-emit" && node.completionStrategy !== "agent-end") {
			issues.push(
				error(
					w.name,
					name,
					`completionStrategy: "${node.completionStrategy}" — must be "artifact-emit" or "agent-end"`,
				),
			);
		}
		if (node.sessionPolicy !== "fresh" && node.sessionPolicy !== "continue") {
			issues.push(error(w.name, name, `sessionPolicy: "${node.sessionPolicy}" — must be "fresh" or "continue"`));
		}
		// Phase fanout for implement nodes requires per-phase session isolation —
		// `continue` would replay the prior phase's branch into the next phase's
		// session. The runner enforces this at dispatch (`enforceSessionInvariants`);
		// surface it at load time so user-authored configs get a targeted error
		// instead of a generic chain-advance failure on first invocation.
		if ((node.skill === "implement" || name === "implement") && node.sessionPolicy === "continue") {
			issues.push(
				error(
					w.name,
					name,
					`implement node "${name}" cannot use sessionPolicy "continue" — phase fanout requires per-phase session isolation`,
				),
			);
		}
		// Async schemas can't drive the runner's synchronous retry loop. Probe
		// each schema with an empty object at load time and reject ones whose
		// `~standard.validate` returns a Promise. Without this, the runner's
		// extractAndValidateManifest throws mid-stage and the audit trail
		// surfaces an opaque chain-advance error instead of a workflow-load
		// error pointing at the offending node.
		if (node.outputSchema && isAsyncSchema(node.outputSchema)) {
			issues.push(
				error(
					w.name,
					name,
					"outputSchema declares an async `~standard.validate` — workflow runner is synchronous at the validation seam; refactor the schema to be synchronous or drop the schema entirely",
				),
			);
		}
		if (node.inputSchema && isAsyncSchema(node.inputSchema)) {
			issues.push(
				error(
					w.name,
					name,
					"inputSchema declares an async `~standard.validate` — workflow runner is synchronous at the validation seam; refactor the schema to be synchronous or drop the schema entirely",
				),
			);
		}
	}
}

/**
 * Probe a Standard Schema with an empty object and report whether its
 * `~standard.validate` returned a Promise. The probe value is intentionally
 * meaningless — we don't care about the validation outcome, only its
 * sync/async shape. Any schema that throws on the probe is treated as
 * "not async" (the throw bubbles to the runner anyway and surfaces under
 * the same fatal-extraction path).
 *
 * Best-effort: a schema whose synchronous arm throws on the empty-object
 * probe is reported as non-async; if such a schema is in fact async, the
 * runtime `validateManifestData` throw is the load-bearing safety net —
 * see `validate-manifest.ts:validateManifestData` (the `result instanceof Promise`
 * branch).
 */
function isAsyncSchema(schema: { "~standard": { validate: (data: unknown) => unknown } }): boolean {
	try {
		const result = schema["~standard"].validate({});
		return result instanceof Promise;
	} catch {
		return false;
	}
}

/**
 * Predicate edges that read `manifest.data[field]` (i.e. `definePredicate`,
 * `threshold`, and any future factory that auto-attaches the
 * `READS_FRONTMATTER` marker) should fire on data the source node has
 * validated against its `outputSchema`. If the schema is absent, the
 * validation-retry loop never runs and the predicate may read an undefined
 * field — routing decisions silently default.
 *
 * Predicates authored via `defineStatePredicate` consult only `state` or
 * `manifest.meta` and carry no marker — exempt from this lint.
 */
function checkPredicateSchemas(w: Workflow, issues: WorkflowValidationIssue[]): void {
	for (const [from, target] of Object.entries(w.edges)) {
		if (typeof target === "string") continue;
		if (!marksFrontmatter(target)) continue;
		const node = w.nodes[from];
		if (node && !node.outputSchema) {
			issues.push(
				warning(
					w.name,
					from,
					`predicate edge from "${from}" reads manifest.data but the node has no outputSchema — routing may fire on un-validated frontmatter`,
				),
			);
		}
	}
}

// ===========================================================================
// Edge-target enumeration
// ===========================================================================

/**
 * Returns the set of possible string targets an `EdgeTarget` could resolve to.
 *
 * - String → singleton.
 * - `EdgeFn` with `.targets` metadata → declared targets.
 * - `EdgeFn` without `.targets` → error; the missing metadata makes reachability
 *   analysis and the runtime status-line denominator structurally unsound.
 *   Users authoring predicates by hand MUST go through `definePredicate(targets, fn)`.
 *
 * Issues collected via the `issues` array — pass an empty array when you're
 * only interested in enumeration (reachability traversal).
 */
function enumerateTargets(
	target: EdgeTarget,
	workflow: string,
	from: string,
	issues: WorkflowValidationIssue[],
): string[] {
	if (typeof target === "string") return [target];
	if (Array.isArray(target.targets) && target.targets.length > 0) return [...target.targets];
	issues.push(
		error(
			workflow,
			from,
			`edges["${from}"] is an EdgeFn without \`.targets\` metadata — use definePredicate([...], fn) or threshold() so reachability can enumerate branches`,
		),
	);
	return [];
}

// ===========================================================================
// Issue constructors
// ===========================================================================

function error(workflow: string, node: string | undefined, message: string): WorkflowValidationIssue {
	return { workflow, node, severity: "error", message };
}

function warning(workflow: string, node: string | undefined, message: string): WorkflowValidationIssue {
	return { workflow, node, severity: "warning", message };
}
