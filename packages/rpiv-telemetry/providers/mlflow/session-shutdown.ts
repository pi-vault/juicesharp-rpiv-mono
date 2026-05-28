import type { SessionShutdownEvent } from "../../types/events.js";
import { msToNs } from "./keys.js";
import type { MlflowSpanRegistry } from "./span-registry.js";

export function onSessionShutdown(registry: MlflowSpanRegistry, event: SessionShutdownEvent): void {
	registry.endAllForSession(event.sessionId, msToNs(event.timestamp));
}
