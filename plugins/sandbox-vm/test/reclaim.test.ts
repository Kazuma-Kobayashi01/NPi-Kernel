import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { formatBytes, IMAGE_FILES, imageInfo, reclaimImage } from "../src/reclaim";
import { VmController } from "../src/vm-controller";

const roots: string[] = [];

async function makeImage(extra: Record<string, string> = {}): Promise<{ root: string; image: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "vm-reclaim-"));
	roots.push(root);
	const image = path.join(root, "sandbox-vm", "image");
	await fs.mkdir(image, { recursive: true });
	for (const name of IMAGE_FILES) await Bun.write(path.join(image, name), "x".repeat(10));
	for (const [name, text] of Object.entries(extra)) await Bun.write(path.join(image, name), text);
	return { root, image };
}

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("reclaiming the guest image", () => {
	it("measures the image and deletes it with its now-empty folders", async () => {
		const { root, image } = await makeImage();
		expect(await imageInfo(image)).toEqual({ bytes: 30, files: [...IMAGE_FILES] });

		const freed = await reclaimImage(image, path.join(root, "sandbox-vm"));

		expect(freed.bytes).toBe(30);
		expect(await fs.readdir(root)).toEqual([]);
	});

	it("leaves files it did not write, and the folder that holds them", async () => {
		const { image } = await makeImage({ "notes.txt": "mine" });

		await reclaimImage(image, path.dirname(image));

		expect(await fs.readdir(image)).toEqual(["notes.txt"]);
	});

	it("frees nothing when there is no image", async () => {
		const freed = await reclaimImage(path.join(os.tmpdir(), "vm-reclaim-missing"));
		expect(freed).toEqual({ bytes: 0, files: [] });
	});

	it("stops the VM before the controller deletes the image", async () => {
		const { image } = await makeImage();
		const controller = new VmController({
			loadConfig: async () => ({ ...DEFAULT_CONFIG, image }),
			routes: false,
			helperCommand: async () => [process.execPath, path.join(import.meta.dir, "fake-helper.ts")],
		});
		controller.setProjectDir(os.tmpdir());
		await controller.start();

		const freed = await controller.reclaim();

		expect(controller.status.state).toBe("stopped");
		expect(freed.bytes).toBe(30);
		expect((await imageInfo(image)).files).toEqual([]);
	});

	it("cleans up the custom image, the settings file and its folder, leaving foreign files", async () => {
		const { root, image } = await makeImage({ "notes.txt": "mine" });
		const configFile = path.join(root, "sandbox-vm.json");
		await Bun.write(configFile, JSON.stringify({ image }));
		const controller = new VmController({
			loadConfig: async () => ({ ...DEFAULT_CONFIG, image }),
			routes: false,
			configFile,
		});

		const done = await controller.cleanUp();

		expect(done.freed.bytes).toBe(30);
		expect(done.configRemoved).toBe(true);
		expect(await fs.readdir(image)).toEqual(["notes.txt"]);
		expect(await Bun.file(configFile).exists()).toBe(false);
		// A second run finds nothing left to remove.
		expect((await controller.cleanUp()).configRemoved).toBe(false);
	});

	it("formats sizes", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(71_500_000)).toBe("68.2 MB");
	});
});
