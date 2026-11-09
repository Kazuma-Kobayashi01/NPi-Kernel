/**
 * Fullscreen `/rank` dashboard (the /settings idiom): mounted as an overlay on
 * the alternate screen so it takes no transcript space. A tab per ranking
 * period switches with ←/→, Tab or a click, the board scrolls with ↑/↓, and
 * Enter flips between the leaderboard and a per-model token breakdown.
 */
import { type Component, matchesKey, routeSgrMouseInput } from "../index";
import { ListDialogFrame } from "../chrome/list-dialog";
import { divider, row } from "../chrome/overlay-box";
import { getTabBarTheme } from "../chrome/shared";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import { formatKeyHint } from "../app-keybindings";
import { type Tab, TabBar } from "../components/tab-bar";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";

export type RankDashboardView = "board" | "detail";

export interface RankDashboardOptions {
	/** Period tabs, in order. */
	tabs: Tab[];
	/** Id of the tab to open on. */
	initialTab: string;
	/** Content lines of `tab` in `view`, at most `width` columns wide. */
	render: (tab: string, view: RankDashboardView, width: number) => string[];
	/** Reload the data behind the board; the dashboard repaints when it settles. */
	refresh?: () => Promise<void>;
	requestRender: () => void;
	onClose: () => void;
}

export class RankDashboardComponent implements Component {
	#options: RankDashboardOptions;
	#tabBar: TabBar;
	#view: RankDashboardView = "board";
	#scroll = 0;
	#refreshing = false;
	#lastViewportRows = 10;
	#tabRowStart = 0;
	#tabRowCount = 0;
	#cache: { key: string; lines: string[] } | undefined;

	constructor(options: RankDashboardOptions) {
		this.#options = options;
		const initial = Math.max(
			0,
			options.tabs.findIndex(tab => tab.id === options.initialTab),
		);
		this.#tabBar = new TabBar("", options.tabs, getTabBarTheme(), initial);
		this.#tabBar.showHint = false;
		this.#tabBar.onTabChange = () => {
			this.#scroll = 0;
			this.#changed();
		};
	}

	invalidate(): void {
		this.#tabBar.invalidate();
		this.#cache = undefined;
	}

	#content(innerWidth: number): string[] {
		const tab = this.#tabBar.getActiveTab().id;
		const key = `${tab}:${this.#view}:${innerWidth}`;
		if (this.#cache?.key !== key) this.#cache = { key, lines: this.#options.render(tab, this.#view, innerWidth) };
		return this.#cache.lines;
	}

	render(width: number): readonly string[] {
		const height = Math.max(14, process.stdout.rows || 40);
		const innerWidth = Math.max(20, width - 4);
		const tabLines = this.#tabBar.render(innerWidth);
		const content = this.#content(innerWidth);

		// Fixed chrome: top border, tabs, divider, content…, divider, hint, bottom border.
		const contentRows = Math.max(4, height - tabLines.length - 5);
		this.#lastViewportRows = contentRows;
		const maxScroll = Math.max(0, content.length - contentRows);
		if (this.#scroll > maxScroll) this.#scroll = maxScroll;

		const title = this.#view === "detail" ? "Token Ranking · Details" : "Token Ranking";
		const frame = new ListDialogFrame(width, title);
		const out = frame.lines;
		this.#tabRowStart = out.length;
		this.#tabRowCount = tabLines.length;
		for (const line of tabLines) out.push(row(line, width));
		out.push(divider(width));
		const visible = content.slice(this.#scroll, this.#scroll + contentRows);
		for (let i = 0; i < contentRows; i++) out.push(row(visible[i] ?? "", width));

		const cancel = editorKey("tui.select.cancel");
		const scroll = maxScroll > 0 ? ` · ${editorKeys("tui.select.up", "tui.select.down")} scroll` : "";
		const refresh = this.#options.refresh ? (this.#refreshing ? " · refreshing…" : " · r refresh") : "";
		const toggle =
			this.#view === "board"
				? `${formatKeyHint("enter")} details · ${cancel} close`
				: `${formatKeyHint("enter")} board · ${cancel} back`;
		return frame.finish(`←/→ period${scroll}${refresh} · ${toggle}`);
	}

	handleInput(data: string): void {
		if (
			routeSgrMouseInput(data, event => {
				if (event.wheel !== null) {
					this.#scrollBy(event.wheel * 2);
					return true;
				}
				const tabLine = event.row - this.#tabRowStart;
				if (tabLine < 0 || tabLine >= this.#tabRowCount) return true;
				const tab = this.#tabBar.tabAt(tabLine, event.col - 2);
				if (event.motion) {
					this.#tabBar.setHoverTab(tab?.id ?? null);
					this.#options.requestRender();
				} else if (event.leftClick && tab) {
					this.#tabBar.selectTab(tab.id);
				}
				return true;
			})
		) {
			return;
		}
		if (matchesSelectCancel(data) || matchesKey(data, "q")) {
			if (this.#view === "detail") this.#setView("board");
			else this.#options.onClose();
			return;
		}
		if (matchesKey(data, "return") || matchesKey(data, "d")) {
			this.#setView(this.#view === "board" ? "detail" : "board");
			return;
		}
		if (matchesKey(data, "r")) {
			void this.#refresh();
			return;
		}
		if (
			matchesKey(data, "left") ||
			matchesKey(data, "right") ||
			matchesKey(data, "tab") ||
			matchesKey(data, "shift+tab")
		) {
			this.#tabBar.handleInput(data);
			return;
		}
		if (matchesKey(data, "ctrl+left") || matchesKey(data, "ctrl+right")) {
			this.#tabBar.handleInput(matchesKey(data, "ctrl+left") ? "\x1b[D" : "\x1b[C");
			return;
		}
		if (matchesSelectUp(data)) this.#scrollBy(-1);
		else if (matchesSelectDown(data)) this.#scrollBy(1);
		else if (matchesSelectPageUp(data)) this.#scrollBy(-this.#lastViewportRows);
		else if (matchesSelectPageDown(data)) this.#scrollBy(this.#lastViewportRows);
		else if (matchesKey(data, "home")) this.#scrollBy(-Number.MAX_SAFE_INTEGER);
		else if (matchesKey(data, "end")) this.#scrollBy(Number.MAX_SAFE_INTEGER);
	}

	async #refresh(): Promise<void> {
		const refresh = this.#options.refresh;
		if (!refresh || this.#refreshing) return;
		this.#refreshing = true;
		this.#options.requestRender();
		try {
			await refresh();
		} finally {
			this.#refreshing = false;
			this.#changed();
		}
	}

	#setView(view: RankDashboardView): void {
		this.#view = view;
		this.#scroll = 0;
		this.#changed();
	}

	#scrollBy(delta: number): void {
		this.#scroll = Math.max(0, this.#scroll + delta);
		this.#options.requestRender();
	}

	#changed(): void {
		this.#cache = undefined;
		this.#tabBar.invalidate();
		this.#options.requestRender();
	}
}
