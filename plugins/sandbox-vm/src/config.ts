import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { VmConfig } from "./protocol";

/** The Linux root the VM boots; both run the same kernel, see `scripts/build-image.sh`. */
export type VmBase = "alpine" | "ubuntu";

export const VM_BASES: readonly VmBase[] = ["alpine", "ubuntu"];

export function isVmBase(value: unknown): value is VmBase {
	return typeof value === "string" && (VM_BASES as readonly string[]).includes(value);
}

export interface SandboxVmConfig {
	/** Which root the VM boots (`alpine` by default); switching takes effect at the next VM start. */
	base: VmBase;
	memoryMiB: number;
	cpus: number;
	network: VmConfig["network"];
	/** Whether the guest may change the project folder (`read-write`, the default) or only read it. */
	projectAccess: "read-write" | "read-only";
	/** Folder holding the guest image of the selected base (`Image`, `rootfs.cpio.gz`); see {@link defaultImageDir}. */
	image?: string;
	/** The VM helper executable; `NPI_VM_HELPER` wins over it. Default: `bin/npi-vm-helper` inside the plugin. */
	helper?: string;
	/** Extra folders mounted read-only at the same path in the guest. */
	readOnlyMounts: string[];
	/** Stop the VM after this many idle minutes (it starts again on the next command); 0 keeps it running. */
	idleStopMinutes: number;
}

export const DEFAULT_CONFIG: SandboxVmConfig = {
	base: "alpine",
	// Up to 8 GiB and 8 cores; the host commits guest memory only as the guest touches it, see the README.
	memoryMiB: 8192,
	cpus: 8,
	// The strict default: the guest cannot reach the network until the user turns it on.
	network: "off",
	projectAccess: "read-write",
	readOnlyMounts: [],
	idleStopMinutes: 15,
};

/** The plugin's data folder (`NPI_VM_DATA_DIR` overrides it, for tests); the image folders of the bases live in it. */
export function dataDir(): string {
	return Bun.env.NPI_VM_DATA_DIR || path.join(os.homedir(), ".local", "share", "npi", "sandbox-vm");
}

/** Where `scripts/build-image.sh [base]` puts a base's guest image unless told otherwise. */
export function defaultImageDir(base: VmBase = "alpine"): string {
	return path.join(dataDir(), base === "ubuntu" ? "image-ubuntu" : "image");
}

/** The images shipped inside the plugin package (`images/<base>/`, put there by `scripts/pack.sh`; `NPI_VM_BUNDLED_DIR` replaces `images/`, for tests). */
export function bundledImageDir(base: VmBase): string {
	return path.join(Bun.env.NPI_VM_BUNDLED_DIR || path.join(import.meta.dir, "..", "images"), base);
}

/**
 * The folders images are built into (and reclaimed from), one per base; the settings' `image` replaces the
 * selected base's folder only. The package's bundled images are a fallback, see `resolveImageDir`.
 */
export function imageDirs(config: SandboxVmConfig): Record<VmBase, string> {
	return {
		alpine: config.base === "alpine" ? (config.image ?? defaultImageDir("alpine")) : defaultImageDir("alpine"),
		ubuntu: config.base === "ubuntu" ? (config.image ?? defaultImageDir("ubuntu")) : defaultImageDir("ubuntu"),
	};
}

/** Where the plugin's settings live: `<agent dir>/sandbox-vm.json`. */
export function configPath(): string {
	return path.join(getAgentDir(), "sandbox-vm.json");
}

function positiveInt(value: unknown, fallback: number, max: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

function nonNegativeInt(value: unknown, fallback: number, max: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? Math.min(value, max) : fallback;
}

/** Read the settings file, keeping defaults for anything missing or malformed. */
export async function loadConfig(file: string = configPath()): Promise<SandboxVmConfig> {
	let raw: unknown;
	try {
		raw = await Bun.file(file).json();
	} catch (error) {
		if (!isEnoent(error))
			logger.warn("sandbox-vm: could not read its settings, using defaults", { file, error: String(error) });
		return { ...DEFAULT_CONFIG };
	}
	if (typeof raw !== "object" || raw === null) return { ...DEFAULT_CONFIG };
	const value = raw as Record<string, unknown>;
	return {
		base: isVmBase(value.base) ? value.base : DEFAULT_CONFIG.base,
		memoryMiB: positiveInt(value.memoryMiB, DEFAULT_CONFIG.memoryMiB, 65_536),
		cpus: positiveInt(value.cpus, DEFAULT_CONFIG.cpus, 64),
		network: value.network === "nat" ? "nat" : "off",
		projectAccess: value.projectAccess === "read-only" ? "read-only" : "read-write",
		...(typeof value.image === "string" && value.image !== "" ? { image: value.image } : {}),
		...(typeof value.helper === "string" && value.helper !== "" ? { helper: value.helper } : {}),
		readOnlyMounts: Array.isArray(value.readOnlyMounts)
			? value.readOnlyMounts.filter((entry): entry is string => typeof entry === "string" && path.isAbsolute(entry))
			: [],
		idleStopMinutes: nonNegativeInt(value.idleStopMinutes, DEFAULT_CONFIG.idleStopMinutes, 24 * 60),
	};
}

/** Write `patch` into the settings file, keeping every other key (and creating the file when there is none). */
export async function savePatch(patch: Record<string, unknown>, file: string = configPath()): Promise<void> {
	let existing: Record<string, unknown> = {};
	try {
		const raw: unknown = await Bun.file(file).json();
		if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) existing = raw as Record<string, unknown>;
	} catch (error) {
		if (!isEnoent(error)) throw new Error(`cannot update ${file}: ${String(error)}`);
	}
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, `${JSON.stringify({ ...existing, ...patch }, null, "\t")}\n`);
}

/** Select the base the VM boots; see {@link savePatch}. */
export function saveBase(base: VmBase, file: string = configPath()): Promise<void> {
	return savePatch({ base }, file);
}
