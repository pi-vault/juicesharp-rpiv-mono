/**
 * Bundled resolvers — universal primitives + ergonomic wrappers +
 * composition helpers. Re-exported through `outcomes/index.ts` and
 * surfaced to authors via the package's top-level barrel.
 *
 * The framework ships ONLY host-agnostic resolvers — no Pi tool-name
 * defaults, no `.rpiv/artifacts/` defaults, no domain helpers
 * (Linear/S3/Notion). Convention layers live in sibling packages
 * (`rpiv-pi` ships `rpivArtifactResolver` / `rpivBucketResolver`).
 */

export { type DirectoryPathResolverOpts, directoryPathResolver } from "./directory-path.js";
export { type ToolCall, type ToolCallResolverOpts, toolCallResolver } from "./tool-call.js";
export { type TranscriptPathResolverOpts, transcriptPathResolver } from "./transcript-path.js";
export { unionResolvers } from "./union.js";
export { type UrlResolverOpts, urlResolver } from "./url.js";
export {
	type WorkspaceDiffBaseline,
	type WorkspaceDiffResolverOpts,
	workspaceDiffResolver,
} from "./workspace-diff.js";
