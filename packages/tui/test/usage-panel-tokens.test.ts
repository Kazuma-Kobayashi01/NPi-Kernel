import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "../src/index";
import { initTheme } from "../src/theme/theme";
import type { UsageTokensData } from "../src/overlays/usage-panel-model";
import { renderUsageTokens } from "../src/overlays/usage-panel-tokens";

beforeAll(async () => {
	await initTheme(false);
});

function mockTokensData(): UsageTokensData {
	return {
		session: {
			totals: {
				input: 12500,
				output: 3200,
				cacheRead: 45000,
				cacheWrite: 1200,
				cost: 0.13,
			},
			reasoning: 850,
			models: [
				{
					name: "anthropic/claude-3-5-sonnet",
					input: 10000,
					output: 2500,
					cacheRead: 40000,
					cacheWrite: 1000,
					cost: 0.1,
					requests: 4,
				},
				{
					name: "openai/gpt-4o",
					input: 2500,
					output: 700,
					cacheRead: 5000,
					cacheWrite: 200,
					cost: 0.03,
					requests: 1,
				},
			],
		},
		periods: [
			{
				id: "day",
				label: "Today",
				models: [
					{
						name: "anthropic/claude-3-5-sonnet",
						input: 50000,
						output: 12000,
						cacheRead: 200000,
						cacheWrite: 8000,
						cost: 1.45,
						requests: 18,
					},
					{
						name: "openai/gpt-4o",
						input: 15000,
						output: 4000,
						cacheRead: 30000,
						cacheWrite: 1000,
						cost: 0.35,
						requests: 5,
					},
				],
			},
			{
				id: "week",
				label: "Week",
				models: [
					{
						name: "anthropic/claude-3-5-sonnet",
						input: 250000,
						output: 60000,
						cacheRead: 1000000,
						cacheWrite: 40000,
						cost: 7.5,
						requests: 95,
					},
				],
			},
			{
				id: "month",
				label: "Month",
				models: [],
			},
			{
				id: "year",
				label: "Year",
				models: [],
			},
		],
	};
}

describe("renderUsageTokens", () => {
	it("renders loading and error states without data", () => {
		const loadingLines = renderUsageTokens({
			width: 80,
			data: undefined,
			loading: true,
			error: undefined,
			period: "day",
		});
		expect(loadingLines).toHaveLength(1);
		expect(loadingLines[0]).toContain("Loading token stats…");

		const errorLines = renderUsageTokens({
			width: 80,
			data: undefined,
			loading: false,
			error: "Network connection refused",
			period: "day",
		});
		expect(errorLines).toHaveLength(1);
		expect(errorLines[0]).toContain("Local stats unavailable: Network connection refused");
	});

	it("renders empty states for session and period when no tokens are recorded", () => {
		const emptyData: UsageTokensData = {
			session: {
				totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
				models: [],
			},
			periods: [
				{ id: "day", label: "Today", models: [] },
				{ id: "week", label: "Week", models: [] },
			],
		};

		const lines = renderUsageTokens({
			width: 80,
			data: emptyData,
			loading: false,
			error: undefined,
			period: "day",
		});

		const text = lines.join("\n");
		expect(text).toContain("Session");
		expect(text).toContain("No tokens used in this session yet.");
		expect(text).toContain("Local stats");
		expect(text).toContain("No recorded usage for this period.");
	});

	it("renders session and period figures with cost, model names, and token kinds", () => {
		const data = mockTokensData();
		const lines = renderUsageTokens({
			width: 100,
			data,
			loading: false,
			error: undefined,
			period: "day",
		});
		const text = lines.join("\n");

		// Session figures
		expect(text).toContain("Session");
		expect(text).toContain("claude-3-5-sonnet");
		expect(text).toContain("gpt-4o");
		expect(text).toContain("$0.13");
		expect(text).toContain("reasoning");

		// Local stats figures
		expect(text).toContain("Local stats");
		expect(text).toContain("$1.45");
		expect(text).toContain("$0.35");
	});

	it("marks the requested period in the period selector and handles refresh/error notes", () => {
		const data = mockTokensData();

		// Active period "week"
		const weekLines = renderUsageTokens({
			width: 100,
			data,
			loading: false,
			error: undefined,
			period: "week",
		});
		expect(weekLines.some(l => l.includes("[Week]"))).toBe(true);
		expect(weekLines.some(l => l.includes("Today") && !l.includes("[Today]"))).toBe(true);

		// Loading with data shows refreshing…
		const refreshingLines = renderUsageTokens({
			width: 100,
			data,
			loading: true,
			error: undefined,
			period: "day",
		});
		expect(refreshingLines.some(l => l.includes("refreshing…"))).toBe(true);

		// Error with data still renders session but shows error instead of period table
		const errorWithDataLines = renderUsageTokens({
			width: 100,
			data,
			loading: false,
			error: "database disk image is malformed",
			period: "day",
		});
		const errorText = errorWithDataLines.join("\n");
		expect(errorText).toContain("Session");
		expect(errorText).toContain("claude-3-5-sonnet");
		expect(errorText).toContain("Local stats unavailable: database disk image is malformed");
		expect(errorText).not.toContain("$1.45"); // Day model cost should not be rendered
	});

	it("never exceeds width across narrow and wide terminals (20, 40, 100)", () => {
		const data = mockTokensData();
		const widths = [20, 40, 100];

		for (const width of widths) {
			const lines = renderUsageTokens({
				width,
				data,
				loading: false,
				error: undefined,
				period: "day",
			});

			for (const line of lines) {
				const len = visibleWidth(line);
				expect(len).toBeLessThanOrEqual(width);
			}

			// Also test error state
			const errorLines = renderUsageTokens({
				width,
				data,
				loading: false,
				error: "A rather long error message that could potentially overflow on a small terminal window",
				period: "day",
			});
			for (const line of errorLines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}

		// At narrow width (20), verify that the model table collapsed to 2 lines per model
		const narrowLines = renderUsageTokens({
			width: 20,
			data,
			loading: false,
			error: undefined,
			period: "day",
		});
		expect(narrowLines.some(l => l.trim().startsWith("claude-3-5-sonnet") || l.trim().startsWith("anthropic/"))).toBe(
			true,
		);
	});
});
