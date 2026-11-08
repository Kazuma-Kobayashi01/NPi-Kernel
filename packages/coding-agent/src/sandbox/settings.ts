/**
 * Process sandbox settings. `sandbox.mode` confines what the agent's process
 * tree may write: on macOS the whole `npi` process is relaunched under a
 * Seatbelt profile, so bash, eval, file tools and MCP servers inherit it.
 */
import { register, type SettingValueOf } from "../config/registry";

const EMPTY_STRING_ARRAY: string[] = [];

export const cfgSandboxMode = register({
	id: "sandbox.mode",
	type: "enum",
	values: ["off", "workspace-write", "read-only"] as const,
	default: "off",
	ui: {
		tab: "interaction",
		group: "Approvals",
		label: "Sandbox",
		description:
			"macOS only, applied when a session starts. 'Workspace write' lets commands and tools write only inside the project (its git repository), npi's own folders and temporary folders; 'Read only' keeps the project read-only too. Reading files and network access are not restricted.",
		options: [
			{ value: "off", label: "Off", description: "No process sandbox." },
			{
				value: "workspace-write",
				label: "Workspace write",
				description: "Write only inside the project, npi's folders, temporary folders and sandbox.writableRoots.",
			},
			{
				value: "read-only",
				label: "Read only",
				description: "Write only to npi's folders, temporary folders and sandbox.writableRoots.",
			},
		],
	},
});

export const cfgSandboxWritableRoots = register({
	id: "sandbox.writableRoots",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	ui: {
		tab: "interaction",
		group: "Approvals",
		label: "Sandbox Writable Folders",
		description:
			"Extra folders the sandbox lets commands write (for example ~/.bun or ~/.cargo for package caches). Absolute paths or ~/…",
	},
});

export type SandboxMode = SettingValueOf<typeof cfgSandboxMode>;
