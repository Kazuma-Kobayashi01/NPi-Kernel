/**
 * The session tab strip above the composer: the conversations this process
 * has opened, the current one filled, and a hint for the keys that switch.
 * One process runs one conversation at a time, so a tab is a session to
 * switch to, not one running beside it; interactive mode keeps the list and
 * does the switch. The strip shows once there are two tabs to switch between.
 */
import type { Component } from "../tui";
import { theme } from "../theme/theme";
import { truncateToWidth, visibleWidth } from "../utils";

export interface SessionTab {
	readonly title: string;
	readonly current: boolean;
}

/** Cells a tab's title may take before it is cut. */
const MAX_TITLE = 24;
const SEPARATOR = " │ ";

function label(tab: SessionTab): string {
	const text = ` ${truncateToWidth(tab.title.replace(/\s+/g, " ").trim() || "Untitled", MAX_TITLE)} `;
	return tab.current ? theme.bg("selectedBg", theme.bold(theme.fg("accent", text))) : theme.fg("muted", text);
}

/**
 * One row `width` cells wide: as many tabs around the current one as fit, `…` where
 * some are left out, and `hint` (the switch keys) on the right when there is room.
 * Empty with fewer than two tabs.
 */
export function renderSessionTabs(tabs: readonly SessionTab[], width: number, hint = ""): string {
	if (tabs.length < 2 || width < 12) return "";
	const labels = tabs.map(label);
	const sep = theme.fg("dim", SEPARATOR);
	const more = theme.fg("dim", "…");
	const hinted = hint && visibleWidth(hint) + 2 <= Math.floor(width / 3) ? hint : "";
	const room = width - (hinted ? visibleWidth(hinted) + 2 : 0);
	const cost = (from: number, to: number) =>
		labels.slice(from, to + 1).reduce((n, l) => n + visibleWidth(l), 0) +
		(to - from) * SEPARATOR.length +
		(from > 0 ? 2 : 0) +
		(to < labels.length - 1 ? 2 : 0);
	// Grow a window around the current tab, right first, while it fits.
	const at = Math.max(
		0,
		tabs.findIndex(t => t.current),
	);
	let from = at;
	let to = at;
	for (let grew = true; grew;) {
		grew = false;
		if (to + 1 < labels.length && cost(from, to + 1) <= room) {
			to += 1;
			grew = true;
		}
		if (from > 0 && cost(from - 1, to) <= room) {
			from -= 1;
			grew = true;
		}
	}
	let row = `${from > 0 ? `${more} ` : ""}${labels.slice(from, to + 1).join(sep)}${to < labels.length - 1 ? ` ${more}` : ""}`;
	row = truncateToWidth(row, room);
	if (!hinted) return row;
	return `${row}${" ".repeat(Math.max(2, width - visibleWidth(row) - visibleWidth(hinted)))}${hinted}`;
}

/** The strip as a component: `tabs()` is asked on every frame, `hint` names the switch keys. */
export class SessionTabsComponent implements Component {
	readonly #tabs: () => readonly SessionTab[];
	readonly #hint: () => string;
	#last: { key: string; rows: readonly string[] } | undefined;

	constructor(tabs: () => readonly SessionTab[], hint: () => string) {
		this.#tabs = tabs;
		this.#hint = hint;
	}

	render(width: number): readonly string[] {
		const tabs = this.#tabs();
		const hint = this.#hint();
		const key = `${width}\0${hint}\0${tabs.map(t => `${t.current ? "*" : ""}${t.title}`).join("\0")}`;
		if (this.#last?.key === key) return this.#last.rows;
		const row = renderSessionTabs(tabs, width, hint);
		const rows = row ? [row] : [];
		this.#last = { key, rows };
		return rows;
	}

	invalidate(): void {
		this.#last = undefined;
	}
}
