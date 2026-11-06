/**
 * The model roster: four tiers of models (flagship, high, standard, economy) that subagents are
 * scheduled onto by how hard their work is, configured as the `modelRoles` of the same names.
 * In Auto subagent mode a batch whose items all name one configured tier (`model: "@economy"`)
 * runs on it without asking; the arbiter role judges a multi-expert review.
 */
import { MODEL_ROLE_ALIAS_PREFIX } from "./model-roles";

export const ROSTER_TIERS = ["flagship", "high", "standard", "economy"] as const;
export type RosterTier = (typeof ROSTER_TIERS)[number];

/** The roster tier a model selector names (`@flagship`, with an optional `:thinking` suffix), if any. */
export function rosterTierOf(selector: string | undefined): RosterTier | undefined {
	if (!selector?.startsWith(MODEL_ROLE_ALIAS_PREFIX)) return undefined;
	const name = selector.slice(MODEL_ROLE_ALIAS_PREFIX.length).split(":")[0];
	return ROSTER_TIERS.find(tier => tier === name);
}
