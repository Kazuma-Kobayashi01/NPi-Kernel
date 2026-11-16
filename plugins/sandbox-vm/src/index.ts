import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { applyHostCodePolicy, HOST_CODE_TOOLS } from "./policy";
import type { VmStatus } from "./helper-client";
import { isVmBase, VM_BASES, type VmBase } from "./config";
import { runPermissionsPanel } from "./panel";
import { formatBytes } from "./reclaim";
import { BACKEND_NAME, VmController } from "./vm-controller";

const STATUS_KEY = "sandbox-vm";
const HELP = "Usage: /vm [status|start|stop|on|off|base [alpine|ubuntu]|permissions|reclaim [alpine|ubuntu|all]|clean]";

function describe(status: VmStatus, isBackend: boolean, base: VmBase): string {
	const detail = status.detail ? ` (${status.detail})` : "";
	return `VM ${base} ${status.state}${detail}; bash ${isBackend ? "runs in the VM" : "runs on this machine"}`;
}

/**
 * Sandbox VM: the `bash` tool's commands run in a local Linux virtual machine (`exec.backend`), the project
 * folder mounted at the same path. While the VM is the backend, tools that would run agent code on the host
 * (`eval`, `python`, `debug`) are switched off.
 */
export default function sandboxVm(pi: ExtensionAPI): void {
	const controller = new VmController();
	const execBackend = lookup("exec.backend");
	let removedTools: string[] = [];

	const isBackend = (): boolean => execBackend?.get(pi.pi.settings) === BACKEND_NAME;

	// The selected base, as the status line and the event show it; refreshed when it changes and on each report.
	let currentBase: VmBase = "alpine";

	/**
	 * What the RPC commands answer with: the VM's state, the selected base and which bases have an image, whether
	 * bash runs in the VM, and the host-code tools' state.
	 */
	const report = async (status: VmStatus): Promise<Record<string, unknown>> => {
		currentBase = await controller.base();
		const images = await controller.images();
		return {
			...status,
			base: currentBase,
			bases: VM_BASES.map(name => ({
				name,
				// Bootable: built here or shipped in the package. `bytes` is what `/vm reclaim` would free.
				built: images[name].bundled || ["Image", "rootfs.cpio.gz"].every(file => images[name].local.files.includes(file)),
				bundled: images[name].bundled,
				bytes: images[name].local.bytes,
			})),
			...reportTools(),
		};
	};
	const reportTools = (): Record<string, unknown> => ({
		backend: isBackend(),
		hostToolsOff: [...removedTools].sort(),
		hostCodeToolsActive: pi
			.getActiveTools()
			.filter(name => HOST_CODE_TOOLS.includes(name))
			.sort(),
	});

	// One at a time: the setting's listener and `/vm on|off` both land here, and a second pass that read the tools
	// before the first one's change took effect would undo it.
	let policyChain: Promise<void> = Promise.resolve();
	const applyPolicy = (): Promise<void> => {
		const pass = async (): Promise<void> => {
			const result = applyHostCodePolicy(pi.getActiveTools(), removedTools, isBackend());
			await pi.setActiveTools(result.active);
			removedTools = result.removed;
		};
		policyChain = policyChain.then(pass, pass);
		return policyChain;
	};

	pi.setLabel("Sandbox VM");
	pi.registerExecBackend(BACKEND_NAME, controller.backend);

	const publish = (emit: ((name: string, data?: unknown) => void) | undefined, status: VmStatus): void => {
		emit?.("sandbox-vm/state", { state: status.state, detail: status.detail, backend: isBackend(), base: currentBase });
	};

	pi.on("session_start", async (_event, ctx) => {
		controller.setProjectDir(ctx.cwd);
		currentBase = await controller.base();
		const show = (status: VmStatus): void => {
			const theme = ctx.ui.theme;
			// Highlighted, not plain: green once the VM runs, amber while it starts, red when it failed; bold while
			// bash is routed to it.
			const color = status.state === "running" ? "success" : status.state === "error" ? "error" : "warning";
			const line = `▣ ${describe(status, isBackend(), currentBase)}`;
			ctx.ui.setStatus(
				STATUS_KEY,
				isBackend() || status.state !== "stopped"
					? theme.fg(color, isBackend() ? theme.bold(line) : line)
					: undefined,
			);
			publish(ctx.ui.emitEvent, status);
		};
		controller.onState(show);
		execBackend?.listen(pi.pi.settings, () => {
			void applyPolicy();
			show(controller.status);
		});
		await applyPolicy();
		show(controller.status);
	});

	pi.on("session_shutdown", async () => {
		await controller.stop().catch(() => undefined);
	});

	/** Point `exec.backend` at the VM (or back at this machine) and settle the tools before answering. */
	const switchBackend = async (on: boolean): Promise<void> => {
		if (!execBackend) throw new Error("this npi has no exec.backend setting");
		if (on) execBackend.override(pi.pi.settings, BACKEND_NAME);
		else execBackend.clearOverride(pi.pi.settings);
		await applyPolicy();
	};

	/** Stop the VM, send bash back to this machine for this run, and delete the guest image. */
	const reclaim = async (which?: VmBase | "all"): Promise<{ freedBytes: number; persistedBackend: boolean }> => {
		if (execBackend) await switchBackend(false);
		const freed = await controller.reclaim(which);
		// `switchBackend(false)` only clears this run's override; a persisted `exec.backend` would still point here.
		return { freedBytes: freed.bytes, persistedBackend: isBackend() };
	};

	/**
	 * Everything `reclaim` does for every base, plus: a persisted `exec.backend` naming the VM is removed from the
	 * global config (so bash keeps working once the plugin is uninstalled), and the settings file and stale
	 * terminal routes go. `persistedBackend` is still true when another layer (a project's config) names the VM.
	 */
	const cleanUp = async (): Promise<{
		freedBytes: number;
		configRemoved: boolean;
		backendReset: boolean;
		persistedBackend: boolean;
		bundledBytes: number;
	}> => {
		let backendReset = false;
		if (execBackend) {
			await switchBackend(false);
			if (isBackend()) {
				execBackend.unset(pi.pi.settings);
				backendReset = true;
				await applyPolicy();
			}
		}
		const { freed, configRemoved, bundledBytes } = await controller.cleanUp();
		currentBase = await controller.base();
		return { freedBytes: freed.bytes, configRemoved, backendReset, persistedBackend: isBackend(), bundledBytes };
	};

	/** Select the base and refresh what the status line shows. */
	const setBase = async (base: VmBase): Promise<void> => {
		await controller.setBase(base);
		currentBase = base;
	};

	pi.registerCommand("vm", {
		description: "Sandbox VM: status, start, stop, run bash in it (on/off), or reclaim its disk space",
		handler: async (args, ctx) => {
			const word = args.trim().split(/\s+/u)[0] ?? "";
			try {
				switch (word) {
					case "":
					case "status":
						ctx.ui.notify(describe(controller.status, isBackend(), await controller.base()), "info");
						return;
					case "start":
						const started = await controller.start();
						ctx.ui.notify(describe(started, isBackend(), await controller.base()), "info");
						return;
					case "stop":
						const stopped = await controller.stop();
						ctx.ui.notify(describe(stopped, isBackend(), await controller.base()), "info");
						return;
					case "on":
						await switchBackend(true);
						ctx.ui.notify("bash now runs in the VM; eval, python and debug are off", "info");
						return;
					case "off":
						await switchBackend(false);
						ctx.ui.notify("bash runs on this machine again", "info");
						return;
					case "permissions":
						await runPermissionsPanel(ctx.ui, {
							permissions: () => controller.permissions(),
							set: (changes, restart) => controller.setPermissions(changes, restart),
						});
						return;
					case "base": {
						const wanted = args.trim().split(/\s+/u)[1];
						if (wanted === undefined) {
							ctx.ui.notify(`VM base: ${await controller.base()} (available: ${VM_BASES.join(", ")})`, "info");
							return;
						}
						if (!isVmBase(wanted)) {
							ctx.ui.notify(`unknown base ${wanted}; ${VM_BASES.join(" or ")}`, "warning");
							return;
						}
						await setBase(wanted);
						ctx.ui.notify(`VM base is ${wanted}; the VM was stopped and boots it at the next command`, "info");
						return;
					}
					case "reclaim": {
						const target = args.trim().split(/\s+/u)[1];
						if (target !== undefined && target !== "all" && !isVmBase(target)) {
							ctx.ui.notify(`unknown base ${target}; ${VM_BASES.join(", ")} or all`, "warning");
							return;
						}
						const { freedBytes, persistedBackend } = await reclaim(target as VmBase | "all" | undefined);
						const warn = persistedBackend
							? "; exec.backend is still set to the VM, so run `npi config set exec.backend \"\"` or bash will refuse to run"
							: "";
						const images = await controller.images();
						const shipped = VM_BASES.filter(name => images[name].bundled);
						const rest =
							shipped.length > 0
								? `; the ${shipped.join(" and ")} image shipped in the plugin stays (it goes with \`npi plugin uninstall\`) and boots again as is`
								: "; rebuild it with scripts/build-image.sh <base>";
						ctx.ui.notify(
							`VM stopped and the images built on this machine deleted (${formatBytes(freedBytes)} freed)${rest}${warn}`,
							persistedBackend ? "warning" : "info",
						);
						return;
					}
					case "clean": {
						const ok = await ctx.ui.confirm(
							"Clean up the Sandbox VM?",
							"Stops the VM, sends bash back to this machine (also in the saved config), and deletes the images built here and sandbox-vm.json. The plugin itself stays until it is uninstalled.",
						);
						if (!ok) return;
						const done = await cleanUp();
						const parts = [`VM cleaned up: ${formatBytes(done.freedBytes)} of local images freed`];
						if (done.configRemoved) parts.push("sandbox-vm.json deleted");
						if (done.backendReset) parts.push("exec.backend reset to this machine");
						if (done.persistedBackend) parts.push("a project config still sets exec.backend to the VM: remove it there");
						if (done.bundledBytes > 0)
							parts.push(`the plugin's own images (${formatBytes(done.bundledBytes)}) go with \`npi plugin uninstall @npi/plugin-sandbox-vm\``);
						ctx.ui.notify(parts.join("; "), done.persistedBackend ? "warning" : "info");
						return;
					}
					default:
						ctx.ui.notify(HELP, "warning");
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerRpcCommand("sandbox-vm/status", {
		description: "The VM's state, base and images, and whether bash runs in it",
		handler: () => report(controller.status),
	});
	pi.registerRpcCommand("sandbox-vm/start", {
		description: "Start the VM",
		handler: async () => report(await controller.start()),
	});
	pi.registerRpcCommand("sandbox-vm/terminal", {
		description: "Make sure the VM is running and reachable by the Desktop terminal panel (`ready: true`)",
		handler: async () => ({ ...(await report(await controller.start())), ready: true }),
	});
	pi.registerRpcCommand("sandbox-vm/stop", {
		description: "Stop the VM",
		handler: async () => report(await controller.stop()),
	});
	pi.registerRpcCommand("sandbox-vm/set-base", {
		description: "Select the Linux base (`{ base: \"alpine\" | \"ubuntu\" }`); stops the VM, which boots it next time",
		handler: async params => {
			const base = typeof params === "object" && params !== null ? (params as { base?: unknown }).base : undefined;
			if (!isVmBase(base)) throw new Error(`base must be one of ${VM_BASES.join(", ")}`);
			await setBase(base);
			return report(controller.status);
		},
	});
	pi.registerRpcCommand("sandbox-vm/permissions", {
		description: "The VM's permissions (network, project access, read-only folders, cores, memory, idle stop) and this machine's limits",
		handler: async () => ({ ...(await controller.permissions()), running: controller.status.state === "running" }),
	});
	pi.registerRpcCommand("sandbox-vm/set-permissions", {
		description:
			"Change permissions (`{ changes: { network?, projectAccess?, readOnlyMounts?, cpus?, memoryMiB?, idleStopMinutes? }, restart?: boolean }`); they apply when the VM restarts (`restart: true` stops it now)",
		handler: async params => {
			const input = typeof params === "object" && params !== null ? (params as { changes?: unknown; restart?: unknown }) : {};
			const { restartNeeded } = await controller.setPermissions(input.changes ?? {}, input.restart === true);
			return { ...(await controller.permissions()), running: controller.status.state === "running", restartNeeded };
		},
	});
	pi.registerRpcCommand("sandbox-vm/image", {
		description: "How much disk each base's guest image takes (`bases`), and the selected base's `bytes`",
		handler: async () => {
			const status = await report(controller.status);
			const selected = (status.bases as { name: string; bytes: number }[]).find(entry => entry.name === status.base);
			return { bytes: selected?.bytes ?? 0, base: status.base, bases: status.bases };
		},
	});
	pi.registerRpcCommand("sandbox-vm/reclaim", {
		description:
			"Stop the VM and delete a guest image (`{ base?: \"alpine\" | \"ubuntu\" | \"all\" }`, default the selected base); answers with `freedBytes` and the usual status",
		handler: async params => {
			const base = typeof params === "object" && params !== null ? (params as { base?: unknown }).base : undefined;
			if (base !== undefined && base !== "all" && !isVmBase(base)) {
				throw new Error(`base must be one of ${VM_BASES.join(", ")} or all`);
			}
			const { freedBytes, persistedBackend } = await reclaim(base);
			return { ...(await report(controller.status)), freedBytes, persistedBackend };
		},
	});
	pi.registerRpcCommand("sandbox-vm/clean", {
		description:
			"Clean up for removal (the caller confirms first): stop the VM, reset a persisted exec.backend naming it, delete every locally built image, sandbox-vm.json and stale terminal routes. Answers with `freedBytes`, `configRemoved`, `backendReset`, `persistedBackend`, `bundledBytes` and the usual status",
		handler: async () => {
			const done = await cleanUp();
			return { ...(await report(controller.status)), ...done };
		},
	});
	pi.registerRpcCommand("sandbox-vm/set-backend", {
		description: "Run bash in the VM (`{ on: true }`) or on this machine (`{ on: false }`)",
		handler: async params => {
			const on = typeof params === "object" && params !== null && (params as { on?: unknown }).on === true;
			await switchBackend(on);
			return report(controller.status);
		},
	});
}
