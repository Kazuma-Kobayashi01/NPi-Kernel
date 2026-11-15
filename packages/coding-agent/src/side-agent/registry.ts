/**
 * The ACP agent registry (https://agentclientprotocol.com/get-started/registry): which agents exist and
 * how to start each one on this machine.
 *
 * A binary distribution is downloaded once per version into `getSideAgentsDir()/<id>/<version>`, and only
 * when the registry pins its SHA-256; npx / uvx distributions run through the user's own `npx` / `uvx`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which, getSideAgentsDir, isEnoent, logger, pathIsWithin } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import type { SideAgentLaunch } from "./connection";

export const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
/** A fresh registry is re-read at most this often; an older copy still serves when offline. */
const REGISTRY_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export interface RegistryBinaryTarget {
	archive: string;
	cmd: string;
	args?: string[];
	env?: Record<string, string>;
	sha256?: string;
}

export interface RegistryPackage {
	package: string;
	args?: string[];
	env?: Record<string, string>;
}

export interface RegistryAgent {
	id: string;
	name: string;
	version: string;
	description?: string;
	repository?: string;
	website?: string;
	authors?: string[];
	license?: string;
	distribution: {
		binary?: Record<string, RegistryBinaryTarget>;
		npx?: RegistryPackage;
		uvx?: RegistryPackage;
	};
}

interface RegistryCache {
	fetchedAt: number;
	agents: RegistryAgent[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keeps the entries NPi can start; anything malformed is dropped rather than trusted. */
export function parseRegistry(json: unknown): RegistryAgent[] {
	const agents = isRecord(json) && Array.isArray(json.agents) ? json.agents : [];
	return agents.filter((agent): agent is RegistryAgent => {
		if (!isRecord(agent) || !isRecord(agent.distribution)) return false;
		if (typeof agent.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(agent.id)) return false;
		if (typeof agent.name !== "string" || typeof agent.version !== "string") return false;
		// the version names an install folder
		return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(agent.version);
	});
}

/** Registry platform key for this machine, e.g. `darwin-aarch64`. */
export function registryPlatform(platform: string = process.platform, arch: string = process.arch): string {
	const os = platform === "win32" ? "windows" : platform;
	const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch;
	return `${os}-${cpu}`;
}

function cachePath(): string {
	return path.join(getSideAgentsDir(), "registry.json");
}

/** The registry, from a cache younger than an hour or the network; a stale cache when the fetch fails. */
export async function loadRegistry(options: { refresh?: boolean } = {}): Promise<RegistryAgent[]> {
	let cached: RegistryCache | undefined;
	try {
		cached = (await Bun.file(cachePath()).json()) as RegistryCache;
	} catch (error) {
		if (!isEnoent(error)) logger.warn("Side agent registry cache unreadable", { error: String(error) });
	}
	if (cached && !options.refresh && Date.now() - cached.fetchedAt < REGISTRY_TTL_MS) return parseRegistry(cached);
	try {
		const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const agents = parseRegistry(await response.json());
		await Bun.write(cachePath(), JSON.stringify({ fetchedAt: Date.now(), agents } satisfies RegistryCache));
		return agents;
	} catch (error) {
		if (cached) {
			logger.warn("Side agent registry fetch failed; using the cached copy", { error: String(error) });
			return parseRegistry(cached);
		}
		throw new Error(`Couldn't load the ACP agent registry: ${error instanceof Error ? error.message : error}`);
	}
}

type LaunchPlan =
	| { kind: "binary"; target: RegistryBinaryTarget }
	| { kind: "npx" | "uvx"; command: string; pkg: RegistryPackage };

function planLaunch(agent: RegistryAgent, platform: string): LaunchPlan | null {
	const binary = agent.distribution.binary?.[platform];
	if (binary?.sha256) return { kind: "binary", target: binary };
	const npx = agent.distribution.npx;
	const npxCommand = npx ? $which("npx") : null;
	if (npx && npxCommand) return { kind: "npx", command: npxCommand, pkg: npx };
	const uvx = agent.distribution.uvx;
	const uvxCommand = uvx ? $which("uvx") : null;
	if (uvx && uvxCommand) return { kind: "uvx", command: uvxCommand, pkg: uvx };
	return null;
}

/** How an entry would start here, without installing anything. `null`: no distribution works on this machine. */
export function launchKind(agent: RegistryAgent, platform = registryPlatform()): "binary" | "npx" | "uvx" | null {
	return planLaunch(agent, platform)?.kind ?? null;
}

/**
 * The command that starts `agent`, downloading and verifying its binary first when needed.
 * Throws with a reason the user can act on when nothing fits (no pinned binary, no npx/uvx).
 */
export async function resolveLaunch(agent: RegistryAgent, platform = registryPlatform()): Promise<SideAgentLaunch> {
	const plan = planLaunch(agent, platform);
	if (plan?.kind === "binary") {
		const dir = await installBinary(agent, plan.target);
		const command = path.resolve(dir, plan.target.cmd);
		if (!pathIsWithin(dir, command)) throw new Error(`${agent.name}: command escapes its install folder`);
		return { command, args: plan.target.args ?? [], env: plan.target.env };
	}
	if (plan) {
		const args = plan.kind === "npx" ? ["-y", plan.pkg.package] : [plan.pkg.package];
		return { command: plan.command, args: [...args, ...(plan.pkg.args ?? [])], env: plan.pkg.env };
	}
	const reasons: string[] = [];
	if (agent.distribution.binary?.[platform]) reasons.push("its download has no pinned SHA-256");
	else if (agent.distribution.binary) reasons.push(`no build for ${platform}`);
	if (agent.distribution.npx) reasons.push("npx is not installed");
	if (agent.distribution.uvx) reasons.push("uvx is not installed");
	throw new Error(`Can't start ${agent.name}: ${reasons.join("; ") || "no supported distribution"}`);
}

/** Installs a binary distribution once per version; returns its folder. */
async function installBinary(agent: RegistryAgent, target: RegistryBinaryTarget): Promise<string> {
	const root = getSideAgentsDir();
	const dir = path.join(root, agent.id, agent.version);
	try {
		await fs.access(path.join(dir, ".installed"));
		return dir;
	} catch {}
	const staging = path.join(root, `.staging-${agent.id}-${Date.now()}`);
	const archive = `${staging}.download`;
	try {
		const response = await fetch(target.archive, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
		if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
		await Bun.write(archive, response);
		const hasher = new Bun.CryptoHasher("sha256");
		for await (const chunk of Bun.file(archive).stream()) hasher.update(chunk);
		const digest = hasher.digest("hex");
		if (digest !== target.sha256?.toLowerCase()) {
			throw new Error(`checksum mismatch for ${target.archive} (got ${digest})`);
		}
		await fs.mkdir(staging, { recursive: true });
		const url = new URL(target.archive);
		if (url.pathname.endsWith(".zip")) await $`unzip -q ${archive} -d ${staging}`.quiet();
		else if (/\.(tar\.gz|tgz)$/.test(url.pathname)) await $`tar -xzf ${archive} -C ${staging}`.quiet();
		else throw new Error(`unsupported archive type: ${url.pathname}`);
		await Bun.write(path.join(staging, ".installed"), `${target.archive}\n${digest}\n`);
		await fs.rm(dir, { recursive: true, force: true });
		await fs.mkdir(path.dirname(dir), { recursive: true });
		await fs.rename(staging, dir);
		return dir;
	} catch (error) {
		await fs.rm(staging, { recursive: true, force: true });
		throw new Error(
			`Couldn't install ${agent.name} ${agent.version}: ${error instanceof Error ? error.message : error}`,
		);
	} finally {
		await fs.rm(archive, { force: true });
	}
}

/**
 * Agents whose own CLI ships ACP and updates itself faster than the registry build: when the CLI is on
 * PATH it is started instead (`agy acp` tracks Antigravity CLI releases; the registry pins an older one).
 */
const LOCAL_CLIS: Record<string, { name: string; bin: string; args: string[] }> = {
	"antigravity-acp": { name: "Google Antigravity", bin: "agy", args: ["acp"] },
};

/** Resolves a registry id to a display name and launch command, preferring an installed CLI. */
export async function resolveSideAgent(id: string): Promise<{ name: string; launch: SideAgentLaunch }> {
	const local = LOCAL_CLIS[id];
	const bin = local ? $which(local.bin) : null;
	if (local && bin) return { name: local.name, launch: { command: bin, args: local.args } };
	const agent = (await loadRegistry()).find(entry => entry.id === id);
	if (!agent) throw new Error(`No agent "${id}" in the ACP registry`);
	return { name: agent.name, launch: await resolveLaunch(agent) };
}
