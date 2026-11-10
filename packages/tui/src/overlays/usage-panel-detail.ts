import {
	resolveUsedFraction,
	type UsageAmount,
	type UsageLimit,
	type UsageWindow,
} from "@oh-my-pi/pi-ai";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../index";
import { theme } from "../theme/theme";
import { sanitizeDisplayLine, sanitizeDisplayText } from "./extensions/display-text";
import { formatLimitTitle, summarizeUsageResetCredits } from "./usage-display";
import { type UsageEntry, usageBar, usageStatusColor, usageStatusIcon } from "./usage-panel-model";

export interface UsageDetailOptions {
	width: number;
	nowMs: number;
}

const BAR_MIN_WIDTH = 6;
const BAR_MAX_WIDTH = 20;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function resolveWindowQualifier(limit: UsageLimit): string | undefined {
	const durationMs = limit.window?.durationMs;
	if (durationMs !== undefined && Number.isFinite(durationMs) && durationMs > 0) {
		const HOUR = 3_600_000;
		const DAY = 86_400_000;
		if (durationMs % DAY === 0) {
			const days = durationMs / DAY;
			if (days === 7) return "weekly";
			if (days >= 28 && days <= 31) return "monthly";
			if (days === 1) return "daily";
			return `${days}d`;
		}
		if (durationMs % HOUR === 0) {
			const hours = durationMs / HOUR;
			return `${hours}h`;
		}
		return formatDuration(durationMs);
	}
	const label = limit.window?.label ?? limit.window?.id ?? limit.scope.windowId;
	if (label) {
		const normalized = label.toLowerCase();
		if (normalized === "quota window") return undefined;
		return sanitizeDisplayLine(label);
	}
	return undefined;
}

function formatAmountsLine(amount: UsageAmount): string | undefined {
	if (amount.unit === "percent" || amount.unit === "unknown") return undefined;
	const hasUsed = amount.used !== undefined && Number.isFinite(amount.used);
	const hasLimit = amount.limit !== undefined && Number.isFinite(amount.limit);
	const hasRemaining = amount.remaining !== undefined && Number.isFinite(amount.remaining);
	if (!hasUsed && !hasLimit && !hasRemaining) return undefined;

	const unit = amount.unit;
	const isUsd = unit === "usd";

	const fmtVal = (val: number): string => {
		if (isUsd) return `$${val >= 100 ? Math.round(val) : val.toFixed(2)}`;
		return formatNumber(val);
	};

	const parts: string[] = [];
	if (hasUsed && hasLimit) {
		const valStr = isUsd
			? `${fmtVal(amount.used!)} / ${fmtVal(amount.limit!)}`
			: `${fmtVal(amount.used!)} / ${fmtVal(amount.limit!)} ${unit}`;
		parts.push(`used ${valStr}`);
	} else if (hasUsed) {
		const valStr = isUsd ? fmtVal(amount.used!) : `${fmtVal(amount.used!)} ${unit}`;
		parts.push(`used ${valStr}`);
	} else if (hasLimit) {
		const valStr = isUsd ? fmtVal(amount.limit!) : `${fmtVal(amount.limit!)} ${unit}`;
		parts.push(`limit ${valStr}`);
	}

	if (hasRemaining) {
		if (isUsd) {
			parts.push(`${fmtVal(amount.remaining!)} remaining`);
		} else if (parts.length > 0) {
			parts.push(`${fmtVal(amount.remaining!)} remaining`);
		} else {
			parts.push(`${fmtVal(amount.remaining!)} ${unit} remaining`);
		}
	}

	return parts.join(" · ");
}

function formatResetsLine(window: UsageWindow | undefined, nowMs: number): string | undefined {
	if (!window || window.resetsAt === undefined || !Number.isFinite(window.resetsAt)) {
		return undefined;
	}
	const verb = window.resetLabel ?? "resets";
	if (window.resetsAt > nowMs) {
		const diff = window.resetsAt - nowMs;
		const countdown = formatDuration(diff);
		const date = new Date(window.resetsAt);
		const weekday = WEEKDAYS[date.getDay()];
		const hours = String(date.getHours()).padStart(2, "0");
		const minutes = String(date.getMinutes()).padStart(2, "0");
		const time = `${hours}:${minutes}`;
		return `${verb} in ${countdown} (${weekday} ${time})`;
	}
	return "reset time passed";
}

export function renderUsageDetail(entry: UsageEntry | undefined, options: UsageDetailOptions): string[] {
	const width = Math.max(1, options.width);
	if (!entry) {
		return wrapTextWithAnsi(theme.fg("dim", "Select a provider on the Overview tab."), width).map(line =>
			visibleWidth(line) > width ? truncateToWidth(line, width) : line,
		);
	}

	const lines: string[] = [];

	// Header
	const headParts: string[] = [theme.bold(sanitizeDisplayLine(entry.providerName))];
	const cleanAccount = sanitizeDisplayLine(entry.account);
	if (cleanAccount && cleanAccount !== entry.providerName) {
		headParts.push(theme.fg("dim", cleanAccount));
	}
	if (entry.report && Number.isFinite(entry.report.fetchedAt) && entry.report.fetchedAt > 0) {
		const elapsed = Math.max(0, options.nowMs - entry.report.fetchedAt);
		headParts.push(theme.fg("dim", `checked ${formatDuration(elapsed)} ago`));
	}
	const headLine = headParts.join(" · ");
	lines.push(visibleWidth(headLine) > width ? truncateToWidth(headLine, width) : headLine);

	if (entry.active) {
		lines.push(theme.fg("accent", "in use by this session"));
	}

	// State branching
	if (entry.state === "loading") {
		lines.push(theme.fg("dim", "Loading usage…"));
		return lines.map(line => (visibleWidth(line) > width ? truncateToWidth(line, width) : line));
	}

	if (entry.state === "unavailable") {
		lines.push(...wrapTextWithAnsi("Usage unavailable for this account.", width));
		lines.push(...wrapTextWithAnsi(theme.fg("dim", "Press r to retry."), width));
		return lines.map(line => (visibleWidth(line) > width ? truncateToWidth(line, width) : line));
	}

	if (entry.state === "error") {
		const errText = entry.error ? sanitizeDisplayText(entry.error) : "unknown error";
		lines.push(...wrapTextWithAnsi(theme.fg("error", `Failed to fetch usage: ${errText}`), width));
		lines.push(...wrapTextWithAnsi(theme.fg("dim", "Press r to retry."), width));
		return lines.map(line => (visibleWidth(line) > width ? truncateToWidth(line, width) : line));
	}

	const report = entry.report;
	if (!report) {
		lines.push(...wrapTextWithAnsi("Usage unavailable for this account.", width));
		lines.push(...wrapTextWithAnsi(theme.fg("dim", "Press r to retry."), width));
		return lines.map(line => (visibleWidth(line) > width ? truncateToWidth(line, width) : line));
	}

	// Limits
	if (report.limits.length === 0) {
		lines.push(theme.fg("dim", "No limits reported."));
	} else {
		for (const limit of report.limits) {
			const title = formatLimitTitle(limit);
			let qualifier = resolveWindowQualifier(limit);
			if (qualifier && title.toLowerCase().includes(qualifier.toLowerCase())) {
				qualifier = undefined;
			}
			const titleParts: string[] = [usageStatusIcon(limit.status), title];
			if (qualifier) {
				titleParts.push(theme.fg("dim", `(${qualifier})`));
			}
			if (limit.status === "exhausted" || limit.status === "warning") {
				titleParts.push(theme.fg(usageStatusColor(limit.status), limit.status));
			}
			const titleLine = titleParts.join(" ");
			lines.push(visibleWidth(titleLine) > width ? truncateToWidth(titleLine, width) : titleLine);

			// Bar line
			const fraction = resolveUsedFraction(limit);
			let percentText = "";
			if (fraction !== undefined && Number.isFinite(fraction)) {
				const usedPercent = Math.round(fraction * 100);
				const leftPercent = Math.max(0, Math.round((1 - fraction) * 100));
				percentText = `${usedPercent}% used · ${leftPercent}% left`;
			}
			const textWidth = visibleWidth(percentText);
			const spaceForBar = width - textWidth - (textWidth > 0 ? 1 : 0);
			if (spaceForBar >= BAR_MIN_WIDTH) {
				const barWidth = Math.min(BAR_MAX_WIDTH, spaceForBar);
				const bar = usageBar(fraction, limit.status, barWidth);
				const barLine = textWidth > 0 ? `${bar} ${percentText}` : bar;
				lines.push(visibleWidth(barLine) > width ? truncateToWidth(barLine, width) : barLine);
			} else if (textWidth > 0) {
				lines.push(textWidth > width ? truncateToWidth(percentText, width) : percentText);
			} else if (fraction === undefined && width >= BAR_MIN_WIDTH) {
				const bar = usageBar(undefined, limit.status, Math.min(BAR_MAX_WIDTH, width));
				lines.push(bar);
			}

			// Amounts line
			const amounts = formatAmountsLine(limit.amount);
			if (amounts) {
				const amountsLine = theme.fg("dim", amounts);
				lines.push(visibleWidth(amountsLine) > width ? truncateToWidth(amountsLine, width) : amountsLine);
			}

			// Resets line
			const resetsLine = formatResetsLine(limit.window, options.nowMs);
			if (resetsLine) {
				const styled = theme.fg("dim", resetsLine);
				lines.push(visibleWidth(styled) > width ? truncateToWidth(styled, width) : styled);
			}

			// Limit notes
			if (limit.notes && limit.notes.length > 0) {
				for (const note of limit.notes) {
					const cleanNote = sanitizeDisplayText(note).trim();
					if (cleanNote) {
						lines.push(...wrapTextWithAnsi(theme.fg("dim", cleanNote), width));
					}
				}
			}
		}
	}

	// Saved resets
	if (report.resetCredits) {
		const resetSummary = summarizeUsageResetCredits(report.resetCredits, options.nowMs);
		if (resetSummary) {
			const head = `${theme.fg("accent", "✦")} ${resetSummary.bankedCount} saved reset${resetSummary.bankedCount === 1 ? "" : "s"} available · ${resetSummary.redeemableCount} redeemable now`;
			lines.push(...wrapTextWithAnsi(head, width));

			if (resetSummary.soonestExpiry) {
				const expiryMs = Date.parse(resetSummary.soonestExpiry);
				if (Number.isFinite(expiryMs)) {
					const diff = expiryMs - options.nowMs;
					const text = diff > 0 ? `soonest expiry in ${formatDuration(diff)}` : "expired";
					lines.push(...wrapTextWithAnsi(theme.fg("dim", text), width));
				}
			}

			if (resetSummary.unavailableReason) {
				const reason = sanitizeDisplayLine(resetSummary.unavailableReason);
				if (reason) {
					const text = reason.toLowerCase().startsWith("unavailable") ? reason : `unavailable: ${reason}`;
					lines.push(...wrapTextWithAnsi(theme.fg("dim", text), width));
				}
			}

			const credits = report.resetCredits.credits ?? [];
			const eligibleCredits = credits.filter(
				c =>
					(c.title && c.title.trim().length > 0) ||
					(c.remainingCount !== undefined && Number.isFinite(c.remainingCount)) ||
					(c.expiresAt && c.expiresAt.trim().length > 0),
			);
			for (const credit of eligibleCredits.slice(0, 5)) {
				const parts: string[] = [];
				if (credit.title) {
					parts.push(sanitizeDisplayLine(credit.title));
				}
				if (credit.remainingCount !== undefined && Number.isFinite(credit.remainingCount)) {
					parts.push(`${credit.remainingCount} remaining`);
				}
				if (credit.expiresAt) {
					const expMs = Date.parse(credit.expiresAt);
					if (Number.isFinite(expMs)) {
						const diff = expMs - options.nowMs;
						parts.push(diff > 0 ? `expires in ${formatDuration(diff)}` : "expired");
					}
				}
				if (parts.length > 0) {
					const line = `• ${parts.join(" · ")}`;
					lines.push(...wrapTextWithAnsi(theme.fg("dim", line), width));
				}
			}
			if (eligibleCredits.length > 5) {
				const remaining = eligibleCredits.length - 5;
				lines.push(...wrapTextWithAnsi(theme.fg("dim", `+${remaining} more`), width));
			}
		}
	}

	// Provider notes
	if (report.notes && report.notes.length > 0) {
		for (const note of report.notes) {
			const cleanNote = sanitizeDisplayText(note).trim();
			if (cleanNote) {
				lines.push(...wrapTextWithAnsi(theme.fg("dim", cleanNote), width));
			}
		}
	}

	return lines.map(line => (visibleWidth(line) > width ? truncateToWidth(line, width) : line));
}
