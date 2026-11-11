import { Container, matchesKey, ScrollView, TruncatedText } from "../index";
import { theme } from "../theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { OverlayPanel } from "../chrome/overlay-box";
import { MenuSelection } from "../components/menu-selection";
import { formatKeyHint } from "../app-keybindings";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import { node, span } from "../native/describe";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { actionHint, hintsRow, overlayCard } from "../native/overlay";

/** Where an account stands with its provider. */
export type AccountState = "active" | "idle" | "rotating";

/** One signed-in OAuth account in the `/account` panel. */
export interface AccountRow {
	readonly provider: string;
	readonly providerName: string;
	readonly credentialId: number;
	/** The name the user gave the account, else its email or id. */
	readonly name: string;
	/** The name the user gave the account, when it has one. */
	readonly label?: string;
	readonly email?: string;
	/** Email, organization and row id, whatever the name does not already say. */
	readonly detail: string;
	/**
	 * `active`: the account activated for its provider, the only one used; `idle`: another account of
	 * the provider is activated; `rotating`: none is, so the provider's accounts share the load.
	 */
	readonly state: AccountState;
	/** This session's requests to the provider go to this account right now. */
	readonly inUse: boolean;
}

export interface AccountManagerCallbacks {
	onActivate(row: AccountRow): void;
	onRename(row: AccountRow): void;
	onCancel(): void;
}

const MAX_VISIBLE_LINES = 16;

/** Row key: credential ids are per store, so the provider keeps keys unique across providers. */
export function accountRowKey(row: Pick<AccountRow, "provider" | "credentialId">): string {
	return `${row.provider}:${row.credentialId}`;
}

/**
 * `/account`: signed-in OAuth accounts grouped by provider. One account per provider can be active
 * (the only one its requests use); the rest are idle. Enter activates the selected account, `r`
 * renames it.
 */
export class AccountManagerComponent extends OverlayPanel {
	readonly #rows: readonly AccountRow[];
	readonly #menu: MenuSelection<AccountRow>;
	readonly #callbacks: AccountManagerCallbacks;
	readonly #list = new Container();
	#nativeRoot: NativeNode | undefined;

	constructor(rows: readonly AccountRow[], callbacks: AccountManagerCallbacks, selectKey?: string) {
		super("Accounts", "omp.overlay.accounts");
		this.#rows = rows;
		this.#callbacks = callbacks;
		const start = rows.find(row => accountRowKey(row) === selectKey) ?? rows.find(row => row.inUse) ?? rows[0];
		this.#menu = new MenuSelection<AccountRow>(
			[...rows],
			{ getKey: accountRowKey, getSearchText: row => `${row.providerName} ${row.name} ${row.detail}` },
			start ? accountRowKey(start) : undefined,
		);
		this.addChild(this.#list);
		this.#update();
	}

	/** Lines of the grouped list, with the line index of the selected account. */
	#lines(): { lines: string[]; selectedLine: number } {
		const lines: string[] = [];
		let selectedLine = 0;
		const selected = this.#menu.selectedItem;
		let provider: string | undefined;
		for (const row of this.#rows) {
			if (row.provider !== provider) {
				provider = row.provider;
				if (lines.length > 0) lines.push("");
				const rotating = row.state === "rotating";
				lines.push(
					`${theme.bold(row.providerName)}${rotating ? theme.fg("dim", "  no active account · accounts rotate") : ""}`,
				);
			}
			const isSelected = row === selected;
			if (isSelected) selectedLine = lines.length;
			const state =
				row.state === "active"
					? theme.fg("success", "active")
					: row.state === "idle"
						? theme.fg("muted", "idle")
						: theme.fg("dim", "rotating");
			const inUse = row.inUse ? theme.fg("dim", " · in use by this session") : "";
			const detail = row.detail ? theme.fg("dim", `  ${row.detail}`) : "";
			const name = isSelected ? theme.fg("accent", `${theme.nav.cursor} ${row.name}`) : `  ${row.name}`;
			lines.push(`${name}  ${state}${inUse}${detail}`);
		}
		return { lines, selectedLine };
	}

	#update(): void {
		this.#nativeRoot = undefined;
		this.#list.clear();
		if (this.#rows.length === 0) {
			this.#list.addChild(new TruncatedText(theme.fg("muted", "No OAuth accounts are signed in"), 0, 0));
		} else {
			const { lines, selectedLine } = this.#lines();
			const height = Math.min(lines.length, MAX_VISIBLE_LINES);
			const offset = Math.max(0, Math.min(selectedLine - Math.floor(height / 2), lines.length - height));
			const view = new ScrollView(lines, {
				height,
				scrollbar: "auto",
				totalRows: lines.length,
				theme: { track: text => theme.fg("muted", text), thumb: text => theme.fg("accent", text) },
			});
			view.setScrollOffset(offset);
			this.#list.addChild(view);
		}
		this.#list.addChild(
			new TruncatedText(
				theme.fg(
					"muted",
					`${editorKeys("tui.select.up", "tui.select.down")} select · ${formatKeyHint("enter")} activate · r rename · ${editorKey("tui.select.cancel")} close`,
				),
				0,
				0,
			),
		);
	}

	handleInput(keyData: string): void {
		if (matchesSelectCancel(keyData)) {
			this.#callbacks.onCancel();
			return;
		}
		if (matchesSelectUp(keyData)) {
			this.#menu.move(-1, true);
			this.#update();
		} else if (matchesSelectDown(keyData)) {
			this.#menu.move(1, true);
			this.#update();
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const row = this.#menu.selectedItem;
			if (row) this.#callbacks.onActivate(row);
		} else if (keyData === "r" || keyData === "R") {
			const row = this.#menu.selectedItem;
			if (row) this.#callbacks.onRename(row);
		}
	}

	override describe(_cx: DescribeContext): NativeNode {
		if (this.#nativeRoot) return this.#nativeRoot;
		const items = this.#rows.map(row =>
			node(
				"item",
				{
					label: `${row.providerName} · ${row.name}`,
					detail: row.detail || undefined,
					value: [span(row.state, row.state === "active" ? "success" : "muted")],
				},
				undefined,
				accountRowKey(row),
			),
		);
		this.#nativeRoot = overlayCard(this.nativeRole, this.title, [
			node(
				"list",
				{
					selected: this.#menu.selectedKey ?? null,
					empty: "No OAuth accounts are signed in",
					max: { lines: MAX_VISIBLE_LINES },
				},
				items,
				"list",
			),
			hintsRow([
				actionHint(["tui.select.up", "tui.select.down"], "select"),
				{ keys: ["enter"], label: "activate" },
				{ keys: ["r"], label: "rename" },
				actionHint("tui.select.cancel", "close"),
			]),
		]);
		return this.#nativeRoot;
	}

	/** A click selects an account; activating it (double-click) activates it, like Enter. */
	handleNativeEvent(event: NativeUiEvent): void {
		if ((event.type !== "select" && event.type !== "activate") || event.key !== "list") return;
		this.#menu.setSelectedKey(event.item);
		this.#update();
		if (event.type === "activate") {
			const row = this.#menu.selectedItem;
			if (row) this.#callbacks.onActivate(row);
		}
	}
}
