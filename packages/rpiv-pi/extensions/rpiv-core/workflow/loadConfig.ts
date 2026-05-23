/**
 * Layered JSON config: project `<cwd>/.rpiv/workflow.json` overrides user
 * `~/.config/rpiv/workflow.json` (full-replacement, no merge). Fail-soft:
 * malformed or invalid config falls back to built-in WORKFLOW_DAG with
 * warnings.
 *
 * Schema:
 *   { "presets": { "my-flow": ["discover", "research", "commit"] },
 *     "defaultPreset": "my-flow" }
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configPath } from "@juicesharp/rpiv-config";
import { validateDag, WORKFLOW_DAG, type WorkflowDag } from "./dag.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowConfigFile {
	readonly presets?: Record<string, string[]>;
	readonly defaultPreset?: string;
}

/** Used when a config omits `defaultPreset` AND ships in WORKFLOW_DAG.presets. */
export const DEFAULT_PRESET_NAME = "mid";

export interface LoadedConfig {
	dag: WorkflowDag;
	presetNames: ReadonlySet<string>;
	defaultPreset: string;
	warnings?: string[];
}

export type ConfigSource = "project" | "user" | "built-in";

export interface LoadedConfigWithSource extends LoadedConfig {
	source: ConfigSource;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** ~/.config/rpiv/workflow.json */
export const USER_CONFIG_PATH = configPath("rpiv", "workflow.json");

export function projectConfigPath(cwd: string): string {
	return join(cwd, ".rpiv", "workflow.json");
}

// ---------------------------------------------------------------------------
// Config file reading
// ---------------------------------------------------------------------------

/** Missing file → `{data: undefined}`; malformed → adds `warning`. */
export function readConfigFile(path: string): { data: WorkflowConfigFile | undefined; warning?: string } {
	if (!existsSync(path)) return { data: undefined };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { data: undefined, warning: `Invalid config at ${path}: not a JSON object` };
		}
		return { data: parsed as WorkflowConfigFile };
	} catch (err) {
		return {
			data: undefined,
			warning: `Malformed JSON at ${path}: ${(err as Error).message}`,
		};
	}
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/**
 * Resolution: project config > user config > WORKFLOW_DAG. Validation
 * failures fall back to built-in and reset `source` to "built-in" so help
 * listings don't lie about which layer is active. Never throws.
 */
export function loadConfig(cwd: string): LoadedConfigWithSource {
	const warnings: string[] = [];

	const project = readConfigFile(projectConfigPath(cwd));
	if (project.warning) warnings.push(project.warning);

	let configFile: WorkflowConfigFile | undefined;
	let source: ConfigSource;

	if (project.data) {
		configFile = project.data;
		source = "project";
	} else {
		const user = readConfigFile(USER_CONFIG_PATH);
		if (user.warning) warnings.push(user.warning);
		configFile = user.data;
		source = configFile ? "user" : "built-in";
	}

	const builtInFallback = (extraWarnings: string[] = []): LoadedConfigWithSource => {
		warnings.push(...extraWarnings);
		return {
			dag: WORKFLOW_DAG,
			presetNames: new Set(Object.keys(WORKFLOW_DAG.presets)),
			defaultPreset: resolveDefaultPreset(WORKFLOW_DAG.presets, configFile?.defaultPreset, warnings),
			source: "built-in",
			warnings: warnings.length > 0 ? warnings : undefined,
		};
	};

	if (!configFile?.presets || typeof configFile.presets !== "object" || Array.isArray(configFile.presets)) {
		return builtInFallback();
	}

	// validateDag iterates a stray string character-by-character and emits
	// per-character warnings without this shape guard.
	const shapeErrors: string[] = [];
	for (const [name, stageIds] of Object.entries(configFile.presets)) {
		if (!Array.isArray(stageIds) || !stageIds.every((n) => typeof n === "string")) {
			shapeErrors.push(`Config validation: preset "${name}" must be an array of strings`);
		}
	}
	if (shapeErrors.length > 0) return builtInFallback(shapeErrors);

	// Phase 1 only allows preset overrides — inherit nodes + edges.
	const configDag: WorkflowDag = {
		edges: WORKFLOW_DAG.edges,
		presets: configFile.presets as Record<string, string[]>,
		nodes: WORKFLOW_DAG.nodes,
	};
	try {
		const { errors, warnings: dagWarnings } = validateDag(configDag);
		if (errors.length > 0) {
			return builtInFallback(errors.map((e) => `Config validation: ${e}`));
		}
		warnings.push(...dagWarnings.map((w) => `Config validation: ${w}`));
	} catch (err) {
		return builtInFallback([`Config validation error: ${(err as Error).message}`]);
	}

	const defaultPreset = resolveDefaultPreset(configDag.presets, configFile.defaultPreset, warnings);

	return {
		dag: configDag,
		presetNames: new Set(Object.keys(configDag.presets)),
		defaultPreset,
		source,
		warnings: warnings.length > 0 ? warnings : undefined,
	};
}

/** requested → DEFAULT_PRESET_NAME → first preset key → DEFAULT_PRESET_NAME (last-resort, may not exist). */
function resolveDefaultPreset(
	presets: Record<string, unknown>,
	requested: string | undefined,
	warnings: string[],
): string {
	if (requested && requested in presets) return requested;
	if (requested) {
		warnings.push(`defaultPreset "${requested}" not found in presets — falling back to first preset`);
	}
	if (DEFAULT_PRESET_NAME in presets) return DEFAULT_PRESET_NAME;
	const first = Object.keys(presets)[0];
	if (first) {
		if (!requested) {
			warnings.push(`No defaultPreset specified and "${DEFAULT_PRESET_NAME}" not in presets — using "${first}"`);
		}
		return first;
	}
	return DEFAULT_PRESET_NAME;
}
