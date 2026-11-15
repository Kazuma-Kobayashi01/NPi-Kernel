import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { parseRegistry, type RegistryAgent, resolveLaunch } from "@oh-my-pi/pi-coding-agent/side-agent/registry";
import * as utils from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $, type Server } from "bun";

const PLATFORM = "darwin-aarch64";

function agent(distribution: RegistryAgent["distribution"]): RegistryAgent {
	return { id: "fake-agent", name: "Fake Agent", version: "1.2.3", distribution };
}

describe("side agent registry", () => {
	let home: TempDir;
	let server: Server<undefined> | undefined;

	beforeEach(() => {
		home = TempDir.createSync("@npi-side-agents-");
		vi.spyOn(utils, "getSideAgentsDir").mockReturnValue(home.path());
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		server?.stop(true);
		server = undefined;
		await home.remove();
	});

	it("drops entries whose id or version could leave the install folder", () => {
		const parsed = parseRegistry({
			agents: [
				{ id: "good", name: "Good", version: "1.0.0", distribution: {} },
				{ id: "../evil", name: "Evil", version: "1.0.0", distribution: {} },
				{ id: "sneaky", name: "Sneaky", version: "../../bin", distribution: {} },
				{ id: "nodist", name: "No distribution", version: "1.0.0" },
			],
		});
		expect(parsed.map(a => a.id)).toEqual(["good"]);
	});

	/** Serves one zip holding `bin/run` (a script printing "started") and returns its URL, sha256 and hit count. */
	async function serveArchive(): Promise<{ url: string; sha256: string; hits: () => number }> {
		const src = path.join(home.path(), "src");
		await Bun.write(path.join(src, "bin", "run"), "#!/bin/sh\necho started\n");
		await $`chmod +x ${path.join(src, "bin", "run")}`.quiet();
		const zip = path.join(home.path(), "agent.zip");
		await $`cd ${src} && zip -qr ${zip} bin`.quiet();
		const bytes = await Bun.file(zip).bytes();
		let hits = 0;
		server = Bun.serve({
			port: 0,
			fetch: () => {
				hits++;
				return new Response(bytes);
			},
		});
		const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
		return { url: `http://127.0.0.1:${server.port}/agent.zip`, sha256, hits: () => hits };
	}

	it("installs a pinned binary once per version and starts it from the install folder", async () => {
		const archive = await serveArchive();
		const entry = agent({
			binary: { [PLATFORM]: { archive: archive.url, cmd: "./bin/run", sha256: archive.sha256 } },
		});
		const launch = await resolveLaunch(entry, PLATFORM);
		expect(launch.command).toBe(path.join(home.path(), "fake-agent", "1.2.3", "bin", "run"));
		expect((await $`${launch.command}`.quiet().text()).trim()).toBe("started");
		await resolveLaunch(entry, PLATFORM);
		expect(archive.hits()).toBe(1);
	});

	it("refuses a download whose checksum does not match and leaves nothing installed", async () => {
		const archive = await serveArchive();
		const entry = agent({
			binary: { [PLATFORM]: { archive: archive.url, cmd: "./bin/run", sha256: "0".repeat(64) } },
		});
		await expect(resolveLaunch(entry, PLATFORM)).rejects.toThrow(/checksum mismatch/);
		expect(await Bun.file(path.join(home.path(), "fake-agent", "1.2.3", ".installed")).exists()).toBe(false);
	});

	it("never runs an unpinned binary: falls back to npx, or explains why it can't start", async () => {
		const unpinned = { [PLATFORM]: { archive: "http://127.0.0.1:1/x.zip", cmd: "./run" } };
		vi.spyOn(utils, "$which").mockImplementation(cmd => (cmd === "npx" ? "/usr/local/bin/npx" : null));
		const viaNpx = await resolveLaunch(
			agent({ binary: unpinned, npx: { package: "@acme/agent@1.2.3", args: ["--acp"] } }),
			PLATFORM,
		);
		expect([viaNpx.command, ...viaNpx.args]).toEqual(["/usr/local/bin/npx", "-y", "@acme/agent@1.2.3", "--acp"]);

		await expect(resolveLaunch(agent({ binary: unpinned }), PLATFORM)).rejects.toThrow(/SHA-256/);
	});
});
