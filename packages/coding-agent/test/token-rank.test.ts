import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import {
	rankPeriodStart,
	renderRankDetail,
	renderTokenRankFramed,
	type TokenRankData,
} from "../src/slash-commands/helpers/token-rank";

const now = new Date(2026, 10, 15, 9); // a Sunday
const model = (name: string, input: number, output: number, cacheRead: number, cacheWrite: number) => ({
	name,
	tokens: input + output + cacheRead + cacheWrite,
	input,
	output,
	cacheRead,
	cacheWrite,
	cost: 1.5,
	requests: 1234,
});
const models = [
	model("provider-with-a-long-name/model-with-an-even-longer-name", 2e6, 1e6, 2.5e6, 0.5e6),
	model("other/model", 1e6, 1e6, 1e6, 0),
];
const data: TokenRankData = {
	now,
	periods: (["day", "week", "month", "year"] as const).map((period, i) => ({
		period,
		since: rankPeriodStart(period, now),
		total: [2e6, 9e6, 40e6, 500e6][i]!,
		models,
	})),
};

describe("token rank rendering", () => {
	it("starts weeks on Monday", () => {
		expect(rankPeriodStart("week", now).getDate()).toBe(9);
	});

	it("frames every line to the same width and drops the request column when narrow", () => {
		for (const width of [96, 60]) {
			const lines = renderTokenRankFramed(data, "week", width);
			expect(new Set(lines.map(line => visibleWidth(line)))).toEqual(new Set([width]));
			expect(lines.join("\n").includes("1.2k req")).toBe(width === 96);
		}
	});

	it("splits each model's stacked bar in proportion to input, output and cache", () => {
		const row = renderRankDetail(data, "week", 140).find(line => line.includes("other/model"))!;
		const segment = (char: string) => [...row].filter(c => c === char).length;
		// "other/model" moves equal input, output and cache reads and no cache writes;
		// whole cells round, so equal parts may differ by one.
		const parts = [segment("█"), segment("▓"), segment("▒")];
		expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
		expect(Math.min(...parts)).toBeGreaterThan(0);
		expect(segment("░")).toBe(0);
	});
});
