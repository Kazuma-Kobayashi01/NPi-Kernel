import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { SessionStats } from "../src/session/agent-session-types";
import {
	buildSessionTokens,
	buildStatsPeriods,
	type UsageTokensSession,
} from "../src/slash-commands/helpers/usage-tokens";
import type { TokenRankData, TokenRankModel } from "../src/slash-commands/helpers/token-rank";

function createFakeStats(overrides: Partial<SessionStats> = {}): SessionStats {
	return {
		sessionFile: undefined,
		sessionId: "fake-session",
		userMessages: 2,
		assistantMessages: 3,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 5,
		tokens: {
			input: 5000,
			output: 2000,
			reasoning: 1000,
			cacheRead: 10000,
			cacheWrite: 500,
			total: 17500,
		},
		premiumRequests: 0,
		cost: 0.125,
		...overrides,
	};
}

function createAssistantMessage(
	provider: string,
	model: string,
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
	},
): AssistantMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider,
		model,
		content: [{ type: "text", text: "hello" }],
		stopReason: "stop",
		timestamp: 1700000000000,
		usage: usage
			? {
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
					totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: usage.cost,
					},
				}
			: (undefined as unknown as AssistantMessage["usage"]),
	};
}

describe("usage-tokens", () => {
	it("returns empty models when session has no assistant messages, totals match getSessionStats", () => {
		const stats = createFakeStats({
			assistantMessages: 0,
			tokens: {
				input: 0,
				output: 0,
				reasoning: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
			cost: 0,
		});
		const session: UsageTokensSession = {
			getSessionStats: () => stats,
			agent: {
				state: {
					messages: [{ role: "user", content: [{ type: "text", text: "hi" }] } as AgentMessage],
				},
			},
		};

		const result = buildSessionTokens(session);
		expect(result.models).toEqual([]);
		expect(result.totals).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			requests: 0,
		});
		expect(result.reasoning).toBeUndefined();
	});

	it("groups assistant messages by provider/model and sorts by total tokens descending", () => {
		const stats = createFakeStats({
			assistantMessages: 3,
			cost: 0.5,
			tokens: {
				input: 10000,
				output: 4000,
				reasoning: 500,
				cacheRead: 20000,
				cacheWrite: 1000,
				total: 35000,
			},
		});

		const messages: AgentMessage[] = [
			// Smaller model turn 1
			createAssistantMessage("anthropic", "claude-sonnet", {
				input: 1000,
				output: 500,
				cacheRead: 2000,
				cacheWrite: 100,
				cost: 0.05,
			}),
			// User message interspersed
			{ role: "user", content: [{ type: "text", text: "next" }] } as AgentMessage,
			// Smaller model turn 2
			createAssistantMessage("anthropic", "claude-sonnet", {
				input: 1500,
				output: 700,
				cacheRead: 2500,
				cacheWrite: 200,
				cost: 0.08,
			}),
			// Assistant message without usage (skipped)
			createAssistantMessage("anthropic", "claude-sonnet"),
			// Larger model turn 1
			createAssistantMessage("openai", "gpt-4o", {
				input: 5000,
				output: 2000,
				cacheRead: 10000,
				cacheWrite: 500,
				cost: 0.25,
			}),
		];

		const session: UsageTokensSession = {
			getSessionStats: () => stats,
			agent: {
				state: {
					messages,
				},
			},
		};

		const result = buildSessionTokens(session);

		// Totals match getSessionStats exactly
		expect(result.totals).toEqual({
			input: 10000,
			output: 4000,
			cacheRead: 20000,
			cacheWrite: 1000,
			cost: 0.5,
			requests: 3,
		});
		expect(result.reasoning).toBe(500);

		// Sorted: openai/gpt-4o (17500 tokens) > anthropic/claude-sonnet (8000 tokens)
		expect(result.models).toHaveLength(2);
		expect(result.models[0]).toEqual({
			name: "openai/gpt-4o",
			input: 5000,
			output: 2000,
			cacheRead: 10000,
			cacheWrite: 500,
			cost: 0.25,
			requests: 1,
		});
		expect(result.models[1]).toEqual({
			name: "anthropic/claude-sonnet",
			input: 2500,
			output: 1200,
			cacheRead: 4500,
			cacheWrite: 300,
			cost: 0.13,
			requests: 2,
		});
	});

	it("buildStatsPeriods maps ordering, labels, and fields from TokenRankData", () => {
		const sampleModel: TokenRankModel = {
			name: "anthropic/claude-opus",
			tokens: 20000,
			input: 5000,
			output: 2000,
			cacheRead: 12000,
			cacheWrite: 1000,
			cost: 0.75,
			requests: 4,
		};

		// Provide periods in reverse order to verify RANK_PERIODS ordering
		const fakeData: TokenRankData = {
			now: new Date(),
			periods: [
				{
					period: "year",
					since: new Date(2026, 0, 1),
					total: 100000,
					models: [sampleModel],
				},
				{
					period: "month",
					since: new Date(2026, 10, 1),
					total: 50000,
					models: [sampleModel],
				},
				{
					period: "week",
					since: new Date(2026, 10, 9),
					total: 20000,
					models: [sampleModel],
				},
				{
					period: "day",
					since: new Date(2026, 10, 10),
					total: 5000,
					models: [sampleModel],
				},
			],
		};

		const periods = buildStatsPeriods(fakeData);

		expect(periods.map(p => p.id)).toEqual(["day", "week", "month", "year"]);
		expect(periods.map(p => p.label)).toEqual(["Today", "This week", "This month", "This year"]);

		// Model field mapping (tokens property should not exist on UsageTokenModel)
		expect(periods[0].models[0]).toEqual({
			name: "anthropic/claude-opus",
			input: 5000,
			output: 2000,
			cacheRead: 12000,
			cacheWrite: 1000,
			cost: 0.75,
			requests: 4,
		});
	});
});
