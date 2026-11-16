/**
 * A stand-in for the VM helper that speaks the plugin's line protocol and runs commands with `sh` on this
 * machine. `__config` answers with the start config it received; `__crash` kills the helper mid-command.
 */
import type { HelperMessage, HelperRequest } from "../src/protocol";

const send = (message: HelperMessage): void => {
	process.stdout.write(`${JSON.stringify(message)}\n`);
};

let startConfig: unknown;
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
