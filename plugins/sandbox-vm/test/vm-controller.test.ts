import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecBackendResult } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_CONFIG, type SandboxVmConfig } from "../src/config";
import { VmController } from "../src/vm-controller";

const FAKE_HELPER = path.join(import.meta.dir, "fake-helper.ts");
const PROJECT = os.tmpdir();

const controllers: VmController[] = [];

function makeController(
	config: Partial<SandboxVmConfig> = {},
	command?: readonly string[],
	idleStopMs?: number,
): VmController {
	const controller = new VmController({
		loadConfig: async () => ({ ...DEFAULT_CONFIG, ...config }),
		routes: false,
		helperCommand: async () => command ?? [process.execPath, FAKE_HELPER],
		idleStopMs,
	});
	controller.setProjectDir(PROJECT);
	controllers.push(controller);
	return controller;
}

interface RunResult {
	output: string;
	result: ExecBackendResult;
}

async function run(
	controller: VmController,
	command: string,
	options: { signal?: AbortSignal; sessionKey?: string } = {},
): Promise<RunResult> {
	let output = "";
	const result = await controller.backend.run(command, {
		cwd: PROJECT,
		env: { FROM_CALL: "1" },
		signal: options.signal ?? new AbortController().signal,
		sessionKey: options.sessionKey,
		onChunk: chunk => {
			output += chunk;
		},
	});
	return { output, result };
}

afterEach(async () => {
	for (const controller of controllers.splice(0)) await controller.stop().catch(() => undefined);
});

describe("VM controller", () => {
	it("starts the VM on first use, with the project mounted read-write and the network off", async () => {
		const controller = makeController({ readOnlyMounts: ["/opt/toolchain"] });

		const { output } = await run(controller, "__config");

		expect(controller.status.state).toBe("running");
		expect(JSON.parse(output)).toMatchObject({
			network: "off",
			mounts: [
				{ path: PROJECT, readOnly: false },
				{ path: "/opt/toolchain", readOnly: true },
			],
		});
	});

	it("runs a command in the guest, streaming its output and exit status", async () => {
		const controller = makeController();

		const ok = await run(controller, "echo out; echo err >&2; echo $FROM_CALL");
		const failed = await run(controller, "exit 3");

		expect(ok.output).toContain("out");
		expect(ok.output).toContain("err");
		expect(ok.output).toContain("1");
		expect(ok.result).toEqual({ exitCode: 0 });
		expect(failed.result).toEqual({ exitCode: 3 });
	});

	it("cancels a running command when the call is aborted", async () => {
		const controller = makeController();
		await controller.start();
		const abort = new AbortController();

		const pending = run(controller, "sleep 30", { signal: abort.signal });
		await Bun.sleep(100);
		const started = performance.now();
		abort.abort();
		const { result } = await pending;

		expect(result.cancelled).toBe(true);
		expect(performance.now() - started).toBeLessThan(5_000);
	});

	it("tells the guest when an agent session ends", async () => {
		const controller = makeController();
		await run(controller, "true", { sessionKey: "session-1" });

		await controller.backend.release?.("session-1");
		const { output } = await run(controller, "__released");

		expect(output).toBe("session-1");
	});

	it("stops the VM after its idle time and starts it again for the next command", async () => {
		const controller = makeController({}, undefined, 400);
		await run(controller, "true");
		expect(controller.status.state).toBe("running");

		await Bun.sleep(900);
		expect(controller.status.state).toBe("stopped");

		const again = await run(controller, "echo back");
		expect(again.output).toBe("back\n");
		expect(controller.status.state).toBe("running");
	});

	it("does not stop the VM under a command that is still running", async () => {
		const controller = makeController({}, undefined, 300);
		const { output } = await run(controller, "sleep 1; echo done");
		expect(output).toBe("done\n");
		expect(controller.status.state).toBe("running");
	});

	it("fails the command, and says why, when the helper dies under it", async () => {
		const controller = makeController();

		await expect(run(controller, "__crash")).rejects.toThrow(/VM helper exited/);
		expect(controller.status.state).toBe("stopped");
	});

	it("starts afresh on the next command after a start failed", async () => {
		const marker = path.join(os.tmpdir(), `sandbox-vm-fail-once-${process.pid}-${Date.now()}`);
		const controller = makeController({}, [process.execPath, FAKE_HELPER, "--fail-once", marker]);
		try {
			await expect(run(controller, "true")).rejects.toThrow(/did not come up/);
			expect(controller.status.state).toBe("error");

			const again = await run(controller, "echo up");

			expect(again.output).toBe("up\n");
			expect(controller.status.state).toBe("running");
		} finally {
			await fs.rm(marker, { force: true });
		}
	});

	it("keeps the VM running past its idle time while a terminal is attached", async () => {
		const controller = makeController({}, undefined, 300);
		await run(controller, "__terminals 1");

		await Bun.sleep(700);
		expect(controller.status.state).toBe("running");

		await run(controller, "__terminals 0");
		await Bun.sleep(700);
		expect(controller.status.state).toBe("stopped");
	});

	it("stops a VM that was started without a command after its idle time", async () => {
		const controller = makeController({}, undefined, 300);
		await controller.start();

		await Bun.sleep(700);

		expect(controller.status.state).toBe("stopped");
	});

	it("remounts the project when the session moved to another folder", async () => {
		const controller = makeController();
		await run(controller, "true");
		const other = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-vm-project-"));
		try {
			controller.setProjectDir(other);

			const { output } = await run(controller, "__config");

			expect(JSON.parse(output).mounts[0]).toEqual({ path: other, readOnly: false });
		} finally {
			await fs.rm(other, { recursive: true, force: true });
		}
	});

	it("fails with a clear error when the helper is not installed", async () => {
		const controller = new VmController({
			loadConfig: async () => ({ ...DEFAULT_CONFIG, helper: "/nonexistent/npi-vm-helper" }),
		});
		controller.setProjectDir(PROJECT);
		controllers.push(controller);

		await expect(run(controller, "true")).rejects.toThrow(/VM helper not found at \/nonexistent\/npi-vm-helper/);
		expect(controller.status.state).toBe("error");
	});
});
