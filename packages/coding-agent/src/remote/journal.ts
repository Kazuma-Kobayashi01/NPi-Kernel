/**
 * Per-channel replay journal, pending UI dialog tracker, and command dedup cache.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import type { RpcExtensionUIRequest } from "../modes/rpc/rpc-types";

export interface JournalEntry {
	firstSeq: number;
	seq: number;
	timestamp: number;
	bytes: number;
	frame: unknown;
}

export interface RemoteSessionJournalOptions {
	maxBytes?: number;
	maxAgeMs?: number;
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;

const INTERACTIVE_UI_METHODS: Readonly<Record<string, true>> = {
	select: true,
	confirm: true,
	input: true,
	editor: true,
	ask: true,
};

function canCoalesceTextDelta(
	prevFrame: unknown,
	nextFrame: unknown,
): { merged: unknown; addedBytes: number } | undefined {
	if (!isRecord(prevFrame) || !isRecord(nextFrame)) return undefined;
	if (prevFrame.type !== "message_update" || nextFrame.type !== "message_update") return undefined;
	if (prevFrame.messageId !== nextFrame.messageId) return undefined;
	const prevEvent = isRecord(prevFrame.assistantMessageEvent) ? prevFrame.assistantMessageEvent : undefined;
	const nextEvent = isRecord(nextFrame.assistantMessageEvent) ? nextFrame.assistantMessageEvent : undefined;
	if (!prevEvent || !nextEvent) return undefined;
	if (prevEvent.type !== "text_delta" || nextEvent.type !== "text_delta") return undefined;
	if (prevEvent.contentIndex !== nextEvent.contentIndex) return undefined;
	if (typeof prevEvent.delta !== "string" || typeof nextEvent.delta !== "string") return undefined;

	const mergedEvent = {
		...nextEvent,
		delta: `${prevEvent.delta}${nextEvent.delta}`,
	};
	return {
		merged: {
			...nextFrame,
			assistantMessageEvent: mergedEvent,
		},
		addedBytes: Buffer.byteLength(nextEvent.delta, "utf8"),
	};
}

/**
 * Byte- and age-bounded ring buffer for outbound session frames with consecutive
 * `text_delta` coalescing and `streamEpoch` generation tracking.
 */
export class RemoteSessionJournal {
	readonly streamEpoch: number;
	readonly #maxBytes: number;
	readonly #maxAgeMs: number;
	#entries: JournalEntry[] = [];
	#totalBytes = 0;
	#seq = 0;

	constructor(streamEpoch: number, options: RemoteSessionJournalOptions = {}) {
		this.streamEpoch = streamEpoch;
		this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.#maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
	}

	get currentSeq(): number {
		return this.#seq;
	}

	get bufferedCount(): number {
		return this.#entries.length;
	}

	get bufferedBytes(): number {
		return this.#totalBytes;
	}

	push(frame: unknown, now = Date.now()): { seq: number; coalesced: boolean } {
		this.#pruneExpired(now);
		const seq = ++this.#seq;
		const last = this.#entries[this.#entries.length - 1];
		if (last) {
			const coalesced = canCoalesceTextDelta(last.frame, frame);
			if (coalesced) {
				last.seq = seq;
				last.timestamp = now;
				last.bytes += coalesced.addedBytes;
				last.frame = coalesced.merged;
				this.#totalBytes += coalesced.addedBytes;
				this.#trimToBudget();
				return { seq, coalesced: true };
			}
		}
		const bytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
		this.#entries.push({ firstSeq: seq, seq, timestamp: now, bytes, frame });
		this.#totalBytes += bytes;
		this.#trimToBudget();
		return { seq, coalesced: false };
	}

	replaySince(
		streamEpoch: number,
		sinceSeq: number,
		now = Date.now(),
	): { kind: "replay"; frames: Array<{ seq: number; frame: unknown }> } | { kind: "reset" } {
		this.#pruneExpired(now);
		if (streamEpoch !== this.streamEpoch || sinceSeq < 0 || sinceSeq > this.#seq) {
			return { kind: "reset" };
		}
		if (sinceSeq === this.#seq) {
			return { kind: "replay", frames: [] };
		}
		if (this.#entries.length === 0) {
			return { kind: "reset" };
		}
		const oldestAvailableSeq = this.#entries[0]!.firstSeq;
		if (sinceSeq + 1 < oldestAvailableSeq) {
			return { kind: "reset" };
		}
		const frames = this.#entries
			.filter(entry => entry.seq > sinceSeq)
			.map(entry => ({ seq: entry.seq, frame: entry.frame }));
		return { kind: "replay", frames };
	}

	#pruneExpired(now: number): void {
		const cutoff = now - this.#maxAgeMs;
		while (this.#entries.length > 0 && this.#entries[0]!.timestamp < cutoff) {
			const dropped = this.#entries.shift()!;
			this.#totalBytes -= dropped.bytes;
		}
	}

	#trimToBudget(): void {
		while (this.#entries.length > 1 && this.#totalBytes > this.#maxBytes) {
			const dropped = this.#entries.shift()!;
			this.#totalBytes -= dropped.bytes;
		}
	}
}

/**
 * Tracks interactive `extension_ui_request` dialogs outside the replay buffer
 * so reconnects and Attach always rehydrate unsettled approvals & `ask` forms.
 */
export class PendingDialogTracker {
	#pending = new Map<string, RpcExtensionUIRequest>();

	get size(): number {
		return this.#pending.size;
	}

	observeOutbound(request: RpcExtensionUIRequest): void {
		if (request.method === "cancel") {
			this.#pending.delete(request.targetId);
			return;
		}
		if (Object.hasOwn(INTERACTIVE_UI_METHODS, request.method)) {
			this.#pending.set(request.id, request);
		}
	}

	get(requestId: string): RpcExtensionUIRequest | undefined {
		return this.#pending.get(requestId);
	}

	resolve(requestId: string): boolean {
		return this.#pending.delete(requestId);
	}

	listPending(): RpcExtensionUIRequest[] {
		return Array.from(this.#pending.values());
	}

	clear(): void {
		this.#pending.clear();
	}
}

interface DedupEntry<T> {
	expiresAt: number;
	value: T;
}

/**
 * Bounded `(deviceId, msgId)` deduplication cache so retried prompts/commands
 * after transient network drops do not execute twice.
 */
export class CommandDedupCache<T = unknown> {
	readonly #ttlMs: number;
	readonly #maxEntries: number;
	#entries = new Map<string, DedupEntry<T>>();

	constructor(options: { ttlMs?: number; maxEntries?: number } = {}) {
		this.#ttlMs = options.ttlMs ?? 5 * 60 * 1000;
		this.#maxEntries = options.maxEntries ?? 1024;
	}

	#key(deviceId: string, msgId: string): string {
		return `${deviceId}\0${msgId}`;
	}

	get(deviceId: string, msgId: string, now = Date.now()): T | undefined {
		const key = this.#key(deviceId, msgId);
		const entry = this.#entries.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt < now) {
			this.#entries.delete(key);
			return undefined;
		}
		return entry.value;
	}

	set(deviceId: string, msgId: string, value: T, now = Date.now()): void {
		const key = this.#key(deviceId, msgId);
		this.#entries.set(key, { expiresAt: now + this.#ttlMs, value });
		if (this.#entries.size > this.#maxEntries) {
			this.#prune(now);
		}
	}

	#prune(now: number): void {
		for (const [key, entry] of this.#entries) {
			if (entry.expiresAt < now) this.#entries.delete(key);
		}
		while (this.#entries.size > this.#maxEntries) {
			const oldestKey = this.#entries.keys().next().value;
			if (oldestKey === undefined) break;
			this.#entries.delete(oldestKey);
		}
	}
}
