import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, type SandboxVmConfig } from "../src/config";
import { runPermissionsPanel, type PanelUi } from "../src/panel";
import { formatMemory, limits, parseCount, parseMemory, permissionsOf, summarize, validatePatch } from "../src/permissions";
import { VmController } from "../src/vm-controller";

const FAKE_HELPER = path.join(import.meta.dir, "fake-helper.ts");

describe("permission values", () => {
	it("parses cores, minutes and memory the way a person types them", () => {
		expect(parseCount("8", 1, 10, "cores")).toBe(8);
		expect(parseCount("8 cores", 1, 10, "cores")).toBe(8);
		expect(parseCount("0", 1, 10, "cores")).toBeString();
		expect(parseCount("2.5", 1, 10, "cores")).toBeString();
		expect(parseMemory("8")).toBe(8192);
		expect(parseMemory("8 GiB")).toBe(8192);
		expect(parseMemory("1.5g")).toBe(1536);
		expect(parseMemory("4096 MiB")).toBe(4096);
		expect(parseMemory("4096")).toBe(4096);
		expect(parseMemory("100m")).toBeString();
		expect(parseMemory("lots")).toBeString();
		expect(formatMemory(8192)).toBe("8 GiB");
		expect(formatMemory(1536)).toBe("1536 MiB");
	});

	it("validates a change set and refuses what the helper could not start with", async () => {
		expect(await validatePatch({ network: "nat", cpus: 4, memoryMiB: 4096, readOnlyMounts: [os.tmpdir(), os.tmpdir()] })).toEqual({
			network: "nat",
			cpus: 4,
			memoryMiB: 4096,
			readOnlyMounts: [path.resolve(os.tmpdir())],
		});
		await expect(validatePatch({ network: "yes" })).rejects.toThrow("network");
		await expect(validatePatch({ cpus: limits().maxCpus + 1 })).rejects.toThrow("cpus");
		await expect(validatePatch({ memoryMiB: 64 })).rejects.toThrow("memoryMiB");
		await expect(validatePatch({ readOnlyMounts: ["relative"] })).rejects.toThrow("absolute");
		await expect(validatePatch({ readOnlyMounts: ["/definitely/not/here"] })).rejects.toThrow("not a folder");
		await expect(validatePatch({ sudo: true })).rejects.toThrow("unknown permission");
	});

	it("summarizes every permission", () => {
		const lines = summarize(permissionsOf(DEFAULT_CONFIG)).map(line => `${line.label}: ${line.value}`);
		expect(lines).toEqual([
			"Network: off",
			"Project folder: read-write",
			"Extra read-only folders: none",
			"CPU cores: 8",
			"Memory (up to): 8 GiB",
			"Stop when idle: after 15 min",
		]);
	});
});

describe("permissions in the controller", () => {
	function make(config: { current: SandboxVmConfig }, saved: Record<string, unknown>[]): VmController {
		const controller = new VmController({
			loadConfig: async () => config.current,
			savePatch: async patch => {
				saved.push(patch);
				config.current = { ...config.current, ...patch } as SandboxVmConfig;
			},
			routes: false,
			helperCommand: async () => [process.execPath, FAKE_HELPER],
		});
		controller.setProjectDir(os.tmpdir());
		return controller;
	}

	async function startConfig(controller: VmController): Promise<{ mounts: { path: string; readOnly: boolean }[]; network: string; cpus: number; memoryMiB: number }> {
		let output = "";
		await controller.backend.run("__config", {
			cwd: os.tmpdir(),
			env: {},
			signal: new AbortController().signal,
			onChunk: chunk => {
				output += chunk;
			},
		});
		return JSON.parse(output);
	}

	it("saves changes, applies them at the next start, and says when a restart is pending", async () => {
		const config = { current: { ...DEFAULT_CONFIG } };
		const saved: Record<string, unknown>[] = [];
		const controller = make(config, saved);

		expect(await controller.setPermissions({ projectAccess: "read-only", cpus: 4 })).toEqual({ restartNeeded: false });
		expect(saved).toEqual([{ projectAccess: "read-only", cpus: 4 }]);

		const first = await startConfig(controller);
		expect(first).toMatchObject({ cpus: 4, network: "off" });
		expect(first.mounts[0]).toEqual({ path: os.tmpdir(), readOnly: true });

		// The VM is running: the change is saved but waits for a restart.
		expect(await controller.setPermissions({ network: "nat" })).toEqual({ restartNeeded: true });
		expect(controller.status.state).toBe("running");

		expect(await controller.setPermissions({}, true)).toEqual({ restartNeeded: false });
		expect(controller.status.state).toBe("stopped");
		expect(await startConfig(controller)).toMatchObject({ network: "nat" });
		await controller.stop();
	});

	it("saves nothing when a change is invalid", async () => {
		const saved: Record<string, unknown>[] = [];
		const controller = make({ current: { ...DEFAULT_CONFIG } }, saved);
		await expect(controller.setPermissions({ cpus: 0 })).rejects.toThrow("cpus");
		expect(saved).toEqual([]);
	});
});

describe("the TUI panel", () => {
	it("walks the permissions, saves each change and offers a restart on the way out", async () => {
		const config = { current: { ...DEFAULT_CONFIG } };
		const changes: { changes: unknown; restart: boolean }[] = [];
		// Scripted answers: network → on (confirmed), cores → "6" after a bad "0", then Done, then restart yes.
		const selects = ["Network: off", "on: the guest reaches the network through this machine", "CPU cores: 8", "Done"];
		const inputs = ["0", "6"];
		const notices: string[] = [];
		const ui: PanelUi = {
			select: async (_title, options) => {
				const answer = selects.shift();
				if (answer?.startsWith("Done")) return options.find(option => option.startsWith("Done"));
				expect(options).toContain(answer as string);
				return answer;
			},
			input: async () => inputs.shift(),
			confirm: async () => true,
			notify: message => void notices.push(message),
		};

		await runPermissionsPanel(ui, {
			permissions: async () => ({ permissions: permissionsOf(config.current), limits: { maxCpus: 10, maxMemoryMiB: 65536, hostMemoryMiB: 16384 } }),
			set: async (patch, restart) => {
				changes.push({ changes: patch, restart });
				config.current = { ...config.current, ...patch };
				return { restartNeeded: !restart && Object.keys(patch).length > 0 };
			},
		});

		expect(changes).toEqual([
			{ changes: { network: "nat" }, restart: false },
			{ changes: { cpus: 6 }, restart: false },
			{ changes: {}, restart: true },
		]);
		expect(notices[0]).toContain("cores");
	});
});
