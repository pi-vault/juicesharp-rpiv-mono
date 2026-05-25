/**
 * Default outcome for agent-end nodes — and the framework's
 * "no artifacts produced" primitive.
 *
 * Resolver always returns `{ kind: "ok", artifacts: [] }`. The chain
 * semantics (see `runner/stage-lifecycle.ts:inputForStage`) then
 * inherit the upstream artifact list forward — an action skill
 * between two artifact-emit skills doesn't need its own resolver.
 *
 * No reader: with `artifacts: []` the manifest's `data` is the empty
 * list and `kind` is the literal `"artifacts"`. Stages that need a
 * different discriminator wire their own outcome.
 *
 * No baseline — side-effect nodes have no pre-stage state to capture.
 */

import type { ArtifactResolver, Outcome } from "../outcome-types.js";

/** Resolver primitive: always returns zero artifacts, never fatal. */
export const noopResolver: ArtifactResolver = {
	resolve: () => ({ kind: "ok", artifacts: [] }),
};

export const sideEffectOutcome: Outcome = {
	resolver: noopResolver,
};
