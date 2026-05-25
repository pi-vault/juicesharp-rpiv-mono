/**
 * rpiv-flavoured artifact resolution — the `.rpiv/artifacts/<bucket>/<file>.md`
 * convention all rpiv-pi skills emit into. This module owns the
 * convention; the framework (`@juicesharp/rpiv-workflow`) ships only
 * the primitives (`ArtifactResolver`, `ArtifactReader`, handle
 * constructors, `defineResolver`, etc.) and stays layout-agnostic.
 *
 * Two resolvers:
 *   - `rpivArtifactResolver` — accepts any `.rpiv/artifacts/<bucket>/...md`
 *     path the agent announces in text (bucket-agnostic). Use when a
 *     stage may emit to several sibling subfolders.
 *   - `rpivBucketResolver(bucket)` — accepts only that one bucket's
 *     paths. Use when the stage MUST land in a specific subfolder
 *     (`research`, `plans`, etc.) — the resolver halts the chain if the
 *     agent strayed.
 *
 * One reader: `frontmatterReader` parses YAML frontmatter from the
 * primary fs artifact into `Record<string, unknown>` — what
 * `outputSchema` validates against for typed downstream narrowing.
 *
 * Pre-bundled outcome: `rpivArtifactMdOutcome` =
 * `{ resolver: rpivArtifactResolver, reader: frontmatterReader }` —
 * the drop-in default rpiv-pi's built-in workflows wire into every
 * `artifact()` node.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	type ArtifactReader,
	type ArtifactResolver,
	defineReader,
	type Outcome,
	type ReadCtx,
	transcriptPathResolver,
} from "@juicesharp/rpiv-workflow";

// ---------------------------------------------------------------------------
// Resolvers — text-scan over assistant transcript
// ---------------------------------------------------------------------------

const RPIV_ARTIFACT_PATTERN = /\.rpiv\/artifacts\/[\w.-]+\/[\w.-]+\.md/g;

/** Bucket-agnostic — accepts any `.rpiv/artifacts/<bucket>/...md`. */
export const rpivArtifactResolver: ArtifactResolver = transcriptPathResolver({ pattern: RPIV_ARTIFACT_PATTERN });

/** Bucket-narrowed — accepts only `.rpiv/artifacts/<bucket>/...md`. */
export function rpivBucketResolver(bucket: string): ArtifactResolver {
	const escaped = bucket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`\\.rpiv/artifacts/${escaped}/[\\w.-]+\\.md`, "g");
	return transcriptPathResolver({ pattern });
}

// ---------------------------------------------------------------------------
// Reader — markdown frontmatter
// ---------------------------------------------------------------------------

/**
 * Reads YAML frontmatter from the primary fs artifact. Files without
 * frontmatter produce `data: {}`. Fatals when the announced path
 * doesn't exist on disk (the agent claimed to write but didn't).
 */
export const frontmatterReader: ArtifactReader<undefined, "artifact-md", Record<string, unknown>> = defineReader({
	read(ctx: ReadCtx<undefined>) {
		const primary = ctx.artifacts[0];
		if (!primary || primary.handle.kind !== "fs") {
			return {
				kind: "fatal",
				message: `${ctx.skill}: frontmatterReader requires an fs artifact (got ${primary?.handle.kind ?? "none"})`,
			};
		}
		const abs = isAbsolute(primary.handle.path) ? primary.handle.path : join(ctx.cwd, primary.handle.path);
		if (!existsSync(abs)) {
			return {
				kind: "fatal",
				message: `agent announced ${primary.handle.path} but file does not exist on disk`,
			};
		}
		const content = readFileSync(abs, "utf-8");
		const { frontmatter } = parseFrontmatter(content);
		return {
			kind: "ok",
			payload: {
				kind: "artifact-md",
				data: frontmatter && typeof frontmatter === "object" ? (frontmatter as Record<string, unknown>) : {},
			},
		};
	},
});

// ---------------------------------------------------------------------------
// Outcome — pre-bundled wiring rpiv-pi workflows plug in
// ---------------------------------------------------------------------------

/** Default rpiv-pi artifact-emit outcome — bucket-agnostic text scan + frontmatter parse. */
export const rpivArtifactMdOutcome: Outcome<unknown, "artifact-md", Record<string, unknown>> = {
	resolver: rpivArtifactResolver,
	reader: frontmatterReader,
};

/** Per-bucket variant — narrows accepted paths to the supplied subfolder. */
export function rpivBucketOutcome(bucket: string): Outcome<unknown, "artifact-md", Record<string, unknown>> {
	return { resolver: rpivBucketResolver(bucket), reader: frontmatterReader };
}
