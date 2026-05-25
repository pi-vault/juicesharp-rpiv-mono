/**
 * Union resolver — runs N resolvers and concatenates their artifacts.
 *
 * Useful for the "look in transcript OR tool calls" pattern, or for
 * combining a workspace-diff scan with a transcript URL scan. The
 * sub-resolvers run sequentially; their `baseline` hooks are NOT
 * threaded (each resolver gets its own baseline only if it declares
 * one and is invoked through `Outcome.resolver` directly — wrapping
 * resolvers inside a union loses individual baselines today).
 *
 * Fatal policy: `unionResolvers` returns `fatal` only when EVERY
 * sub-resolver returned fatal (carries the last fatal message for
 * diagnostics). One success is enough for the union to succeed —
 * matches the "any of these channels produced the artifact" mental
 * model the union represents.
 *
 * Empty artifact list from one sub-resolver is treated as `ok` (it
 * just contributes nothing to the concatenation). The union itself
 * returns `ok` with the merged list; the runner's
 * `enforceCompletionContract` decides whether an empty merged list is
 * a halt (artifact-emit) or a pass-through (agent-end).
 */

import type { Artifact } from "../../handle.js";
import type { ArtifactResolver, ResolveResult } from "../../outcome-types.js";
import { defineResolver } from "../../outcome-types.js";

export function unionResolvers(...resolvers: ArtifactResolver[]): ArtifactResolver {
	if (resolvers.length === 0) {
		throw new Error("unionResolvers: at least one resolver is required");
	}
	return defineResolver({
		resolve: async (ctx) => {
			const all: Artifact[] = [];
			let lastFatalMessage: string | undefined;
			let everySubResolverFatal = true;
			for (const r of resolvers) {
				const result: ResolveResult = await r.resolve(ctx);
				if (result.kind === "fatal") {
					lastFatalMessage = result.message;
					continue;
				}
				everySubResolverFatal = false;
				all.push(...result.artifacts);
			}
			if (everySubResolverFatal) {
				return {
					kind: "fatal",
					message: lastFatalMessage ?? `${ctx.skill}: unionResolvers had no successful sub-resolver`,
				};
			}
			return { kind: "ok", artifacts: all };
		},
	});
}
