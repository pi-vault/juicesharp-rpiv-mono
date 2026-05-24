/**
 * Pretty-print workflow lists (no-args path) and per-workflow details
 * (workflow-name-only path). Read-only against `LoadedWorkflows` — no I/O,
 * no mutation. Two public formatters, both returning a single multiline
 * string that `command.ts` hands straight to `ctx.ui.notify(..., "info")`.
 */

import type { NodeDef, Workflow } from "./api.js";
import type { ConfigLayer, LoadedWorkflows } from "./load.js";

const USAGE = "Usage: /rpiv [workflow] <description>";
const USAGE_PREVIEW = "/rpiv <workflow>           — preview stages";

// ===========================================================================
// Public formatters
// ===========================================================================

/** No-args listing: every loaded workflow, its stage count, and its source. */
export function formatWorkflowList(loaded: LoadedWorkflows): string {
	const rows = loaded.workflows.map((w) => {
		const layer = loaded.workflowSources.get(w.name) ?? "built-in";
		const stages = Object.keys(w.nodes).length;
		const tags = [`[${layer}]`];
		if (w.name === loaded.default) tags.push("(default)");
		return `  ${w.name.padEnd(28)} ${String(stages).padStart(2)} stages  ${tags.join(" ")}`;
	});

	return ["Available workflows:", ...rows, "", formatLayerBanner(loaded.layers), USAGE, USAGE_PREVIEW].join("\n");
}

/** Workflow-name-only path: full stage list + edges for one workflow. */
export function formatWorkflowDetails(loaded: LoadedWorkflows, name: string): string {
	const workflow = loaded.workflows.find((w) => w.name === name);
	if (!workflow) return formatWorkflowList(loaded);

	const layer = loaded.workflowSources.get(name) ?? "built-in";
	const heading = formatWorkflowHeading(name, layer, name === loaded.default);
	const stageRows = Object.entries(workflow.nodes).map(([nodeName, node], i) =>
		formatStageRow(i + 1, nodeName, node, workflow),
	);

	return [heading, "", ...stageRows, "", `Usage: /rpiv ${name} <description>`].join("\n");
}

// ===========================================================================
// Stage / source rendering
// ===========================================================================

/** `workflow: <name>  (<layer>[, default])` — header line for details view. */
function formatWorkflowHeading(name: string, layer: ConfigLayer, isDefault: boolean): string {
	const tags: string[] = [layer];
	if (isDefault) tags.push("default");
	return `workflow: ${name}  (${tags.join(", ")})`;
}

/** Numbered row showing the node + its outgoing edge target(s). */
function formatStageRow(idx: number, nodeName: string, node: NodeDef, workflow: Workflow): string {
	const num = `${idx}.`.padEnd(3);
	const decorations = [node.completionStrategy.padEnd(13), node.sessionPolicy];
	if (node.extractor?.before) decorations.push("snapshot");
	if (node.extractor) decorations.push("extractor");

	const arrow = formatEdge(workflow, nodeName);
	const trailer = arrow ? `  → ${arrow}` : "";

	return `  ${num} ${nodeName.padEnd(28)} ${decorations.join(" · ")}${trailer}`;
}

/** Render the outgoing edge as a human-readable trailer (string or predicate target set). */
function formatEdge(workflow: Workflow, from: string): string | undefined {
	const target = workflow.edges[from];
	if (target === undefined) return "(terminal — no edge declared)";
	if (target === "stop") return "stop";
	if (typeof target === "string") return target;
	const targets = target.targets;
	if (Array.isArray(targets) && targets.length > 0) return `predicate(${targets.join(" | ")})`;
	return "predicate";
}

/** "Sources: built-in + user + project" — single-line layer banner. */
function formatLayerBanner(layers: readonly ConfigLayer[]): string {
	return `Sources: ${layers.join(" + ")}`;
}
