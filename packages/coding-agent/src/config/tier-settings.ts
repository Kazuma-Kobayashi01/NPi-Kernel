/**
 * Settings declared by this domain (see `config/registry.ts`).
 */
import { register } from "./registry";

/** Whether the panel lists the less common (tier B) settings in every tab. */
export const cfgSettingsShowMore = register({
	id: "settings.showMore",
	type: "boolean",
	default: false,
	ui: {
		tab: "advanced",
		label: "Show More Options",
		description: "List the less common settings in every tab. Off keeps each tab to the settings most people change.",
	},
});
