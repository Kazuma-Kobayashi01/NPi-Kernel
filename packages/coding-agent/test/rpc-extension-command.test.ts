import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";

/**
 * An extension serving RPC commands (`registerRpcCommand`) and pushing events (`ctx.ui.emitEvent`).
 * The provider only lets RPC mode start: no prompt is sent, so it is never called.
 */
const helloExtension = `
export default function (pi) {
	pi.registerProvider("scripted", {
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "scripted-key",
		api: "scripted-none",
		models: [{
			id: "none",
			name: "Never called",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32768,
			maxTokens: 1024,
		}],
		streamSimple: () => { throw new Error("not used"); },
	});
	pi.registerRpcCommand("hello/greet", {
		handler: (params, ctx) => {
			const name = params && typeof params.name === "string" ? params.name : "world";
			ctx.ui.emitEvent?.("hello/greeted", { name });
			return { message: "Hello, " + name + "!" };
		},
	});
	pi.registerRpcCommand("hello/fail", {
		handler: async () => {
			throw new Error("failed on purpose");
		},
	});
}
`;

describe("extension RPC commands", () => {
	it("routes extension_command to the extension, relays its events, and reports failures", async () => {
		await using temp = await TempDir.create("@rpc-extension-command-");
		const extensionPath = temp.join("hello.ts");
		await Bun.write(extensionPath, helloExtension);
		const child = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "..", "src", "cli.ts"),
				"--trusted-extension",
				extensionPath,
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
					CI: "true",
					PI_NO_TITLE: "1",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				timeout: 30_000,
			},
		);
		const stdout = new Response(child.stdout).body;
		if (!stdout) throw new Error("RPC fixture did not expose stdout");
		const stderr = new Response(child.stderr).text();
		const send = async (frame: object) => {
			child.stdin.write(`${JSON.stringify(frame)}\n`);
			await child.stdin.flush();
		};
		const responses = new Map<string, Record<string, unknown>>();
		const events: Record<string, unknown>[] = [];

		try {
			await send({ type: "extension_command", id: "greet", name: "hello/greet", params: { name: "NPi" } });
			await send({ type: "extension_command", id: "fail", name: "hello/fail" });
			await send({ type: "extension_command", id: "missing", name: "nobody/serves-this" });
			for await (const frame of readJsonl<unknown>(stdout)) {
				if (!isRecord(frame)) continue;
				if (frame.type === "extension_event") events.push(frame);
				if (frame.type === "response" && typeof frame.id === "string") responses.set(frame.id, frame);
				if (responses.size === 3) break;
			}
		} finally {
			child.stdin.end();
			child.kill();
			await child.exited;
		}

		expect(responses.get("greet"), await stderr).toMatchObject({
			command: "extension_command",
			success: true,
			data: { result: { message: "Hello, NPi!" } },
		});
		expect(events).toEqual([{ type: "extension_event", name: "hello/greeted", data: { name: "NPi" } }]);
		expect(responses.get("fail")).toMatchObject({ success: false, error: "failed on purpose" });
		expect(responses.get("missing")).toMatchObject({ success: false, code: "unsupported" });
	});
});
