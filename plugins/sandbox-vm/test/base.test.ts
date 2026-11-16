import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { bundledImageDir, DEFAULT_CONFIG, defaultImageDir, imageDirs, loadConfig, saveBase } from "../src/config";
import { IMAGE_FILES, imageInfo } from "../src/reclaim";
import { VmController } from "../src/vm-controller";

const FAKE_HELPER = path.join(import.meta.dir, "fake-helper.ts");
const roots: string[] = [];
const dataEnv = Bun.env.NPI_VM_DATA_DIR;
const bundledEnv = Bun.env.NPI_VM_BUNDLED_DIR;

async function makeData(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "vm-base-"));
	roots.push(root);
	Bun.env.NPI_VM_DATA_DIR = root;
	return root;
}

async function writeImage(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	for (const name of IMAGE_FILES) await Bun.write(path.join(dir, name), "x".repeat(10));
}

afterEach(async () => {
	if (dataEnv === undefined) delete Bun.env.NPI_VM_DATA_DIR;
	else Bun.env.NPI_VM_DATA_DIR = dataEnv;
	if (bundledEnv === undefined) delete Bun.env.NPI_VM_BUNDLED_DIR;
	else Bun.env.NPI_VM_BUNDLED_DIR = bundledEnv;
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("VM bases", () => {
	it("keeps one image folder per base, the settings' image replacing only the selected base's", async () => {
		const root = await makeData();
		expect(defaultImageDir("alpine")).toBe(path.join(root, "image"));
		expect(defaultImageDir("ubuntu")).toBe(path.join(root, "image-ubuntu"));

		const dirs = imageDirs({ ...DEFAULT_CONFIG, base: "ubuntu", image: "/custom/ubuntu" });
		expect(dirs).toEqual({ alpine: path.join(root, "image"), ubuntu: "/custom/ubuntu" });
	});

	it("reads the base from the settings file and ignores an unknown one", async () => {
		const root = await makeData();
		const file = path.join(root, "sandbox-vm.json");
		await Bun.write(file, JSON.stringify({ base: "ubuntu", cpus: 4 }));
		expect((await loadConfig(file)).base).toBe("ubuntu");
		await Bun.write(file, JSON.stringify({ base: "debian" }));
		expect((await loadConfig(file)).base).toBe("alpine");
	});

	it("saves the base without dropping the other settings", async () => {
		const root = await makeData();
		const file = path.join(root, "agent", "sandbox-vm.json");
		await saveBase("ubuntu", file);
		expect(await Bun.file(file).json()).toEqual({ base: "ubuntu" });

		await Bun.write(file, JSON.stringify({ cpus: 4, network: "nat" }));
		await saveBase("alpine", file);
		expect(await Bun.file(file).json()).toEqual({ cpus: 4, network: "nat", base: "alpine" });
	});

	it("stops the VM when the base is switched, and boots the new one next time", async () => {
		await makeData();
		let base = DEFAULT_CONFIG.base;
		const controller = new VmController({
			loadConfig: async () => ({ ...DEFAULT_CONFIG, base }),
			saveBase: async next => {
				base = next;
			},
			routes: false,
			helperCommand: async () => [process.execPath, FAKE_HELPER],
		});
		controller.setProjectDir(os.tmpdir());
		await controller.start();
		expect(controller.status.state).toBe("running");

		await controller.setBase("ubuntu");

		expect(controller.status.state).toBe("stopped");
		expect(await controller.base()).toBe("ubuntu");
		await controller.stop();
	});

	it("reclaims the selected base by default and every base on request", async () => {
		const root = await makeData();
		await writeImage(path.join(root, "image"));
		await writeImage(path.join(root, "image-ubuntu"));
		const controller = new VmController({
			loadConfig: async () => ({ ...DEFAULT_CONFIG, base: "ubuntu" }),
			routes: false,
			helperCommand: async () => [process.execPath, FAKE_HELPER],
		});

		const first = await controller.reclaim();
		expect(first.bytes).toBe(30);
		expect((await imageInfo(path.join(root, "image-ubuntu"))).files).toEqual([]);
		expect((await imageInfo(path.join(root, "image"))).files.length).toBe(3);

		const second = await controller.reclaim("all");
		expect(second.bytes).toBe(30);
		// The data folder itself goes with its last image.
		await expect(fs.access(root)).rejects.toThrow();
	});

	it("names the base to build when its image is missing", async () => {
		await makeData();
		const controller = new VmController({
			loadConfig: async () => ({ ...DEFAULT_CONFIG, base: "ubuntu" }),
			routes: false,
			helperCommand: async () => [
				process.execPath,
				"-e",
				`process.stdin.on("data", d => { const r = JSON.parse(d.toString().split("\\n")[0]); console.log(JSON.stringify({ id: r.id, type: "error", message: "VM image not found in \\"x\\"; build it" })); })`,
			],
		});
		controller.setProjectDir(os.tmpdir());

		await expect(controller.start()).rejects.toThrow("scripts/build-image.sh ubuntu");
		await controller.stop().catch(() => undefined);
	});

	it("boots the image shipped in the package unless one was built on this machine", async () => {
		const root = await makeData();
		Bun.env.NPI_VM_BUNDLED_DIR = path.join(root, "bundled");
		await writeImage(bundledImageDir("ubuntu"));
		const controller = new VmController({
			loadConfig: async () => ({ ...DEFAULT_CONFIG, base: "ubuntu" }),
			routes: false,
			helperCommand: async () => [process.execPath, FAKE_HELPER],
		});
		controller.setProjectDir(os.tmpdir());
		const booted = async (): Promise<string> => {
			let output = "";
			await controller.start();
			await controller.backend.run("__config", {
				cwd: os.tmpdir(),
				env: {},
				signal: new AbortController().signal,
				onChunk: chunk => {
					output += chunk;
				},
			});
			await controller.stop();
			return (JSON.parse(output) as { image: string }).image;
		};

		expect(await booted()).toBe(bundledImageDir("ubuntu"));
		expect((await controller.images()).ubuntu).toMatchObject({ bundled: true, local: { bytes: 0 } });

		await writeImage(defaultImageDir("ubuntu"));
		expect(await booted()).toBe(defaultImageDir("ubuntu"));

		// Reclaiming deletes what was built here and leaves the packaged image.
		const freed = await controller.reclaim("ubuntu");
		expect(freed.bytes).toBe(30);
		expect((await imageInfo(bundledImageDir("ubuntu"))).files.length).toBe(3);
	});
});
