import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetDirsFromEnvForTests,
	getCheckpointsDir,
	getPuppeteerDir,
	getSessionsDir,
	getWorktreesDir,
	migrateLegacyCaches,
} from "@oh-my-pi/pi-utils/dirs";

const ENV_KEYS = [
	"HOME",
	"USERPROFILE",
	"OMP_PROFILE",
	"PI_PROFILE",
	"PI_CONFIG_DIR",
	"PI_CODING_AGENT_DIR",
	"OMP_WORKTREE_DIR",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
] as const;

describe("cache root and worktree defaults", () => {
	let tempRoot = "";
	let home = "";
	let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

	beforeEach(async () => {
		originalEnv = {};
		for (const key of ENV_KEYS) {
			originalEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-utils-cache-root-"));
		home = path.join(tempRoot, "home");
		await fs.mkdir(home);
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		__resetDirsFromEnvForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const key of ENV_KEYS) {
			const value = originalEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		__resetDirsFromEnvForTests();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("keeps sessions in the data root and caches, checkpoints and worktrees out of it", () => {
		expect(getSessionsDir()).toBe(path.join(home, ".local", "share", "npi", "agent", "sessions"));
		expect(getPuppeteerDir()).toBe(path.join(home, ".cache", "npi", "puppeteer"));
		expect(getCheckpointsDir()).toBe(path.join(home, ".cache", "npi", "agent", "checkpoints"));
		expect(getWorktreesDir()).toBe(path.join(home, "Documents", "NPi", "Code", ".agent-worktrees"));
	});

	it("keeps everything inside a PI_CONFIG_DIR-relocated root", () => {
		process.env.PI_CONFIG_DIR = ".sandbox";
		__resetDirsFromEnvForTests();
		expect(getPuppeteerDir()).toBe(path.join(home, ".sandbox", "puppeteer"));
		expect(getCheckpointsDir()).toBe(path.join(home, ".sandbox", "agent", "checkpoints"));
		expect(getWorktreesDir()).toBe(path.join(home, ".sandbox", "wt"));
	});

	it("moves old caches to the cache root once and drops a copy the new root already has", async () => {
		const data = path.join(home, ".local", "share", "npi");
		const cache = path.join(home, ".cache", "npi");
		await fs.mkdir(path.join(data, "agent", "checkpoints", "p"), { recursive: true });
		await Bun.write(path.join(data, "agent", "checkpoints", "p", "m.json"), "{}");
		await Bun.write(path.join(data, "puppeteer", "old"), "x");
		await Bun.write(path.join(cache, "puppeteer", "new"), "y");
		await Bun.write(path.join(data, "agent", "sessions", "s.jsonl"), "{}");

		migrateLegacyCaches();
		migrateLegacyCaches();

		expect(await Bun.file(path.join(cache, "agent", "checkpoints", "p", "m.json")).text()).toBe("{}");
		expect(await Bun.file(path.join(data, "agent", "checkpoints")).exists()).toBe(false);
		await expect(fs.stat(path.join(data, "puppeteer"))).rejects.toThrow();
		expect(await Bun.file(path.join(cache, "puppeteer", "new")).text()).toBe("y");
		expect(await Bun.file(path.join(data, "agent", "sessions", "s.jsonl")).text()).toBe("{}");
	});
});
