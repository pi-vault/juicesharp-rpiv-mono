import type { LiveSpan } from "@mlflow/core";

/**
 * Owns the four MLflow span maps that together describe live span state for
 * one `MlflowProvider` instance. Per-session inner maps make
 * `endAllForSession` O(1) at the session level — replacing the prior flat
 * `${sessionId}\0${innerKey}` composite-string-key sweep.
 */
export class MlflowSpanRegistry {
	/** Agent-turn root spans keyed by sessionId. */
	private readonly turnSpans = new Map<string, LiveSpan>();
	/** Tool-execution child spans keyed by sessionId → toolCallId. */
	private readonly toolSpans = new Map<string, Map<string, LiveSpan>>();
	/** LLM-request child spans keyed by sessionId → requestSeq. */
	private readonly llmSpans = new Map<string, Map<number, LiveSpan>>();
	/** Latest open LLM-request span per session — O(1) `message_end` attribution target. */
	private readonly latestLlmSpanBySession = new Map<string, LiveSpan>();

	setTurnSpan(sessionId: string, span: LiveSpan): void {
		this.turnSpans.set(sessionId, span);
	}

	getTurnSpan(sessionId: string): LiveSpan | undefined {
		return this.turnSpans.get(sessionId);
	}

	deleteTurnSpan(sessionId: string): void {
		this.turnSpans.delete(sessionId);
	}

	setToolSpan(sessionId: string, toolCallId: string, span: LiveSpan): void {
		let inner = this.toolSpans.get(sessionId);
		if (!inner) {
			inner = new Map();
			this.toolSpans.set(sessionId, inner);
		}
		inner.set(toolCallId, span);
	}

	getToolSpan(sessionId: string, toolCallId: string): LiveSpan | undefined {
		return this.toolSpans.get(sessionId)?.get(toolCallId);
	}

	deleteToolSpan(sessionId: string, toolCallId: string): void {
		const inner = this.toolSpans.get(sessionId);
		if (!inner) return;
		inner.delete(toolCallId);
		if (inner.size === 0) this.toolSpans.delete(sessionId);
	}

	setLlmSpan(sessionId: string, requestSeq: number, span: LiveSpan): void {
		let inner = this.llmSpans.get(sessionId);
		if (!inner) {
			inner = new Map();
			this.llmSpans.set(sessionId, inner);
		}
		inner.set(requestSeq, span);
	}

	getLlmSpan(sessionId: string, requestSeq: number): LiveSpan | undefined {
		return this.llmSpans.get(sessionId)?.get(requestSeq);
	}

	deleteLlmSpan(sessionId: string, requestSeq: number): void {
		const inner = this.llmSpans.get(sessionId);
		if (!inner) return;
		inner.delete(requestSeq);
		if (inner.size === 0) this.llmSpans.delete(sessionId);
	}

	setLatestLlmSpan(sessionId: string, span: LiveSpan): void {
		this.latestLlmSpanBySession.set(sessionId, span);
	}

	getLatestLlmSpan(sessionId: string): LiveSpan | undefined {
		return this.latestLlmSpanBySession.get(sessionId);
	}

	/**
	 * Clear the latest-span tracker only when it currently points at `span` —
	 * preserves attribution to other still-open spans in the concurrent case.
	 */
	clearLatestLlmSpanIfMatches(sessionId: string, span: LiveSpan): void {
		if (this.latestLlmSpanBySession.get(sessionId) === span) {
			this.latestLlmSpanBySession.delete(sessionId);
		}
	}

	/** End every live span for the given session and drop its entries. */
	endAllForSession(sessionId: string, endTimeNs: number): void {
		const turn = this.turnSpans.get(sessionId);
		if (turn) {
			turn.end({ endTimeNs });
			this.turnSpans.delete(sessionId);
		}
		const tools = this.toolSpans.get(sessionId);
		if (tools) {
			for (const span of tools.values()) span.end({ endTimeNs });
			this.toolSpans.delete(sessionId);
		}
		const llms = this.llmSpans.get(sessionId);
		if (llms) {
			for (const span of llms.values()) span.end({ endTimeNs });
			this.llmSpans.delete(sessionId);
		}
		this.latestLlmSpanBySession.delete(sessionId);
	}

	clear(): void {
		this.turnSpans.clear();
		this.toolSpans.clear();
		this.llmSpans.clear();
		this.latestLlmSpanBySession.clear();
	}
}
