/**
 * Manifest validation via TypeBox `Value.Check` + `Value.Errors`, plus a
 * walltime-cap helper for the agent-roundtrip retry loop.
 */

import type { TSchema } from "typebox";
import { Value } from "typebox/value";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidationFailure {
	/** JSON-pointer-like path (instancePath); `"."` for root. */
	path: string;
	/** Schema keyword that failed. */
	expected: string;
	/** typeof / "array" / "null" / "undefined" of the offending value. */
	actual: string;
	message: string;
}

export interface ValidationResult {
	valid: boolean;
	failures: ValidationFailure[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MIN_VALIDATION_RETRIES = 1;
export const MAX_VALIDATION_RETRIES = 3;
export const DEFAULT_VALIDATION_RETRIES = 1;

export const DEFAULT_VALIDATION_RETRY_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_VALIDATION_RETRY_TIMEOUT_MS = 30 * 60 * 1000;
export const MIN_VALIDATION_RETRY_TIMEOUT_MS = 1_000;

/**
 * Race a promise against `ms`. The inner promise is NOT cancelled — Pi's
 * `ctx.waitForIdle()` has no abort signal today; the dangling promise becomes
 * inert when the next stage's `newSession` replaces the ctx.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateManifestData(schema: TSchema, data: unknown): ValidationResult {
	if (Value.Check(schema, data)) {
		return { valid: true, failures: [] };
	}

	const errors = Value.Errors(schema, data);
	const failures: ValidationFailure[] = [];
	for (const err of errors) {
		failures.push({
			path: err.instancePath === "" ? "." : err.instancePath,
			expected: err.keyword,
			actual: describeType((err as { value?: unknown }).value ?? resolveInstanceValue(data, err.instancePath)),
			message: err.message || `${err.keyword} validation failed at ${err.instancePath || "root"}`,
		});
	}
	return { valid: false, failures };
}

function resolveInstanceValue(data: unknown, instancePath: string): unknown {
	if (!instancePath || instancePath === "") return data;
	const segments = instancePath.split("/").slice(1);
	let cur: unknown = data;
	for (const seg of segments) {
		if (cur === null || cur === undefined) return cur;
		cur = (cur as Record<string, unknown>)[seg];
	}
	return cur;
}

/** Asks the agent to update the frontmatter + re-write the artifact at the same path. */
export function formatValidationFailuresForAgent(skill: string, failures: ValidationFailure[]): string {
	const errorLines = failures.map((f) => ` • ${f.path} — ${f.message}`).join("\n");

	return (
		`The artifact you produced for ${skill} doesn't satisfy the expected output schema. ` +
		"Please update the frontmatter and re-write the artifact at the same path.\n\n" +
		`Errors:\n${errorLines}`
	);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function describeType(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (Array.isArray(value)) return "array";
	return typeof value;
}
