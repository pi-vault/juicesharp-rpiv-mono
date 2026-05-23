/**
 * Process-wide flag: current `session_start` was fired by runWorkflow
 * spawning an inner stage (not by the user opening Pi). Only `ui.notify`
 * calls in session_start handlers gate on this — state mutation (advisor
 * restore, agent sync, guidance injection) runs unconditionally.
 *
 * `Symbol.for` so rpiv-advisor can read it without an import cycle.
 * Runner is serial — no concurrent-workflow concern.
 */

const CHILD_SESSION_KEY = Symbol.for("@juicesharp/rpiv-workflow:child-session");

type Global = Record<symbol, unknown>;

export function markChildSession(): void {
	(globalThis as unknown as Global)[CHILD_SESSION_KEY] = true;
}

export function clearChildSession(): void {
	delete (globalThis as unknown as Global)[CHILD_SESSION_KEY];
}

export function isChildSession(): boolean {
	return Boolean((globalThis as unknown as Global)[CHILD_SESSION_KEY]);
}
