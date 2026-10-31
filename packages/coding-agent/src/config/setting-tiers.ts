/**
 * How prominent each setting is in the settings panel.
 *
 *  - A: always listed in its tab.
 *  - B: listed in its tab only while "Show more options" (`settings.showMore`) is on.
 *  - D: moved to the Advanced tab, grouped by the tab it came from.
 *
 * (Tier C is a merge of several settings into one choice; it lives next to the
 * settings concerned, not here.) The tier never changes what a setting does or
 * where it is stored: a hidden or moved setting still reads from the config file.
 */

export type SettingTier = "A" | "B" | "D";

/** Settings a user touches: always visible in their tab. */
const TIER_A = new Set<string>([
	"modelRoles", "modelPresets", "enabledModels", "enabledProviders", "disabledProviders",
	"defaultThinkingLevel", "hideThinkingBlock", "personality",
	"tools.approvalMode", "tools.approval", "tools.restrictedFolders",
	"session.maxCost", "session.warnCost", "autoResume",
	"plan.enabled", "plan.defaultOnStartup", "goal.enabled",
	"skills.enabled", "browser.enabled", "mcp.enableProjectConfig",
	"compaction.enabled", "retry.enabled", "git.enabled", "ask.enabled",
	"display.showTokenUsage", "display.showTurnTime",
	"memory.backend", "memories.enabled",
	"completion.notify", "error.notify",
]);

/** Prefixes (`a.` = any `a.*`) or exact ids of settings that go to the Advanced tab. */
const TIER_D = [
	"theme.", "symbolPreset", "colorBlindMode", "composer.", "statusLine.", "terminal.", "tui.", "showHardwareCursor",
	"spelling.", "emojiAutocomplete", "treeFilterMode", "autocompleteMaxVisible", "input.", "paste.",
	"startup.", "update.", "marketplace.", "setupVersion", "magicKeywords.",
	"stt.", "tts.", "speech.", "live.", "collab.", "share.", "stream.", "auth.", "telemetry.", "dev.",
	"codexResets.", "claudeResets.", "ida.", "computer.", "exa.", "searxng.", "secrets.", "power.", "title.",
	"images.", "extensionRenderers.", "extensionHandlers.",
];

export function tierOf(id: string): SettingTier {
	if (TIER_A.has(id)) return "A";
	for (const p of TIER_D) {
		if (p.endsWith(".") ? id.startsWith(p) : id === p) return "D";
	}
	return "B";
}
