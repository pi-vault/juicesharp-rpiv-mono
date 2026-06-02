/**
 * rpiv-models-command — /rpiv-models cascade picker.
 *
 * Scope picker → key picker (context-specific) → model picker → effort picker
 * → save (saveJsonConfig) → invalidate cache (__resetModelsConfigCache).
 *
 * Scope coverage matches the ModelsConfig surface widened in Phase 1:
 *   - defaults                       (no key picker)
 *   - agents / <name>                (BUNDLED_AGENTS_DIR readdir)
 *   - stages / <name>                (loadWorkflows().workflows[*].stages keys)
 *   - skills / <name>                (pi.getCommands() filter source==="skill",
 *                                     per Decision 8 — live registry)
 *   - presets / <wf> / stages / <s>  (workflow picker → stage picker per-wf)
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels, type ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { configPath, loadJsonConfig, modelKey, saveJsonConfig } from "@juicesharp/rpiv-config";
import { __resetModelsConfigCache, THINKING_LEVEL_VALUES, type ThinkingLevelValue } from "./models-config.js";
import { bundledAgentNames, loadWorkflowMap, skillCommandNames } from "./models-config-sources.js";
import { showFilterablePicker } from "./models-picker.js";

const CONFIG_PATH = configPath("rpiv-pi", "models.json");

const SCOPE_DEFAULTS = "defaults";
const SCOPE_AGENTS = "agents";
const SCOPE_STAGES = "stages";
const SCOPE_SKILLS = "skills";
const SCOPE_PRESETS = "presets";
const SCOPE_RESET_ALL = "__reset_all__";
const RESET_VALUE = "__reset__";
const RESET_LABEL = "Reset to default";

// `thinking` is narrowed to the 5-value `ThinkingLevelValue` union (vs. raw
// `string`) so the picker's persisted output mirrors the schema's runtime
// validation surface (Plan Review row #concern-F).
type RawModelEntry = string | { model?: string; thinking?: ThinkingLevelValue };

interface RawModelsConfig {
	defaults?: RawModelEntry;
	agents?: Record<string, RawModelEntry>;
	stages?: Record<string, RawModelEntry>;
	skills?: Record<string, RawModelEntry>;
	presets?: Record<string, { stages?: Record<string, RawModelEntry> }>;
}

function scopeItems(): SelectItem[] {
	return [
		{ value: SCOPE_DEFAULTS, label: "defaults" },
		{ value: SCOPE_AGENTS, label: "agents" },
		{ value: SCOPE_STAGES, label: "stages" },
		{ value: SCOPE_SKILLS, label: "skills" },
		{ value: SCOPE_PRESETS, label: "presets" },
		{ value: SCOPE_RESET_ALL, label: "reset all overrides" },
	];
}

function buildModelItems(models: Model<Api>[], currentKey?: string): SelectItem[] {
	return models.map((m) => {
		const key = modelKey(m);
		const check = key === currentKey ? " ✓" : "";
		return { value: key, label: `${m.name}  (${m.provider})${check}` };
	});
}

function buildEffortItems(picked: Model<Api>): SelectItem[] {
	const levels = getSupportedThinkingLevels(picked).filter((l): l is (typeof THINKING_LEVEL_VALUES)[number] =>
		THINKING_LEVEL_VALUES.includes(l as never),
	);
	return [{ value: "__off__", label: "off" }, ...levels.map((level) => ({ value: level, label: level }))];
}

function getCurrentOverrideKey(scope: string, keyPath: string[]): string | undefined {
	const raw = loadJsonConfig<RawModelsConfig>(CONFIG_PATH);
	if (scope === SCOPE_DEFAULTS) {
		const entry = raw.defaults;
		return typeof entry === "string" ? entry : entry?.model;
	}
	if (scope === SCOPE_AGENTS || scope === SCOPE_STAGES || scope === SCOPE_SKILLS) {
		const map = (raw as Record<string, unknown>)[scope] as Record<string, unknown> | undefined;
		if (!map) return undefined;
		const entry = map[keyPath[0]];
		return typeof entry === "string"
			? entry
			: ((entry as Record<string, unknown> | undefined)?.model as string | undefined);
	}
	if (scope === SCOPE_PRESETS) {
		const [wf, stage] = keyPath;
		const entry = raw.presets?.[wf]?.stages?.[stage];
		return typeof entry === "string" ? entry : entry?.model;
	}
	return undefined;
}

function removeOverride(config: RawModelsConfig, scope: string, keyPath: string[]): RawModelsConfig {
	const next: RawModelsConfig = { ...config };
	if (scope === SCOPE_DEFAULTS) {
		delete next.defaults;
		return next;
	}
	if (scope === SCOPE_AGENTS || scope === SCOPE_STAGES || scope === SCOPE_SKILLS) {
		const map = (next as Record<string, unknown>)[scope] as Record<string, unknown> | undefined;
		if (map && keyPath[0] in map) {
			const updated: Record<string, unknown> = { ...map };
			delete updated[keyPath[0]];
			if (!Object.keys(updated).length) delete (next as Record<string, unknown>)[scope];
			else (next as Record<string, unknown>)[scope] = updated;
		}
		return next;
	}
	if (scope === SCOPE_PRESETS) {
		const [wf, stage] = keyPath;
		if (next.presets?.[wf]?.stages) {
			const presets = { ...next.presets };
			const presetBlock = { ...presets[wf] };
			const stages = { ...presetBlock.stages };
			delete stages[stage];
			if (!Object.keys(stages).length) {
				delete presetBlock.stages;
				delete presets[wf];
				if (!Object.keys(presets).length) delete next.presets;
				else next.presets = presets;
			} else {
				presetBlock.stages = stages;
				presets[wf] = presetBlock;
				next.presets = presets;
			}
		}
		return next;
	}
	return next;
}

function applyOverride(
	config: RawModelsConfig,
	scope: string,
	keyPath: string[],
	entry: { model: string; thinking?: ThinkingLevel },
): RawModelsConfig {
	const next: RawModelsConfig = { ...config };
	if (scope === SCOPE_DEFAULTS) {
		next.defaults = entry.thinking ? { model: entry.model, thinking: entry.thinking } : entry.model;
		return next;
	}
	if (scope === SCOPE_AGENTS || scope === SCOPE_STAGES || scope === SCOPE_SKILLS) {
		const target = (next as Record<string, unknown>)[scope] as Record<string, unknown> | undefined;
		const updated: Record<string, unknown> = { ...(target ?? {}) };
		updated[keyPath[0]] = entry.thinking ? { model: entry.model, thinking: entry.thinking } : entry.model;
		(next as Record<string, unknown>)[scope] = updated;
		return next;
	}
	if (scope === SCOPE_PRESETS) {
		const [wf, stage] = keyPath;
		const presets = { ...(next.presets ?? {}) };
		const presetBlock = { ...(presets[wf] ?? {}) };
		const stages = { ...(presetBlock.stages ?? {}) };
		stages[stage] = entry.thinking ? { model: entry.model, thinking: entry.thinking } : entry.model;
		presetBlock.stages = stages;
		presets[wf] = presetBlock;
		next.presets = presets;
		return next;
	}
	return next;
}

const MSG_REQUIRES_INTERACTIVE = "/rpiv-models requires an interactive UI session.";
const MSG_SAVE_FAILED = "Failed to save models.json (disk error or permissions).";
const MSG_NO_SKILLS = "No skills registered; install or enable an extension that contributes skills.";
const MSG_NO_WORKFLOWS = "No workflows discovered; install rpiv-workflow or define a workflow first.";
const MSG_RESET_ALL = "All model overrides cleared.";

export function registerRpivModelsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("rpiv-models", {
		description: "Configure model and reasoning overrides in ~/.config/rpiv-pi/models.json",
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(MSG_REQUIRES_INTERACTIVE, "error");
				return;
			}

			const scope = await showFilterablePicker(ctx, {
				title: "Model Overrides",
				proseLines: ["Select scope."],
				items: scopeItems(),
			});
			if (!scope) return;

			if (scope === SCOPE_RESET_ALL) {
				if (!saveJsonConfig(CONFIG_PATH, {})) {
					ctx.ui.notify(MSG_SAVE_FAILED, "error");
					return;
				}
				__resetModelsConfigCache();
				ctx.ui.notify(MSG_RESET_ALL, "info");
				return;
			}

			const keyPath: string[] = [];

			if (scope === SCOPE_AGENTS) {
				const items = bundledAgentNames().map((n) => ({ value: n, label: n }));
				if (items.length === 0) {
					ctx.ui.notify("No bundled agents found.", "error");
					return;
				}
				const picked = await showFilterablePicker(ctx, {
					title: "Agent",
					proseLines: ["Select agent."],
					items,
				});
				if (!picked) return;
				keyPath.push(picked);
			} else if (scope === SCOPE_STAGES) {
				const wfMap = await loadWorkflowMap(ctx.cwd);
				const stages = Array.from(new Set(Object.values(wfMap).flat())).sort();
				if (stages.length === 0) {
					ctx.ui.notify(MSG_NO_WORKFLOWS, "error");
					return;
				}
				const picked = await showFilterablePicker(ctx, {
					title: "Stage",
					proseLines: ["Select stage."],
					items: stages.map((s) => ({ value: s, label: s })),
				});
				if (!picked) return;
				keyPath.push(picked);
			} else if (scope === SCOPE_SKILLS) {
				const names = skillCommandNames(pi);
				if (names.length === 0) {
					ctx.ui.notify(MSG_NO_SKILLS, "error");
					return;
				}
				const picked = await showFilterablePicker(ctx, {
					title: "Skill",
					proseLines: ["Select skill."],
					items: names.map((n) => ({ value: n, label: n })),
				});
				if (!picked) return;
				keyPath.push(picked);
			} else if (scope === SCOPE_PRESETS) {
				const wfMap = await loadWorkflowMap(ctx.cwd);
				const wfNames = Object.keys(wfMap).sort();
				if (wfNames.length === 0) {
					ctx.ui.notify(MSG_NO_WORKFLOWS, "error");
					return;
				}
				const wf = await showFilterablePicker(ctx, {
					title: "Workflow",
					proseLines: ["Select workflow."],
					items: wfNames.map((n) => ({ value: n, label: n })),
				});
				if (!wf) return;
				const stages = wfMap[wf] ?? [];
				if (stages.length === 0) {
					ctx.ui.notify(`Workflow "${wf}" has no stages.`, "error");
					return;
				}
				const stage = await showFilterablePicker(ctx, {
					title: `Stage — ${wf}`,
					proseLines: ["Select stage."],
					items: stages.map((s) => ({ value: s, label: s })),
				});
				if (!stage) return;
				keyPath.push(wf, stage);
			}

			const available = ctx.modelRegistry.getAvailable();
			if (available.length === 0) {
				ctx.ui.notify("No models available (no API keys configured?).", "error");
				return;
			}
			const currentKey = getCurrentOverrideKey(scope, keyPath);
			const items = buildModelItems(available, currentKey);
			if (scope !== SCOPE_DEFAULTS) {
				items.push({ value: RESET_VALUE, label: RESET_LABEL });
			}
			const modelChoice = await showFilterablePicker(ctx, {
				title: "Model",
				proseLines: ["Select model."],
				items,
				preferredValue: currentKey ?? undefined,
			});
			if (!modelChoice) return;

			if (modelChoice === RESET_VALUE) {
				const fresh = loadJsonConfig<RawModelsConfig>(CONFIG_PATH);
				const updated = removeOverride(fresh, scope, keyPath);
				if (!saveJsonConfig(CONFIG_PATH, updated)) {
					ctx.ui.notify(MSG_SAVE_FAILED, "error");
					return;
				}
				__resetModelsConfigCache();
				const label = `${scope}/${keyPath.join("/")}`;
				ctx.ui.notify(`Removed ${label}.`, "info");
				return;
			}
			const picked = available.find((m) => modelKey(m) === modelChoice);
			if (!picked) {
				ctx.ui.notify(`Model not found: ${modelChoice}`, "error");
				return;
			}

			let effort: ThinkingLevel | undefined;
			if (picked.reasoning) {
				const effortChoice = await showFilterablePicker(ctx, {
					title: "Reasoning Effort",
					proseLines: [`Select effort level for ${picked.name}.`],
					items: buildEffortItems(picked),
				});
				if (!effortChoice) return;
				effort = effortChoice === "__off__" ? undefined : (effortChoice as ThinkingLevel);
			}

			const fresh = loadJsonConfig<RawModelsConfig>(CONFIG_PATH);
			const updated = applyOverride(fresh, scope, keyPath, { model: modelKey(picked), thinking: effort });
			if (!saveJsonConfig(CONFIG_PATH, updated)) {
				ctx.ui.notify(MSG_SAVE_FAILED, "error");
				return;
			}
			__resetModelsConfigCache();

			const label = scope === SCOPE_DEFAULTS ? scope : `${scope}/${keyPath.join("/")}`;
			ctx.ui.notify(`Saved ${label} → ${modelKey(picked)}${effort ? ` (${effort})` : ""}`, "info");
		},
	});
}
