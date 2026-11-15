import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as os from "node:os";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { executeBash, releaseShellSessions } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { selectExecBackend } from "@oh-my-pi/pi-coding-agent/exec/exec-backend";
import type {
	ExecBackendResult,
	ExecBackendRunOptions,
	RegisteredExecBackend,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { Shell } from "@oh-my-pi/pi-natives";

const BACKEND = "fake/vm";

interface Call {
	command: string;
	options: ExecBackendRunOptions;
}

/** A backend that records what it was asked and answers from `reply`. */
function fakeBackend(
	reply: (command: string, options: ExecBackendRunOptions) => Promise<ExecBackendResult> | ExecBackendResult,
	calls: Call[] = [],
	released: string[] = [],
): RegisteredExecBackend {
	return {
		name: BACKEND,
		async run(command, options) {
			calls.push({ command, options });
			return reply(command, options);
		},
		release(sessionKey) {
			released.push(sessionKey);
		},
	};
}

function makeSession(setting: string, lookup?: ToolSession["getExecBackend"]): ToolSession {
	return {
		cwd: os.tmpdir(),
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		settings: Settings.isolated({
			"exec.backend": setting,
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
			"astGrep.enabled": false,
			"astEdit.enabled": false,
			"grep.enabled": false,
			"glob.enabled": false,
		}),
		getClientBridge: () => undefined,
		...(lookup ? { getExecBackend: lookup } : {}),
	} as unknown as ToolSession;
}

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	mock.restore();
	resetSettingsForTest();
});

describe("exec backend selection", () => {
	it("maps the setting to the host, a backend, or a missing backend", () => {
		const backend = fakeBackend(() => ({ exitCode: 0 }));
		const lookup = (name: string) => (name === BACKEND ? backend : undefined);
		expect(selectExecBackend("", lookup)).toEqual({ kind: "host" });
		expect(selectExecBackend("  ", lookup)).toEqual({ kind: "host" });
		expect(selectExecBackend(` ${BACKEND} `, lookup)).toEqual({ kind: "backend", backend });
		expect(selectExecBackend("gone/vm", lookup)).toEqual({ kind: "missing", name: "gone/vm" });
	});
});

describe("bash on an exec backend", () => {
	it("runs the command there, streams its output and never starts the host shell", async () => {
		const hostRun = spyOn(Shell.prototype, "run");
		const calls: Call[] = [];
		const backend = fakeBackend((_command, options) => {
			options.onChunk("hello from the vm\n");
			return { exitCode: 0 };
		}, calls);
		const tool = new BashTool(makeSession(BACKEND, name => (name === BACKEND ? backend : undefined)));

		const result = await tool.execute("call-1", { command: "echo hi" });

		expect(result.content.find(block => block.type === "text")?.text).toContain("hello from the vm");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.command).toBe("echo hi");
		expect(calls[0]?.options.cwd).toBe(os.tmpdir());
		expect(hostRun).not.toHaveBeenCalled();
	});

	it("reports a non-zero exit as a failed command with its status", async () => {
		const backend = fakeBackend(() => ({ exitCode: 3 }));
		const tool = new BashTool(makeSession(BACKEND, () => backend));

		const result = await tool.execute("call-fail", { command: "exit 3" });

		expect(result.isError).toBe(true);
		expect(result.details?.exitCode).toBe(3);
	});

	it("hands the backend the call's environment, not the host's", async () => {
		const calls: Call[] = [];
		const backend = fakeBackend(() => ({ exitCode: 0 }), calls);
		const tool = new BashTool(makeSession(BACKEND, () => backend));
		const previous = process.env.OMP_TEST_HOST_SECRET;
		process.env.OMP_TEST_HOST_SECRET = "do-not-cross";
		try {
			await tool.execute("call-env", { command: "true" });
		} finally {
			if (previous === undefined) delete process.env.OMP_TEST_HOST_SECRET;
			else process.env.OMP_TEST_HOST_SECRET = previous;
		}

		const env = calls[0]?.options.env ?? {};
		expect(env.OMP_TEST_HOST_SECRET).toBeUndefined();
		expect(env.TERM).toBe("dumb");
		expect(env.PI_SESSION_ID).toBeDefined();
	});

	it("fails instead of running on the host when the named backend is not loaded", async () => {
		const hostRun = spyOn(Shell.prototype, "run");
		for (const session of [makeSession("gone/vm", () => undefined), makeSession("gone/vm")]) {
			const tool = new BashTool(session);
			await expect(tool.execute("call-missing", { command: "echo oops > /tmp/never" })).rejects.toThrow(
				/gone\/vm.*no loaded extension provides it/,
			);
		}
		expect(hostRun).not.toHaveBeenCalled();
	});

	it("refuses a service launch, which would start a process on the host", async () => {
		const hostRun = spyOn(Shell.prototype, "run");
		const backend = fakeBackend(() => ({ exitCode: 0 }));
		const tool = new BashTool(makeSession(BACKEND, () => backend));

		await expect(tool.execute("call-svc", { command: "sleep 100", name: "svc" })).rejects.toThrow(
			/Services run on this machine/,
		);
		expect(hostRun).not.toHaveBeenCalled();
	});

	it("runs a pty request on the backend without a terminal and says so", async () => {
		const calls: Call[] = [];
		const backend = fakeBackend((_command, options) => {
			options.onChunk("ok\n");
			return { exitCode: 0 };
		}, calls);
		const tool = new BashTool(makeSession(BACKEND, () => backend));

		const result = await tool.execute("call-pty", { command: "top", pty: true });

		expect(calls).toHaveLength(1);
		expect(result.content.find(block => block.type === "text")?.text).toContain("pty is unavailable on fake/vm");
	});
});

describe("executeBash on an exec backend", () => {
	it("returns a cancelled result when the call is aborted and the backend stops", async () => {
		const abort = new AbortController();
		let sawAbort = false;
		const backend = fakeBackend(
			(_command, options) =>
				new Promise<ExecBackendResult>(resolve => {
					options.signal.addEventListener("abort", () => {
						sawAbort = true;
						resolve({ cancelled: true });
					});
					queueMicrotask(() => abort.abort());
				}),
		);

		const result = await executeBash("sleep 100", { backend, signal: abort.signal, timeout: 0 });

		expect(sawAbort).toBe(true);
		expect(result.cancelled).toBe(true);
		expect(result.timedOut).toBeUndefined();
		expect(result.exitCode).toBeUndefined();
	});

	it("marks a command that outlives its deadline as timed out", async () => {
		const backend = fakeBackend(
			(_command, options) =>
				new Promise<ExecBackendResult>(resolve => {
					options.signal.addEventListener("abort", () => resolve({ cancelled: true }));
				}),
		);

		const result = await executeBash("sleep 100", { backend, timeout: 1_000 });

		expect(result.cancelled).toBe(true);
		expect(result.timedOut).toBe(true);
		expect(result.output).toContain("timed out after 1 seconds");
	});

	it("reports a backend that fails as an error, naming it", async () => {
		const backend = fakeBackend(() => {
			throw new Error("vm is not running");
		});

		await expect(executeBash("true", { backend })).rejects.toThrow("Exec backend fake/vm failed: vm is not running");
	});

	it("tells the backend when the agent session that ran commands on it ends", async () => {
		const released: string[] = [];
		const backend = fakeBackend(() => ({ exitCode: 0 }), [], released);

		await executeBash("true", { backend, sessionKey: "session-1:async:job-7" });
		releaseShellSessions("session-1");
		await Bun.sleep(0);

		expect(released).toEqual(["session-1"]);
	});
});
