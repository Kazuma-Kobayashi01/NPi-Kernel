import { formatNumber } from "@oh-my-pi/pi-utils";
import { truncateToWidth, visibleWidth } from "../index";
import { theme } from "../theme/theme";
import { sanitizeDisplayLine } from "./extensions/display-text";
import type { UsageSessionTokens, UsageStatsPeriodId, UsageTokensData } from "./usage-panel-model";

export interface UsageTokensViewOptions {
	width: number;
	/** Session + local stats; undefined while the first load is in flight. */
	data: UsageTokensData | undefined;
	loading: boolean; // local stats load/refresh in flight
	error: string | undefined; // local stats load failed (session figures still render from data when present)
	period: UsageStatsPeriodId; // which local stats period to show
}

const WHOLE_DOLLARS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** `$1,234`, `$759`, `$84.20`, `$0.13`: cents only below $100. */
function formatCost(cost: number): string {
	if (cost <= 0) return "$0";
	return cost >= 100 ? `$${WHOLE_DOLLARS.format(cost)}` : `$${cost.toFixed(2)}`;
}

function padEndVisible(text: string, targetWidth: number): string {
	const current = visibleWidth(text);
	return current >= targetWidth ? text : text + " ".repeat(targetWidth - current);
}

function padStartVisible(text: string, targetWidth: number): string {
	const current = visibleWidth(text);
	return current >= targetWidth ? text : " ".repeat(targetWidth - current) + text;
}

function pushLine(lines: string[], line: string, width: number): void {
	lines.push(visibleWidth(line) <= width ? line : truncateToWidth(line, width));
}

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

function renderBar(fraction: number, width: number): string {
	const clamped = Math.max(0, Math.min(1, fraction));
	const eighths = Math.round(clamped * width * 8);
	const full = Math.floor(eighths / 8);
	let partial = EIGHTHS[eighths % 8] ?? "";
	if (full === 0 && partial === "" && clamped > 0) partial = "▏";
	const rest = Math.max(0, width - full - (partial ? 1 : 0));
	return `${theme.fg("dim", "▕")}${theme.fg("accent", "█".repeat(full) + partial)}${theme.fg("dim", "░".repeat(rest))}${theme.fg("dim", "▏")}`;
}

interface FlowItem {
	styled: string;
	visibleWidth: number;
}

function flowItems(items: FlowItem[], separator: string, separatorVisibleWidth: number, width: number): string[] {
	if (items.length === 0) return [];
	const lines: string[] = [];
	let currentLine = "";
	let currentWidth = 0;

	for (const item of items) {
		if (currentWidth === 0) {
			currentLine = item.styled;
			currentWidth = item.visibleWidth;
		} else if (currentWidth + separatorVisibleWidth + item.visibleWidth <= width) {
			currentLine += separator + item.styled;
			currentWidth += separatorVisibleWidth + item.visibleWidth;
		} else {
			lines.push(currentLine);
			currentLine = item.styled;
			currentWidth = item.visibleWidth;
		}
	}
	if (currentWidth > 0) {
		lines.push(currentLine);
	}
	return lines;
}

function isSessionEmpty(session: UsageSessionTokens): boolean {
	const totalTokens =
		session.totals.input +
		session.totals.output +
		session.totals.cacheRead +
		session.totals.cacheWrite +
		(session.reasoning ?? 0);
	if (totalTokens > 0 || session.totals.cost > 0) return false;
	for (const m of session.models) {
		const mTotal = m.input + m.output + m.cacheRead + m.cacheWrite;
		if (mTotal > 0 || m.cost > 0) return false;
	}
	return true;
}

export function renderUsageTokens(options: UsageTokensViewOptions): string[] {
	const width = Math.max(1, options.width);

	if (!options.data) {
		if (options.error) {
			return [
				truncateToWidth(theme.fg("error", `Local stats unavailable: ${sanitizeDisplayLine(options.error)}`), width),
			];
		}
		return [truncateToWidth(theme.fg("dim", "Loading token stats…"), width)];
	}

	const lines: string[] = [];
	const sep = theme.fg("dim", " · ");
	const sepWidth = 3;

	// =========================================================================
	// 1. Session section
	// =========================================================================
	pushLine(lines, theme.bold("Session"), width);

	const session = options.data.session;
	if (isSessionEmpty(session)) {
		pushLine(lines, theme.fg("dim", "No tokens used in this session yet."), width);
	} else {
		// Session totals line(s)
		const sessionTotalItems: FlowItem[] = [
			{
				styled: theme.fg("accent", `input ${formatNumber(session.totals.input)}`),
				visibleWidth: visibleWidth(`input ${formatNumber(session.totals.input)}`),
			},
			{
				styled: theme.fg("success", `output ${formatNumber(session.totals.output)}`),
				visibleWidth: visibleWidth(`output ${formatNumber(session.totals.output)}`),
			},
			{
				styled: theme.fg("borderAccent", `cache read ${formatNumber(session.totals.cacheRead)}`),
				visibleWidth: visibleWidth(`cache read ${formatNumber(session.totals.cacheRead)}`),
			},
			{
				styled: theme.fg("warning", `cache write ${formatNumber(session.totals.cacheWrite)}`),
				visibleWidth: visibleWidth(`cache write ${formatNumber(session.totals.cacheWrite)}`),
			},
		];
		if (session.reasoning !== undefined && session.reasoning > 0) {
			sessionTotalItems.push({
				styled: theme.fg("muted", `reasoning ${formatNumber(session.reasoning)}`),
				visibleWidth: visibleWidth(`reasoning ${formatNumber(session.reasoning)}`),
			});
		}
		sessionTotalItems.push({
			styled: `cost ${formatCost(session.totals.cost)}`,
			visibleWidth: visibleWidth(`cost ${formatCost(session.totals.cost)}`),
		});

		for (const line of flowItems(sessionTotalItems, sep, sepWidth, width)) {
			pushLine(lines, line, width);
		}

		// Session per-model table
		if (session.models.length > 0) {
			const hasRequests = session.models.some(m => m.requests !== undefined);
			const nameWidth = Math.min(32, Math.max(16, Math.floor(width * 0.28)));
			const tableColWidth = 2 + nameWidth + 1 + 8 + 1 + 8 + 1 + 9 + 1 + 9 + 1 + 8 + (hasRequests ? 1 + 8 : 0);
			const fitsSingleLine = width >= tableColWidth;

			if (fitsSingleLine) {
				const header = `  ${padEndVisible("Model", nameWidth)} ${padStartVisible("Input", 8)} ${padStartVisible("Output", 8)} ${padStartVisible("Cache Rd", 9)} ${padStartVisible("Cache Wr", 9)} ${padStartVisible("Cost", 8)}${hasRequests ? ` ${padStartVisible("Requests", 8)}` : ""}`;
				pushLine(lines, theme.fg("dim", header), width);

				for (const m of session.models) {
					const name = sanitizeDisplayLine(m.name);
					const reqCol = hasRequests
						? ` ${m.requests !== undefined ? padStartVisible(formatNumber(m.requests), 8) : padStartVisible("-", 8)}`
						: "";
					const row = `  ${padEndVisible(truncateToWidth(name, nameWidth), nameWidth)} ${theme.fg("accent", padStartVisible(formatNumber(m.input), 8))} ${theme.fg("success", padStartVisible(formatNumber(m.output), 8))} ${theme.fg("borderAccent", padStartVisible(formatNumber(m.cacheRead), 9))} ${theme.fg("warning", padStartVisible(formatNumber(m.cacheWrite), 9))} ${padStartVisible(formatCost(m.cost), 8)}${reqCol}`;
					pushLine(lines, row, width);
				}
			} else {
				// Narrow terminals: two lines per model
				for (const m of session.models) {
					const name = sanitizeDisplayLine(m.name);
					pushLine(lines, `  ${name}`, width);
					const reqText = m.requests !== undefined ? ` · ${formatNumber(m.requests)} req` : "";
					const figLine = `    ${theme.fg("accent", `in ${formatNumber(m.input)}`)} · ${theme.fg("success", `out ${formatNumber(m.output)}`)} · ${theme.fg("borderAccent", `crd ${formatNumber(m.cacheRead)}`)} · ${theme.fg("warning", `cwr ${formatNumber(m.cacheWrite)}`)} · ${formatCost(m.cost)}${reqText}`;
					pushLine(lines, figLine, width);
				}
			}
		}
	}

	// Blank line between sections
	pushLine(lines, "", width);

	// =========================================================================
	// 2. Local stats section
	// =========================================================================
	const heading = options.loading
		? `${theme.bold("Local stats")} ${theme.fg("dim", "refreshing…")}`
		: theme.bold("Local stats");

	const periodsText = options.data.periods
		.map(p => {
			if (p.id === options.period) {
				return theme.bold(theme.fg("accent", `[${p.label}]`));
			}
			return theme.fg("muted", p.label);
		})
		.join(" ");

	const hint = theme.fg("dim", "p cycles the period");
	const left = `${heading}  ${periodsText}`;
	const fullLine = visibleWidth(left) + 2 + visibleWidth(hint) <= width ? `${left}  ${hint}` : left;
	pushLine(lines, fullLine, width);

	// Local stats error
	if (options.error) {
		pushLine(lines, theme.fg("error", `Local stats unavailable: ${sanitizeDisplayLine(options.error)}`), width);
		return lines;
	}

	const currentPeriod = options.data.periods.find(p => p.id === options.period) ?? options.data.periods[0];
	if (!currentPeriod || currentPeriod.models.length === 0) {
		pushLine(lines, theme.fg("dim", "No recorded usage for this period."), width);
		return lines;
	}

	// Period totals
	let pInput = 0;
	let pOutput = 0;
	let pCacheRead = 0;
	let pCacheWrite = 0;
	let pCost = 0;
	let pRequests = 0;
	let pHasRequests = false;
	for (const m of currentPeriod.models) {
		pInput += m.input;
		pOutput += m.output;
		pCacheRead += m.cacheRead;
		pCacheWrite += m.cacheWrite;
		pCost += m.cost;
		if (m.requests !== undefined) {
			pRequests += m.requests;
			pHasRequests = true;
		}
	}
	const pTotalTokens = pInput + pOutput + pCacheRead + pCacheWrite;

	const periodTotalItems: FlowItem[] = [
		{
			styled: theme.fg("accent", `input ${formatNumber(pInput)}`),
			visibleWidth: visibleWidth(`input ${formatNumber(pInput)}`),
		},
		{
			styled: theme.fg("success", `output ${formatNumber(pOutput)}`),
			visibleWidth: visibleWidth(`output ${formatNumber(pOutput)}`),
		},
		{
			styled: theme.fg("borderAccent", `cache read ${formatNumber(pCacheRead)}`),
			visibleWidth: visibleWidth(`cache read ${formatNumber(pCacheRead)}`),
		},
		{
			styled: theme.fg("warning", `cache write ${formatNumber(pCacheWrite)}`),
			visibleWidth: visibleWidth(`cache write ${formatNumber(pCacheWrite)}`),
		},
		{
			styled: `cost ${formatCost(pCost)}`,
			visibleWidth: visibleWidth(`cost ${formatCost(pCost)}`),
		},
	];
	if (pHasRequests) {
		periodTotalItems.push({
			styled: `${formatNumber(pRequests)} req`,
			visibleWidth: visibleWidth(`${formatNumber(pRequests)} req`),
		});
	}

	for (const line of flowItems(periodTotalItems, sep, sepWidth, width)) {
		pushLine(lines, line, width);
	}

	// Period per-model table
	const pNameWidth = Math.min(32, Math.max(16, Math.floor(width * 0.28)));
	const pBarInnerWidth = 10;
	const pBarVisibleWidth = pBarInnerWidth + 2;
	const pShareColWidth = pBarVisibleWidth + 1 + 6;
	const pTableColWidth = 2 + pNameWidth + 1 + pShareColWidth + 1 + 8 + 1 + 8 + (pHasRequests ? 1 + 8 : 0);
	const pFitsSingleLine = width >= pTableColWidth;

	if (pFitsSingleLine) {
		const header = `  ${padEndVisible("Model", pNameWidth)} ${padEndVisible("Share", pShareColWidth)} ${padStartVisible("Tokens", 8)} ${padStartVisible("Cost", 8)}${pHasRequests ? ` ${padStartVisible("Requests", 8)}` : ""}`;
		pushLine(lines, theme.fg("dim", header), width);

		for (const m of currentPeriod.models) {
			const mTotal = m.input + m.output + m.cacheRead + m.cacheWrite;
			const fraction = pTotalTokens > 0 ? mTotal / pTotalTokens : 0;
			const pct = `${(fraction * 100).toFixed(1)}%`;
			const barStr = renderBar(fraction, pBarInnerWidth);
			const name = sanitizeDisplayLine(m.name);
			const shareStr = `${barStr} ${padStartVisible(pct, 6)}`;
			const reqCol = pHasRequests
				? ` ${m.requests !== undefined ? padStartVisible(formatNumber(m.requests), 8) : padStartVisible("-", 8)}`
				: "";
			const row = `  ${padEndVisible(truncateToWidth(name, pNameWidth), pNameWidth)} ${shareStr} ${padStartVisible(formatNumber(mTotal), 8)} ${padStartVisible(formatCost(m.cost), 8)}${reqCol}`;
			pushLine(lines, row, width);
		}
	} else {
		// Narrow terminals: two lines per model
		for (const m of currentPeriod.models) {
			const mTotal = m.input + m.output + m.cacheRead + m.cacheWrite;
			const fraction = pTotalTokens > 0 ? mTotal / pTotalTokens : 0;
			const pct = `${(fraction * 100).toFixed(1)}%`;
			const reqText = m.requests !== undefined ? ` · ${formatNumber(m.requests)} req` : "";
			let figLine: string;
			if (width >= 35) {
				const barStr = renderBar(fraction, 8);
				figLine = `    ${barStr} ${pct} · ${formatNumber(mTotal)} · ${formatCost(m.cost)}${reqText}`;
			} else {
				figLine = `    ${formatNumber(mTotal)} (${pct}) · ${formatCost(m.cost)}${reqText}`;
			}
			pushLine(lines, `  ${sanitizeDisplayLine(m.name)}`, width);
			pushLine(lines, figLine, width);
		}
	}

	return lines;
}
