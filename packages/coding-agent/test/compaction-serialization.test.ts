import { describe, expect, it } from "bun:test";
import { serializeConversation } from "@oh-my-pi/pi-agent-core/compaction/utils";
import type { Message } from "@oh-my-pi/pi-ai";

describe("serializeConversation", () => {
	it("truncates long tool results in serialized summaries preserving head and tail", () => {
		const headPrefix = "HEAD_START_" + "a".repeat(1189); // 1200 chars
		const middle = "m".repeat(3000);
		const tailSuffix = "b".repeat(785) + "_TAIL_ERROR_END"; // 800 chars
		const longContent = headPrefix + middle + tailSuffix; // 5000 chars
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("[Tool Result]:");
		expect(result).toContain("[... 3000 characters truncated ...]");
		expect(result).toContain("HEAD_START_");
		expect(result).toContain("_TAIL_ERROR_END");
		expect(result).not.toContain(middle);
	});

	it("does not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: shortContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(`[Tool Result]: ${shortContent}`);
		expect(result).not.toContain("truncated");
	});

	it("does not truncate assistant or user messages", () => {
		const longText = "y".repeat(5000);
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: longText }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: longText }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).not.toContain("truncated");
		expect(result).toContain(longText);
	});
});
