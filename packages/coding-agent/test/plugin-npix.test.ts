import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runPluginCommand } from "@oh-my-pi/pi-coding-agent/cli/plugin-cli";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import { MarketplaceManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { inspectNpix, installNpix, packNpix } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/npix";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

const DEVELOPER = { name: "Ada Lovelace", email: "ada@example.com", url: "https://example.com" };

async function writePlugin(dir: string, entry = "./index.ts", developer: unknown = DEVELOPER): Promise<void> {
	// `null`: the package has no developer.json
	if (developer !== null) await Bun.write(path.join(dir, "developer.json"), JSON.stringify(developer));
	await Bun.write(
		path.join(dir, "package.json"),
		JSON.stringify({ name: "@npi/plugin-sample", version: "1.2.0", omp: { extensions: [entry] } }),
	);
	await Bun.write(path.join(dir, "index.ts"), "export default function () {}\n");
	// a bundled dependency travels inside the package
	await Bun.write(path.join(dir, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
}

describe(".npix packages", () => {
	let tmpRoot: string;
	let pluginsDir: string;

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "npi-npix-"));
		pluginsDir = path.join(tmpRoot, "plugins");
		await fs.mkdir(path.join(pluginsDir, "node_modules"), { recursive: true });
		spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir);
		spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(path.join(pluginsDir, "node_modules"));
		spyOn(piUtils, "getPluginsPackageJson").mockReturnValue(path.join(pluginsDir, "package.json"));
		spyOn(piUtils, "getPluginsLockfile").mockReturnValue(path.join(tmpRoot, "omp-plugins.lock.json"));
		spyOn(piUtils, "getProjectDir").mockReturnValue(tmpRoot);
		spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(tmpRoot, "plugin-overrides.json"));
		spyOn(MarketplaceManager.prototype, "listMarketplaces").mockResolvedValue([]);
		spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([]);
		spyOn(console, "log").mockImplementation(() => undefined);
		spyOn(console, "error").mockImplementation(() => undefined);
	});

	afterEach(async () => {
		mock.restore();
		await removeWithRetries(tmpRoot);
	});

	test("pack, install and uninstall: the plugin is listed from its unpacked copy, then fully removed", async () => {
		const source = path.join(tmpRoot, "src");
		await writePlugin(source);
		const { file, info } = await packNpix(source, path.join(tmpRoot, "sample.npix"));
		expect(info.capabilities.extensions).toEqual(["./index.ts"]);
		// inspect reads the unpacked copy before its temp folder goes away
		expect(await inspectNpix(file)).toMatchObject({ name: "@npi/plugin-sample", version: "1.2.0" });

		// `json` output: runPluginCommand does not initialize the theme its plain messages use
		await runPluginCommand({ action: "install", args: [file], flags: { json: true } });
		const installed = (await new PluginManager().list()).find(p => p.name === "@npi/plugin-sample");
		expect(installed?.enabled).toBe(true);
		// what the Desktop's plugin list reads: source and developer of each npm entry
		const log = spyOn(console, "log").mockImplementation(() => undefined);
		await runPluginCommand({ action: "list", args: [], flags: { json: true } });
		const listed = JSON.parse(String(log.mock.calls.at(-1)?.[0])).npm.find(
			(p: { name: string }) => p.name === "@npi/plugin-sample",
		);
		expect(listed).toMatchObject({ npix: true, developer: DEVELOPER });
		const unpacked = path.join(pluginsDir, "npix", "@npi__plugin-sample", "1.2.0");
		expect(await fs.realpath(path.join(pluginsDir, "node_modules", "@npi", "plugin-sample"))).toBe(
			await fs.realpath(unpacked),
		);
		expect(await Bun.file(path.join(unpacked, "node_modules", "dep", "index.js")).exists()).toBe(true);

		await runPluginCommand({ action: "uninstall", args: ["@npi/plugin-sample"], flags: { json: true } });
		expect((await new PluginManager().list()).some(p => p.name === "@npi/plugin-sample")).toBe(false);
		expect(await Bun.file(path.join(unpacked, "package.json")).exists()).toBe(false);
	});

	test("refuses archives with entries outside package/ or with symlinks, and writes nothing", async () => {
		const outside = path.join(tmpRoot, "outside.txt");
		await Bun.write(outside, "x");
		const absolute = path.join(tmpRoot, "absolute.npix");
		await $`tar -czPf ${absolute} ${outside}`.quiet();
		await expect(inspectNpix(absolute)).rejects.toThrow(/outside package\//);

		const linked = path.join(tmpRoot, "linked");
		await writePlugin(path.join(linked, "package"));
		await fs.symlink("/etc", path.join(linked, "package", "etc"));
		const withLink = path.join(tmpRoot, "with-link.npix");
		await $`tar -czf ${withLink} -C ${linked} package`.quiet();
		await expect(installNpix(new PluginManager(), withLink)).rejects.toThrow(/symlink/);
		expect(await Bun.file(path.join(pluginsDir, "npix")).exists()).toBe(false);
		expect(await fs.readdir(path.join(pluginsDir, "node_modules"))).toEqual([]);
	});

	test("will not pack a plugin whose declared entry is missing", async () => {
		const source = path.join(tmpRoot, "broken");
		await writePlugin(source, "./missing.ts");
		await expect(packNpix(source)).rejects.toThrow(/missing\.ts/);
	});

	test("every package names its developer in a valid developer.json", async () => {
		const anonymous = path.join(tmpRoot, "anonymous");
		await writePlugin(anonymous, "./index.ts", null);
		await expect(packNpix(anonymous)).rejects.toThrow(/developer\.json is missing/);
		const badUrl = path.join(tmpRoot, "bad-url");
		await writePlugin(badUrl, "./index.ts", { name: "Ada", url: "javascript:alert(1)" });
		await expect(packNpix(badUrl)).rejects.toThrow(/http\(s\) URL/);
	});
});
