import { beforeAll, describe, expect, it } from "bun:test";
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { visibleWidth } from "../src";
import { renderUsageDetail } from "../src/overlays/usage-panel-detail";
import type { UsageEntry } from "../src/overlays/usage-panel-model";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme(false);
});

function makeLimit(
	id: string,
	label: string,
	durationMs: number | undefined,
	usedFraction: number | undefined,
	status: UsageLimit["status"],
	resetsAt?: number,
	amount?: UsageLimit["amount"],
	notes?: string[],
): UsageLimit {
	return {
		id,
		label,
		scope: { provider: "anthropic", windowId: id },
		window: durationMs || resetsAt ? { id, label, durationMs, resetsAt } : undefined,
		amount: amount ?? {
			usedFraction,
			unit: "percent",
		},
		status,
		notes,
	};
}

describe("renderUsageDetail", () => {
	const nowMs = 1770000000000;

	it("never exceeds visible width at 20, 40, and 100 columns", () => {
		const report: UsageReport = {
			provider: "anthropic",
			fetchedAt: nowMs - 60_000,
			limits: [
				makeLimit("5h", "Claude 3.5 Sonnet", 5 * 3_600_000, 0.42, "ok", nowMs + 7_200_000, {
					used: 120,
					limit: 500,
					remaining: 380,
					unit: "requests",
				}),
				makeLimit(
					"weekly",
					"Claude Opus (Weekly)",
					7 * 86_400_000,
					0.95,
					"warning",
					nowMs + 86_400_000,
					undefined,
					["Shared group allowance across all tokens"],
				),
			],
			resetCredits: {
				availableCount: 3,
				redeemableCount: 1,
				credits: [
					{
						title: "Cedar Monthly Reset",
						remainingCount: 1,
						expiresAt: new Date(nowMs + 86_400_000 * 5).toISOString(),
					},
					{
						title: "Cedar Emergency Grant",
						remainingCount: 2,
						expiresAt: new Date(nowMs - 3_600_000).toISOString(),
					},
				],
			},
			notes: ["OMP observed usage only; backend refresh may lag"],
		};

		const entry: UsageEntry = {
			key: "anthropic#0",
			provider: "anthropic",
			providerName: "Anthropic",
			account: "user@example.com",
			state: "ok",
			report,
		};

		for (const width of [20, 40, 100]) {
			const lines = renderUsageDetail(entry, { width, nowMs });
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}

		// At width 20 the bar drops so text never overflows 20
		const lines20 = renderUsageDetail(entry, { width: 20, nowMs });
		const plain20 = lines20.map(l => Bun.stripANSI(l)).join("\n");
		expect(plain20).toContain("24% used");
		for (const line of lines20) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		}
	});

	it("shows percents, countdown, and reset summary for a 5h + weekly report with saved resets", () => {
		const report: UsageReport = {
			provider: "anthropic",
			fetchedAt: nowMs - 120_000,
			limits: [
				makeLimit("5h", "Claude Sonnet", 5 * 3_600_000, 0.4, "ok", nowMs + 7_200_000),
				makeLimit("weekly", "Claude", 7 * 86_400_000, 0.85, "warning", nowMs + 36_000_000),
			],
			resetCredits: {
				availableCount: 2,
				redeemableCount: 1,
				credits: [
					{
						title: "Monthly Cedar Grant",
						remainingCount: 1,
						expiresAt: new Date(nowMs + 86_400_000 * 2).toISOString(),
					},
				],
			},
		};

		const entry: UsageEntry = {
			key: "anthropic#0",
			provider: "anthropic",
			providerName: "Anthropic",
			account: "pro@company.com",
			state: "ok",
			report,
		};

		const lines = renderUsageDetail(entry, { width: 80, nowMs });
		const text = lines.map(l => Bun.stripANSI(l)).join("\n");

		expect(text).toContain("Anthropic");
		expect(text).toContain("pro@company.com");
		expect(text).toContain("checked 2m ago");

		// 5h limit with percents and countdown
		expect(text).toContain("5h");
		expect(text).toContain("40% used · 60% left");
		expect(text).toContain("resets in 2h");

		// weekly limit
		expect(text).toContain("weekly");
		expect(text).toContain("85% used · 15% left");
		expect(text).toContain("warning");
		expect(text).toContain("resets in 10h");

		// saved resets
		expect(text).toContain("✦ 2 saved resets available · 1 redeemable now");
		expect(text).toContain("soonest expiry in 2d");
		expect(text).toContain("Monthly Cedar Grant");
		expect(text).toContain("1 remaining");
	});

	it("renders loading, unavailable, error, and undefined states correctly", () => {
		// Undefined entry
		const undefLines = renderUsageDetail(undefined, { width: 60, nowMs });
		expect(undefLines.map(l => Bun.stripANSI(l)).join("\n")).toContain("Select a provider on the Overview tab.");

		// Loading state
		const loadingEntry: UsageEntry = {
			key: "openai#0",
			provider: "openai",
			providerName: "OpenAI",
			account: "user@test.org",
			state: "loading",
		};
		const loadingLines = renderUsageDetail(loadingEntry, { width: 60, nowMs });
		const loadingText = loadingLines.map(l => Bun.stripANSI(l)).join("\n");
		expect(loadingText).toContain("OpenAI");
		expect(loadingText).toContain("Loading usage…");

		// Unavailable state
		const unavailEntry: UsageEntry = {
			key: "google#0",
			provider: "google",
			providerName: "Google",
			account: "dev@google.com",
			state: "unavailable",
		};
		const unavailLines = renderUsageDetail(unavailEntry, { width: 60, nowMs });
		const unavailText = unavailLines.map(l => Bun.stripANSI(l)).join("\n");
		expect(unavailText).toContain("Usage unavailable for this account.");
		expect(unavailText).toContain("Press r to retry.");

		// Error state
		const errorEntry: UsageEntry = {
			key: "bedrock#0",
			provider: "bedrock",
			providerName: "AWS Bedrock",
			account: "account-1234",
			state: "error",
			error: "rate limited by remote endpoint",
		};
		const errorLines = renderUsageDetail(errorEntry, { width: 60, nowMs });
		const errorText = errorLines.map(l => Bun.stripANSI(l)).join("\n");
		expect(errorText).toContain("Failed to fetch usage: rate limited by remote endpoint");
		expect(errorText).toContain("Press r to retry.");

		// Report with zero limits
		const zeroEntry: UsageEntry = {
			key: "anthropic#0",
			provider: "anthropic",
			providerName: "Anthropic",
			account: "enterprise@work.com",
			state: "ok",
			report: {
				provider: "anthropic",
				fetchedAt: nowMs,
				limits: [],
			},
		};
		const zeroLines = renderUsageDetail(zeroEntry, { width: 60, nowMs });
		expect(zeroLines.map(l => Bun.stripANSI(l)).join("\n")).toContain("No limits reported.");
	});

	it("renders absolute amounts only when reported", () => {
		// Report with absolute figures
		const withAmounts: UsageEntry = {
			key: "codex#0",
			provider: "openai-codex",
			providerName: "OpenAI Codex",
			account: "bot@codex.ai",
			state: "ok",
			report: {
				provider: "openai-codex",
				fetchedAt: nowMs,
				limits: [
					makeLimit("reqs", "Request Quota", 3_600_000, 0.24, "ok", nowMs + 1_800_000, {
						used: 120,
						limit: 500,
						remaining: 380,
						unit: "requests",
					}),
				],
			},
		};
		const amountsText = renderUsageDetail(withAmounts, { width: 80, nowMs })
			.map(l => Bun.stripANSI(l))
			.join("\n");
		expect(amountsText).toContain("used 120 / 500 requests · 380 remaining");

		// Report with percent unit only
		const percentOnly: UsageEntry = {
			key: "codex#1",
			provider: "openai-codex",
			providerName: "OpenAI Codex",
			account: "bot@codex.ai",
			state: "ok",
			report: {
				provider: "openai-codex",
				fetchedAt: nowMs,
				limits: [
					makeLimit("pct", "Percent Limit", 3_600_000, 0.4, "ok", nowMs + 1_800_000, {
						used: 40,
						limit: 100,
						unit: "percent",
					}),
				],
			},
		};
		const percentText = renderUsageDetail(percentOnly, { width: 80, nowMs })
			.map(l => Bun.stripANSI(l))
			.join("\n");
		expect(percentText).toContain("40% used · 60% left");
		expect(percentText).not.toContain("used 40");
		expect(percentText).not.toContain("requests");
		expect(percentText).not.toContain("remaining");
	});
});
