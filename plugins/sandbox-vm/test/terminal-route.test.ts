import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { pruneRoutes, removeRoute, routePaths, writeRoute } from "../src/terminal-route";
import { VmController } from "../src/vm-controller";

const FAKE_HELPER = path.join(import.meta.dir, "fake-helper.ts");
// A pid no real process has, so the test never touches the route of a running omp.
const PID = 2_000_000_000;

afterEach(async () => {
	await removeRoute(PID);
});

describe("terminal route", () => {
	it("publishes the helper and the socket in an owner-only folder, and withdraws them", async () => {
		const route = await writeRoute("/opt/npi/npi-vm-helper", PID);
		const { dir, file, socket } = routePaths(PID);

		expect(route).toEqual({ helper: "/opt/npi/npi-vm-helper", socket });
		expect(await Bun.file(file).json()).toEqual(route);
		expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
		expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
		// A macOS unix socket path has to stay under 104 bytes.
		expect(socket.length).toBeLessThan(104);
		expect(path.dirname(socket)).toBe(path.join(os.tmpdir(), "npi-vm-routes"));

		await removeRoute(PID);
		await expect(fs.access(file)).rejects.toThrow();
	});

	it("is published when the VM runs and withdrawn when it stops", async () => {
		const events: string[] = [];
		const controller = new VmController({
			loadConfig: async () => ({ ...DEFAULT_CONFIG }),
			helperCommand: async () => [process.execPath, FAKE_HELPER],
			routes: {
				publish: async helper => void events.push(`publish ${path.basename(helper)}`),
				withdraw: async () => void events.push("withdraw"),
			},
		});
		controller.setProjectDir(os.tmpdir());

		await controller.start();
		expect(events).toEqual([`publish ${path.basename(process.execPath)}`]);
		await controller.stop();
		expect(events).toEqual([`publish ${path.basename(process.execPath)}`, "withdraw"]);
	});

	it("prunes the files of processes that are gone and keeps those of live ones", async () => {
		const dead = routePaths(PID);
		await fs.mkdir(dead.dir, { recursive: true, mode: 0o700 });
		await Bun.write(dead.file, "{}");
		await Bun.write(routePaths(process.pid).file, "{}");

		await pruneRoutes();

		await expect(fs.access(dead.file)).rejects.toThrow();
		await fs.access(routePaths(process.pid).file);
		await removeRoute(process.pid);
	});
});
