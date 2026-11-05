/**
 * The session side panel, the terminal's take on the desktop app's rail: where
 * the conversation runs, how full its context is, what is left of the
 * subscription, what this conversation has spent, and what is left to do.
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
	readonly cost?: number;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
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

	const conversation: string[] = [];
	if (facts.cost) conversation.push(muted(spaced("Spend", `$${facts.cost.toFixed(2)}`, width)));
	if (facts.inputTokens) conversation.push(muted(spaced("Input", formatNumber(facts.inputTokens), width)));
	if (facts.outputTokens) conversation.push(muted(spaced("Output", formatNumber(facts.outputTokens), width)));
	if (conversation.length > 0) top.push("", heading("This conversation"), ...conversation);

	if (facts.tasksTotal > 0) {
		top.push("", `${heading("Todo")} ${muted(`${facts.tasksDone}/${facts.tasksTotal}`)}`);
		for (const task of facts.openTasks.slice(0, MAX_OPEN_TASKS)) top.push(muted(fit(`○ ${task}`)));
		const hidden = facts.openTasks.length - MAX_OPEN_TASKS;
		if (hidden > 0) top.push(theme.fg("dim", `… ${hidden} more`));
	}

	return { top, bottom: [] };
}

/** `text` cut from the left: a path's end says more than its start. */
function keepEnd(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	const glyphs = [...text];
	while (glyphs.length > 0 && visibleWidth(glyphs.join("")) > width - 1) glyphs.shift();
	return `…${glyphs.join("")}`;
}
