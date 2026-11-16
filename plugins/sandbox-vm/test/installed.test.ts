/**
 * The shipped path: pack the plugin, install the .npix into a fresh npi home, and start the real VM through the
 * installed copy with a compiled kernel. Needs NPI_BIN (the binary), the helper and the guest image.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import { defaultImageDir } from "../src/config";

const NPI = process.env.NPI_BIN ?? "";
const PLUGIN_DIR = path.join(import.meta.dir, "..");
const IMAGE = process.env.NPI_VM_IMAGE_DIR ?? defaultImageDir();
const ready =
	NPI !== "" &&
	fs.existsSync(NPI) &&
	fs.existsSync(path.join(PLUGIN_DIR, "bin", "npi-vm-helper")) &&
	fs.existsSync(path.join(IMAGE, "Image")) &&
	fs.existsSync(path.join(IMAGE, "rootfs.cpio.gz"));

/**
 * Only lets RPC mode start: no prompt is sent, so the provider is never called. Loaded with `-e`, which adds to the
 * installed plugins; `--trusted-extension` would replace them.
 */
const providerExtension = `
export default function (pi) {
	pi.registerProvider("scripted", {
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "scripted-key",
		api: "scripted-none",
		models: [{ id: "none", name: "Never called", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
		streamSimple: () => { throw new Error("not used"); },
	});
}
`;

describe.skipIf(!ready)("sandbox-vm as installed from a .npix", () => {
	it("keeps the helper executable and signed, and starts the VM from the installed copy", async () => {
		await using temp = await TempDir.create("@sandbox-vm-installed-");
		const env = {
			PATH: Bun.env.PATH ?? "",
			HOME: temp.join("home"),
			PI_CODING_AGENT_DIR: temp.join("agent"),
			XDG_CONFIG_HOME: temp.join("config"),
			XDG_DATA_HOME: temp.join("data"),
			XDG_CACHE_HOME: temp.join("cache"),
			CI: "true",
			PI_NO_TITLE: "1",
		};
		const npi = async (...args: string[]) => {
			const child = Bun.spawn([NPI, ...args], { env, stdout: "pipe", stderr: "pipe" });
			const [out, err, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(code, `${args.join(" ")}: ${out}${err}`).toBe(0);
			return out;
		};

		const npix = temp.join("sandbox-vm.npix");
		await npi("plugin", "pack", PLUGIN_DIR, "-o", npix);
		await npi("plugin", "install", npix);
		const helpers: string[] = [];
		for (const entry of fs.readdirSync(temp.path(), { recursive: true, withFileTypes: true })) {
			if (entry.isFile() && entry.name === "npi-vm-helper") helpers.push(path.join(entry.parentPath, entry.name));
		}
		expect(helpers.length).toBeGreaterThan(0);
		// Every copy the install left (the unpacked package and whatever links it) is runnable and still signed.
		for (const helper of helpers) {
			expect(fs.statSync(helper).mode & 0o111, helper).not.toBe(0);
			const verify = Bun.spawnSync(["codesign", "--verify", helper]);
			expect(verify.exitCode, `${helper}: ${verify.stderr.toString()}`).toBe(0);
		}

		// Settings: the image lives outside the test's home.
		await Bun.write(temp.join("agent", "sandbox-vm.json"), JSON.stringify({ image: IMAGE }));
		const providerPath = temp.join("provider.ts");
		await Bun.write(providerPath, providerExtension);
		const project = temp.join("project");
		fs.mkdirSync(project, { recursive: true });

		const child = Bun.spawn([NPI, "-e", providerPath, "--mode", "rpc-ui", "--no-session"], {
			cwd: project,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 120_000,
		});
		const stdout = new Response(child.stdout).body;
		if (!stdout) throw new Error("RPC fixture did not expose stdout");
		const stderr = new Response(child.stderr).text();
		const responses = new Map<string, Record<string, unknown>>();
		try {
			for (const [id, name] of [
				["start", "sandbox-vm/start"],
				["stop", "sandbox-vm/stop"],
			] as const) {
				child.stdin.write(`${JSON.stringify({ type: "extension_command", id, name })}\n`);
			}
			await child.stdin.flush();
			for await (const frame of readJsonl<unknown>(stdout)) {
				if (isRecord(frame) && frame.type === "response" && typeof frame.id === "string")
					responses.set(frame.id, frame);
				if (responses.size === 2) break;
			}
		} finally {
			child.stdin.end();
			child.kill();
			await child.exited;
		}
		const result = (id: string) => (responses.get(id)?.data as { result?: unknown } | undefined)?.result;
		expect(result("start"), `${JSON.stringify([...responses.values()])}\n${await stderr}`).toMatchObject({
			state: "running",
		});
		expect(result("stop")).toMatchObject({ state: "stopped" });
	}, 180_000);
});
