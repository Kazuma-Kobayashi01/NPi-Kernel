/**
 * The session side panel, the terminal's take on the desktop app's rail: where
 * the conversation runs, how full its context is, what this conversation has
 * spent so far (USD and tokens), what is left of the subscription, and what is
 * left to do.
 * Pure rendering; the composer docks the rows.
 */
import { formatNumber } from "@oh-my-pi/pi-utils";
import { theme } from "../theme/theme";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils";

export interface SidePanelLimit {
	readonly label: string;
	/** Percent of the window used, 0-100. */
	readonly percent: number;
	readonly resetMinutes?: number;
}

export interface SidePanelFacts {
	readonly title: string;
	readonly directory: string;
	readonly branch?: string;
	readonly contextTokens?: number;
	readonly contextWindow?: number;
	readonly contextPercent?: number;
	/** `Provider · plan`, present only for a signed-in subscription. */
	readonly plan?: string;
	readonly limits: readonly SidePanelLimit[];
	/** Estimated USD spend of this conversation, its subagents included. */
	readonly cost?: number;
	/** Input tokens, cache writes included. */
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheReadTokens?: number;
	/** Output of the reply streaming now, estimated; shown with a "~" on top of the booked totals. */
	readonly streamingTokens?: number;
	readonly streamingCost?: number;
	readonly tasksDone: number;
	readonly tasksTotal: number;
	/** Unfinished tasks in plan order. */
	readonly openTasks: readonly string[];
}

export interface SidePanelRows {
	readonly top: readonly string[];
	readonly bottom: readonly string[];
}

const MAX_TITLE_ROWS = 2;
const MAX_OPEN_TASKS = 5;
/** Used percentages where a meter turns amber and red, as in the desktop rail. */
const METER_WARNING = 65;
const METER_DANGER = 85;

/** `left` and `right` on one row, pushed to its two edges. */
function spaced(left: string, right: string, width: number): string {
	const room = Math.max(0, width - visibleWidth(right) - 1);
	const shown = truncateToWidth(left, room);
	return `${shown}${" ".repeat(Math.max(1, width - visibleWidth(shown) - visibleWidth(right)))}${right}`;
}

function meter(percent: number, width: number): string {
	const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width);
	const colour = percent > METER_DANGER ? "error" : percent > METER_WARNING ? "warning" : "accent";
	return `${theme.fg(colour, "━".repeat(filled))}${theme.fg("dim", "─".repeat(width - filled))}`;
}

/** `2h 5m`, the desktop rail's countdown. */
function untilReset(minutes: number): string {
	const rounded = Math.max(1, Math.round(minutes));
	const days = Math.floor(rounded / 1440);
	const hours = Math.floor((rounded % 1440) / 60);
	if (days > 0) return `${days}d ${hours}h`;
	return hours > 0 ? `${hours}h ${rounded % 60}m` : `${rounded}m`;
}

export function renderSidePanel(facts: SidePanelFacts, width: number): SidePanelRows {
	const fit = (text: string) => truncateToWidth(text, width);
	const muted = (text: string) => theme.fg("muted", text);
	const heading = (text: string) => theme.bold(text);
	const top = wrapTextWithAnsi(facts.title, width)
		.slice(0, MAX_TITLE_ROWS)
		.map(row => theme.bold(fit(row)));

	top.push("", heading("Environment"), muted(keepEnd(facts.directory, width)));
	if (facts.branch) top.push(muted(fit(`⎇ ${facts.branch}`)));

	const percent = facts.contextPercent;
	if (facts.contextTokens !== undefined || percent !== undefined) {
		const used = facts.contextTokens === undefined ? "" : formatNumber(facts.contextTokens);
		const total = facts.contextWindow ? ` / ${formatNumber(facts.contextWindow)}` : "";
		const share = percent === undefined ? "" : `${percent > 0 && percent < 1 ? "<1" : Math.round(percent)}% used`;
		top.push("", heading("Context"), muted(spaced(share, `${used}${total}`, width)));
		if (percent !== undefined) top.push(meter(percent, width));
	}

	// Spend comes right after context and is always shown: it is what a session costs as it runs.
	const input = facts.inputTokens ?? 0;
	const output = facts.outputTokens ?? 0;
	const cacheRead = facts.cacheReadTokens ?? 0;
	const streaming = facts.streamingTokens ?? 0;
	// While a reply streams its output is estimated on top, marked "~", until its usage is booked.
	const mark = streaming > 0 ? "~" : "";
	const spend = `${mark}${formatSpend((facts.cost ?? 0) + (streaming > 0 ? (facts.streamingCost ?? 0) : 0))}`;
	top.push(
		"",
		heading("Spend"),
		spaced(
			streaming > 0 ? muted(spend) : theme.bold(spend),
			muted(`${mark}${formatNumber(input + output + cacheRead + streaming)} tokens`),
			width,
		),
	);
	if (streaming > 0) top.push(theme.fg("dim", spaced("Streaming", `~${formatNumber(streaming)}`, width)));
	top.push(muted(spaced("Input", formatNumber(input), width)), muted(spaced("Output", formatNumber(output), width)));
	if (cacheRead > 0) top.push(muted(spaced("Cache read", formatNumber(cacheRead), width)));

	if (facts.plan !== undefined || facts.limits.length > 0) {
		top.push("", heading("Plan usage"));
		if (facts.plan) top.push(muted(fit(facts.plan)));
		for (const limit of facts.limits) {
			top.push(muted(spaced(limit.label, `${Math.round(limit.percent)}% used`, width)), meter(limit.percent, width));
			if (limit.resetMinutes !== undefined) {
				top.push(theme.fg("dim", fit(`Resets in ${untilReset(limit.resetMinutes)}`)));
			}
		}
	}

	if (facts.tasksTotal > 0) {
		top.push("", `${heading("Todo")} ${muted(`${facts.tasksDone}/${facts.tasksTotal}`)}`);
		for (const task of facts.openTasks.slice(0, MAX_OPEN_TASKS)) top.push(muted(fit(`○ ${task}`)));
		const hidden = facts.openTasks.length - MAX_OPEN_TASKS;
		if (hidden > 0) top.push(theme.fg("dim", `… ${hidden} more`));
	}

	return { top, bottom: [] };
}

/** `$0.0123` under a dollar, `$1.23` above: small sessions still show movement. */
export function formatSpend(cost: number | undefined): string {
	if (!cost || cost <= 0) return "$0.0000";
	if (cost < 0.0001) return "<$0.0001";
	return "$" + (cost < 1 ? cost.toFixed(4) : cost.toFixed(2));
}

/** `text` cut from the left: a path's end says more than its start. */
function keepEnd(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	const glyphs = [...text];
	while (glyphs.length > 0 && visibleWidth(glyphs.join("")) > width - 1) glyphs.shift();
	return `…${glyphs.join("")}`;
}
