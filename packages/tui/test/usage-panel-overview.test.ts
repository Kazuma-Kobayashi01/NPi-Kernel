import { beforeAll, describe, expect, it } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { initTheme } from "../src/theme";
import { visibleWidth } from "../src/utils";
import type { UsageEntry } from "../src/overlays/usage-panel-model";
import { renderUsageOverview } from "../src/overlays/usage-panel-overview";

beforeAll(async () => {
	await initTheme(false);
});

const NOW = 1_700_000_000_000;
const FIVE_HOURS_MS = 5 * 3_600_000;
const SEVEN_DAYS_MS = 7 * 24 * 3_600_000;

function createTestEntries(): UsageEntry[] {
	const anthropicReport: UsageReport = {
		provider: "anthropic",
		fetchedAt: NOW,
		limits: [
			{
				id: "anthropic:5h",
				label: "Session quota",
				scope: { provider: "anthropic" },
				window: {
					id: "5h",
					label: "5h",
					durationMs: FIVE_HOURS_MS,
					resetsAt: NOW + 2 * 3_600_000 + 5 * 60_000,
				},
				amount: { usedFraction: 0.5, unit: "percent" },
				status: "ok",
			},
			{
				id: "anthropic:weekly",
				label: "Weekly quota",
				scope: { provider: "anthropic" },
				window: {
					id: "weekly",
					label: "weekly",
					durationMs: SEVEN_DAYS_MS,
					resetsAt: NOW + 3 * 24 * 3_600_000,
				},
				amount: { usedFraction: 0.85, unit: "percent" },
				status: "warning",
			},
		],
		resetCredits: {
			availableCount: 2,
			redeemableCount: 1,
		},
	};

	const openaiReport: UsageReport = {
		provider: "openai",
		fetchedAt: NOW,
		limits: [
			{
				id: "openai:credit",
				label: "Credits",
				scope: { provider: "openai" },
				amount: { used: 12.5, unit: "usd" },
				status: "ok",
			},
		],
	};

	const zeroLimitsReport: UsageReport = {
		provider: "google",
		fetchedAt: NOW,
		limits: [],
	};

	return [
		{
			key: "anthropic#0",
			provider: "anthropic",
			providerName: "Anthropic",
			account: "alice@example.com",
			state: "ok",
			report: anthropicReport,
		},
		{
			key: "openai#0",
			provider: "openai",
			providerName: "OpenAI",
			account: "bob@example.com",
			state: "ok",
			report: openaiReport,
		},
		{
			key: "google#0",
			provider: "google",
			providerName: "Google",
			account: "zero@example.com",
			state: "ok",
			report: zeroLimitsReport,
		},
		{
			key: "loading#0",
			provider: "provider-load",
			providerName: "Loading Provider",
			account: "loading@example.com",
			state: "loading",
		},
		{
			key: "unavail#0",
			provider: "provider-unavail",
			providerName: "Unavailable Provider",
			account: "unavail@example.com",
			state: "unavailable",
		},
		{
			key: "error#0",
			provider: "provider-err",
			providerName: "Error Provider",
			account: "err@example.com",
			state: "error",
			error: "Connection timeout while fetching usage",
		},
	];
}

describe("renderUsageOverview", () => {
	it("renders empty state correctly", () => {
		const res100 = renderUsageOverview([], { width: 100, nowMs: NOW, selected: 0 });
		expect(res100.lines.length).toBe(1);
		expect(res100.lines[0]).toContain("No usage data available.");
		expect(res100.selectedStart).toBe(0);
		expect(res100.selectedEnd).toBe(0);

		for (const w of [20, 40, 100]) {
			const res = renderUsageOverview([], { width: w, nowMs: NOW, selected: 0 });
			for (const line of res.lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(w);
			}
		}
	});

	it("renders loading, unavailable, error, and zero-limits states", () => {
		const entries = createTestEntries();
		const res = renderUsageOverview(entries, { width: 100, nowMs: NOW, selected: 0 });
		const joined = res.lines.join("\n");

		expect(joined).toContain("loading…");
		expect(joined).toContain("usage unavailable");
		expect(joined).toContain("failed: Connection timeout while fetching usage");
		expect(joined).toContain("no limits");
	});

	it("renders 5h + weekly limits with bar, % used, and countdown at width 100", () => {
		const entries = createTestEntries();
		const res = renderUsageOverview(entries, { width: 100, nowMs: NOW, selected: 0 });

		// Anthropic entry is selected (index 0)
		const anthropicLines = res.lines.slice(res.selectedStart, res.selectedEnd + 1);
		const fullText = anthropicLines.join("\n");

		// Header line shows selection marker, account, and worst window summary
		expect(anthropicLines[0]).toContain("❯");
		expect(anthropicLines[0]).toContain("alice@example.com");

		// 5h limit line
		expect(fullText).toContain("Session quota");
		expect(fullText).toContain("5h");
		expect(fullText).toContain("50% used");
		expect(fullText).toContain("resets in 2h5m");

		// weekly limit line
		expect(fullText).toContain("Weekly quota");
		expect(fullText).toContain("7d");
		expect(fullText).toContain("85% used");
		expect(fullText).toContain("resets in 3d");

		// Bars should contain block/track characters
		expect(fullText).toContain("█");
		expect(fullText).toContain("░");

		// Reset credits line
		expect(fullText).toContain("✦ 2 resets · 1 usable");
	});

	it("sets selectedStart and selectedEnd to the exact lines of the selected entry", () => {
		const entries = createTestEntries();

		// Select entry 0 (Anthropic)
		const res0 = renderUsageOverview(entries, { width: 100, nowMs: NOW, selected: 0 });
		expect(res0.lines[res0.selectedStart]).toContain("❯");
		expect(res0.lines[res0.selectedStart]).toContain("alice@example.com");
		expect(res0.lines[res0.selectedEnd]).toContain("✦ 2 resets · 1 usable");

		// Select entry 1 (OpenAI)
		const res1 = renderUsageOverview(entries, { width: 100, nowMs: NOW, selected: 1 });
		expect(res1.lines[res1.selectedStart]).toContain("❯");
		expect(res1.lines[res1.selectedStart]).toContain("bob@example.com");
		// Unselected entry 0 should not have the accent marker
		expect(res1.lines[res0.selectedStart]).not.toContain("❯");
	});

	it("never exceeds width at 20, 40, and 100 columns", () => {
		const entries = createTestEntries();

		for (const w of [20, 40, 100]) {
			for (let sel = 0; sel < entries.length; sel++) {
				const res = renderUsageOverview(entries, { width: w, nowMs: NOW, selected: sel });
				expect(res.lines.length).toBeGreaterThan(0);
				expect(res.selectedStart).toBeLessThanOrEqual(res.selectedEnd);
				expect(res.selectedStart).toBeGreaterThanOrEqual(0);
				expect(res.selectedEnd).toBeLessThan(res.lines.length);

				for (let lineIdx = 0; lineIdx < res.lines.length; lineIdx++) {
					const line = res.lines[lineIdx]!;
					const len = visibleWidth(line);
					expect(len).toBeLessThanOrEqual(w);
				}
			}
		}
	});
});
