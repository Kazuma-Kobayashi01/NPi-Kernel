import * as stream from "node:stream";
import {
	AgentSideConnection,
	ndJsonStream,
	PROTOCOL_VERSION,
	RequestError,
	type StopReason,
} from "@oh-my-pi/pi-utils/acp";

// A stdio ACP agent scripted by its prompt text, for SideAgentConnection tests.
//   permission         → asks to run a tool call, replies with the chosen option id
//   read <abs path>    → reads through the client, replies with the content (or the client's error)
//   write <abs path>   → writes "written" through the client, replies "ok" (or the error)
//   terminal           → runs `printf hello` in a client terminal, replies "<output>|<exit code>"
//   wait               → holds the turn until session/cancel
//   exit               → the process dies mid-turn (exit code 3)
//   tool               → says "looking", runs one tool call that outputs "found", then says "done"
// FAKE_REQUIRE_AUTH=1 refuses sessions until `authenticate` with method "login".
let authenticated = Bun.env.FAKE_REQUIRE_AUTH !== "1";
let cancelTurn: (() => void) | undefined;

const input = stream.Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const output = new WritableStream<Uint8Array>({
	write(chunk) {
		process.stdout.write(chunk);
	},
});

const connection = new AgentSideConnection(
	conn => ({
		initialize: () => ({
			protocolVersion: PROTOCOL_VERSION,
			agentInfo: { name: "fake", version: "1.0.0" },
			agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } },
			authMethods: [{ id: "login", name: "Sign in", type: "terminal", args: ["--login"] }],
		}),
		authenticate: params => {
			if (params.methodId === "login") authenticated = true;
		},
		newSession: () => {
			if (!authenticated) throw RequestError.authRequired();
			return { sessionId: "s1" };
		},
		closeSession: () => {},
		cancel: () => cancelTurn?.(),
		prompt: async params => {
			const first = params.prompt[0];
			const text = first?.type === "text" ? first.text : "";
			const reply = (message: string) =>
				conn.sessionUpdate({
					sessionId: params.sessionId,
					update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: message } },
				});
			const [command, arg] = text.split(" ");
			let stop: StopReason = "end_turn";
			try {
				switch (command) {
					case "permission": {
						const answer = await conn.requestPermission({
							sessionId: params.sessionId,
							toolCall: { toolCallId: "t1", title: "Run tests", kind: "execute", status: "pending" },
							options: [
								{ optionId: "yes", name: "Allow", kind: "allow_once" },
								{ optionId: "no", name: "Deny", kind: "reject_once" },
							],
						});
						await reply(answer.outcome.outcome === "selected" ? answer.outcome.optionId : "cancelled");
						break;
					}
					case "read":
						await reply((await conn.readTextFile({ sessionId: params.sessionId, path: arg })).content);
						break;
					case "write":
						await conn.writeTextFile({ sessionId: params.sessionId, path: arg, content: "written" });
						await reply("ok");
						break;
					case "terminal": {
						const terminal = await conn.createTerminal({
							sessionId: params.sessionId,
							command: "printf",
							args: ["hello"],
						});
						const exit = await terminal.waitForExit();
						const out = await terminal.currentOutput();
						await terminal.release();
						await reply(`${out.output}|${exit.exitCode}`);
						break;
					}
					case "tool": {
						await reply("looking");
						const update = (u: Parameters<typeof conn.sessionUpdate>[0]["update"]) =>
							conn.sessionUpdate({ sessionId: params.sessionId, update: u });
						await update({
							sessionUpdate: "tool_call",
							toolCallId: "t2",
							title: "Search",
							kind: "search",
							status: "in_progress",
						});
						await update({
							sessionUpdate: "tool_call_update",
							toolCallId: "t2",
							status: "completed",
							content: [{ type: "content", content: { type: "text", text: "found" } }],
						});
						await reply("done");
						break;
					}
					case "exit":
						process.exit(3);
						break;
					case "wait": {
						const { promise, resolve } = Promise.withResolvers<void>();
						cancelTurn = resolve;
						await promise;
						stop = "cancelled";
						break;
					}
				}
			} catch (error) {
				await reply(`error: ${error instanceof Error ? error.message : String(error)}`);
			}
			return { stopReason: stop };
		},
	}),
	ndJsonStream(output, input),
);
await connection.closed;
