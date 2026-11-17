import { isRecord } from "@oh-my-pi/pi-utils";

/**
 * Per-model context windows (`modelContextWindows`): `provider/model-id` → the
 * window that model runs with, chosen from {@link contextWindowStops}. A choice
 * past the model's standard window opts it into its extended window; a smaller
 * one caps the window the session binds (compaction, context display), never
 * the catalog row. A model without an entry keeps its default window.
 */
export type ModelContextWindows = Readonly<Record<string, number | null>>;

/** The windows the pickers offer: 200K, 400K and 1M, below a model's largest window. */
export const CONTEXT_WINDOW_STEPS: readonly number[] = [200_000, 400_000, 1_000_000];

/**
 * The choices for a model whose largest window is `ceiling`: every step below
 * it, then the largest window itself (1M at most). Empty when the model has no
 * known window or its window is below the first step (nothing to choose).
 */
export function contextWindowStops(ceiling: number | null | undefined): number[] {
	if (ceiling === null || ceiling === undefined || !(ceiling >= CONTEXT_WINDOW_STEPS[0])) return [];
	const top = Math.min(ceiling, CONTEXT_WINDOW_STEPS[CONTEXT_WINDOW_STEPS.length - 1]);
	const stops = CONTEXT_WINDOW_STEPS.filter(step => step < top);
	stops.push(top);
	return stops;
}

/** `provider/model-id`: a provider, one slash, an id, no whitespace. */
function contextWindowKeyError(key: string): string | undefined {
	const slash = key.indexOf("/");
	if (slash <= 0 || slash === key.length - 1) return "expected provider/model-id";
	if (/\s/.test(key)) return "must not contain whitespace";
	return undefined;
}

/** Rejects anything but a map of `provider/model-id` to a positive integer token count (or `null` to clear). */
export function validateModelContextWindows(raw: unknown): void {
	if (raw === undefined || raw === null) return;
	if (!isRecord(raw)) throw new Error("Invalid modelContextWindows: expected a map of provider/model-id to tokens.");
	for (const [key, value] of Object.entries(raw)) {
		const keyError = contextWindowKeyError(key);
		if (keyError) throw new Error(`Invalid modelContextWindows key "${key}": ${keyError}.`);
		if (value === null) continue;
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
			throw new Error(`Invalid modelContextWindows.${key}: expected a positive integer token count.`);
		}
	}
}

/** The window chosen for `model`, or undefined when it has no entry. */
export function modelContextWindowChoice(
	windows: unknown,
	model: { provider: string; id: string },
): number | undefined {
	if (!isRecord(windows)) return undefined;
	const value = windows[`${model.provider}/${model.id}`];
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** A window as the pickers label it: `200K`, `400K`, `1M`, `1.05M`. */
export function formatContextWindow(tokens: number): string {
	if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(2))}M`;
	return `${Math.round(tokens / 1_000)}K`;
}

/** What the `modelContextWindows` editors need from the model registry. */
export interface ContextWindowSource {
	contextWindowTiers(model: { provider: string; id: string }): { standard: number; extended: number } | undefined;
	contextWindowCeiling(model: { provider: string; id: string }): number | null;
}

/** One model as the `modelContextWindows` editors list it. */
export interface ContextWindowModelInfo {
	key: string;
	name: string;
	/** The window without an entry: the standard tier, or the extended one while `extendedContext` is on. */
	defaultWindow: number | null;
	stops: number[];
}

/** `models` (the current one first, then by provider and name) with their default window and stops. */
export function describeContextWindowModels(
	source: ContextWindowSource,
	models: readonly { provider: string; id: string; name: string; contextWindow: number | null }[],
	options: { extendedContext: boolean; current?: { provider: string; id: string } },
): ContextWindowModelInfo[] {
	const currentKey = options.current ? `${options.current.provider}/${options.current.id}` : "";
	const seen = new Set<string>();
	const rows: ContextWindowModelInfo[] = [];
	for (const model of models) {
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const tiers = source.contextWindowTiers(model);
		rows.push({
			key,
			name: `${model.name} (${model.provider})`,
			defaultWindow: tiers ? (options.extendedContext ? tiers.extended : tiers.standard) : model.contextWindow,
			stops: contextWindowStops(source.contextWindowCeiling(model)),
		});
	}
	return rows.sort((a, b) => {
		if (a.key === currentKey) return -1;
		if (b.key === currentKey) return 1;
		return a.key.localeCompare(b.key);
	});
}
