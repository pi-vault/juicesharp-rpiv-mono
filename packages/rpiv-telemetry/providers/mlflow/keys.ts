/** `Date.now()` (ms) → MLflow's expected nanosecond integer. */
export function msToNs(ms: number): number {
	return ms * 1_000_000;
}
