/**
 * Filled composer with one strong accent rail on the left. The asymmetric
 * silhouette separates input from transcript without enclosing it in a box.
 */
import { padding } from "../../utils";
import type { ComposerChromeContext, ComposerRowContext, ComposerStyle } from "./types";

const ACCENT_RAIL = "▎";

/** An empty row of the filled surface: the prompt gets a line of air above and below, as a panel. */
function blankSurfaceRow(ctx: ComposerChromeContext): string {
	return ctx.accentColor(ACCENT_RAIL) + ctx.surfaceColor(padding(Math.max(0, ctx.width - 1)));
}

/** Filled composer surface anchored by a single left accent rail. */
export const railComposerStyle: ComposerStyle = {
	id: "rail",
	filledSurface: true,
	sideBorders: true,
	verticalChrome: 2,
	statusAttachment: "bottom-label",
	bottomBar: "full",
	bottomBarGap: true,
	defaultPromptGutter: undefined,

	defaultPaddingX(): number {
		return 1;
	},

	sideChromeWidth(paddingX: number): number {
		return paddingX + 1;
	},

	renderTop(ctx: ComposerChromeContext): string {
		return blankSurfaceRow(ctx);
	},

	renderRow(ctx: ComposerRowContext): string[] {
		const rail = ctx.accentColor(ACCENT_RAIL);
		const leftFill = padding(ctx.paddingX) + ctx.gutter + ctx.text;
		if (ctx.imeSafeCursorTail) return [rail + ctx.surfaceColor(leftFill)];

		const rightFillCells = Math.max(0, ctx.paddingX + 1 - ctx.cursorOverflow);
		if (ctx.scrollbarThumb && rightFillCells > 0) {
			const interior = leftFill + ctx.pad + padding(rightFillCells - 1);
			return [rail + ctx.surfaceColor(interior) + ctx.accentColor("█")];
		}
		return [rail + ctx.surfaceColor(leftFill + ctx.pad + padding(rightFillCells))];
	},

	renderBottom(ctx: ComposerChromeContext): string {
		const content = ctx.topBorder?.content ?? "";
		return (
			ctx.accentColor(ACCENT_RAIL) +
			ctx.surfaceColor(" " + content + padding(Math.max(0, ctx.width - 2 - (ctx.topBorder?.width ?? 0))))
		);
	},
};
