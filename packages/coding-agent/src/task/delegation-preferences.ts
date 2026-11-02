import type { ScopeLike } from "../config/registry";
import {
	cfgTaskDelegationAppetite,
	cfgTaskMaxConcurrency,
	cfgTaskSubagentCustomModel,
	cfgTaskSubagentCustomThinking,
	cfgTaskSubagentModelMode,
	type SUBAGENT_DELEGATION_APPETITES,
	type SUBAGENT_MODEL_MODES,
	type SUBAGENT_THINKING_LEVELS,
} from "./settings";

export type SubagentPreferences = {
	mode: (typeof SUBAGENT_MODEL_MODES)[number];
	appetite: (typeof SUBAGENT_DELEGATION_APPETITES)[number];
	model: string;
	thinking: (typeof SUBAGENT_THINKING_LEVELS)[number];
};

const CONCURRENCY_LIMITS: Record<SubagentPreferences["appetite"], number> = {
	unlimited: 32,
	aggressive: 8,
	moderate: 4,
	conservative: 2,
	off: 0,
};

/** Undefined means the host has not enabled Desktop's subagent policy. */
export function readSubagentPreferences(scope: ScopeLike): SubagentPreferences | undefined {
	const mode = cfgTaskSubagentModelMode.get(scope);
	if (mode === "default") return undefined;
	const appetite = cfgTaskDelegationAppetite.get(scope);
	if (appetite === "default") throw new Error("Subagent preferences require a delegation appetite");
	return {
		mode,
		appetite,
		model: cfgTaskSubagentCustomModel.get(scope),
		thinking: cfgTaskSubagentCustomThinking.get(scope),
	};
}

/** Off is zero admissions, unlike legacy task.maxConcurrency's zero = unlimited. */
export function getSubagentConcurrencyLimit(scope: ScopeLike): number {
	const preferences = readSubagentPreferences(scope);
	return preferences ? CONCURRENCY_LIMITS[preferences.appetite] : cfgTaskMaxConcurrency.get(scope);
}
