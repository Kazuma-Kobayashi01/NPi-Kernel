import type { UsageReport } from "@oh-my-pi/pi-ai";
import { formatProviderName } from "../chrome/format";
import { sanitizeDisplayLine } from "./extensions/display-text";

/** The `/usage` panel's tabs, in display order. */
export const USAGE_TABS = ["overview", "detail", "tokens"] as const;
export type UsageTab = (typeof USAGE_TABS)[number];

/** A connected account whose usage lookup produced no attributable report. */
export interface UnavailableUsageAccount {
	provider: string;
	label: string;
}

/**
 * One selectable row of the panel: a provider credential (account) and the
 * latest usage report attributed to it.
 *
 * - `ok`: `report` is present (it may be stale while a refresh is running).
 * - `loading`: no report yet and a fetch is in flight.
 * - `unavailable`: the fetch finished but the provider returned no report for this account.
 * - `error`: the fetch itself failed; `error` holds the message.
 */
export interface UsageEntry {
	/** Stable per-open identity (`provider#index`). */
	key: string;
	provider: string;
	providerName: string;
	/** Sanitized credential label (email, account id, project id, or `account N`). */
	account: string;
	state: "ok" | "loading" | "unavailable" | "error";
	report?: UsageReport;
	error?: string;
}

/** Stable, human account name for a report. */
export function reportAccountLabel(report: UsageReport, index: number): string {
	const metadata = report.metadata;
	const pick = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
	const identity =
		pick(metadata?.email) ??
		pick(metadata?.accountId) ??
		pick(metadata?.projectId) ??
		pick(report.limits[0]?.scope.projectId) ??
		`account ${index + 1}`;
	const org = pick(metadata?.orgName);
	return sanitizeDisplayLine(org && org !== identity ? `${identity} (${org})` : identity);
}

export interface BuildUsageEntriesOptions {
	/** A fetch is in flight: accounts without a report read as loading. */
	loading: boolean;
	/** The last fetch failed: accounts without a report read as error. */
	error?: string | null;
}

/**
 * One entry per credential: each report is a credential, and every connected
 * account without a report follows its provider's reports. Providers keep the
 * order of first appearance so the list does not reshuffle on refresh.
 */
export function buildUsageEntries(
	reports: readonly UsageReport[],
	unavailableAccounts: readonly UnavailableUsageAccount[],
	options: BuildUsageEntriesOptions,
): UsageEntry[] {
	const order: string[] = [];
	const byProvider = new Map<string, UsageEntry[]>();
	const add = (provider: string, entry: Omit<UsageEntry, "key" | "provider" | "providerName">): void => {
		let list = byProvider.get(provider);
		if (!list) {
			list = [];
			byProvider.set(provider, list);
			order.push(provider);
		}
		list.push({ key: `${provider}#${list.length}`, provider, providerName: formatProviderName(provider), ...entry });
	};
	const providerReportCount = new Map<string, number>();
	for (const report of reports) {
		const index = providerReportCount.get(report.provider) ?? 0;
		providerReportCount.set(report.provider, index + 1);
		add(report.provider, { account: reportAccountLabel(report, index), state: "ok", report });
	}
	const missing: UsageEntry["state"] = options.loading ? "loading" : options.error ? "error" : "unavailable";
	for (const account of unavailableAccounts) {
		add(account.provider, {
			account: sanitizeDisplayLine(account.label),
			state: missing,
			...(missing === "error" ? { error: options.error ?? undefined } : {}),
		});
	}
	return order.flatMap(provider => byProvider.get(provider) ?? []);
}

/** Move a selection by `delta` rows, clamped to the list. */
export function moveUsageSelection(selected: number, delta: number, count: number): number {
	if (count === 0) return 0;
	return Math.min(count - 1, Math.max(0, selected + delta));
}

/** The tab `delta` steps from `tab`, wrapping at the ends. */
export function stepUsageTab(tab: UsageTab, delta: number): UsageTab {
	const index = USAGE_TABS.indexOf(tab);
	return USAGE_TABS[(index + delta + USAGE_TABS.length) % USAGE_TABS.length]!;
}
