import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { hashAuthGatewayToken, parseAuthGatewayClients } from "@oh-my-pi/pi-ai/auth-gateway";
import { isEnoent, isRecord } from "@oh-my-pi/pi-utils";
import { resolveCliEntryCmd } from "../subprocess/worker-client";
import type { GatewayStore } from "./store";
import { BOT_ID_RE, GatewayApiError, type GatewayBotModelConfig, type GatewayConfig, RUN_ID_RE } from "./types";

const OWNER_LABEL = "io.npi.gateway.instance";
const BOT_LABEL = "io.npi.gateway.bot";
const SPEC_LABEL = "io.npi.gateway.spec";
const FIREWALL_LABEL = "io.npi.gateway.firewall";
export const GATEWAY_WORKER_UID = 1000;
export const GATEWAY_WORKER_GID = 1000;

// Match the deployed Hermes Bot budgets; the aggregate bots.slice forbids swap.
const SANDBOX_DOCKER_ARGS = [
	"--security-opt",
	"no-new-privileges:true",
	"--cap-drop",
	"ALL",
	"--read-only",
	"--memory",
	"1g",
	"--memory-swap",
	"2g",
	"--cpus",
	"1",
	"--pids-limit",
	"2048",
	"--tmpfs",
	"/tmp:rw,nosuid,nodev,size=512m,mode=1777",
	"--tmpfs",
	"/run:rw,noexec,nosuid,nodev,size=64m",
	"--tmpfs",
	"/var/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777",
];

const RUN_WORKER = `
import json, os, subprocess, sys
record = sys.argv[1]
child = subprocess.Popen(sys.argv[2:], start_new_session=True)
try:
    with open('/proc/%s/stat' % child.pid) as stream:
        started = stream.read().rsplit(')', 1)[1].split()[19]
    fd = os.open(record, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump({'pid': child.pid, 'started': started}, stream)
    result = child.wait()
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    try:
        os.unlink(record)
    except FileNotFoundError:
        pass
sys.exit(result if result >= 0 else 128 - result)
`;

const KILL_WORKER = `
import json, os, signal, sys
record = sys.argv[1]
try:
    fd = os.open(record, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        run = json.load(stream)
    root = int(run['pid'])
    with open('/proc/%s/stat' % root) as stream:
        started = stream.read().rsplit(')', 1)[1].split()[19]
    if root <= 1 or started != run['started']:
        sys.exit(0)
    os.kill(root, signal.SIGSTOP)
    victims = {root}
    while True:
        found = set()
        for item in os.listdir('/proc'):
            if not item.isdigit() or int(item) in victims:
                continue
            try:
                with open('/proc/%s/stat' % item) as stream:
                    parent = int(stream.read().rsplit(')', 1)[1].split()[1])
                if parent in victims:
                    os.kill(int(item), signal.SIGSTOP)
                    found.add(int(item))
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                pass
        if not found:
            break
        victims.update(found)
    for pid in victims - {root}:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    os.kill(root, signal.SIGKILL)
except (FileNotFoundError, ProcessLookupError):
    pass
`;

interface ContainerInspection {
	Id: string;
	Config: { Labels?: Record<string, string>; User: string };
	State: { Running: boolean };
}

export interface GatewayWorkerCommand {
	cmd: string[];
	cwd?: string;
	env: Record<string, string>;
}

export interface GatewayShellTarget {
	application: string;
	args: string[];
	cwd?: string;
	env?: Record<string, string>;
}

function unavailable(message: string): GatewayApiError {
	return new GatewayApiError(503, "sandbox_unavailable", message);
}

/** Only trusted provisioner metadata is converted to models.yml; no executable config values. */
function cleanModels(value: unknown): GatewayBotModelConfig {
	if (!isRecord(value) || typeof value.baseUrl !== "string" || typeof value.token !== "string") {
		throw unavailable("per-bot scoped model configuration is missing or invalid");
	}
	let endpoint: URL;
	try {
		endpoint = new URL(value.baseUrl);
	} catch {
		throw unavailable("model proxy URL is invalid");
	}
	if (
		!["http:", "https:"].includes(endpoint.protocol) ||
		endpoint.username ||
		endpoint.password ||
		endpoint.hash ||
		endpoint.search ||
		endpoint.pathname !== "/"
	) {
		throw unavailable("model proxy baseUrl must be an HTTP(S) origin without a /v1 suffix or embedded credentials");
	}
	if (!/^[A-Za-z0-9_-]{32,}$/.test(value.token) || !Array.isArray(value.providers) || value.providers.length === 0) {
		throw unavailable("model proxy requires a scoped token and explicit model grants");
	}
	const providers: GatewayBotModelConfig["providers"] = [];
	const seen = new Set<string>();
	for (const entry of value.providers) {
		if (
			!isRecord(entry) ||
			typeof entry.id !== "string" ||
			!/^[a-z][a-z0-9-]{0,59}$/.test(entry.id) ||
			seen.has(entry.id)
		) {
			throw unavailable("invalid scoped model provider");
		}
		seen.add(entry.id);
		if (
			entry.api !== "openai-responses" &&
			entry.api !== "openai-completions" &&
			entry.api !== "anthropic-messages"
		) {
			throw unavailable("unsupported model proxy API");
		}
		if (!Array.isArray(entry.models) || entry.models.length === 0) throw unavailable("model grants cannot be empty");
		const models: GatewayBotModelConfig["providers"][number]["models"] = [];
		for (const model of entry.models) {
			if (
				!isRecord(model) ||
				typeof model.id !== "string" ||
				!model.id ||
				model.id.includes("*") ||
				/[\s\u0000-\u001f]/.test(model.id)
			) {
				throw unavailable("invalid scoped model id");
			}
			const cleaned: GatewayBotModelConfig["providers"][number]["models"][number] = { id: model.id };
			if (typeof model.name === "string") cleaned.name = model.name;
			if (typeof model.reasoning === "boolean") cleaned.reasoning = model.reasoning;
			if (Array.isArray(model.input) && model.input.every(v => v === "text" || v === "image"))
				cleaned.input = model.input;
			for (const key of ["contextWindow", "maxTokens"] as const) {
				if (model[key] !== undefined) {
					if (typeof model[key] !== "number" || !Number.isSafeInteger(model[key]) || model[key] <= 0)
						throw unavailable("invalid scoped model limits");
					cleaned[key] = model[key];
				}
			}
			models.push(cleaned);
		}
		providers.push({ id: entry.id, api: entry.api, models });
	}
	return { baseUrl: endpoint.href.replace(/\/$/, ""), token: value.token, providers };
}

/** Owns only instance-labelled containers; never probes Docker and then falls back to host execution. */
export class GatewaySandbox {
	readonly #cfg: GatewayConfig;
	readonly #store: GatewayStore;
	readonly #instance: string;
	readonly #pending = new Map<string, Promise<void>>();
	readonly #ready = new Map<string, string>();
	readonly #generation = new Map<string, number>();

	constructor(cfg: GatewayConfig, store: GatewayStore) {
		this.#cfg = cfg;
		this.#store = store;
		this.#instance = crypto.createHash("sha256").update(path.resolve(cfg.dataDir)).digest("hex");
	}

	#usesDocker(botId: string): boolean {
		return (
			this.#cfg.sandboxBackend === "docker" &&
			!(!BOT_ID_RE.test(botId) && this.#cfg.localProfiles.includes(botId) && this.#cfg.adminLocalTools)
		);
	}

	#name(botId: string): string {
		return `npi-${this.#instance.slice(0, 16)}-${botId}`;
	}

	#state(botId: string): string {
		return path.join(this.#store.botDir(botId), "state");
	}

	#hostEnv(): Record<string, string> {
		return { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" };
	}

	#docker(args: string[], optional = false): string | null {
		try {
			const result = Bun.spawnSync(["docker", "--config", path.join(this.#cfg.dataDir, "docker-client"), ...args], {
				env: this.#hostEnv(),
				stdout: "pipe",
				stderr: "pipe",
				timeout: 20_000,
			});
			if (result.exitCode === 0) return result.stdout.toString().trim();
		} catch {
			// Executable or daemon unavailable; never use a host worker instead.
		}
		if (optional) return null;
		throw unavailable("Docker operation failed; check the worker image, bridge, and daemon");
	}

	#inspect(botId: string): ContainerInspection | null {
		const text = this.#docker(["container", "inspect", this.#name(botId)], true);
		if (text === null) {
			this.#docker(["info", "--format", "{{.ServerVersion}}"]);
			return null;
		}
		let container: ContainerInspection;
		try {
			[container] = JSON.parse(text) as ContainerInspection[];
		} catch {
			throw unavailable("invalid Docker container inspection");
		}
		if (container?.Config?.Labels?.[OWNER_LABEL] !== this.#instance || container.Config.Labels[BOT_LABEL] !== botId) {
			throw unavailable("refusing to access a container not owned by this gateway and bot");
		}
		return container;
	}

	#updateClient(botId: string, config?: GatewayBotModelConfig): void {
		const clientsFile = this.#cfg.sandboxClientsFile;
		if (!clientsFile) {
			if (config) return; // A trusted external provisioner can manage its own authorization file.
			return;
		}
		const lock = `${clientsFile}.lock`;
		let fd: number;
		try {
			fs.mkdirSync(path.dirname(clientsFile), { recursive: true, mode: 0o700 });
			fd = fs.openSync(lock, "wx", 0o600);
		} catch {
			throw unavailable("cannot lock the scoped model client registry");
		}
		const temp = `${clientsFile}.${crypto.randomBytes(8).toString("hex")}.tmp`;
		try {
			let text = "{}";
			try {
				text = fs.readFileSync(clientsFile, "utf8");
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
			parseAuthGatewayClients(text);
			const clients = JSON.parse(text) as Record<string, unknown>;
			const name = `${this.#instance}:${botId}`;
			if (config) {
				clients[name] = {
					tokenSha256: hashAuthGatewayToken(config.token),
					models: config.providers.flatMap(provider => provider.models.map(model => `${provider.id}/${model.id}`)),
				};
			} else delete clients[name];
			const updated = JSON.stringify(clients, null, 2);
			parseAuthGatewayClients(updated);
			fs.writeFileSync(temp, updated, { mode: 0o600 });
			fs.renameSync(temp, clientsFile);
		} catch {
			throw unavailable("cannot update the scoped model client registry");
		} finally {
			fs.closeSync(fd);
			fs.rmSync(temp, { force: true });
			fs.rmSync(lock, { force: true });
		}
	}

	async #models(botId: string): Promise<GatewayBotModelConfig> {
		if (this.#cfg.provisionBotModels) {
			const config = cleanModels(await this.#cfg.provisionBotModels(botId));
			this.#updateClient(botId, config);
			return config;
		}
		const dir = this.#cfg.sandboxModelConfigDir;
		if (!dir) throw unavailable("trusted per-bot model provisioner is not configured");
		const file = path.join(dir, `${botId}.json`);
		let value: unknown;
		try {
			value = await Bun.file(file).json();
		} catch (err) {
			if (!isEnoent(err)) throw unavailable("cannot read scoped model configuration");
			if (!this.#cfg.sandboxClientsFile)
				throw unavailable("automatic model provisioning requires a scoped clients registry");
			try {
				const template: unknown = await Bun.file(path.join(dir, "template.json")).json();
				if (!isRecord(template) || Object.hasOwn(template, "token"))
					throw unavailable("model template must not contain a shared token");
				value = { ...template, token: crypto.randomBytes(32).toString("base64url") };
				const validated = cleanModels(value);
				fs.writeFileSync(file, JSON.stringify(validated, null, 2), { mode: 0o600, flag: "wx" });
			} catch (error) {
				if (error instanceof GatewayApiError) throw error;
				throw unavailable("cannot provision a scoped model configuration from template.json");
			}
		}
		const config = cleanModels(value);
		this.#updateClient(botId, config);
		return config;
	}

	#quota(botId: string): void {
		const root = this.#cfg.sandboxQuotaRoot;
		const botDir = path.resolve(this.#store.botDir(botId));
		if (!root || !botDir.startsWith(`${path.resolve(root)}${path.sep}`) || /[\s"\\,]/.test(botDir)) {
			throw unavailable("Docker bots require an XFS project-quota root containing their storage");
		}
		if (this.#cfg.sandboxQuotaCommand) {
			if (
				!path.isAbsolute(this.#cfg.sandboxQuotaCommand) ||
				(!BOT_ID_RE.test(botId) && !this.#cfg.localProfiles.includes(botId))
			) {
				throw unavailable("quota helper requires an absolute trusted executable and a registered bot id");
			}
			try {
				const result = Bun.spawnSync([this.#cfg.sandboxQuotaCommand, botId], {
					env: this.#hostEnv(),
					stdout: "pipe",
					stderr: "pipe",
					timeout: 20_000,
				});
				if (result.exitCode !== 0) throw unavailable("trusted bot quota helper rejected storage provisioning");
			} catch {
				throw unavailable("trusted bot quota helper is unavailable");
			}
			return;
		}
		const quotaId =
			(Number.parseInt(crypto.createHash("sha256").update(botId).digest("hex").slice(0, 8), 16) >>> 1) + 1;
		const registryFile = path.join(this.#cfg.dataDir, "quota-projects.json");
		let registry: Record<string, string> = {};
		try {
			registry = JSON.parse(fs.readFileSync(registryFile, "utf8")) as Record<string, string>;
		} catch (err) {
			if (!isEnoent(err)) throw unavailable("cannot read quota project registry");
		}
		if (registry[quotaId] && registry[quotaId] !== botId) throw unavailable("quota project id collision");
		for (const command of [
			"state -p",
			`project -s -p ${botDir} ${quotaId}`,
			`limit -p bhard=5g ihard=100000 ${quotaId}`,
		]) {
			try {
				const result = Bun.spawnSync(["xfs_quota", "-x", "-c", command, path.resolve(root)], {
					env: this.#hostEnv(),
					stdout: "pipe",
					stderr: "pipe",
					timeout: 20_000,
				});
				if (result.exitCode !== 0 || result.stderr.toString().trim())
					throw unavailable("cannot enforce the bot storage quota");
				if (command === "state -p" && !/Enforcement:\s+ON/i.test(result.stdout.toString())) {
					throw unavailable("XFS project quota enforcement is not enabled");
				}
			} catch (error) {
				if (error instanceof GatewayApiError) throw error;
				throw unavailable("XFS project quota tooling is unavailable");
			}
		}
		registry[quotaId] = botId;
		fs.writeFileSync(registryFile, JSON.stringify(registry), { mode: 0o600 });
	}

	#prepare(botId: string, docker: boolean): void {
		const roots = [
			this.#store.workspaceDir(botId),
			this.#store.sessionsDir(botId),
			this.#store.attachmentsDir(botId),
			this.#state(botId),
		];
		for (const root of roots) {
			fs.mkdirSync(root, { recursive: true, mode: 0o700 });
			const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
			try {
				if (docker) fs.fchownSync(fd, GATEWAY_WORKER_UID, GATEWAY_WORKER_GID);
			} finally {
				fs.closeSync(fd);
			}
		}
		for (const name of ["home", "tmp"]) {
			const folder = path.join(this.#state(botId), name);
			fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
			const fd = fs.openSync(folder, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
			try {
				if (docker) fs.fchownSync(fd, GATEWAY_WORKER_UID, GATEWAY_WORKER_GID);
			} finally {
				fs.closeSync(fd);
			}
		}
		if (!docker && this.#cfg.sandboxBackend === "host-unsafe") {
			const source = path.join(this.#cfg.agentDir, "models.yml");
			const destination = path.join(this.#state(botId), "models.yml");
			if (fs.existsSync(source) && !fs.existsSync(destination)) {
				fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
			}
		}
		if (docker) this.#quota(botId);
	}

	ensure(botId: string): Promise<void> {
		const current = this.#pending.get(botId);
		if (current) return current;
		const pending = this.#ensure(botId)
			.catch(error => {
				if (error instanceof GatewayApiError) throw error;
				throw unavailable("cannot prepare the bot's isolated filesystem or model configuration");
			})
			.finally(() => this.#pending.delete(botId));
		this.#pending.set(botId, pending);
		return pending;
	}

	async #ensure(botId: string): Promise<void> {
		this.#store.ensureAppBot(botId);
		const generation = this.#generation.get(botId) ?? 0;
		const docker = this.#usesDocker(botId);
		this.#prepare(botId, docker);
		if (!docker) return;
		const network = this.#cfg.dockerNetwork ?? "npi-bots";
		let networkInfo: {
			Driver: string;
			EnableIPv6: boolean;
			Labels?: Record<string, string>;
			Options?: Record<string, string>;
		};
		try {
			[networkInfo] = JSON.parse(this.#docker(["network", "inspect", network]) ?? "[]");
		} catch {
			throw unavailable("the externally firewalled Docker bridge is unavailable");
		}
		if (
			networkInfo?.Driver !== "bridge" ||
			networkInfo.EnableIPv6 ||
			networkInfo.Labels?.[FIREWALL_LABEL] !== "managed" ||
			networkInfo.Options?.["com.docker.network.bridge.enable_icc"] !== "false"
		) {
			throw unavailable(
				"Docker bridge requires managed firewall, disabled inter-container communication, and no IPv6",
			);
		}
		const image = this.#cfg.dockerImage || "npi-worker:withbot";
		const imageId = this.#docker(["image", "inspect", "--format", "{{.Id}}", image]);
		const models = await this.#models(botId);
		try {
			this.#store.ensureAppBot(botId);
			if ((this.#generation.get(botId) ?? 0) !== generation) {
				throw new GatewayApiError(409, "bot_stopped", "bot was stopped during sandbox preparation");
			}
		} catch (error) {
			this.#updateClient(botId);
			throw error;
		}
		const modelsFile = path.join(this.#cfg.dataDir, "sandbox-models", `${botId}.yml`);
		const guestModelsFile = path.join(this.#state(botId), "models.yml");
		const providers: Record<string, unknown> = Object.create(null);
		for (const provider of models.providers) {
			providers[provider.id] = {
				baseUrl: models.baseUrl,
				apiKey: models.token,
				api: provider.api,
				transport: "pi-native",
				models: provider.models,
			};
		}
		const configText = JSON.stringify({ providers }, null, 2);
		fs.mkdirSync(path.dirname(modelsFile), { recursive: true, mode: 0o700 });
		fs.writeFileSync(modelsFile, configText, { mode: 0o444 });
		fs.chmodSync(modelsFile, 0o444);
		const user = `${GATEWAY_WORKER_UID}:${GATEWAY_WORKER_GID}`;
		const mount = (source: string, target = source, readonly = false): string => {
			if (source.includes(",") || target.includes(","))
				throw unavailable("Docker bind mount paths cannot contain commas");
			return `type=bind,src=${source},dst=${target}${readonly ? ",readonly" : ""}`;
		};
		const mounts = [
			mount(this.#store.workspaceDir(botId)),
			mount(this.#store.sessionsDir(botId)),
			mount(this.#store.attachmentsDir(botId), this.#store.attachmentsDir(botId), true),
			mount(this.#state(botId)),
			mount(this.#store.workspaceDir(botId), "/workspace"),
			mount(this.#store.attachmentsDir(botId), this.#cfg.sandboxAttachmentsDir, true),
			mount(modelsFile, guestModelsFile, true),
		];
		const spec = crypto
			.createHash("sha256")
			.update(JSON.stringify({ imageId, network, user, mounts, configText, dockerArgs: SANDBOX_DOCKER_ARGS }))
			.digest("hex");
		let container = this.#inspect(botId);
		if (container && container.Config.Labels?.[SPEC_LABEL] !== spec) {
			this.#docker(["rm", "-f", container.Id]);
			container = null;
		}
		if (!container) {
			this.#docker([
				"run",
				"--detach",
				"--name",
				this.#name(botId),
				"--label",
				`${OWNER_LABEL}=${this.#instance}`,
				"--label",
				`${BOT_LABEL}=${botId}`,
				"--label",
				`${SPEC_LABEL}=${spec}`,
				"--user",
				user,
				...SANDBOX_DOCKER_ARGS,
				"--network",
				network,
				"--workdir",
				this.#store.workspaceDir(botId),
				...mounts.flatMap(value => ["--mount", value]),
				"--entrypoint",
				"/bin/sleep",
				imageId ?? image,
				"infinity",
			]);
		} else if (!container.State.Running) this.#docker(["start", container.Id]);
		this.#docker([
			"exec",
			"--user",
			user,
			this.#name(botId),
			"/bin/sh",
			"-c",
			"test -x /usr/local/bin/npi && test -x /usr/bin/env",
		]);
		// The auth gateway reloads --clients periodically. Do not start a worker with an unrecognized token.
		const readyKey = hashAuthGatewayToken(models.token);
		if (this.#ready.get(botId) !== readyKey && this.#cfg.sandboxClientsFile) {
			let admitted = false;
			for (let attempt = 0; attempt < 13; attempt++) {
				try {
					const response = await fetch(`${models.baseUrl}/v1/models`, {
						headers: { Authorization: `Bearer ${models.token}` },
						signal: AbortSignal.timeout(2_000),
						redirect: "error",
					});
					await response.body?.cancel();
					if (response.ok) {
						admitted = true;
						break;
					}
				} catch {
					/* Retry until the configured authorization reload has completed. */
				}
				await Bun.sleep(1_000);
			}
			if (!admitted) throw unavailable("scoped model client has not been admitted by the trusted proxy");
		}
		this.#store.ensureAppBot(botId);
		if ((this.#generation.get(botId) ?? 0) !== generation) {
			throw new GatewayApiError(409, "bot_stopped", "bot was stopped during sandbox preparation");
		}
		this.#ready.set(botId, readyKey);
	}

	workerCommand(botId: string, args: readonly string[], runId?: string): GatewayWorkerCommand {
		const state = this.#state(botId);
		const env = {
			HOME: path.join(state, "home"),
			PI_CODING_AGENT_DIR: state,
			PATH: "/usr/local/bin:/usr/bin:/bin",
			LANG: "C.UTF-8",
			TERM: "xterm-256color",
			PI_NO_TITLE: "1",
			PI_NO_PTY: "1",
			NO_COLOR: "1",
			TMPDIR: this.#usesDocker(botId) ? "/tmp" : path.join(state, "tmp"),
		};
		if (!this.#usesDocker(botId)) {
			return {
				cmd: [...(this.#cfg.cliCommand ?? resolveCliEntryCmd()), ...args],
				cwd: this.#store.workspaceDir(botId),
				env: { ...env, PATH: this.#hostEnv().PATH },
			};
		}
		const container = this.#inspect(botId);
		if (!container?.State.Running || !this.#ready.has(botId))
			throw unavailable("bot sandbox must be prepared before starting a worker");
		if (runId !== undefined && !RUN_ID_RE.test(runId))
			throw new GatewayApiError(400, "bad_request", "invalid worker run id");
		const worker = runId
			? ["/usr/bin/python3", "-c", RUN_WORKER, `/tmp/npi-run-${runId}.pid`, "/usr/local/bin/npi", ...args]
			: ["/usr/local/bin/npi", ...args];
		return {
			cmd: [
				"docker",
				"--config",
				path.join(this.#cfg.dataDir, "docker-client"),
				"exec",
				"-i",
				"--user",
				container.Config.User,
				"--workdir",
				this.#store.workspaceDir(botId),
				container.Id,
				"/usr/bin/env",
				"-i",
				...Object.entries(env).map(([key, value]) => `${key}=${value}`),
				...worker,
			],
			env: this.#hostEnv(),
		};
	}

	killWorker(botId: string, runId: string): void {
		if (!RUN_ID_RE.test(runId)) throw new GatewayApiError(400, "bad_request", "invalid worker run id");
		if (!this.#usesDocker(botId)) return;
		const container = this.#inspect(botId);
		if (!container?.State.Running) return;
		this.#docker([
			"exec",
			"--user",
			container.Config.User,
			container.Id,
			"/usr/bin/python3",
			"-c",
			KILL_WORKER,
			`/tmp/npi-run-${runId}.pid`,
		]);
	}

	status(botId: string): "running" | "idle" | "unknown" {
		if (!this.#usesDocker(botId)) return "idle";
		try {
			return this.#inspect(botId)?.State.Running ? "running" : "idle";
		} catch {
			return "unknown";
		}
	}

	copyOut(botId: string, containerPath: string, destination: string): boolean {
		if (!this.#usesDocker(botId) || !containerPath.startsWith("/") || containerPath.includes("\0")) return false;
		const destinationRoot = fs.realpathSync(this.#store.mediaRescueDir(botId));
		if (!path.resolve(destination).startsWith(`${destinationRoot}${path.sep}`)) return false;
		try {
			const container = this.#inspect(botId);
			if (!container?.State.Running) return false;
			// Read as the unprivileged worker, never docker cp (which could follow a privileged path).
			const result = Bun.spawnSync(
				[
					"docker",
					"--config",
					path.join(this.#cfg.dataDir, "docker-client"),
					"exec",
					"--user",
					container.Config.User,
					container.Id,
					"/bin/sh",
					"-c",
					'test -f "$1" && test "$(wc -c < "$1")" -le 26214400 && exec cat -- "$1"',
					"sh",
					containerPath,
				],
				{ env: this.#hostEnv(), stdout: "pipe", stderr: "pipe", timeout: 20_000, maxBuffer: 26 * 1024 * 1024 },
			);
			if (result.exitCode !== 0) return false;
			fs.writeFileSync(destination, result.stdout, { mode: 0o600, flag: "wx" });
			return true;
		} catch {
			return false;
		}
	}

	stop(botId: string): void {
		this.#generation.set(botId, (this.#generation.get(botId) ?? 0) + 1);
		this.#ready.delete(botId);
		if (!this.#usesDocker(botId)) return;
		this.#updateClient(botId);
		if (this.#cfg.sandboxClientsFile && this.#cfg.sandboxModelConfigDir) {
			fs.rmSync(path.join(this.#cfg.sandboxModelConfigDir, `${botId}.json`), { force: true });
		}
		const container = this.#inspect(botId);
		if (container?.State.Running) this.#docker(["stop", "--time", "5", container.Id]);
	}

	remove(botId: string): void {
		this.stop(botId);
		if (!this.#usesDocker(botId)) return;
		const container = this.#inspect(botId);
		if (container) this.#docker(["rm", "-f", container.Id]);
	}

	async shellTarget(botId: string): Promise<GatewayShellTarget> {
		await this.ensure(botId);
		if (!this.#usesDocker(botId)) {
			return {
				application: "/bin/sh",
				args: ["-c", "command -v bash >/dev/null && exec bash -l || exec sh -l"],
				cwd: this.#store.workspaceDir(botId),
				env: this.workerCommand(botId, []).env,
			};
		}
		const command = this.workerCommand(botId, []);
		const args = command.cmd.slice(1);
		args[args.indexOf("-i")] = "-it";
		args.splice(
			args.lastIndexOf("/usr/local/bin/npi"),
			1,
			"/bin/sh",
			"-c",
			"command -v bash >/dev/null && exec bash -l || exec sh -l",
		);
		return { application: command.cmd[0], args, env: command.env };
	}
}
