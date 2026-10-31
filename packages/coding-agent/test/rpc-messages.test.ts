import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { readJsonl } from "@oh-my-pi/pi-utils";
import { encodeRpcFrame, MAX_RPC_FRAME_BYTES } from "../src/modes/rpc/rpc-frame";
import { pageRpcMessages, type RpcMessageSnapshot } from "../src/modes/rpc/rpc-messages";
import type { RpcResponse } from "../src/modes/rpc/rpc-types";
import { SessionManager } from "../src/session/session-manager";
import { makeAssistantMessage } from "./session-manager/helpers";

function message(index: number, bytes = 32 * 1024): AgentMessage {
	return { role: "user", content: `${index}:${"x".repeat(bytes)}`, timestamp: index };
}

const snapshot: RpcMessageSnapshot = {
	sessionId: "session-1",
	leafId: "leaf-1",
	messageCount: 40,
};

describe("RPC message pagination", () => {
	it("reconstructs a large history from v1-safe pages without loss or overlap", () => {
		const messages = Array.from({ length: snapshot.messageCount }, (_, index) => message(index));
		const reconstructed: AgentMessage[] = [];
		let cursor: string | undefined;
		let pageCount = 0;

		do {
			const page = pageRpcMessages(messages, snapshot, { cursor, limit: 256 });
			const encoded = encodeRpcFrame({
				id: `page-${pageCount}`,
				type: "response",
				command: "get_messages_page",
				success: true,
				data: page,
			});
			expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(MAX_RPC_FRAME_BYTES);
			expect(JSON.parse(encoded).success).toBe(true);
			reconstructed.push(...page.messages);
			cursor = page.nextCursor;
			pageCount++;
		} while (cursor);

		expect(pageCount).toBeGreaterThan(1);
		expect(reconstructed).toEqual(messages);
	});

	it("rejects a cursor after the session snapshot changes", () => {
		const messages = Array.from({ length: snapshot.messageCount }, (_, index) => message(index, 1024));
		const first = pageRpcMessages(messages, snapshot, { limit: 5 });
		expect(first.nextCursor).toBeDefined();

		expect(() =>
			pageRpcMessages(messages, { ...snapshot, leafId: "leaf-2" }, { cursor: first.nextCursor, limit: 5 }),
		).toThrow("RPC message cursor is stale");
	});

	it("returns one individually oversized message so negotiated v2 can carry it losslessly", () => {
		const messages = [message(0, 2 * 1024 * 1024), message(1, 128)];
		const first = pageRpcMessages(
			messages,
			{ sessionId: "session-2", leafId: "leaf-2", messageCount: messages.length },
			{ limit: 10 },
		);

		expect(first.messages).toEqual([messages[0]]);
		expect(first.nextCursor).toBeDefined();
	});
});

describe("RPC full message history", () => {
	it("returns pre-compaction messages only on the active branch without changing context", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-full-history-"));
		const manager = SessionManager.create(root, path.join(root, "sessions"));
		try {
			const first: AgentMessage = { role: "user", content: "first message", timestamp: 1 };
			const branchPoint = manager.appendMessage(first);
			manager.appendMessage({ ...makeAssistantMessage(), content: [{ type: "text", text: "sibling reply" }] });
			manager.branch(branchPoint);
			const toolCall: AgentMessage = {
				...makeAssistantMessage(),
				content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "example.txt" } }],
				stopReason: "toolUse",
			};
			const toolResult: AgentMessage = {
				role: "toolResult",
				toolCallId: "read-1",
				toolName: "read",
				content: [{ type: "text", text: "original tool output" }],
				isError: false,
				timestamp: 2,
			};
			manager.appendMessage(toolCall);
			manager.appendMessage(toolResult);
			const kept: AgentMessage = { role: "user", content: "kept message", timestamp: 3 };
			const keptId = manager.appendMessage(kept);
			manager.appendCompaction("Earlier work summarized", undefined, keptId, 1000);
			const last = { ...makeAssistantMessage(), content: [{ type: "text" as const, text: "last reply" }] };
			manager.appendMessage(last);
			await manager.flush();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted test session");
			await manager.close();

			const child = Bun.spawn(
				[
					process.execPath,
					path.join(import.meta.dir, "..", "src", "cli.ts"),
					"--mode",
					"rpc",
					"--resume",
					sessionFile,
					"--model",
					"openai/gpt-4o",
				],
				{
					cwd: root,
					env: {
						HOME: root,
						PATH: process.env.PATH,
						PI_CODING_AGENT_DIR: path.join(root, "agent"),
						PI_NO_TITLE: "1",
					},
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const stderr = new Response(child.stderr).text();
			try {
				for (const command of [
					{ id: "default", type: "get_messages" },
					{ id: "false", type: "get_messages", fullHistory: false },
					{ id: "full", type: "get_messages", fullHistory: true },
					{ id: "after", type: "get_messages" },
				]) {
					child.stdin.write(`${JSON.stringify(command)}\n`);
				}
				await child.stdin.flush();
				const replies = new Map<string, AgentMessage[]>();
				for await (const frame of readJsonl<RpcResponse | { type: "ready" }>(child.stdout)) {
					if (frame.type !== "response" || frame.command !== "get_messages") continue;
					if (!frame.success) throw new Error(frame.error);
					replies.set(frame.id ?? "", frame.data.messages);
					if (replies.size === 4) break;
				}
				expect(replies.size).toBe(4);
				expect(replies.get("full")).toEqual([first, toolCall, toolResult, kept, last]);
				expect(replies.get("default")).toEqual(replies.get("false"));
				expect(replies.get("after")).toEqual(replies.get("default"));
				expect(replies.get("default")?.map(message => message.role)).toEqual([
					"compactionSummary",
					"user",
					"assistant",
				]);
			} finally {
				child.stdin.end();
				child.kill();
				await child.exited;
				await stderr;
			}
		} finally {
			await manager.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 30_000);
});
