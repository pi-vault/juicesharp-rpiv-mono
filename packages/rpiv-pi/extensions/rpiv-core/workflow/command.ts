/** /rpiv slash command: parse → loadConfig → runWorkflow. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type LoadedConfigWithSource, loadConfig } from "./loadConfig.js";
import { runWorkflow } from "./runner.js";

// ---------------------------------------------------------------------------
// Message constants
// ---------------------------------------------------------------------------

const MSG_INTERACTIVE_ONLY = "/rpiv requires interactive mode";
const MSG_USAGE = "Usage: /rpiv [preset] <feature description>";
const ERR_WORKFLOW_THROW = (reason: string) => `/rpiv: workflow runner failed unexpectedly: ${reason}`;

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

/** First token is a preset name iff recognised; otherwise the whole arg is input + defaultPreset. */
export function parseArgs(
	args: string,
	config: { presetNames: ReadonlySet<string>; defaultPreset: string },
): { preset: string; input: string } {
	const trimmed = args.trim();
	if (!trimmed) {
		return { preset: config.defaultPreset, input: "" };
	}

	const firstSpace = trimmed.indexOf(" ");
	const firstToken = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);

	if (config.presetNames.has(firstToken)) {
		const remaining = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
		return { preset: firstToken, input: remaining };
	}

	return { preset: config.defaultPreset, input: trimmed };
}

export function formatPresetList(config: LoadedConfigWithSource): string {
	const lines = Array.from(config.presetNames, (name) => {
		const isDefault = name === config.defaultPreset;
		return `  ${name}${isDefault ? " (default)" : ""}`;
	});
	return `Available presets [${config.source}]:\n${lines.join("\n")}\n\n${MSG_USAGE}`;
}

export function registerWorkflowCommand(pi: ExtensionAPI): void {
	pi.registerCommand("rpiv", {
		description: "Run the rpiv skill pipeline: /rpiv [preset] [description]",
		handler: (args: string, ctx: ExtensionCommandContext) => handleWorkflowCommand(pi, args, ctx),
	});
}

async function handleWorkflowCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(MSG_INTERACTIVE_ONLY, "error");
		return;
	}

	const config = loadConfig(ctx.cwd);
	if (config.warnings?.length) {
		for (const warning of config.warnings) {
			ctx.ui.notify(warning, "warning");
		}
	}

	const { preset, input } = parseArgs(args, config);
	if (!input) {
		ctx.ui.notify(formatPresetList(config), "info");
		return;
	}

	// runWorkflow returns a result envelope rather than throwing — but a
	// misconfigured DAG or thrown predicate could still bubble. Catch so
	// Pi's dispatcher doesn't print a raw stack.
	try {
		await runWorkflow(ctx, { preset, input, dag: config.dag, pi });
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		ctx.ui.notify(ERR_WORKFLOW_THROW(reason), "error");
	}
}
