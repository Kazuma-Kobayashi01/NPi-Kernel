import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { planFileRestore, restoreFileCheckpoint, takeFileCheckpoint } from "../../src/session/file-checkpoints";

describe("file checkpoints", () => {
	let base: string;
	let root: string;
	let previousAgentDir: string | undefined;

	beforeEach(async () => {
		base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "file-checkpoints-")));
		root = path.join(base, "proj");
		await fs.mkdir(path.join(root, "src"), { recursive: true });
		await Bun.write(path.join(root, "a.txt"), "one\n");
		await Bun.write(path.join(root, "gone.txt"), "keep me\n");
		await Bun.write(path.join(root, ".gitignore"), "secret.env\n");
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		setAgentDir(path.join(base, "agent"));
	});

	afterEach(async () => {
		if (previousAgentDir) setAgentDir(previousAgentDir);
		await fs.rm(base, { recursive: true, force: true });
	});

	const read = (rel: string) => Bun.file(path.join(root, rel)).text();

	it("puts changed, deleted and new files back and leaves ignored ones", async () => {
		const ref = await takeFileCheckpoint(root, 60_000);
		expect(ref).toBeDefined();

		await Bun.write(path.join(root, "a.txt"), "two\n");
		await fs.rm(path.join(root, "gone.txt"));
		await Bun.write(path.join(root, "new/deep/b.txt"), "new\n");
		await Bun.write(path.join(root, "secret.env"), "ignored\n");

		expect(await planFileRestore(ref!)).toEqual([
			{ path: "a.txt", removes: false },
			{ path: "gone.txt", removes: false },
			{ path: "new/deep/b.txt", removes: true },
		]);

		expect(await restoreFileCheckpoint(ref!)).toBe(3);
		expect(await read("a.txt")).toBe("one\n");
		expect(await read("gone.txt")).toBe("keep me\n");
		expect(await Bun.file(path.join(root, "new/deep/b.txt")).exists()).toBe(false);
		expect(await fs.stat(path.join(root, "new")).catch(() => null)).toBeNull();
		expect((await fs.stat(path.join(root, "src"))).isDirectory()).toBe(true);
		expect(await read("secret.env")).toBe("ignored\n");
		expect(await planFileRestore(ref!)).toEqual([]);
	});

	it("keeps the executable bit", async () => {
		await fs.chmod(path.join(root, "a.txt"), 0o755);
		const ref = await takeFileCheckpoint(root, 60_000);
		await fs.rm(path.join(root, "a.txt"));
		await restoreFileCheckpoint(ref!);
		expect((await fs.stat(path.join(root, "a.txt"))).mode & 0o777).toBe(0o755);
	});

	it("leaves a Git repository's own folder out", async () => {
		await Bun.write(path.join(root, ".git/HEAD"), "ref: refs/heads/main\n");
		const ref = await takeFileCheckpoint(root, 60_000);
		await Bun.write(path.join(root, ".git/HEAD"), "ref: refs/heads/other\n");
		expect(await planFileRestore(ref!)).toEqual([]);
	});

	it("does not hold a prompt up for a slow snapshot, and the next one is usable", async () => {
		expect(await takeFileCheckpoint(root, 0)).toBeUndefined();
		await Bun.sleep(200);
		expect(await takeFileCheckpoint(root, 60_000)).toBeDefined();
	});

	it("stops at the store's size and stays stopped", async () => {
		expect(await takeFileCheckpoint(root, 60_000, 1)).toBeUndefined();
		expect(await takeFileCheckpoint(root, 60_000)).toBeUndefined();
	});

	it("reports a snapshot that is gone", async () => {
		expect(await planFileRestore({ root, id: "nope" })).toBeUndefined();
		await expect(restoreFileCheckpoint({ root, id: "nope" })).rejects.toThrow("gone");
	});
});
