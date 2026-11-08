import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import {
	buildSeatbeltProfile,
	gitWriteRoots,
	sandboxSupported,
	sandboxWritableRoots,
} from "@oh-my-pi/pi-coding-agent/sandbox/seatbelt";

let root: string;

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "npi-sandbox-test-")));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("Seatbelt profile", () => {
	it.skipIf(!sandboxSupported())("lets the process tree write only inside the writable roots", () => {
		const allowed = path.join(root, "allowed");
		const denied = path.join(root, "denied");
		fs.mkdirSync(allowed);
		fs.mkdirSync(denied);
		// Only `allowed` is listed: the temporary folder holding both is not,
		// so this exercises the deny rule rather than a broad tmp allowance.
		const { profile, params } = buildSeatbeltProfile([allowed]);
		const run = Bun.spawnSync([
			"/usr/bin/sandbox-exec",
			...params,
			"-p",
			profile,
			"/bin/sh",
			"-c",
			`echo a > '${allowed}/in.txt' && /bin/sh -c "echo b > '${denied}/out.txt'"`,
		]);
		expect(fs.readFileSync(path.join(allowed, "in.txt"), "utf8")).toBe("a\n");
		expect(fs.existsSync(path.join(denied, "out.txt"))).toBe(false);
		expect(run.stderr.toString()).toContain("Operation not permitted");
	});

	it("passes roots as parameters so a quote in a folder name cannot break the profile", () => {
		const { profile, params } = buildSeatbeltProfile(['/tmp/a"b']);
		expect(params).toEqual(["-D", 'W0=/tmp/a"b']);
		expect(profile).not.toContain('a"b');
		expect(profile).toContain('(subpath (param "W0"))');
	});
});

describe("sandbox writable roots", () => {
	it("makes a linked worktree's private and shared git directories writable", () => {
		const commonGit = path.join(root, "main", ".git");
		const worktreeGit = path.join(commonGit, "worktrees", "feature");
		const checkout = path.join(root, "feature");
		fs.mkdirSync(worktreeGit, { recursive: true });
		fs.mkdirSync(path.join(checkout, "src"), { recursive: true });
		fs.writeFileSync(path.join(checkout, ".git"), `gitdir: ${worktreeGit}\n`);
		fs.writeFileSync(path.join(worktreeGit, "commondir"), "../..\n");

		expect(gitWriteRoots(path.join(checkout, "src"))).toEqual([checkout, worktreeGit, commonGit]);
	});

	it("includes the project's repository only in workspace-write", () => {
		const repo = path.join(root, "repo");
		const sub = path.join(repo, "pkg");
		fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
		fs.mkdirSync(sub);

		const workspace = sandboxWritableRoots("workspace-write", sub, []);
		expect(workspace).toContain(repo);
		expect(workspace).toContain(sub);
		const readOnly = sandboxWritableRoots("read-only", sub, []);
		expect(readOnly).not.toContain(repo);
		expect(readOnly).not.toContain(sub);
	});

	it("adds existing extra folders and drops relative or missing ones", () => {
		const extra = path.join(root, "cache");
		fs.mkdirSync(extra);
		const roots = sandboxWritableRoots("read-only", root, [extra, "relative/dir", path.join(root, "missing")]);
		expect(roots).toContain(extra);
		expect(roots.some(entry => entry.endsWith("relative/dir") || entry.endsWith("missing"))).toBe(false);
	});
});

describe("--sandbox flag", () => {
	it("accepts the three modes and records anything else as an invalid value", () => {
		expect(parseArgs(["--sandbox", "read-only"]).sandbox).toBe("read-only");
		const invalid = parseArgs(["--sandbox", "strict"]);
		expect(invalid.sandbox).toBeUndefined();
		expect(invalid.invalidFlagValues.join("\n")).toContain("--sandbox");
	});
});
