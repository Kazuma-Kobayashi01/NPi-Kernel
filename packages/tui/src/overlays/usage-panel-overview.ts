import { resolveUsedFraction, type UsageLimit } from "@oh-my-pi/pi-ai";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { truncateToWidth, visibleWidth } from "../index";
import { theme } from "../theme/theme";
import { formatLimitTitle, summarizeUsageResetCredits } from "./usage-display";
import { type UsageEntry, usageBar, usageStatusColor, usageStatusIcon } from "./usage-panel-model";
import { formatAbsoluteOnlyAmount } from "../prompt/usage-amounts";
import { sanitizeDisplayLine } from "./extensions/display-text";

export interface UsageOverviewOptions {
	width: number;
	nowMs: number;
	/** Index into entries */
	selected: number;
}

export interface UsageOverviewResult {
	lines: string[];
	/** First line index (inclusive) of the selected entry's block, for scroll-into-view */
	selectedStart: number;
	/** Last line index (inclusive) of the selected entry's block, for scroll-into-view */
	selectedEnd: number;
}

const DEFAULT_BAR_WIDTH = 12;
const MIN_BAR_WIDTH = 6;

function formatWindowTag(window: NonNullable<UsageLimit["window"]>): string {
	if (window.durationMs) {
		const hours = window.durationMs / 3_600_000;
		if (hours >= 28 * 24) return "mo";
		if (hours >= 24) return `${Math.round(hours / 24)}d`;
		return `${Math.round(hours)}h`;
	}
	return window.label || window.id || "";
}

function statusSeverity(status: UsageLimit["status"]): number {
	if (status === "exhausted") return 3;
	if (status === "warning") return 2;
	if (status === "ok") return 1;
	return 0;
}

function entryWorstStatus(limits: readonly UsageLimit[]): UsageLimit["status"] {
	let worst: UsageLimit["status"] = "unknown";
	let worstRank = 0;
	for (const limit of limits) {
		const rank = statusSeverity(limit.status);
		if (rank > worstRank) {
			worst = limit.status;
			worstRank = rank;
		}
	}
	return worst;
}

function findWorstLimit(limits: readonly UsageLimit[]): UsageLimit | undefined {
	if (limits.length === 0) return undefined;
	let worst = limits[0]!;
	let worstFrac = resolveUsedFraction(worst) ?? -1;
	for (let i = 1; i < limits.length; i++) {
		const limit = limits[i]!;
		const frac = resolveUsedFraction(limit) ?? -1;
		if (frac > worstFrac) {
			worst = limit;
			worstFrac = frac;
		} else if (frac === worstFrac) {
			if (statusSeverity(limit.status) > statusSeverity(worst.status)) {
				worst = limit;
			}
		}
	}
	return worst;
}

function buildEntryHeaderLine(entry: UsageEntry, isSelected: boolean, width: number): string {
	const marker = isSelected ? theme.fg("accent", "❯") : " ";

	let statusIcon: string;
	let worstLimit: UsageLimit | undefined;

	if (entry.state === "loading" || entry.state === "unavailable") {
		statusIcon = theme.fg("dim", theme.status.info);
	} else if (entry.state === "error") {
		statusIcon = theme.fg("error", theme.status.error);
	} else {
		const limits = entry.report?.limits ?? [];
		if (limits.length === 0) {
			statusIcon = theme.fg("dim", theme.status.info);
		} else {
			const worstStatus = entryWorstStatus(limits);
			statusIcon = usageStatusIcon(worstStatus);
			worstLimit = findWorstLimit(limits);
		}
	}

	const accountLabel = sanitizeDisplayLine(entry.account);

	let summaryStyled: string | undefined;
	let summaryWidth = 0;
	if (worstLimit) {
		const frac = resolveUsedFraction(worstLimit);
		if (frac !== undefined) {
			const pct = Math.round(frac * 100);
			const tag = worstLimit.window ? formatWindowTag(worstLimit.window) : "";
			const color = usageStatusColor(worstLimit.status);
			const pctStyled = theme.fg(color, `${pct}%`);
			summaryStyled = tag ? `${theme.fg("dim", tag)} ${pctStyled}` : pctStyled;
			summaryWidth = (tag ? tag.length + 1 : 0) + `${pct}%`.length;
		} else {
			const amt = formatAbsoluteOnlyAmount([worstLimit]);
			if (amt) {
				summaryStyled = theme.fg("dim", amt);
				summaryWidth = visibleWidth(amt);
			}
		}
	}

	const prefixWidth = 4;
	// The credential this session uses carries an `in use` tag; at narrow widths the label is cut
	// before the tag is dropped.
	const tagText = "in use";
	const tagWidth = entry.active ? tagText.length + 1 : 0;
	const tagStyled = entry.active ? ` ${theme.fg("accent", tagText)}` : "";
	const styled = (label: string) => (isSelected ? theme.bold(theme.fg("accent", label)) : label);
	const accountWidth = visibleWidth(accountLabel);

	if (summaryStyled && prefixWidth + accountWidth + tagWidth + 1 + summaryWidth <= width) {
		const padWidth = width - (prefixWidth + accountWidth + tagWidth + summaryWidth);
		return truncateToWidth(
			`${marker} ${statusIcon} ${styled(accountLabel)}${tagStyled}${" ".repeat(padWidth)}${summaryStyled}`,
			width,
		);
	}

	if (prefixWidth + accountWidth + tagWidth <= width) {
		return truncateToWidth(`${marker} ${statusIcon} ${styled(accountLabel)}${tagStyled}`, width);
	}

	const keepTag = entry.active && width - prefixWidth - tagWidth >= 1;
	const budget = Math.max(1, width - prefixWidth - (keepTag ? tagWidth : 0));
	const truncated = truncateToWidth(accountLabel, budget);
	return truncateToWidth(`${marker} ${statusIcon} ${styled(truncated)}${keepTag ? tagStyled : ""}`, width);
}

function buildLimitLine(limit: UsageLimit, nowMs: number, contentWidth: number): string {
	const title = sanitizeDisplayLine(formatLimitTitle(limit));
	const tag = limit.window ? sanitizeDisplayLine(formatWindowTag(limit.window)) : "";
	const fraction = resolveUsedFraction(limit);

	if (fraction === undefined) {
		const amountText = formatAbsoluteOnlyAmount([limit]) ?? "no data";
		const amountStyled = theme.fg("dim", amountText);
		const labelPlain = tag ? `${title} ${tag}` : title;
		const labelStyled = tag ? `${theme.fg("muted", title)} ${theme.fg("dim", tag)}` : theme.fg("muted", title);

		const amountWidth = visibleWidth(amountText);
		if (visibleWidth(labelPlain) + 1 + amountWidth <= contentWidth) {
			return `${labelStyled} ${amountStyled}`;
		}
		const budget = Math.max(1, contentWidth - 1 - amountWidth);
		const truncated = truncateToWidth(labelStyled, budget);
		if (visibleWidth(truncated) + 1 + amountWidth <= contentWidth) {
			return `${truncated} ${amountStyled}`;
		}
		return truncateToWidth(`${labelStyled} ${amountStyled}`, contentWidth);
	}

	const pct = Math.round(fraction * 100);
	const pctText = `${pct}% used`;
	const statusColor = usageStatusColor(limit.status);
	const pctStyled = theme.fg(statusColor, pctText);
	const pctWidth = pctText.length;

	let countdownFull: string | undefined;
	let countdownShort: string | undefined;
	if (limit.window?.resetsAt !== undefined && limit.window.resetsAt > nowMs) {
		const duration = formatDuration(limit.window.resetsAt - nowMs);
		countdownFull = `resets in ${duration}`;
		countdownShort = duration;
	}

	const labelPlain = tag ? `${title} ${tag}` : title;
	const labelStyled = tag ? `${theme.fg("muted", title)} ${theme.fg("dim", tag)}` : theme.fg("muted", title);
	const labelWidth = visibleWidth(labelPlain);

	// 1. Try full countdown with default bar
	if (countdownFull) {
		const cdWidth = visibleWidth(countdownFull);
		const needed = labelWidth + 1 + DEFAULT_BAR_WIDTH + 1 + pctWidth + 1 + cdWidth;
		if (needed <= contentWidth) {
			const bar = usageBar(fraction, limit.status, DEFAULT_BAR_WIDTH);
			return `${labelStyled} ${bar} ${pctStyled} ${theme.fg("dim", countdownFull)}`;
		}
	}

	// 2. Try short countdown with default bar
	if (countdownShort) {
		const cdWidth = visibleWidth(countdownShort);
		const needed = labelWidth + 1 + DEFAULT_BAR_WIDTH + 1 + pctWidth + 1 + cdWidth;
		if (needed <= contentWidth) {
			const bar = usageBar(fraction, limit.status, DEFAULT_BAR_WIDTH);
			return `${labelStyled} ${bar} ${pctStyled} ${theme.fg("dim", countdownShort)}`;
		}
	}

	// 3. Try short countdown with shrunk bar (between DEFAULT_BAR_WIDTH - 1 down to MIN_BAR_WIDTH)
	if (countdownShort) {
		const cdWidth = visibleWidth(countdownShort);
		const fixedWidth = labelWidth + 1 + 1 + pctWidth + 1 + cdWidth;
		const availableBar = contentWidth - fixedWidth;
		if (availableBar >= MIN_BAR_WIDTH) {
			const barWidth = Math.min(DEFAULT_BAR_WIDTH, availableBar);
			const bar = usageBar(fraction, limit.status, barWidth);
			return `${labelStyled} ${bar} ${pctStyled} ${theme.fg("dim", countdownShort)}`;
		}
	}

	// 4. Drop reset text, try default bar
	const neededNoCd = labelWidth + 1 + DEFAULT_BAR_WIDTH + 1 + pctWidth;
	if (neededNoCd <= contentWidth) {
		const bar = usageBar(fraction, limit.status, DEFAULT_BAR_WIDTH);
		return `${labelStyled} ${bar} ${pctStyled}`;
	}

	// 5. Drop reset text, try shrunk bar
	const fixedNoCd = labelWidth + 1 + 1 + pctWidth;
	const availableBarNoCd = contentWidth - fixedNoCd;
	if (availableBarNoCd >= MIN_BAR_WIDTH) {
		const barWidth = Math.min(DEFAULT_BAR_WIDTH, availableBarNoCd);
		const bar = usageBar(fraction, limit.status, barWidth);
		return `${labelStyled} ${bar} ${pctStyled}`;
	}

	// 6. Drop bar: label + pct
	if (labelWidth + 1 + pctWidth <= contentWidth) {
		return `${labelStyled} ${pctStyled}`;
	}

	// 7. Truncate label + pct
	const labelBudget = Math.max(1, contentWidth - 1 - pctWidth);
	const truncatedLabel = truncateToWidth(labelStyled, labelBudget);
	if (visibleWidth(truncatedLabel) + 1 + pctWidth <= contentWidth) {
		return `${truncatedLabel} ${pctStyled}`;
	}

	// 8. Narrowest fallback
	return truncateToWidth(`${labelStyled} ${pctStyled}`, contentWidth);
}

export function renderUsageOverview(
	entries: readonly UsageEntry[],
	options: UsageOverviewOptions,
): UsageOverviewResult {
	const width = Math.max(1, options.width);

	if (entries.length === 0) {
		return {
			lines: [truncateToWidth(theme.fg("dim", "No usage data available."), width)],
			selectedStart: 0,
			selectedEnd: 0,
		};
	}

	const lines: string[] = [];
	let selectedStart = 0;
	let selectedEnd = 0;
	let currentProvider: string | undefined;

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;

		if (entry.provider !== currentProvider) {
			if (currentProvider !== undefined) {
				lines.push("");
			}
			currentProvider = entry.provider;
			const heading = theme.bold(sanitizeDisplayLine(entry.providerName));
			lines.push(truncateToWidth(heading, width));
		}

		const isSelected = i === options.selected;
		const entryStart = lines.length;

		lines.push(buildEntryHeaderLine(entry, isSelected, width));

		if (entry.state === "loading") {
			lines.push(truncateToWidth(`  ${theme.fg("dim", "loading…")}`, width));
		} else if (entry.state === "unavailable") {
			lines.push(truncateToWidth(`  ${theme.fg("dim", "usage unavailable")}`, width));
		} else if (entry.state === "error") {
			const errText = sanitizeDisplayLine(entry.error ?? "unknown error");
			lines.push(truncateToWidth(`  ${theme.fg("error", `failed: ${errText}`)}`, width));
		} else {
			const report = entry.report;
			const limits = report?.limits ?? [];
			if (limits.length === 0) {
				lines.push(truncateToWidth(`  ${theme.fg("dim", "no limits")}`, width));
			} else {
				const contentWidth = Math.max(1, width - 2);
				for (const limit of limits) {
					const limitLine = buildLimitLine(limit, options.nowMs, contentWidth);
					lines.push(truncateToWidth(`  ${limitLine}`, width));
				}
			}

			if (report?.resetCredits) {
				const resetSummary = summarizeUsageResetCredits(report.resetCredits, options.nowMs);
				if (resetSummary && resetSummary.bankedCount > 0) {
					const resetWord = resetSummary.bankedCount === 1 ? "reset" : "resets";
					const resetText = `✦ ${resetSummary.bankedCount} ${resetWord} · ${resetSummary.redeemableCount} usable`;
					const color = resetSummary.redeemableCount > 0 ? "success" : "warning";
					lines.push(truncateToWidth(`  ${theme.fg(color, resetText)}`, width));
				}
			}
		}

		const entryEnd = lines.length - 1;
		if (isSelected) {
			selectedStart = entryStart;
			selectedEnd = entryEnd;
		}
	}

	return {
		lines,
		selectedStart,
		selectedEnd,
	};
}
