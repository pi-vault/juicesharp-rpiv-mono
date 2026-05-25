/**
 * Bundled readers — host-agnostic primitives that turn resolved
 * artifacts into the typed `manifest.data` channel downstream stages
 * see. Re-exported through `outcomes/index.ts`.
 *
 * Format-specific readers (`frontmatterReader` for markdown-with-YAML)
 * live in the convention layer that owns them — rpiv-pi ships its
 * own. The framework ships only universal interpretations.
 */

export { jsonBodyReader } from "./json-body.js";
