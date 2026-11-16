import * as path from "node:path";
import type { RegisteredExecBackend } from "@oh-my-pi/pi-coding-agent";
import { bundledImageDir, dataDir, imageDirs, loadConfig, savePatch, saveBase, type SandboxVmConfig, type VmBase, VM_BASES } from "./config";
import { HelperClient, type VmStatus } from "./helper-client";
import type { VmConfig } from "./protocol";
import { removeRoute, routePaths, writeRoute } from "./terminal-route";
import { limits, type PermissionLimits, type Permissions, permissionsOf, validatePatch } from "./permissions";
import { type ImageInfo, imageInfo, reclaimImage } from "./reclaim";

/** The name `exec.backend` is set to for this plugin's VM. */
export const BACKEND_NAME = "sandbox-vm/default";

/** The plugin's own folder, where `bin/npi-vm-helper` lives. */
const PLUGIN_DIR = path.join(import.meta.dir, "..");

/** The helper executable: `NPI_VM_HELPER`, else the settings file's `helper`, else `bin/npi-vm-helper`. */
export async function resolveHelper(
	config: SandboxVmConfig,
	env: Record<string, string | undefined> = Bun.env,
): Promise<string> {
	const file = env.NPI_VM_HELPER || config.helper || path.join(PLUGIN_DIR, "bin", "npi-vm-helper");
	if (!(await Bun.file(file).exists())) {
		throw new Error(
			`VM helper not found at ${file}. Build it into the plugin's bin/ folder or point NPI_VM_HELPER (or "helper" in sandbox-vm.json) at it.`,
		);
	}
	return file;
}

export interface VmControllerOptions {
	/** Settings source; defaults to the settings file. */
	loadConfig?: () => Promise<SandboxVmConfig>;
	/** The command that starts the helper (executable first); defaults to {@link resolveHelper}. */
	helperCommand?: (config: SandboxVmConfig) => Promise<readonly string[]>;
	/** Publishes how the terminal panel reaches the VM; defaults to `terminal-route.ts`. Tests turn it off. */
	routes?: { publish(helper: string): Promise<unknown>; withdraw(): Promise<void> } | false;
	/** Persists permission changes; defaults to the settings file. */
	savePatch?: (patch: Record<string, unknown>) => Promise<void>;
	/** Persists the selected base; defaults to the settings file. */
	saveBase?: (base: VmBase) => Promise<void>;
	/** Idle time in milliseconds after which the VM stops; overrides the settings (tests). */
	idleStopMs?: number;
}

/**
 * The VM's lifecycle and the exec backend that runs `bash` commands in it. The helper process is started on
 * the first use; the project folder is mounted at the same path in the guest, so a command's cwd and the paths
 * in its output mean the same thing on both sides.
 */
export class VmController {
	readonly #loadConfig: () => Promise<SandboxVmConfig>;
	readonly #helperCommand: (config: SandboxVmConfig) => Promise<readonly string[]>;
	#client: HelperClient | undefined;
	#projectDir: string | undefined;
	#starting: Promise<VmStatus> | undefined;
	#status: VmStatus = { state: "stopped" };
	readonly #routes: { publish(helper: string): Promise<unknown>; withdraw(): Promise<void> } | undefined;
	#helperPath: string | undefined;
	readonly #saveBase: (base: VmBase) => Promise<void>;
	readonly #savePatch: (patch: Record<string, unknown>) => Promise<void>;
	readonly #idleOverrideMs: number | undefined;
	#idleMs = 0;
	#idleTimer: Timer | undefined;
	#running = 0;
	readonly #listeners = new Set<(status: VmStatus) => void>();

	constructor(options: VmControllerOptions = {}) {
		this.#loadConfig = options.loadConfig ?? loadConfig;
		this.#helperCommand = options.helperCommand ?? (async config => [await resolveHelper(config)]);
		this.#routes =
			options.routes === false
				? undefined
				: (options.routes ?? { publish: helper => writeRoute(helper), withdraw: () => removeRoute() });
		this.#saveBase = options.saveBase ?? (base => saveBase(base));
		this.#savePatch = options.savePatch ?? (patch => savePatch(patch));
		this.#idleOverrideMs = options.idleStopMs;
	}

	get status(): VmStatus {
		return this.#status;
	}

	/** The folder the guest gets read-write; set when the session starts. */
	setProjectDir(dir: string): void {
		this.#projectDir = dir;
	}

	onState(listener: (status: VmStatus) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#setStatus(status: VmStatus): void {
		if (this.#status.state === status.state && this.#status.detail === status.detail) return;
		this.#status = status;
		for (const listener of this.#listeners) listener(status);
	}

	/** Start the VM (once; concurrent callers share the start) and resolve when it is running or failed. */
	start(): Promise<VmStatus> {
		this.#starting ??= this.#start().finally(() => {
			this.#starting = undefined;
		});
		return this.#starting;
	}

	async #start(): Promise<VmStatus> {
		if (this.#client?.status.state === "running") return this.#client.status;
		const projectDir = this.#projectDir;
		if (!projectDir) throw new Error("the project folder is not known yet; start the VM from a session");
		this.#setStatus({ state: "starting" });
		try {
			const config = await this.#loadConfig();
			this.#idleMs = this.#idleOverrideMs ?? config.idleStopMinutes * 60_000;
			if (!this.#client) {
				const command = await this.#helperCommand(config);
				this.#helperPath = command[0];
				const client = new HelperClient(command);
				client.onState(status => this.#setStatus(status));
				this.#client = client;
			}
			const vmConfig: VmConfig = {
				memoryMiB: config.memoryMiB,
				cpus: config.cpus,
				network: config.network,
				image: await this.#imageDirFor(config),
				...(this.#routes ? { terminalSocket: routePaths().socket } : {}),
				mounts: [
					{ path: projectDir, readOnly: config.projectAccess === "read-only" },
					...config.readOnlyMounts.map(mount => ({ path: mount, readOnly: true })),
				],
			};
			const status = await this.#client.start(vmConfig);
			if (this.#routes && this.#helperPath) await this.#routes.publish(this.#helperPath);
			this.#setStatus(status);
			return status;
		} catch (error) {
			let message = error instanceof Error ? error.message : String(error);
			if (message.includes("VM image not found")) {
				const { base } = await this.#loadConfig();
				message = `the ${base} VM image is not built; run scripts/build-image.sh ${base} (${message.split("\n")[0]})`;
				error = new Error(message);
			}
			const status: VmStatus = { state: "error", detail: message };
			this.#setStatus(status);
			throw error;
		}
	}

	/** Stop the VM once it has had no command for the idle time; the next command starts it again. */
	#armIdleStop(): void {
		if (this.#idleTimer) clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
		if (this.#idleMs <= 0 || this.#running > 0 || !this.#client) return;
		this.#idleTimer = setTimeout(() => {
			if (this.#running === 0) void this.stop().catch(() => undefined);
		}, this.#idleMs);
		this.#idleTimer.unref();
	}

	/** Shut the VM down and end the helper. */
	async stop(): Promise<VmStatus> {
		if (this.#idleTimer) clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
		const client = this.#client;
		this.#client = undefined;
		if (!client) return this.#status;
		try {
			await client.stop();
		} finally {
			await this.#routes?.withdraw().catch(() => undefined);
			client.close();
			this.#setStatus({ state: "stopped" });
		}
		return this.#status;
	}

	/** The VM's permissions and what this machine allows. */
	async permissions(): Promise<{ permissions: Permissions; limits: PermissionLimits }> {
		return { permissions: permissionsOf(await this.#loadConfig()), limits: limits() };
	}

	/**
	 * Change permissions (validated, saved). They apply when the VM starts, so a running VM keeps its old ones until
	 * `restart` stops it (the next command boots it with the new ones). Returns whether a restart is still pending.
	 */
	async setPermissions(changes: unknown, restart = false): Promise<{ restartNeeded: boolean }> {
		const clean = await validatePatch(changes);
		if (Object.keys(clean).length > 0) await this.#savePatch(clean);
		const running = this.#client?.status.state === "running";
		if (running && restart) await this.stop();
		return { restartNeeded: running && !restart };
	}

	/** Whether `dir` holds a bootable image. */
	static async #complete(dir: string): Promise<boolean> {
		const files = (await imageInfo(dir)).files;
		return files.includes("Image") && files.includes("rootfs.cpio.gz");
	}

	/**
	 * The folder the selected base boots from: an image built on this machine (or the settings' `image`) wins
	 * over the one shipped in the plugin package. With neither, the local folder, whose absence the error names.
	 */
	async #imageDirFor(config: SandboxVmConfig): Promise<string> {
		const local = imageDirs(config)[config.base];
		if (await VmController.#complete(local)) return local;
		const bundled = bundledImageDir(config.base);
		return (await VmController.#complete(bundled)) ? bundled : local;
	}

	/** The selected base. */
	async base(): Promise<VmBase> {
		return (await this.#loadConfig()).base;
	}

	/**
	 * Select the base the VM boots. The running VM, if any, is stopped: the new root is used from the next start.
	 * Returns the previous status.
	 */
	async setBase(base: VmBase): Promise<VmStatus> {
		await this.#saveBase(base);
		return this.stop();
	}

	/**
	 * What each base's guest image takes on disk (`local`: built on this machine, what `reclaim` deletes) and
	 * whether the plugin package ships one (`bundled`).
	 */
	async images(): Promise<Record<VmBase, { local: ImageInfo; bundled: boolean }>> {
		const dirs = imageDirs(await this.#loadConfig());
		const entry = async (base: VmBase) => ({
			local: await imageInfo(dirs[base]),
			bundled: await VmController.#complete(bundledImageDir(base)),
		});
		return { alpine: await entry("alpine"), ubuntu: await entry("ubuntu") };
	}

	/**
	 * Give the sandbox back: stop the VM, then delete the guest image of `which` (the selected base by default,
	 * `all` for every base). The plugin and its settings stay; `scripts/build-image.sh <base>` restores an image.
	 * Returns what was freed.
	 */
	async reclaim(which: VmBase | "all" | undefined = undefined): Promise<ImageInfo> {
		await this.stop();
		const config = await this.#loadConfig();
		const dirs = imageDirs(config);
		const bases: readonly VmBase[] = which === "all" ? VM_BASES : [which ?? config.base];
		const freed: ImageInfo = { bytes: 0, files: [] };
		for (const base of bases) {
			// The default data folder is the plugin's own, so it goes once its last image does; a custom folder
			// has no such parent.
			const custom = config.base === base && config.image !== undefined;
			const one = await reclaimImage(dirs[base], custom ? undefined : dataDir());
			freed.bytes += one.bytes;
			freed.files.push(...one.files.map(name => `${base}/${name}`));
		}
		return freed;
	}

	/** The exec backend for `pi.registerExecBackend`. */
	readonly backend: Omit<RegisteredExecBackend, "name"> = {
		description: "Commands run in a local Linux virtual machine",
		run: async (command, options) => {
			this.#running++;
			if (this.#idleTimer) clearTimeout(this.#idleTimer);
			try {
				if (this.#client?.status.state !== "running") await this.start();
				const client = this.#client;
				if (client?.status.state !== "running") {
					throw new Error(
						`the VM is ${this.#status.state}${this.#status.detail ? `: ${this.#status.detail}` : ""}`,
					);
				}
				return await client.exec(
					{
						sessionKey: options.sessionKey,
						command,
						cwd: options.cwd,
						env: options.env,
						timeoutMs: options.timeoutMs,
					},
					options.onChunk,
					options.signal,
				);
			} finally {
				this.#running--;
				this.#armIdleStop();
			}
		},
		release: async sessionKey => {
			await this.#client?.release(sessionKey);
		},
	};
}
