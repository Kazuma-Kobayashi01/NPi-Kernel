import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { runSideAgentRpcMode } from "@oh-my-pi/pi-coding-agent/side-agent/rpc-host";
import { TempDir } from "@oh-my-pi/pi-utils";

// The RPC host a Desktop tab talks to, in-process, with the scripted stdio agent behind it
// (fixtures/side-agent-fake.ts). Commands go in as JSON lines; frames come back as JSON lines.
const FAKE_AGENT = path.join(import.meta.dir, "fixtures", "side-agent-fake.ts");

type Frame = Record<string, unknown>;

class Harness {
	readonly frames: Frame[] = [];
	#input: ReadableStreamDefaultController<Uint8Array> | undefined;
	#nextId = 0;
	done: Promise<void>;

	constructor(cwd: string, env?: Record<string, string>, approvalMode: "always-ask" | "yolo" = "always-ask") {
		const input = new ReadableStream<Uint8Array>({ start: controller => void (this.#input = controller) });
		const output = new PassThrough();
		let buffered = "";
		output.on("data", chunk => {
			buffered += chunk.toString();
			let newline = buffered.indexOf("\n");
			while (newline >= 0) {
				const line = buffered.slice(0, newline).trim();
				buffered = buffered.slice(newline + 1);
				if (line) this.frames.push(JSON.parse(line) as Frame);
				newline = buffered.indexOf("\n");
			}
		});
		this.done = runSideAgentRpcMode({
			agentId: "fake",
			agentName: "Fake",
			launch: { command: process.execPath, args: [FAKE_AGENT], env },
			cwd,
			approvalMode,
			input,
			output,
		});
	}

	send(command: Frame): string {
		const id = `c${++this.#nextId}`;
		this.#input?.enqueue(new TextEncoder().encode(`${JSON.stringify({ id, ...command })}\n`));
		return id;
	}

	async waitFor(predicate: (frame: Frame) => boolean, timeoutMs = 5000): Promise<Frame> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const found = this.frames.find(predicate);
			if (found) return found;
			if (Date.now() > deadline)
				throw new Error(`timed out; frames: ${JSON.stringify(this.frames.map(f => f.type))}`);
			await Bun.sleep(10);
		}
	}

	/** Frames of the prompt `id`'s turn: from the prompt's response to its prompt_result, inclusive. */
	async turn(text: string): Promise<{ id: string; frames: Frame[]; result: Frame }> {
		const start = this.frames.length;
		const id = this.send({ type: "prompt", message: text });
		const result = await this.waitFor(f => f.type === "prompt_result" && f.id === id);
		return { id, frames: this.frames.slice(start, this.frames.indexOf(result) + 1), result };
	}

	close(): Promise<void> {
		this.#input?.close();
		return this.done;
	}
}

describe("side agent RPC host", () => {
	let workspace: TempDir;
	let harness: Harness | undefined;

	beforeEach(() => {
		workspace = TempDir.createSync("@npi-side-rpc-");
	});

	afterEach(async () => {
		await harness?.close();
		harness = undefined;
		await workspace.remove();
	});

	it("streams a turn like NPi's own: user message, assistant text, tool call before its result, prompt_result", async () => {
		harness = new Harness(workspace.path());
		await harness.waitFor(f => f.type === "ready");
		const { frames, result } = await harness.turn("tool");
		expect(result).toMatchObject({ status: "completed", agentInvoked: true, sessionSettled: true });

		const kinds = frames.map(f => {
			const message = f.message as Frame | undefined;
			return f.type === "message_end" ? `end:${message?.role}:${String(message?.stopReason ?? "")}` : String(f.type);
		});
		const at = (kind: string) => kinds.indexOf(kind);
		// the assistant message carrying the tool call ends before the tool runs and before its result
		expect(at("end:assistant:toolUse")).toBeLessThan(at("tool_execution_start"));
		expect(at("tool_execution_start")).toBeLessThan(at("tool_execution_end"));
		expect(at("tool_execution_end")).toBeLessThan(at("end:toolResult:"));
		expect(kinds.at(-3)).toBe("turn_end");
		expect(kinds.at(-2)).toBe("agent_end");

		const end = frames.find(f => f.type === "tool_execution_end") as Frame;
		expect(end.result).toMatchObject({ content: [{ type: "text", text: "found" }] });

		const messagesId = harness.send({ type: "get_messages" });
		const reply = await harness.waitFor(f => f.type === "response" && f.id === messagesId);
		const transcript = (reply.data as { messages: Frame[] }).messages;
		expect(transcript.map(m => m.role)).toEqual(["user", "assistant", "assistant", "toolResult", "assistant"]);
		const text = (m: Frame) => (m.content as Frame[]).map(c => c.text ?? "").join("");
		expect(text(transcript[1]!)).toBe("looking");
		expect(text(transcript[4]!)).toBe("done");
	});

	it("asks the host about the agent's permission request and passes the choice back", async () => {
		harness = new Harness(workspace.path());
		const pending = harness.turn("permission");
		const ask = await harness.waitFor(f => f.type === "extension_ui_request" && f.method === "select");
		expect(ask).toMatchObject({ title: "Run tests", options: ["Allow", "Deny"], toolCallId: "t1" });
		harness.send({ type: "extension_ui_response", id: ask.id, value: "Allow" });
		const { frames } = await pending;
		const said = frames
			.filter(f => f.type === "message_update")
			.map(f => (f.assistantMessageEvent as Frame).delta ?? "")
			.join("");
		expect(said).toBe("yes");
	});

	it("yolo approval answers the agent's permission requests without asking", async () => {
		harness = new Harness(workspace.path(), undefined, "yolo");
		const { frames } = await harness.turn("permission");
		expect(frames.some(f => f.type === "extension_ui_request")).toBe(false);
	});

	it("queues a message sent mid-turn, and abort ends the running turn as aborted", async () => {
		harness = new Harness(workspace.path());
		const waiting = harness.send({ type: "prompt", message: "wait" });
		await harness.waitFor(f => f.type === "agent_start");
		const queued = harness.send({ type: "prompt", message: "terminal" });
		const stateId = harness.send({ type: "get_state" });
		const state = await harness.waitFor(f => f.type === "response" && f.id === stateId);
		expect(state.data).toMatchObject({ isStreaming: true, queuedMessageCount: 1, isSettled: false });

		// abort drops the queue and cancels the running turn
		harness.send({ type: "abort" });
		const aborted = await harness.waitFor(f => f.type === "prompt_result" && f.id === waiting);
		expect(aborted.status).toBe("aborted");
		await Bun.sleep(100);
		expect(harness.frames.some(f => f.type === "prompt_result" && f.id === queued)).toBe(false);
	});

	it("shows how to sign in when the agent's only method runs in a terminal", async () => {
		harness = new Harness(workspace.path(), { FAKE_REQUIRE_AUTH: "1" });
		const pending = harness.turn("permission");
		const ask = await harness.waitFor(f => f.type === "extension_ui_request" && f.title === "Sign in to Fake");
		harness.send({ type: "extension_ui_response", id: ask.id, value: "Sign in" });
		const { result } = await pending;
		expect(result.status).toBe("error");
		expect((result.error as Frame).message).toContain("--login");
	});

	it("answers NPi-only settings as no-ops and NPi-only queries as unsupported", async () => {
		harness = new Harness(workspace.path());
		const setId = harness.send({ type: "set_auto_compaction", enabled: true });
		const getId = harness.send({ type: "get_session_stats" });
		expect(await harness.waitFor(f => f.id === setId)).toMatchObject({ success: true });
		expect(await harness.waitFor(f => f.id === getId)).toMatchObject({ success: false, code: "unsupported" });
	});
});
