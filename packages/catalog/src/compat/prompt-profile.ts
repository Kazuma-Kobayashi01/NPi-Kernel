/**
 * Prompt profile: which system-prompt weight a model lineage gets. Authored on
 * the `prompt-profile` catalog axis in `rules/classes/*.kdl`; `lite` selects
 * the short tool-first prompt for small fast models.
 *
 * Resolved through the cascade at prompt-build time (session start, model
 * switch) rather than baked onto `Model`, like the delegation bias.
 */
import type { Model } from "../types";
import { PROMPT_PROFILES } from "./axes";
import { resolveCascade } from "./cascade";

/** One of `PROMPT_PROFILES`; see that constant for the semantics of each tier. */
export type PromptProfile = (typeof PROMPT_PROFILES)[number];

function isPromptProfile(value: unknown): value is PromptProfile {
	return typeof value === "string" && (PROMPT_PROFILES as readonly string[]).includes(value);
}

interface PromptProfileCacheEntry {
	provider: Model["provider"];
	api: Model["api"];
	id: string;
	reasoning: boolean;
	identity: Model["identity"];
	identityClass: string;
	family: string | undefined;
	revision: string | undefined;
	bias: PromptProfile;
}

const promptProfileCache = new WeakMap<Model, PromptProfileCacheEntry>();

/**
 * Prompt profile for a built model; `full` when no rule assigns one.
 * Callers: system-prompt and tool-description rendering in the coding agent.
 *
 * Results are cached by model object. Every cascade input is checked before a
 * hit, including fields on a reused/mutated identity object, so model metadata
 * refreshes and policy-relevant replacements cannot return stale profile.
 */
export function resolvePromptProfile(model: Model): PromptProfile {
	const { identity } = model;
	const cached = promptProfileCache.get(model);
	if (
		cached &&
		cached.provider === model.provider &&
		cached.api === model.api &&
		cached.id === model.id &&
		cached.reasoning === Boolean(model.reasoning) &&
		cached.identity === identity &&
		cached.identityClass === identity.class &&
		cached.family === identity.family &&
		cached.revision === identity.revision
	) {
		return cached.bias;
	}

	const resolved = resolveCascade({
		provider: model.provider,
		api: model.api,
		class: identity.class,
		model: model.id,
		reasoning: Boolean(model.reasoning),
		...(identity.family !== undefined && { family: identity.family }),
		...(identity.revision !== undefined && { revision: identity.revision }),
	}).catalog.promptProfile;
	const bias = isPromptProfile(resolved) ? resolved : "full";
	promptProfileCache.set(model, {
		provider: model.provider,
		api: model.api,
		id: model.id,
		reasoning: Boolean(model.reasoning),
		identity,
		identityClass: identity.class,
		family: identity.family,
		revision: identity.revision,
		bias,
	});
	return bias;
}
