/**
 * Host control-plane adapter for `npi remote`:
 * - Workspace directory listing confined to `allowedRoots`
 * - Saved session listing / rename / delete confined to profile sessions dir
 * - Redacted config schema / list / set / reset (`isCredential` protected)
 * - Model discovery, role roster (`getKnownRoleIds`), approval mode, accounts, usage, MCP toggles
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getAgentDir,
	getConfigRootDir,
	getProjectAgentDir,
	getSessionsDir,
	isRecord,
	normalizeProfileName,
	pathIsWithin,
	VERSION,
} from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { orderedSettings } from "../config/all-settings";
import { getKnownRoleIds } from "../config/model-roles";
import { type AnySetting, lookup } from "../config/registry";
import { Settings } from "../config/settings";
import { listRecentSessions, readSessionInfo } from "../session/session-listing";
import { type ApprovalMode, isApprovalMode } from "../tools/approval";
import { cfgToolsApprovalMode } from "../tools/settings";
import type { RemoteChannelSummary, RemoteControlCommand, RemoteSessionSummaryView } from "./protocol";
function readSettingPath(layer: Record<string, unknown>, segments: readonly string[]): unknown {
	let cur: unknown = layer;
	for (const segment of segments) {
		if (!isRecord(cur)) return undefined;
		cur = cur[segment];
	}
	return cur;
}

function writeSettingPath(layer: Record<string, unknown>, segments: readonly string[], value: unknown): void {
	let cur = layer;
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i]!;
		if (!isRecord(cur[segment])) cur[segment] = {};
		cur = cur[segment] as Record<string, unknown>;
	}
	const leaf = segments[segments.length - 1];
	if (leaf !== undefined) cur[leaf] = value;
}

export interface RemoteAuditEntry {
	timestamp: string;
	deviceId: string;
	action: string;
	detail?: Record<string, unknown>;
}

export interface RemoteControlPlaneOptions {
	hostId: string;
	allowedRoots: string[];
	defaultProfile?: string;
	/** Optional agentDir override for the default profile (primarily for isolated tests). */
	agentDir?: string;
	/** Runner used for isolated `--profile` CLI JSON queries (`models`, `usage`, `account`). */
	runCliJson?: (args: string[], profile?: string) => Promise<unknown>;
	getActiveChannels?: () => RemoteChannelSummary[];
	onChannelApprovalModeSet?: (channelId: string, mode: ApprovalMode) => Promise<ApprovalMode>;
	onAudit?: (entry: RemoteAuditEntry) => void;
}

export interface RemoteConfigSchemaEntry {
	id: string;
	type: AnySetting["type"];
	default: unknown;
	values?: readonly string[];
	ui?: AnySetting["ui"];
}

export interface RemoteConfigListItem {
	id: string;
	type: AnySetting["type"];
	provenance: string;
	redacted?: true;
	value?: unknown;
}

function resolveProfilePaths(
	profile?: string,
	defaultAgentDir?: string,
): { profile?: string; agentDir: string; sessionsDir: string } {
	const normalized = normalizeProfileName(profile);
	if (!normalized) {
		const agentDir = defaultAgentDir ?? getAgentDir();
		return {
			profile: undefined,
			agentDir,
			sessionsDir: defaultAgentDir ? path.join(agentDir, "sessions") : getSessionsDir(),
		};
	}
	const profileRoot = path.join(getConfigRootDir(), "profiles", normalized);
	const agentDir = path.join(profileRoot, "agent");
	return {
		profile: normalized,
		agentDir,
		sessionsDir: path.join(agentDir, "sessions"),
	};
}

/** Settings that grant code execution, widen filesystem/network reach, or weaken approvals; never writable remotely. */
const REMOTE_BLOCKED_CONFIG_EXACT: ReadonlySet<string> = new Set([
	"tools.approval",
	"tools.approvalMode",
	"tools.restrictedFolders",
	"extensions",
	"disabledExtensions",
	"secrets.enabled",
]);
const REMOTE_BLOCKED_CONFIG_PREFIXES: readonly string[] = [
	"bash.",
	"bashInterceptor.",
	"shellMinimizer.",
	"sandbox.",
	"eval.",
	"python.",
	"mcp.",
	"images.urls.",
	"collab.",
	"searxng.",
	"computer.",
	"live.",
	"hooks.",
];
const REMOTE_BLOCKED_CONFIG_LEAF = /(url|endpoint|command|path|interpreter|token|password|proxy|host|director|roots|credential|secret|apikey)/i;
const REMOTE_ACCOUNT_PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isRemoteBlockedConfigKey(key: string): boolean {
	if (REMOTE_BLOCKED_CONFIG_EXACT.has(key)) return true;
	if (REMOTE_BLOCKED_CONFIG_PREFIXES.some(prefix => key.startsWith(prefix))) return true;
	const leaf = key.slice(key.lastIndexOf(".") + 1);
	return REMOTE_BLOCKED_CONFIG_LEAF.test(leaf);
}

function assertAccountProvider(provider: unknown): string {
	if (typeof provider !== "string" || !REMOTE_ACCOUNT_PROVIDER_RE.test(provider)) {
		throw new Error("Invalid account provider");
	}
	return provider;
}

function realpathOrSelf(target: string): string {
	try {
		return fs.realpathSync.native(target);
	} catch {
		return target;
	}
}

/** argv prefix that re-launches this CLI: `bun <cli.ts>` from a source checkout, the binary itself when compiled. */
export function selfLaunchCommand(): string[] {
	const cliScript = path.resolve(import.meta.dir, "..", "cli.ts");
	return process.execPath.endsWith("bun") || process.execPath.endsWith("bun.exe")
		? [process.execPath, cliScript]
		: [process.execPath];
}

async function defaultRunCliJson(args: string[], profile?: string): Promise<unknown> {
	const fullArgs = [...(profile ? ["--profile", profile] : []), ...args];
	const cmd = [...selfLaunchCommand(), ...fullArgs];
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const [stdoutText, stderrText, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`CLI ${fullArgs.join(" ")} exited with ${exitCode}: ${stderrText.trim()}`);
	}
	const trimmed = stdoutText.trim();
	return trimmed ? JSON.parse(trimmed) : null;
}

export class RemoteControlPlane {
	readonly #hostId: string;
	readonly #allowedRoots: string[];
	readonly #defaultProfile?: string;
	readonly #agentDir?: string;
	readonly #runCliJson: (args: string[], profile?: string) => Promise<unknown>;
	readonly #getActiveChannels: () => RemoteChannelSummary[];
	readonly #onChannelApprovalModeSet?: (channelId: string, mode: ApprovalMode) => Promise<ApprovalMode>;
	readonly #onAudit?: (entry: RemoteAuditEntry) => void;

	constructor(options: RemoteControlPlaneOptions) {
		this.#hostId = options.hostId;
		this.#allowedRoots = options.allowedRoots.map(root => path.resolve(root));
		if (this.#allowedRoots.length === 0) {
			throw new Error("RemoteControlPlane requires at least one allowed workspace root");
		}
		this.#defaultProfile = options.defaultProfile;
		this.#agentDir = options.agentDir;
		this.#runCliJson = options.runCliJson ?? defaultRunCliJson;
		this.#getActiveChannels = options.getActiveChannels ?? (() => []);
		this.#onChannelApprovalModeSet = options.onChannelApprovalModeSet;
		this.#onAudit = options.onAudit;
	}

	assertAllowedCwd(targetPath: string): string {
		const resolved = path.resolve(targetPath);
		if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
			throw new Error(`Directory does not exist: ${targetPath}`);
		}
		// Compare real paths so a symlink inside a root cannot point out of it.
		const real = fs.realpathSync.native(resolved);
		const inside = this.#allowedRoots.some(root => pathIsWithin(realpathOrSelf(root), real));
		if (!inside) {
			throw new Error(`Directory is outside allowed remote roots: ${targetPath}`);
		}
		return real;
	}

	async execute(command: RemoteControlCommand, deviceId = "local"): Promise<unknown> {
		switch (command.type) {
			case "host.info":
				return {
					hostId: this.#hostId,
					hostname: os.hostname(),
					platform: process.platform,
					arch: process.arch,
					version: VERSION,
					allowedRoots: this.#allowedRoots,
					activeChannels: this.#getActiveChannels(),
				};

			case "host.fs.roots":
				return { roots: this.#allowedRoots };

			case "host.fs.list": {
				const dir = this.assertAllowedCwd(command.path);
				const entries = await fs.promises.readdir(dir, { withFileTypes: true });
				const directories = entries
					.filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
					.map(entry => ({ name: entry.name, path: path.join(dir, entry.name) }))
					.sort((a, b) => a.name.localeCompare(b.name));
				return { path: dir, directories };
			}

			case "host.sessions.list": {
				const { sessionsDir } = resolveProfilePaths(this.#defaultProfile, this.#agentDir);
				const limit = Math.min(Math.max(command.limit ?? 50, 1), 200);
				const sessions = await listRecentSessions({ limit, sessionsRoot: sessionsDir });
				const filtered = command.cwd
					? sessions.filter(item => path.resolve(item.cwd) === path.resolve(command.cwd!))
					: sessions;
				return {
					sessions: filtered.map((item): RemoteSessionSummaryView => ({
						id: item.id,
						path: item.path,
						cwd: item.cwd,
						title: item.title,
						...(item.firstMessage && item.firstMessage !== "(no messages)"
							? { firstMessage: [...item.firstMessage.toWellFormed()].slice(0, 200).join("") }
							: {}),
						modified: item.modified.toISOString(),
						messageCount: item.messageCount,
						status: item.status,
					})),
				};
			}

			case "host.sessions.delete": {
				const sessionFile = this.#resolveManagedSessionFile(command.sessionPath);
				await fs.promises.rm(sessionFile);
				this.#audit(deviceId, "host.sessions.delete", { sessionFile });
				return { deleted: true, path: sessionFile };
			}

			case "host.sessions.rename": {
				const trimmed = command.name.trim();
				if (!trimmed) throw new Error("Session name cannot be empty");
				const sessionFile = this.#resolveManagedSessionFile(command.sessionPath);
				const info = await readSessionInfo(sessionFile);
				if (!info) throw new Error("Session file is unreadable");
				const titleEntry = {
					type: "session_info",
					id: crypto.randomUUID(),
					parentId: null,
					timestamp: new Date().toISOString(),
					name: trimmed,
				};
				await fs.promises.appendFile(sessionFile, `${JSON.stringify(titleEntry)}\n`, "utf8");
				this.#audit(deviceId, "host.sessions.rename", { sessionFile, name: trimmed });
				return { renamed: true, path: sessionFile, name: trimmed };
			}

			case "host.config.schema": {
				const entries: RemoteConfigSchemaEntry[] = [];
				for (const setting of orderedSettings()) {
					if (setting.isCredential || isRemoteBlockedConfigKey(setting.id)) continue;
					entries.push({
						id: setting.id,
						type: setting.type,
						default: setting.default,
						...(setting.enumValues ? { values: setting.enumValues } : {}),
						...(setting.ui ? { ui: setting.ui } : {}),
					});
				}
				return { settings: entries };
			}

			case "host.config.list": {
				const profile = command.profile ?? this.#defaultProfile;
				const { agentDir } = resolveProfilePaths(profile, this.#agentDir);
				const cwd = command.cwd ? this.assertAllowedCwd(command.cwd) : this.#allowedRoots[0]!;
				const settings = await Settings.init({ cwd, agentDir });
				const items: RemoteConfigListItem[] = [];
				for (const setting of orderedSettings()) {
					if (setting.isCredential) {
						items.push({
							id: setting.id,
							type: setting.type,
							provenance: setting.provenance(settings),
							redacted: true,
						});
						continue;
					}
					if (command.scope === "project") {
						const projectLayer = settings.getProjectSettings() as Record<string, unknown>;
						const val = readSettingPath(projectLayer, setting.segments);
						if (val === undefined) continue;
						items.push({ id: setting.id, type: setting.type, provenance: "project", value: val });
						continue;
					}
					if (command.scope === "global") {
						const globalLayer = settings.getGlobalSettings() as Record<string, unknown>;
						const val = readSettingPath(globalLayer, setting.segments);
						if (val === undefined) continue;
						items.push({ id: setting.id, type: setting.type, provenance: "global", value: val });
						continue;
					}
					items.push({
						id: setting.id,
						type: setting.type,
						provenance: setting.provenance(settings),
						value: setting.get(settings),
					});
				}
				return { profile: profile ?? "default", scope: command.scope ?? "effective", items };
			}

			case "host.config.set": {
				const setting = lookup(command.key);
				if (!setting) throw new Error(`Unknown setting: ${command.key}`);
				if (setting.isCredential || isRemoteBlockedConfigKey(command.key)) {
					throw new Error(`Setting "${command.key}" cannot be modified remotely`);
				}
				setting.assertWritable(command.value);
				const scope = command.scope ?? "global";
				const profile = command.profile ?? this.#defaultProfile;
				const { agentDir } = resolveProfilePaths(profile, this.#agentDir);
				const cwd = command.cwd ? this.assertAllowedCwd(command.cwd) : this.#allowedRoots[0]!;
				if (scope === "project") {
					if (!command.cwd) throw new Error("cwd is required for project-scoped config writes");
					await this.#writeProjectConfigKey(cwd, setting.segments, command.value);
				} else {
					const settings = await Settings.init({ cwd, agentDir });
					setting.set(settings, command.value as never);
					await settings.flush();
				}
				this.#audit(deviceId, "host.config.set", {
					key: command.key,
					scope,
					profile: profile ?? "default",
				});
				return { key: command.key, scope, value: command.value };
			}

			case "host.config.reset": {
				const setting = lookup(command.key);
				if (!setting) throw new Error(`Unknown setting: ${command.key}`);
				if (setting.isCredential || isRemoteBlockedConfigKey(command.key)) {
					throw new Error(`Setting "${command.key}" cannot be modified remotely`);
				}
				const scope = command.scope ?? "global";
				const profile = command.profile ?? this.#defaultProfile;
				const { agentDir } = resolveProfilePaths(profile, this.#agentDir);
				const cwd = command.cwd ? this.assertAllowedCwd(command.cwd) : this.#allowedRoots[0]!;
				if (scope === "project") {
					if (!command.cwd) throw new Error("cwd is required for project-scoped config resets");
					await this.#writeProjectConfigKey(cwd, setting.segments, undefined);
				} else {
					const settings = await Settings.init({ cwd, agentDir });
					setting.unset(settings);
					await settings.flush();
				}
				this.#audit(deviceId, "host.config.reset", {
					key: command.key,
					scope,
					profile: profile ?? "default",
				});
				return { key: command.key, scope, reset: true };
			}

			case "host.models.list": {
				const profile = command.profile ?? this.#defaultProfile;
				const models = await this.#runCliJson(["models", "--json"], profile);
				return { models };
			}

			case "host.models.roles_get": {
				const profile = command.profile ?? this.#defaultProfile;
				const { agentDir } = resolveProfilePaths(profile, this.#agentDir);
				const cwd = command.cwd ? this.assertAllowedCwd(command.cwd) : this.#allowedRoots[0]!;
				const settings = await Settings.init({ cwd, agentDir });
				const knownRoles = getKnownRoleIds(settings);
				const roles: Record<string, { value: string | null; provenance: string }> = {};
				for (const role of knownRoles) {
					roles[role] = {
						value: settings.getModelRole(role) ?? null,
						provenance: settings.getModelRoleProvenance(role),
					};
				}
				return { knownRoles, roles };
			}

			case "host.models.roles_set": {
				const profile = command.profile ?? this.#defaultProfile;
				const { agentDir } = resolveProfilePaths(profile, this.#agentDir);
				const cwd = command.cwd ? this.assertAllowedCwd(command.cwd) : this.#allowedRoots[0]!;
				const settings = await Settings.init({ cwd, agentDir });
				const selector = command.selector?.trim() || undefined;
				if (command.scope === "project") {
					if (!command.cwd) throw new Error("cwd is required for project-scoped role writes");
					if (selector) settings.setProjectModelRole(command.role, selector);
					else settings.clearProjectModelRole(command.role);
				} else {
					settings.setModelRole(command.role, selector);
				}
				await settings.flush();
				this.#audit(deviceId, "host.models.roles_set", {
					role: command.role,
					selector: selector ?? null,
					scope: command.scope ?? "global",
				});
				return {
					role: command.role,
					value: settings.getModelRole(command.role) ?? null,
					provenance: settings.getModelRoleProvenance(command.role),
				};
			}

			case "host.approval_mode.get": {
				if (command.channelId) {
					const channel = this.#getActiveChannels().find(item => item.channelId === command.channelId);
					if (!channel) throw new Error(`Unknown active channel: ${command.channelId}`);
					return { channelId: channel.channelId, mode: channel.approvalMode };
				}
				const profile = command.profile ?? this.#defaultProfile;
				const { agentDir } = resolveProfilePaths(profile, this.#agentDir);
				const cwd = command.cwd ? this.assertAllowedCwd(command.cwd) : this.#allowedRoots[0]!;
				const settings = await Settings.init({ cwd, agentDir });
				const rawMode = cfgToolsApprovalMode.get(settings);
				return {
					mode: isApprovalMode(rawMode) ? rawMode : "yolo",
					provenance: cfgToolsApprovalMode.provenance(settings),
				};
			}

			case "host.approval_mode.set": {
				if (!isApprovalMode(command.mode)) {
					throw new Error(`Invalid approval mode: ${String(command.mode)}`);
				}
				if (command.channelId) {
					if (!this.#onChannelApprovalModeSet) {
						throw new Error("Channel approval mode override is unavailable");
					}
					const mode = await this.#onChannelApprovalModeSet(command.channelId, command.mode);
					this.#audit(deviceId, "host.approval_mode.set", { channelId: command.channelId, mode });
					return { channelId: command.channelId, mode };
				}
				if (command.mode === "yolo") {
					throw new Error("yolo cannot be persisted remotely; select it per channel");
				}
				const profile = command.profile ?? this.#defaultProfile;
				const { agentDir } = resolveProfilePaths(profile, this.#agentDir);
				const cwd = command.cwd ? this.assertAllowedCwd(command.cwd) : this.#allowedRoots[0]!;
				const settings = await Settings.init({ cwd, agentDir });
				cfgToolsApprovalMode.set(settings, command.mode);
				await settings.flush();
				this.#audit(deviceId, "host.approval_mode.set", {
					scope: "global",
					profile: profile ?? "default",
					mode: command.mode,
				});
				return { mode: command.mode };
			}

			case "host.account.list": {
				const profile = command.profile ?? this.#defaultProfile;
				const accounts = await this.#runCliJson(["account", "--json"], profile);
				return { accounts };
			}

			case "host.account.activate": {
				const profile = command.profile ?? this.#defaultProfile;
				if (!Number.isInteger(command.credentialId)) {
					throw new Error("credentialId must be an integer");
				}
				const accounts = await this.#runCliJson(
					["account", "activate", assertAccountProvider(command.provider), String(command.credentialId), "--json"],
					profile,
				);
				this.#audit(deviceId, "host.account.activate", {
					provider: command.provider,
					credentialId: command.credentialId,
				});
				return { accounts };
			}

			case "host.account.rotate": {
				const profile = command.profile ?? this.#defaultProfile;
				const accounts = await this.#runCliJson(["account", "rotate", assertAccountProvider(command.provider), "--json"], profile);
				this.#audit(deviceId, "host.account.rotate", { provider: command.provider });
				return { accounts };
			}

			case "host.usage.get": {
				const profile = command.profile ?? this.#defaultProfile;
				if (command.force) {
					await this.#runCliJson(["usage", "invalidate"], profile);
				}
				const usage = await this.#runCliJson(["usage", "--json", "--redact"], profile);
				return { usage };
			}

			case "host.mcp.list": {
				const { agentDir } = resolveProfilePaths(command.profile ?? this.#defaultProfile, this.#agentDir);
				const mcpPath = path.join(agentDir, "mcp.json");
				if (!fs.existsSync(mcpPath)) {
					return { servers: [] };
				}
				const parsed = JSON.parse(await fs.promises.readFile(mcpPath, "utf8")) as Record<string, unknown>;
				const disabled = new Set(
					Array.isArray(parsed.disabledServers)
						? parsed.disabledServers.filter((v): v is string => typeof v === "string")
						: [],
				);
				const serversRecord = isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
				const servers = Object.entries(serversRecord).map(([name, cfg]) => ({
					name,
					transport: isRecord(cfg) && typeof cfg.type === "string" ? cfg.type : "stdio",
					enabled: !disabled.has(name),
				}));
				return { servers };
			}

			case "host.mcp.toggle": {
				const { agentDir } = resolveProfilePaths(command.profile ?? this.#defaultProfile, this.#agentDir);
				const mcpPath = path.join(agentDir, "mcp.json");
				if (!fs.existsSync(mcpPath)) {
					throw new Error(`No mcp.json found at ${mcpPath}`);
				}
				const parsed = JSON.parse(await fs.promises.readFile(mcpPath, "utf8")) as Record<string, unknown>;
				const serversRecord = isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
				if (!Object.hasOwn(serversRecord, command.name)) {
					throw new Error(`Unknown MCP server: ${command.name}`);
				}
				const disabled = new Set(
					Array.isArray(parsed.disabledServers)
						? parsed.disabledServers.filter((v): v is string => typeof v === "string")
						: [],
				);
				if (command.enabled) disabled.delete(command.name);
				else disabled.add(command.name);
				parsed.disabledServers = Array.from(disabled).sort();
				await Bun.write(mcpPath, `${JSON.stringify(parsed, null, 2)}\n`);
				this.#audit(deviceId, "host.mcp.toggle", { name: command.name, enabled: command.enabled });
				return { name: command.name, enabled: command.enabled };
			}

			case "host.sessions.open":
			case "host.sessions.close":
			case "host.sessions.sync":
				throw new Error(`Channel lifecycle command ${command.type} must be handled by RemoteHostDaemon`);
		}
	}

	/** Confines a client-supplied session file to the profile's sessions directory (symlinks resolved). */
	assertManagedSessionPath(sessionPath: string, profile?: string): string {
		const { sessionsDir } = resolveProfilePaths(profile ?? this.#defaultProfile, this.#agentDir);
		const resolved = path.resolve(sessionPath);
		if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
			throw new Error("Session file does not exist");
		}
		const real = fs.realpathSync.native(resolved);
		if (!real.endsWith(".jsonl") || !pathIsWithin(realpathOrSelf(sessionsDir), real)) {
			throw new Error("Session path is outside managed sessions directory");
		}
		return real;
	}

	#resolveManagedSessionFile(sessionPath: string): string {
		return this.assertManagedSessionPath(sessionPath);
	}

	async #writeProjectConfigKey(cwd: string, segments: readonly string[], value: unknown): Promise<void> {
		const projectDir = getProjectAgentDir(cwd);
		const configPath = path.join(projectDir, "config.yml");
		let current: Record<string, unknown> = {};
		if (fs.existsSync(configPath)) {
			const text = await fs.promises.readFile(configPath, "utf8");
			const parsed = YAML.parse(text);
			if (isRecord(parsed)) current = parsed;
		}
		if (value === undefined) {
			let node: Record<string, unknown> = current;
			for (let i = 0; i < segments.length - 1; i++) {
				const child = node[segments[i]!];
				if (!isRecord(child)) return;
				node = child;
			}
			delete node[segments[segments.length - 1]!];
		} else {
			writeSettingPath(current, segments, value);
		}
		await fs.promises.mkdir(projectDir, { recursive: true });
		await Bun.write(configPath, YAML.stringify(current, null, 2));
	}

	#audit(deviceId: string, action: string, detail?: Record<string, unknown>): void {
		this.#onAudit?.({
			timestamp: new Date().toISOString(),
			deviceId,
			action,
			detail,
		});
	}
}
