import { type PermissionLimits, type Permissions, parseCount, parseMemory, summarize } from "./permissions";

/** The slice of the TUI's UI context the panel uses. */
export interface PanelUi {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** What the panel reads and changes; the VM controller in the plugin. */
export interface PanelBackend {
	permissions(): Promise<{ permissions: Permissions; limits: PermissionLimits }>;
	set(changes: Partial<Permissions>, restart: boolean): Promise<{ restartNeeded: boolean }>;
}

const TITLE = "Sandbox VM permissions";
const BACK = "Back";
const ADD_FOLDER = "Add a folder…";

/** Ask for a value until it parses or the user cancels. */
async function ask<T>(ui: PanelUi, title: string, placeholder: string, parse: (text: string) => T | string): Promise<T | undefined> {
	for (;;) {
		const text = await ui.input(title, placeholder);
		if (text === undefined) return undefined;
		const value = parse(text);
		if (typeof value !== "string") return value;
		ui.notify(value, "warning");
	}
}

/** One permission's dialog; the change to save, or nothing. */
async function edit(
	ui: PanelUi,
	key: keyof Permissions,
	current: Permissions,
	limits: PermissionLimits,
): Promise<Partial<Permissions> | undefined> {
	switch (key) {
		case "network": {
			const on = "on: the guest reaches the network through this machine";
			const off = "off: the guest has no network";
			const choice = await ui.select("Network", [off, on]);
			if (choice === undefined) return undefined;
			if (choice === on && current.network !== "nat") {
				const ok = await ui.confirm("Turn the network on?", "Commands in the VM can then download and send data like any program on this machine.");
				if (!ok) return undefined;
			}
			return { network: choice === on ? "nat" : "off" };
		}
		case "projectAccess": {
			const choice = await ui.select("Project folder", ["read-write", "read-only"]);
			return choice === undefined ? undefined : { projectAccess: choice as Permissions["projectAccess"] };
		}
		case "readOnlyMounts": {
			const choice = await ui.select("Extra read-only folders", [ADD_FOLDER, ...current.readOnlyMounts.map(m => `Remove ${m}`), BACK]);
			if (choice === undefined || choice === BACK) return undefined;
			if (choice === ADD_FOLDER) {
				const folder = await ui.input("Folder to mount read-only", "/absolute/path");
				return folder?.trim() ? { readOnlyMounts: [...current.readOnlyMounts, folder.trim()] } : undefined;
			}
			return { readOnlyMounts: current.readOnlyMounts.filter(m => `Remove ${m}` !== choice) };
		}
		case "cpus": {
			const cpus = await ask(ui, `CPU cores (1-${limits.maxCpus})`, `${current.cpus}`, text => parseCount(text, 1, limits.maxCpus, "cores"));
			return cpus === undefined ? undefined : { cpus };
		}
		case "memoryMiB": {
			const memoryMiB = await ask(ui, `Memory ceiling (this machine has ${Math.round(limits.hostMemoryMiB / 1024)} GiB)`, "8 GiB", parseMemory);
			return memoryMiB === undefined ? undefined : { memoryMiB };
		}
		case "idleStopMinutes": {
			const idleStopMinutes = await ask(ui, "Stop the VM after this many idle minutes (0: never)", `${current.idleStopMinutes}`, text =>
				parseCount(text, 0, 24 * 60, "minutes"),
			);
			return idleStopMinutes === undefined ? undefined : { idleStopMinutes };
		}
	}
}

/**
 * The TUI's permissions panel (`/vm permissions`): a list of the VM's permissions with their values; choosing one
 * opens its dialog. Changes are saved as they are made and apply when the VM restarts, which the panel offers on
 * the way out when the VM is running.
 */
export async function runPermissionsPanel(ui: PanelUi, backend: PanelBackend): Promise<void> {
	let pending = false;
	for (;;) {
		const { permissions, limits } = await backend.permissions();
		const rows = summarize(permissions).map(row => ({ key: row.key, text: `${row.label}: ${row.value}` }));
		const done = pending ? "Done (restart the VM to apply)" : "Done";
		const choice = await ui.select(TITLE, [...rows.map(row => row.text), done]);
		const row = rows.find(entry => entry.text === choice);
		if (!row) break;
		const change = await edit(ui, row.key, permissions, limits);
		if (!change) continue;
		try {
			pending = (await backend.set(change, false)).restartNeeded || pending;
		} catch (error) {
			ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	}
	if (pending && (await ui.confirm("Restart the VM?", "The new permissions apply when it restarts. Commands running in it are stopped."))) {
		await backend.set({}, true);
		ui.notify("VM stopped; the next command boots it with the new permissions", "info");
	}
}

