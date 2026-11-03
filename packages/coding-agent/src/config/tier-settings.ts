/**
 * Settings declared by this domain (see `config/registry.ts`).
 */
import { register } from "./registry";

/**
 * Retired: the panel used to hide the less common settings behind this switch and move
 * others to an Advanced tab. Every setting is listed in its own tab now. The key stays
 * registered so a config file that still holds it loads as before; it has no panel row.
 */
export const cfgSettingsShowMore = register({
	id: "settings.showMore",
	type: "boolean",
	default: false,
});
