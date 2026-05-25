/**
 * Barrel re-exports for the bundled outcomes + their primitive parts.
 *
 * `artifactMdOutcome` is deliberately NOT bundled here — the
 * `.rpiv/artifacts/<bucket>/<file>.md` layout is an rpiv-pi convention,
 * not a framework truth. rpiv-pi ships its own `rpivArtifactMdOutcome`
 * (and `rpivArtifactResolver` / `rpivBucketResolver` helpers) built on
 * top of the framework primitives.
 */

export {
	type GitCommitData,
	type GitHeadSnapshot,
	gitCommitOutcome,
	gitCommitReader,
	gitCommitResolver,
	gitHeadSnapshot,
} from "./git-commit.js";
export { noopResolver, sideEffectOutcome } from "./side-effect.js";
