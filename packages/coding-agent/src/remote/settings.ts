/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Remote control
export const cfgRemoteRelayUrl = register({
	id: "remote.relayUrl",
	type: "string",
	default: "",
	ui: {
		tab: "interaction",
		group: "Remote Control",
		label: "Relay URL",
		description: "Relay /rc connects through (wss://…); `/rc <url>` uses another one and saves it here",
	},
});

export const cfgRemoteAutoStart = register({
	id: "remote.autoStart",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Remote Control",
		label: "Start /rc Automatically",
		description: "Run /rc when an interactive session starts, through remote.relayUrl, so a paired phone can open it",
	},
});
