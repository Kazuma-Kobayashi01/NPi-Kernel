/**
 * Cross-process cooldowns for web_search backends that refused a search.
 *
 * A backend that answers 429 (rate limit, CAPTCHA or automated-traffic block)
 * keeps refusing for a while; trying it first on every search only adds its
 * failure latency before the next backend answers. A cooling backend moves to
 * the end of the chain — it is still tried when everything else fails — and a
 * success clears it. The state lives in one small JSON file so every agent
 * process (Desktop tabs, subagents, the CLI) shares what the others learned.
 */

import { getWebSearchCooldownPath, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";
import { SearchProviderError } from "./types";

/** One backend's cooldown: until when, and the refusal that started it. */
export interface SearchCooldownEntry {
	until: number;
	reason: string;
}

interface CooldownFile {
	version: 1;
	entries: Record<string, SearchCooldownEntry>;
}

/** Longest refusal reason kept in the file; provider errors can carry whole response bodies. */
const MAX_REASON_CHARS = 200;

function isEntry(value: unknown): value is SearchCooldownEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return typeof entry.until === "number" && Number.isFinite(entry.until) && typeof entry.reason === "string";
}

/** Whether a failed search should cool its backend down: the backend refused (429), not the query. */
export function isCooldownError(error: unknown): boolean {
	return error instanceof SearchProviderError && error.status === 429;
}

/** File-backed cooldown table shared by every process that uses the same path. */
export class SearchCooldowns {
	readonly #path: string;
	readonly #now: () => number;

	constructor(options: { path: string; now?: () => number }) {
		this.#path = options.path;
		this.#now = options.now ?? Date.now;
	}

	/** Backends still cooling, keyed by `provider/id`. A missing or unreadable file means none. */
	async active(): Promise<Map<string, SearchCooldownEntry>> {
		const entries = await this.#read();
		const now = this.#now();
		return new Map(Object.entries(entries).filter(([, entry]) => entry.until > now));
	}

	/** Cool `key` down for `durationMs`, replacing any earlier cooldown for it. */
	async start(key: string, durationMs: number, reason: string): Promise<void> {
		const entries = await this.#readLive();
		entries[key] = { until: this.#now() + durationMs, reason: reason.slice(0, MAX_REASON_CHARS) };
		await this.#write(entries);
	}

	/** End `key`'s cooldown after it served a search; no write when it was not cooling. */
	async clear(key: string): Promise<void> {
		const entries = await this.#readLive();
		if (!Object.hasOwn(entries, key)) return;
		delete entries[key];
		await this.#write(entries);
	}

	/** Entries still in force; expired ones drop out on the next write. */
	async #readLive(): Promise<Record<string, SearchCooldownEntry>> {
		const now = this.#now();
		const entries = await this.#read();
		return Object.fromEntries(Object.entries(entries).filter(([, entry]) => entry.until > now));
	}

	async #read(): Promise<Record<string, SearchCooldownEntry>> {
		let parsed: unknown;
		try {
			parsed = await Bun.file(this.#path).json();
		} catch (error) {
			// Missing file: nothing is cooling. A torn or foreign file is treated the same and rewritten on the next change.
			if (!isEnoent(error)) logger.warn("web search cooldowns unreadable; ignoring", { path: this.#path });
			return {};
		}
		if (typeof parsed !== "object" || parsed === null) return {};
		const raw = (parsed as Partial<CooldownFile>).entries;
		if (typeof raw !== "object" || raw === null) return {};
		return Object.fromEntries(Object.entries(raw).filter(([, entry]) => isEntry(entry)));
	}

	async #write(entries: Record<string, SearchCooldownEntry>): Promise<void> {
		const file: CooldownFile = { version: 1, entries };
		await Bun.write(this.#path, `${JSON.stringify(file, null, "\t")}\n`);
	}
}

let defaultCooldowns: SearchCooldowns | null | undefined;

/**
 * The shared cooldown table for real sessions. `bun test` processes get none,
 * so suites that drive the search chain never read or write the user's file;
 * tests of this behavior pass their own {@link SearchCooldowns}.
 */
export function defaultSearchCooldowns(): SearchCooldowns | null {
	if (defaultCooldowns === undefined) {
		defaultCooldowns = isBunTestRuntime() ? null : new SearchCooldowns({ path: getWebSearchCooldownPath() });
	}
	return defaultCooldowns;
}

/** Stable partition: cooling candidates keep their relative order after every other candidate. */
export function deferCooling<T>(
	candidates: readonly T[],
	keyOf: (candidate: T) => string,
	cooling: ReadonlyMap<string, unknown>,
): T[] {
	if (cooling.size === 0) return [...candidates];
	const ready: T[] = [];
	const deferred: T[] = [];
	for (const candidate of candidates) (cooling.has(keyOf(candidate)) ? deferred : ready).push(candidate);
	return [...ready, ...deferred];
}
