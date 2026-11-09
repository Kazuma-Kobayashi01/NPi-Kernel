import * as stats from "@oh-my-pi/omp-stats";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";

/** Ranking periods; each starts at its calendar boundary in local time. */
export type RankPeriod = "day" | "week" | "month" | "year";

export const RANK_PERIODS: readonly RankPeriod[] = ["day", "week", "month", "year"];

const PERIOD_UNIT: Record<RankPeriod, string> = { day: "day", week: "week", month: "mo", year: "year" };
export const PERIOD_LABEL: Record<RankPeriod, string> = {
	day: "Today",
	week: "This week",
	month: "This month",
	year: "This year",
};
const PERIOD_ALIASES: Record<string, RankPeriod | undefined> = {
	day: "day",
	d: "day",
	today: "day",
	week: "week",
	w: "week",
	month: "month",
	mo: "month",
	m: "month",
	year: "year",
	y: "year",
};

/** Models listed in the plain-text report; the dashboard scrolls through more. */
const TEXT_LIMIT = 10;
const BOARD_LIMIT = 50;

/** Width of the framed plain-text report. */
export const RANK_TEXT_WIDTH = 96;
/** Narrowest the report lays out. */
const RANK_MIN_WIDTH = 56;

export const RANK_USAGE = "Usage: /rank [day|week|month|year]";

/** Period named by `args` (default month), or an error for anything else. */
export function parseRankPeriod(args: string): RankPeriod | { error: string } {
	const word = args.trim().toLowerCase();
	if (!word) return "month";
	return PERIOD_ALIASES[word] ?? { error: RANK_USAGE };
}

/**
 * Start of `period` containing `now`, local time: midnight today, Monday of
 * this week, the 1st of this month, or January 1st of this year.
 */
export function rankPeriodStart(period: RankPeriod, now: Date): Date {
	const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	switch (period) {
		case "day":
			return start;
		case "week":
			// getDay(): Sunday 0 … Saturday 6; weeks start on Monday.
			start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
			return start;
		case "month":
			return new Date(now.getFullYear(), now.getMonth(), 1);
		case "year":
			return new Date(now.getFullYear(), 0, 1);
	}
}

/** `tokens` in millions with two decimals, e.g. `12.34 M`. */
export function formatMillions(tokens: number): string {
	return `${(tokens / 1_000_000).toFixed(2)} M`;
}

/** A count in at most five columns: `987`, `12.3k`, `4.5M`. */
function formatCount(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatDay(date: Date): string {
	return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export interface TokenRankModel {
	name: string;
	/** Every token the model moved: input, output, cache reads and writes. */
	tokens: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	requests: number;
}

export interface TokenRankPeriod {
	period: RankPeriod;
	since: Date;
	total: number;
	/** Most tokens first. */
	models: TokenRankModel[];
}

export interface TokenRankData {
	now: Date;
	periods: TokenRankPeriod[];
}

/** Sync session files into the stats DB, then gather every period's models. */
export async function loadTokenRanks(now = new Date()): Promise<TokenRankData> {
	await stats.syncAllSessions();
	const periods = await Promise.all(
		RANK_PERIODS.map(async period => {
			const since = rankPeriodStart(period, now);
			const rows = await stats.getModelStatsSince(since.getTime());
			const models = rows
				.map(row => ({
					name: `${row.provider}/${row.model}`,
					tokens:
						row.totalInputTokens + row.totalOutputTokens + row.totalCacheReadTokens + row.totalCacheWriteTokens,
					input: row.totalInputTokens,
					output: row.totalOutputTokens,
					cacheRead: row.totalCacheReadTokens,
					cacheWrite: row.totalCacheWriteTokens,
					cost: row.totalCost,
					requests: row.totalRequests,
				}))
				.filter(model => model.tokens > 0)
				.sort((left, right) => right.tokens - left.tokens);
			return { period, since, total: models.reduce((sum, model) => sum + model.tokens, 0), models };
		}),
	);
	return { now, periods };
}

/** Paint roles for the report; plain text passes everything through. */
export type RankRole =
	| "frame"
	| "rule"
	| "title"
	| "label"
	| "selected"
	| "bar"
	| "track"
	| "value"
	| "dim"
	| "gold"
	| "silver"
	| "bronze"
	| "input"
	| "output"
	| "cacheRead"
	| "cacheWrite";

export type RankPaint = (role: RankRole, text: string) => string;

const PLAIN: RankPaint = (_role, text) => text;

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/** A bar `width` cells wide filled to `fraction`, with eighth-cell precision. */
function bar(fraction: number, width: number, paint: RankPaint, role: RankRole = "bar"): string {
	const eighths = Math.round(Math.max(0, Math.min(1, fraction)) * width * 8);
	const full = Math.floor(eighths / 8);
	let partial = EIGHTHS[eighths % 8]!;
	// Any usage at all shows at least a sliver.
	if (full === 0 && partial === "" && fraction > 0) partial = "▏";
	const rest = Math.max(0, width - full - (partial ? 1 : 0));
	return `${paint("frame", "▕")}${paint(role, "█".repeat(full) + partial)}${paint("track", "░".repeat(rest))}${paint("frame", "▏")}`;
}

/** A bar `width` cells wide whose filled part (`fraction`) is split into stacked segments. */
function stackedBar(
	fraction: number,
	width: number,
	segments: readonly { role: RankRole; char: string; value: number }[],
	paint: RankPaint,
): string {
	const cells = Math.max(fraction > 0 ? 1 : 0, Math.round(Math.max(0, Math.min(1, fraction)) * width));
	const sum = segments.reduce((total, segment) => total + segment.value, 0) || 1;
	let out = "";
	let used = 0;
	let carried = 0;
	for (const segment of segments) {
		carried += (segment.value / sum) * cells;
		const take = Math.min(cells - used, Math.round(carried) - used);
		if (take > 0) {
			out += paint(segment.role, segment.char.repeat(take));
			used += take;
		}
	}
	return `${paint("frame", "▕")}${out}${paint("track", "·".repeat(Math.max(0, width - used)))}${paint("frame", "▏")}`;
}

/** `left` and `right` on one line of `width` columns, padded apart. */
function spread(left: string, right: string, width: number): string {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	return gap >= 1 ? `${left}${" ".repeat(gap)}${right}` : truncateToWidth(`${left} ${right}`, width);
}

function padEnd(text: string, width: number): string {
	const visible = visibleWidth(text);
	return visible >= width ? truncateToWidth(text, width) : text + " ".repeat(width - visible);
}

function padStart(text: string, width: number): string {
	const visible = visibleWidth(text);
	return visible >= width ? text : " ".repeat(width - visible) + text;
}

function periodOf(data: TokenRankData, period: RankPeriod): TokenRankPeriod {
	return data.periods.find(entry => entry.period === period)!;
}

const MEDALS: RankRole[] = ["gold", "silver", "bronze"];

function rankCell(index: number, paint: RankPaint): string {
	return paint(MEDALS[index] ?? "dim", `${index < 3 ? "★" : "#"}${String(index + 1).padStart(2, "0")} `);
}

/**
 * The leaderboard of `period` as lines `width` columns wide, unframed: a
 * header, a log-scale progress bar per period with `period` marked, and the
 * period's models ranked with share bars.
 */
export function renderRankBoard(
	data: TokenRankData,
	period: RankPeriod,
	width: number,
	paint = PLAIN,
	limit = BOARD_LIMIT,
): string[] {
	const inner = Math.max(RANK_MIN_WIDTH - 4, width);
	const lines: string[] = [];
	lines.push(
		spread(
			paint("title", "▓▒░ TOKEN RANKING ░▒▓"),
			paint("dim", `log-scale bars · ${data.now.getFullYear()}-${formatDay(data.now)}`),
			inner,
		),
	);
	lines.push("");

	// A day is a sliver of a year, so the bars use a log scale (from 0.1 M up
	// to the largest period) to keep every period readable.
	const peak = Math.max(1, ...data.periods.map(entry => entry.total));
	const logShare = (tokens: number): number => Math.log1p(tokens / 100_000) / Math.log1p(peak / 100_000);
	const labelWidth = 12;
	const sinceWidth = 6;
	const valueWidth = 22;
	const periodBar = Math.max(8, inner - 2 - labelWidth - sinceWidth - valueWidth - 4);
	for (const entry of data.periods) {
		const chosen = entry.period === period;
		const marker = chosen ? paint("selected", "▶ ") : "  ";
		const label = paint(chosen ? "selected" : "label", padEnd(PERIOD_LABEL[entry.period], labelWidth));
		const since = paint("dim", padEnd(formatDay(entry.since), sinceWidth));
		const value = `${paint(chosen ? "selected" : "value", padStart(formatMillions(entry.total), 10))} ${paint("dim", `Token/${PERIOD_UNIT[entry.period]}`)}`;
		lines.push(
			`${marker}${label}${since}${bar(logShare(entry.total), periodBar, paint, chosen ? "selected" : "bar")}  ${padEnd(value, valueWidth)}`,
		);
	}
	lines.push("", paint("rule", "─".repeat(inner)), "");

	const selected = periodOf(data, period);
	lines.push(
		spread(
			paint("title", `${PERIOD_LABEL[period].toUpperCase()} · TOP MODELS`),
			`${paint("selected", formatMillions(selected.total))} ${paint("dim", `Token/${PERIOD_UNIT[period]}`)}`,
			inner,
		),
	);
	lines.push("");
	if (selected.models.length === 0) {
		lines.push(paint("dim", "No token usage recorded in this period yet."));
		return lines;
	}
	const lead = Math.max(1, selected.models[0]!.tokens);
	const tokenWidth = 10;
	const shareWidth = 8;
	// The request count is the first column to go when the frame is narrow.
	const reqWidth = inner >= 72 ? 10 : 0;
	const nameWidth = Math.min(38, Math.max(14, Math.floor(inner * 0.32)));
	const modelBar = Math.max(6, inner - 4 - nameWidth - tokenWidth - shareWidth - reqWidth - 3);
	for (const [index, model] of selected.models.slice(0, limit).entries()) {
		const role = MEDALS[index];
		const name = paint(role ? "label" : "value", padEnd(truncateToWidth(model.name, nameWidth - 1), nameWidth));
		const share = selected.total > 0 ? `${((model.tokens / selected.total) * 100).toFixed(1)}%` : "-";
		const requests = reqWidth > 0 ? paint("dim", padStart(`${formatCount(model.requests)} req`, reqWidth)) : "";
		lines.push(
			`${rankCell(index, paint)}${name}${bar(model.tokens / lead, modelBar, paint, role ?? "bar")} ${paint("value", padStart(formatMillions(model.tokens), tokenWidth))}${paint("dim", padStart(share, shareWidth))}${requests}`,
		);
	}
	if (selected.models.length > limit) {
		lines.push("", paint("dim", `… ${selected.models.length - limit} more models not shown`));
	}
	return lines;
}

/**
 * Where each model's tokens went in `period`: a stacked bar (input, output,
 * cache reads, cache writes) scaled to the busiest model, with the split and
 * the spend beside it; the split columns drop out when `width` is narrow.
 */
export function renderRankDetail(data: TokenRankData, period: RankPeriod, width: number, paint = PLAIN): string[] {
	const inner = Math.max(RANK_MIN_WIDTH - 4, width);
	const selected = periodOf(data, period);
	const legend = [
		paint("input", "█ input"),
		paint("output", "▓ output"),
		paint("cacheRead", "▒ cache read"),
		paint("cacheWrite", "░ cache write"),
	].join("  ");
	const lines = [spread(paint("title", `${PERIOD_LABEL[period].toUpperCase()} · TOKEN BREAKDOWN`), legend, inner), ""];
	if (selected.models.length === 0) {
		lines.push(paint("dim", "No token usage recorded in this period yet."));
		return lines;
	}
	const wide = inner >= 120;
	const num = 10;
	const nameWidth = Math.min(34, Math.max(14, Math.floor(inner * 0.24)));
	const tail = num * (wide ? 6 : 2);
	const barWidth = Math.max(8, inner - 4 - nameWidth - tail - 3);
	const headings = wide ? ["total", "input", "output", "cache rd", "cache wr", "cost"] : ["total", "cost"];
	lines.push(
		paint("dim", `${" ".repeat(4 + nameWidth + barWidth + 3)}${headings.map(h => padStart(h, num)).join("")}`),
	);
	const lead = Math.max(1, selected.models[0]!.tokens);
	for (const [index, model] of selected.models.slice(0, BOARD_LIMIT).entries()) {
		const name = paint(
			MEDALS[index] ? "label" : "value",
			padEnd(truncateToWidth(model.name, nameWidth - 1), nameWidth),
		);
		const stacked = stackedBar(
			model.tokens / lead,
			barWidth,
			[
				{ role: "input", char: "█", value: model.input },
				{ role: "output", char: "▓", value: model.output },
				{ role: "cacheRead", char: "▒", value: model.cacheRead },
				{ role: "cacheWrite", char: "░", value: model.cacheWrite },
			],
			paint,
		);
		const cells = [paint("value", padStart(formatMillions(model.tokens), num))];
		if (wide) {
			cells.push(
				paint("input", padStart(formatMillions(model.input), num)),
				paint("output", padStart(formatMillions(model.output), num)),
				paint("cacheRead", padStart(formatMillions(model.cacheRead), num)),
				paint("cacheWrite", padStart(formatMillions(model.cacheWrite), num)),
			);
		}
		cells.push(paint("dim", padStart(`$${model.cost.toFixed(2)}`, num)));
		lines.push(`${rankCell(index, paint)}${name}${stacked} ${cells.join("")}`);
	}
	return lines;
}

/** `lines` inside a rounded box `outer` columns wide. */
function framed(lines: readonly string[], outer: number, paint: RankPaint): string[] {
	const inner = outer - 4;
	return [
		paint("frame", `╭${"─".repeat(outer - 2)}╮`),
		...lines.map(line => `${paint("frame", "│")} ${padEnd(line, inner)} ${paint("frame", "│")}`),
		paint("frame", `╰${"─".repeat(outer - 2)}╯`),
	];
}

/** Framed leaderboard lines `outer` columns wide, for plain-text hosts. */
export function renderTokenRankFramed(
	data: TokenRankData,
	period: RankPeriod,
	outer = RANK_TEXT_WIDTH,
	paint = PLAIN,
): string[] {
	const width = Math.max(RANK_MIN_WIDTH, outer);
	return framed(renderRankBoard(data, period, width - 4, paint, TEXT_LIMIT), width, paint);
}

/** The leaderboard as a framed plain-text block for hosts that show markdown. */
export function renderTokenRankMarkdown(data: TokenRankData, period: RankPeriod): string {
	return ["```text", ...renderTokenRankFramed(data, period), "```"].join("\n");
}
