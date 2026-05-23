/** Predicate factories for DAG edge routing. Pure manifest → target-node-id. */

import type { Manifest } from "./manifest.js";
import type { RunState } from "./types.js";

export interface PredicateContext {
	manifest: Manifest | undefined;
	state: Readonly<RunState>;
}

export type EdgePredicate = (ctx: PredicateContext) => string;

/** ifTrue when `manifest.data[field] === equals`, else ifFalse. */
export const predicateOnField =
	<T>(field: string, equals: T, ifTrue: string, ifFalse: string): EdgePredicate =>
	({ manifest }) => {
		const value = (manifest?.data as Record<string, unknown>)?.[field];
		return value === equals ? ifTrue : ifFalse;
	};

/** ifAbove when `Number(manifest.data[field] ?? 0) > threshold`, else ifBelow. */
export const predicateThreshold =
	(field: string, threshold: number, ifAbove: string, ifBelow: string): EdgePredicate =>
	({ manifest }) => {
		const value = Number((manifest?.data as Record<string, unknown>)?.[field] ?? 0);
		return value > threshold ? ifAbove : ifBelow;
	};
