import type { ProvidersConfig } from "../config.js";
import { registerTelemetryProvider } from "../dispatcher.js";
import type { TelemetryProviderMeta } from "../types/provider.js";
import { CONSOLE_PROVIDER_META, ConsoleProvider } from "./console.js";
import { MLFLOW_PROVIDER_META, MlflowProvider } from "./mlflow/index.js";

export { CONSOLE_PROVIDER_META, ConsoleProvider } from "./console.js";
export { MLFLOW_PROVIDER_META, MlflowProvider } from "./mlflow/index.js";

/** Metadata catalog for the providers shipped with this package. */
export const BUILT_IN_PROVIDERS: readonly TelemetryProviderMeta[] = [MLFLOW_PROVIDER_META, CONSOLE_PROVIDER_META];

/**
 * Register every built-in provider present in the given config. Called at
 * extension load time by instrumentation.ts. The schema in `config.ts` is
 * the single source of truth for the provider key set — adding a built-in
 * provider means editing `ProvidersConfigSchema` and adding a branch below.
 */
export function registerConfiguredProviders(config: { providers: ProvidersConfig }): void {
	const { providers } = config;
	if (providers.mlflow !== undefined) {
		registerTelemetryProvider(new MlflowProvider(providers.mlflow));
	}
	if (providers.console !== undefined) {
		registerTelemetryProvider(new ConsoleProvider());
	}
}
