import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";

/** The kernel under test: the source tree, or a compiled binary when NPI_BIN names one (the Desktop ships one). */
const KERNEL: string[] = process.env.NPI_BIN
	? [process.env.NPI_BIN]
	: [process.execPath, path.join(import.meta.dir, "..", "..", "..", "packages", "coding-agent", "src", "cli.ts")];
const PLUGIN = path.join(import.meta.dir, "..", "src", "index.ts");
const FAKE_HELPER = path.join(import.meta.dir, "fake-helper.ts");

/** Only lets RPC mode start: no prompt is sent, so the provider is never called. */
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

describe("sandbox-vm inside npi", () => {
	it("serves its RPC commands, switches the exec backend and drives the VM", async () => {
		await using temp = await TempDir.create("@sandbox-vm-kernel-");
		const providerPath = temp.join("provider.ts");
		await Bun.write(providerPath, providerExtension);
		const helperPath = temp.join("helper.sh");
		await Bun.write(helperPath, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HELPER}" "$@"\n`);
		await fs.chmod(helperPath, 0o755);

		const child = Bun.spawn(
			[
				...KERNEL,
				"--trusted-extension",
				providerPath,
				"--trusted-extension",
				PLUGIN,
				"--mode",
				"rpc-ui",
				"--no-session",
			],
			{
				cwd: temp.path(),
				env: {
					PATH: Bun.env.PATH,
					HOME: temp.join("home"),
					PI_CODING_AGENT_DIR: temp.join("agent"),
					XDG_CONFIG_HOME: temp.join("config"),
					XDG_DATA_HOME: temp.join("data"),
					XDG_CACHE_HOME: temp.join("cache"),
					NPI_VM_HELPER: helperPath,
					CI: "true",
					PI_NO_TITLE: "1",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				timeout: 60_000,
			},
		);
		const stdout = new Response(child.stdout).body;
		if (!stdout) throw new Error("RPC fixture did not expose stdout");
		const stderr = new Response(child.stderr).text();
		const send = async (frame: object) => {
			child.stdin.write(`${JSON.stringify(frame)}\n`);
			await child.stdin.flush();
		};
		const steps = ["status", "set-backend", "start", "status-after", "set-off", "stop"] as const;
		const responses = new Map<string, Record<string, unknown>>();

		try {
			await send({ type: "extension_command", id: "status", name: "sandbox-vm/status" });
			await send({
				type: "extension_command",
				id: "set-backend",
				name: "sandbox-vm/set-backend",
				params: { on: true },
			});
			await send({ type: "extension_command", id: "start", name: "sandbox-vm/start" });
			await send({ type: "extension_command", id: "status-after", name: "sandbox-vm/status" });
			await send({
				type: "extension_command",
				id: "set-off",
				name: "sandbox-vm/set-backend",
				params: { on: false },
			});
			await send({ type: "extension_command", id: "stop", name: "sandbox-vm/stop" });
			for await (const frame of readJsonl<unknown>(stdout)) {
				if (isRecord(frame) && frame.type === "response" && typeof frame.id === "string")
					responses.set(frame.id, frame);
				if (responses.size === steps.length) break;
			}
		} finally {
			child.stdin.end();
			child.kill();
			await child.exited;
		}

		const result = (id: string) =>
			(responses.get(id)?.data as { result?: Record<string, unknown> } | undefined)?.result ?? {};
		const diagnostics = await stderr;
		const before = result("status");
		expect(before, diagnostics).toMatchObject({ state: "stopped", backend: false, hostToolsOff: [] });

		// Switching the backend on takes away exactly the host-code tools that were active, and off gives them back.
		const switchedOn = result("set-backend");
		expect(switchedOn).toMatchObject({ backend: true, hostCodeToolsActive: [] });
		expect(switchedOn.hostToolsOff).toEqual(before.hostCodeToolsActive);
		expect(result("set-off")).toMatchObject({ backend: false, hostToolsOff: [] });
		expect(result("set-off").hostCodeToolsActive).toEqual(before.hostCodeToolsActive);

		expect(result("start")).toMatchObject({ state: "running", backend: true });
		expect(result("status-after")).toMatchObject({ state: "running", backend: true });
		expect(result("stop")).toMatchObject({ state: "stopped" });
	});
});
