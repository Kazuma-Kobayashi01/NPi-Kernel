/**
 * NPi Python integration: the desktop runtime host and the `python` tool.
 *
 * These tests exercise the real thing. `ensure` unpacks the bundled CPython
 * through the Rust host into a fresh temporary `NPI_ENV_DIR`; executions run
 * against that managed interpreter (no system Python, no scripted stand-in).
 *
 * Required environment (the suite reports and skips when absent):
 *   NPI_PYTHON_HOST=<absolute app/debug executable with --npi-python-host>
 *   NPI_PYTHON_RESOURCE_DIR=<dir with python-runtime-manifest.json + archive>
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	ensureNpiPythonEnv,
	enumeratePythonRuntimes,
	getNpiPythonWorkspaceDir,
	npiManagedPythonPath,
	readNpiPythonEnvironment,
} from "@oh-my-pi/pi-coding-agent/eval/py/runtime";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { getNpiEnvDir, getNpiManagedPythonEnvDir } from "@oh-my-pi/pi-utils";
import { __resetShellConfigCacheForTests } from "@oh-my-pi/pi-utils/procmgr";
import { PythonTool } from "../../src/tools/python";

const HOST = process.env.NPI_PYTHON_HOST?.trim();
const RESOURCE_DIR = process.env.NPI_PYTHON_RESOURCE_DIR?.trim();
const missingPrerequisite = !HOST
	? "NPI_PYTHON_HOST (absolute executable)"
	: !RESOURCE_DIR
		? "NPI_PYTHON_RESOURCE_DIR"
		: !fs.existsSync(path.join(RESOURCE_DIR, "python-runtime-manifest.json"))
			? `python-runtime-manifest.json under ${RESOURCE_DIR}`
			: null;
if (missingPrerequisite) {
	console.warn(`npi-python-runtime.test: skipping host smoke; set ${missingPrerequisite}.`);
}

let baseDir: string;
let interpreter: string;
const progressStages: string[] = [];
const savedEnv = {
	NPI_ENV_DIR: process.env.NPI_ENV_DIR,
	VIRTUAL_ENV: process.env.VIRTUAL_ENV,
	CONDA_PREFIX: process.env.CONDA_PREFIX,
	OPENAI_API_KEY: process.env.OPENAI_API_KEY,
	PI_AUTO_QA_PUSH_TOKEN: process.env.PI_AUTO_QA_PUSH_TOKEN,
};

function restoreEnv(key: keyof typeof savedEnv): void {
	const value = savedEnv[key];
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

function createSession(sessionId: string): ToolSession {
	return {
		cwd: path.join(baseDir, "project"),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: () => sessionId,
		settings: Settings.isolated(),
	};
}

describe("NPi environment directories", () => {
	it("defaults to ~/.local/share/npi/env and honors the absolute override", () => {
		const saved = process.env.NPI_ENV_DIR;
		delete process.env.NPI_ENV_DIR;
		try {
			const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || os.homedir();
			expect(getNpiEnvDir()).toBe(path.join(home, ".local", "share", "npi", "env"));
		} finally {
			if (saved === undefined) delete process.env.NPI_ENV_DIR;
			else process.env.NPI_ENV_DIR = saved;
		}
		process.env.NPI_ENV_DIR = path.join(os.tmpdir(), "npi-env-relative-test");
		try {
			expect(getNpiEnvDir()).toBe(path.resolve(os.tmpdir(), "npi-env-relative-test"));
			expect(getNpiManagedPythonEnvDir()).toBe(path.join(getNpiEnvDir(), "environments", "default"));
		} finally {
			if (saved === undefined) delete process.env.NPI_ENV_DIR;
			else process.env.NPI_ENV_DIR = saved;
		}
	});
});

describe.skipIf(missingPrerequisite !== null)("NPi managed Python through the desktop host", () => {
	beforeAll(async () => {
		baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "npi-python-host-"));
		process.env.NPI_ENV_DIR = baseDir;
		delete process.env.VIRTUAL_ENV;
		delete process.env.CONDA_PREFIX;
		fs.mkdirSync(path.join(baseDir, "project"), { recursive: true });
		const managed = await ensureNpiPythonEnv({ onProgress: progress => progressStages.push(progress.stage) });
		if (!managed) throw new Error("ensureNpiPythonEnv returned no interpreter");
		interpreter = managed;
	}, 240_000);

	it("ensure reports structured install progress", () => {
		expect(progressStages.length).toBeGreaterThan(0);
		expect(progressStages.some(stage => /extract|verif|environment|ready|install/i.test(stage))).toBe(true);
	});

	afterAll(() => {
		if (baseDir) fs.rmSync(baseDir, { recursive: true, force: true });
		restoreEnv("NPI_ENV_DIR");
		restoreEnv("VIRTUAL_ENV");
		restoreEnv("CONDA_PREFIX");
		restoreEnv("OPENAI_API_KEY");
		restoreEnv("PI_AUTO_QA_PUSH_TOKEN");
	});

	it("ensure provisions the bundled runtime and reports a versioned interpreter", () => {
		expect(path.isAbsolute(interpreter)).toBe(true);
		expect(fs.existsSync(interpreter)).toBe(true);
		expect(interpreter.startsWith(path.join(baseDir, "environments", "default", "versions"))).toBe(true);
		// The Rust manager versions environments; the old fixed path must not be assumed.
		expect(interpreter).not.toBe(npiManagedPythonPath());
	});

	it("environment reports the host health", async () => {
		const health = await readNpiPythonEnvironment();
		expect(health.ok).toBe(true);
		expect(health.pythonPath).toBe(interpreter);
		expect(health.pythonVersion).toMatch(/^\d+\.\d+\.\d+/);
		expect(health.uvVersion.length).toBeGreaterThan(0);
		expect(health.envPath.startsWith(baseDir)).toBe(true);
		expect(health.runtimePath.startsWith(baseDir)).toBe(true);
	});

	it("execute runs in the session workspace with a filtered environment", async () => {
		process.env.OPENAI_API_KEY = "should-not-leak";
		process.env.PI_AUTO_QA_PUSH_TOKEN = "should-not-leak";
		__resetShellConfigCacheForTests();
		const tool = new PythonTool(createSession("filter-session"));
		const result = await tool.execute("call-filter", {
			action: "execute",
			code: [
				"import os, sys",
				"print(os.getcwd())",
				"print(os.environ.get('OPENAI_API_KEY'))",
				"print(os.environ.get('PI_AUTO_QA_PUSH_TOKEN'))",
				"print(sys.executable)",
			].join("\n"),
		});
		expect(result.details?.exitCode).toBe(0);
		expect(result.details?.timedOut).toBe(false);
		const lines = result.details?.stdout?.trimEnd().split("\n") ?? [];
		expect(fs.realpathSync(lines[0]!)).toBe(fs.realpathSync(getNpiPythonWorkspaceDir("filter-session")));
		expect(lines[1]).toBe("None");
		expect(lines[2]).toBe("None");
		expect(fs.realpathSync(lines[3]!)).toBe(fs.realpathSync(interpreter));
		expect(result.details?.sessionId).toBe("filter-session");
		expect(result.details?.executionId).toMatch(/^[0-9a-f]{16}$/);
	}, 60_000);

	it("execute surfaces stderr and a failing exit code", async () => {
		const tool = new PythonTool(createSession("failure-session"));
		const result = await tool.execute("call-failure", {
			action: "execute",
			code: "import sys\nprint('before')\nprint('detail-on-stderr', file=sys.stderr)\nraise RuntimeError('boom')",
		});
		expect(result.isError).toBe(true);
		expect(result.details?.exitCode).not.toBe(0);
		expect(result.details?.stdout).toContain("before");
		expect(result.details?.stdout).toContain("detail-on-stderr");
		expect(result.details?.stdout).toContain("boom");
	}, 60_000);

	it("execute times out a running cell", async () => {
		const tool = new PythonTool(createSession("timeout-session"));
		const result = await tool.execute("call-timeout", {
			action: "execute",
			code: "import time\nprint('started', flush=True)\ntime.sleep(30)",
			timeout: 1,
		});
		expect(result.details?.timedOut).toBe(true);
		expect(result.isError).toBe(true);
		expect(result.details?.stdout).toContain("started");
		expect(result.details?.durationMs).toBeLessThan(20_000);
	}, 60_000);

	it("abort cancels a running cell", async () => {
		const marker = path.join(getNpiPythonWorkspaceDir("abort-session"), "started");
		const controller = new AbortController();
		const pending = new PythonTool(createSession("abort-session")).execute(
			"call-abort",
			{
				action: "execute",
				code: `import time\nopen(${JSON.stringify(marker)}, "w").close()\ntime.sleep(30)`,
			},
			controller.signal,
		);
		// Integration test against the real child: wait for its marker instead of
		// guessing a startup duration, then abort while it is definitely running.
		for (let attempt = 0; attempt < 1_000 && !fs.existsSync(marker); attempt++) await Bun.sleep(10);
		expect(fs.existsSync(marker)).toBe(true);
		controller.abort();
		await expect(pending).rejects.toThrow(/abort/i);
	}, 60_000);

	it("concurrent sessions get isolated working directories", async () => {
		const [first, second] = await Promise.all([
			new PythonTool(createSession("concurrent-a")).execute("call-a", {
				action: "execute",
				code: "import os; print(os.getpid()); print(os.getcwd())",
			}),
			new PythonTool(createSession("concurrent-b")).execute("call-b", {
				action: "execute",
				code: "import os; print(os.getpid()); print(os.getcwd())",
			}),
		]);
		const firstCwd = getNpiPythonWorkspaceDir("concurrent-a");
		const secondCwd = getNpiPythonWorkspaceDir("concurrent-b");
		expect(first.details?.cwd).toBe(firstCwd);
		expect(second.details?.cwd).toBe(secondCwd);
		const [firstPid, firstPrintedCwd] = first.details?.stdout?.trim().split("\n") ?? [];
		const [secondPid, secondPrintedCwd] = second.details?.stdout?.trim().split("\n") ?? [];
		expect(Number.isInteger(Number(firstPid))).toBe(true);
		expect(Number.isInteger(Number(secondPid))).toBe(true);
		expect(Number(firstPid)).not.toBe(Number(secondPid));
		expect(fs.realpathSync(firstPrintedCwd ?? "")).toBe(fs.realpathSync(firstCwd));
		expect(fs.realpathSync(secondPrintedCwd ?? "")).toBe(fs.realpathSync(secondCwd));
	}, 60_000);

	it("packages list is bound to the managed environment", async () => {
		const result = await new PythonTool(createSession("package-session")).execute("call-list", {
			action: "packages",
			operation: "list",
		});
		const packages = result.details?.packages ?? [];
		expect(Array.isArray(packages)).toBe(true);
		expect(result.details?.pythonPath).toBe(interpreter);
		const names = packages.map(item => item.name);
		expect([...names].sort((left, right) => left.localeCompare(right))).toEqual(names);
	}, 60_000);

	it("package install declares exec approval and interpreter is not a system fallback", async () => {
		const tool = new PythonTool(createSession("approval-session"));
		const decide = tool.approval as (args: unknown) => unknown;
		expect(decide({ action: "environment" })).toBe("read");
		expect(decide({ action: "packages", operation: "list" })).toBe("read");
		expect(decide({ action: "packages", operation: "install" })).toMatchObject({ tier: "exec" });
		expect(decide({ action: "execute" })).toBe("exec");

		const previousMode = process.env.NPI_APP_MODE;
		try {
			for (const mode of ["chat", "academic"]) {
				process.env.NPI_APP_MODE = mode;
				await expect(
					tool.execute("call-interpreter", {
						action: "execute",
						code: "print('nope')",
						interpreter: "/usr/bin/python3",
					}),
				).rejects.toThrow(/Code mode/);
			}
		} finally {
			if (previousMode === undefined) delete process.env.NPI_APP_MODE;
			else process.env.NPI_APP_MODE = previousMode;
		}
	}, 60_000);

	it("does not enumerate a system Python before provisioning", () => {
		const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "npi-python-fresh-"));
		const previous = process.env.NPI_ENV_DIR;
		process.env.NPI_ENV_DIR = fresh;
		try {
			const runtimes = enumeratePythonRuntimes(baseDir, {
				PATH: "/usr/bin:/bin:/usr/local/bin",
				HOME: os.homedir(),
			});
			expect(runtimes).toEqual([]);
		} finally {
			fs.rmSync(fresh, { recursive: true, force: true });
			if (previous === undefined) delete process.env.NPI_ENV_DIR;
			else process.env.NPI_ENV_DIR = previous;
		}
	});
});
