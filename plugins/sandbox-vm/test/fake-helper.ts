/**
 * A stand-in for the VM helper that speaks the plugin's line protocol and runs commands with `sh` on this
 * machine. `__config` answers with the start config it received; `__crash` kills the helper mid-command;
 * `__terminals <n>` reports n attached terminals, as the real helper does when terminal clients come and go.
 *
 * `--fail-once <file>`: when the file does not exist yet, create it and fail the start the way the real helper
 * does (state `error`, every later start refused), so only a new helper process can start the VM.
 */
import type { HelperMessage, HelperRequest } from "../src/protocol";

const send = (message: HelperMessage): void => {
	process.stdout.write(`${JSON.stringify(message)}\n`);
};

let startConfig: unknown;
let failed = false;
const failOnceIndex = process.argv.indexOf("--fail-once");
const failOnceFile = failOnceIndex < 0 ? undefined : process.argv[failOnceIndex + 1];
const running = new Map<number, Bun.Subprocess>();
const released: string[] = [];

async function exec(id: number, request: Extract<HelperRequest, { op: "exec" }>): Promise<void> {
	if (request.command === "__config") {
		send({ id, type: "chunk", data: JSON.stringify(startConfig) });
		send({ id, type: "exit", exitCode: 0 });
		return;
	}
	if (request.command === "__released") {
		send({ id, type: "chunk", data: released.join(",") });
		send({ id, type: "exit", exitCode: 0 });
		return;
	}
	if (request.command === "__crash") process.exit(7);
	if (request.command.startsWith("__terminals ")) {
		process.stdout.write(`${JSON.stringify({ type: "terminals", count: Number(request.command.slice(12)) })}\n`);
		send({ id, type: "exit", exitCode: 0 });
		return;
	}
	const child = Bun.spawn(["sh", "-c", request.command], {
		cwd: request.cwd,
		env: { PATH: Bun.env.PATH ?? "", ...request.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	running.set(id, child);
	const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
		for await (const chunk of stream) send({ id, type: "chunk", data: new TextDecoder().decode(chunk) });
	};
	await Promise.all([pump(child.stdout), pump(child.stderr)]);
	const code = await child.exited;
	running.delete(id);
	if (child.signalCode) send({ id, type: "exit", cancelled: true });
	else send({ id, type: "exit", exitCode: code });
}

for await (const line of console) {
	if (!line.trim()) continue;
	const request = JSON.parse(line) as HelperRequest;
	switch (request.op) {
		case "start":
			if (failed) {
				send({ id: request.id, type: "error", message: "the VM is error" });
				break;
			}
			if (failOnceFile && !(await Bun.file(failOnceFile).exists())) {
				await Bun.write(failOnceFile, "");
				failed = true;
				send({ id: request.id, type: "error", message: "the guest did not come up within 90 seconds" });
				send({ type: "state", state: "error", detail: "the guest did not come up within 90 seconds" });
				break;
			}
			startConfig = request.config;
			send({ id: request.id, type: "result", state: "running" });
			break;
		case "status":
			send({ id: request.id, type: "result", state: startConfig === undefined ? "stopped" : "running" });
			break;
		case "stop":
			send({ id: request.id, type: "result", state: "stopped" });
			process.exit(0);
			break;
		case "cancel":
			running.get(request.target)?.kill();
			send({ id: request.id, type: "result" });
			break;
		case "release":
			released.push(request.sessionKey);
			send({ id: request.id, type: "result" });
			break;
		case "exec":
			void exec(request.id, request);
			break;
	}
}
