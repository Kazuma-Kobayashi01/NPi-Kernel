import { bottomBorder, divider, row, topBorder } from "./overlay-box";
import { editorKey, editorKeys } from "./keybinding-hints";
import { theme } from "../theme";

/** A single title row preserves the selectors' existing mouse-coordinate offsets. */
export function listDialogHeader(width: number, title: string): string {
	return topBorder(width, title, undefined, `${editorKey("tui.select.cancel")} close`);
}

export function listDialogHint(): string {
	return `${editorKeys("tui.select.up", "tui.select.down")} select · ${editorKey("tui.select.confirm")} open · ${editorKey("tui.select.cancel")} close`;
}

/** Shared list shell; selectors retain ownership of filtering, selection and actions. */
export class ListDialogFrame {
	readonly lines: string[];
	constructor(
		readonly width: number,
		title: string,
	) {
		this.lines = [listDialogHeader(width, title)];
	}
	add(content: string): void {
		this.lines.push(row(content, this.width));
	}
	section(label: string): void {
		this.add(theme.fg("accent", theme.bold(label)));
	}
	finish(hint = listDialogHint(), trailingBlank = false): readonly string[] {
		this.lines.push(divider(this.width));
		this.add(theme.fg("dim", hint));
		if (trailingBlank) this.add("");
		this.lines.push(bottomBorder(this.width));
		return this.lines;
	}
}
