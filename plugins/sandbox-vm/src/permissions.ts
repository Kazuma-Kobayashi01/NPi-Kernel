import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SandboxVmConfig } from "./config";

/** What the VM may do: the settings the "permissions" panels (TUI `/vm permissions`, Desktop Settings) edit. */
export interface Permissions {
	/** `off`: no network device; `nat`: the guest reaches the network through the host. */
	network: "off" | "nat";
	/** Whether commands can change the project folder (the host's file tools can either way). */
	projectAccess: "read-write" | "read-only";
	/** Extra host folders mounted read-only at the same path. */
	readOnlyMounts: string[];
	cpus: number;
	memoryMiB: number;
	/** Stop the VM after this many idle minutes; 0 keeps it running. */
	idleStopMinutes: number;
}

/** What this machine allows, for the panels' bounds. */
export interface PermissionLimits {
	maxCpus: number;
	maxMemoryMiB: number;
	hostMemoryMiB: number;
}

export const MIN_MEMORY_MIB = 512;
const MAX_MEMORY_MIB = 65_536;
const MAX_CPUS = 64;
const MAX_IDLE_MINUTES = 24 * 60;

export function permissionsOf(config: SandboxVmConfig): Permissions {
	return {
		network: config.network,
		projectAccess: config.projectAccess,
		readOnlyMounts: [...config.readOnlyMounts],
		cpus: config.cpus,
		memoryMiB: config.memoryMiB,
		idleStopMinutes: config.idleStopMinutes,
	};
}

export function limits(): PermissionLimits {
	return {
		maxCpus: Math.min(MAX_CPUS, os.availableParallelism()),
		maxMemoryMiB: MAX_MEMORY_MIB,
		hostMemoryMiB: Math.floor(os.totalmem() / 1_048_576),
	};
}

function integerIn(value: unknown, min: number, max: number, what: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		throw new Error(`${what} must be a whole number from ${min} to ${max}`);
	}
	return value;
}

/**
 * Check a change set and return the clean version of it. Throws with a message a user can act on; nothing is
 * written by this function. Mount folders must exist (the helper refuses to start the VM otherwise).
 */
export async function validatePatch(patch: unknown): Promise<Partial<Permissions>> {
	if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new Error("changes must be an object");
	const input = patch as Record<string, unknown>;
	const clean: Partial<Permissions> = {};
	const known = new Set(["network", "projectAccess", "readOnlyMounts", "cpus", "memoryMiB", "idleStopMinutes"]);
	for (const key of Object.keys(input)) if (!known.has(key)) throw new Error(`unknown permission ${key}`);

	if ("network" in input) {
		if (input.network !== "off" && input.network !== "nat") throw new Error("network must be off or nat");
		clean.network = input.network;
	}
	if ("projectAccess" in input) {
		if (input.projectAccess !== "read-write" && input.projectAccess !== "read-only") {
			throw new Error("projectAccess must be read-write or read-only");
		}
		clean.projectAccess = input.projectAccess;
	}
	if ("cpus" in input) clean.cpus = integerIn(input.cpus, 1, limits().maxCpus, "cpus");
	if ("memoryMiB" in input) clean.memoryMiB = integerIn(input.memoryMiB, MIN_MEMORY_MIB, MAX_MEMORY_MIB, "memoryMiB");
	if ("idleStopMinutes" in input) {
		clean.idleStopMinutes = integerIn(input.idleStopMinutes, 0, MAX_IDLE_MINUTES, "idleStopMinutes");
	}
	if ("readOnlyMounts" in input) {
		if (!Array.isArray(input.readOnlyMounts)) throw new Error("readOnlyMounts must be a list of folders");
		const mounts: string[] = [];
		for (const entry of input.readOnlyMounts) {
			if (typeof entry !== "string" || !path.isAbsolute(entry)) throw new Error(`${String(entry)} is not an absolute path`);
			const folder = path.resolve(entry);
			const stat = await fs.stat(folder).catch(() => undefined);
			if (!stat?.isDirectory()) throw new Error(`${folder} is not a folder`);
			if (!mounts.includes(folder)) mounts.push(folder);
		}
		clean.readOnlyMounts = mounts;
	}
	return clean;
}

/** `8` / `8 cores` → 8, or an error message (TUI text input). */
export function parseCount(text: string, min: number, max: number, what: string): number | string {
	const value = Number(text.trim().split(/\s+/u)[0]);
	return Number.isInteger(value) && value >= min && value <= max ? value : `${what}: a whole number from ${min} to ${max}`;
}

/** `8`, `8g`, `8 GiB`, `4096m`, `4096 MiB` → MiB, or an error message (a bare number is GiB below 256, MiB above). */
export function parseMemory(text: string): number | string {
	const match = /^\s*(\d+(?:\.\d+)?)\s*(g|gb|gib|m|mb|mib)?\s*$/iu.exec(text);
	if (!match) return "memory: like 8, 8 GiB or 4096 MiB";
	const amount = Number(match[1]);
	const unit = (match[2] ?? "").toLowerCase();
	const mib = Math.round(unit.startsWith("m") || (unit === "" && amount >= 256) ? amount : amount * 1024);
	return mib >= MIN_MEMORY_MIB && mib <= MAX_MEMORY_MIB
		? mib
		: `memory: from ${MIN_MEMORY_MIB} MiB to ${MAX_MEMORY_MIB / 1024} GiB`;
}

export function formatMemory(mib: number): string {
	return mib % 1024 === 0 ? `${mib / 1024} GiB` : `${mib} MiB`;
}

/** The panel's lines, one per permission. */
export function summarize(perms: Permissions): { key: keyof Permissions; label: string; value: string }[] {
	return [
		{ key: "network", label: "Network", value: perms.network === "nat" ? "on (through this machine)" : "off" },
		{ key: "projectAccess", label: "Project folder", value: perms.projectAccess },
		{
			key: "readOnlyMounts",
			label: "Extra read-only folders",
			value: perms.readOnlyMounts.length === 0 ? "none" : `${perms.readOnlyMounts.length}`,
		},
		{ key: "cpus", label: "CPU cores", value: `${perms.cpus}` },
		{ key: "memoryMiB", label: "Memory (up to)", value: formatMemory(perms.memoryMiB) },
		{
			key: "idleStopMinutes",
			label: "Stop when idle",
			value: perms.idleStopMinutes === 0 ? "never" : `after ${perms.idleStopMinutes} min`,
		},
	];
}
