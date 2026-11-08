/**
 * NPi Python integration: the desktop runtime host and the `python` tool.
 *
 * These tests exercise the real thing. `ensure` unpacks the bundled CPython
 * through the Rust host into a fresh temporary `NPI_ENV_DIR`; the `python` tool
 * reports and manages that interpreter (no system Python, no scripted stand-in).
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
	npiManagedPythonPath,
	readNpiPythonEnvironment,
} from "@oh-my-pi/pi-coding-agent/eval/py/runtime";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { getNpiEnvDir, getNpiManagedPythonEnvDir } from "@oh-my-pi/pi-utils";
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

	it("package install declares exec approval and running code is left to eval", async () => {
		const tool = new PythonTool(createSession("approval-session"));
		const decide = tool.approval as (args: unknown) => unknown;
		expect(decide({ action: "environment" })).toBe("read");
		expect(decide({ action: "packages", operation: "list" })).toBe("read");
		expect(decide({ action: "packages", operation: "install" })).toMatchObject({ tier: "exec" });
		await expect(tool.execute("call-execute", { action: "execute", code: "print('nope')" } as never)).rejects.toThrow(
			/Unsupported python action/,
		);
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
