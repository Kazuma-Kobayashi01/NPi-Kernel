/**
 * Filled composer with one strong accent rail on the left. The asymmetric
 * silhouette separates input from transcript without enclosing it in a box.
 */
import { padding } from "../../utils";
import type { ComposerChromeContext, ComposerRowContext, ComposerStyle } from "./types";

const ACCENT_RAIL = "▎";

/** The panel's fill: one step lighter than the page where the theme provides it. */
function panelFill(ctx: ComposerChromeContext): (str: string) => string {
	return ctx.panelColor ?? ctx.surfaceColor;
}

/** The accent rail, on the panel's fill so bar and panel read as one edge. */
function railCell(ctx: ComposerChromeContext): string {
	return panelFill(ctx)(ctx.accentColor(ACCENT_RAIL));
}

/** An empty row of the filled surface: the prompt gets a line of air above and below, as a panel. */
function blankSurfaceRow(ctx: ComposerChromeContext): string {
	return railCell(ctx) + panelFill(ctx)(padding(Math.max(0, ctx.width - 1)));
}

/** Filled composer surface anchored by a single left accent rail. */
export const railComposerStyle: ComposerStyle = {
	id: "rail",
	filledSurface: true,
	sideBorders: true,
	verticalChrome: 3,
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
		const rail = railCell(ctx);
		const fill = panelFill(ctx);
		const leftFill = padding(ctx.paddingX) + ctx.gutter + ctx.text;
		if (ctx.imeSafeCursorTail) return [rail + fill(leftFill)];

		const rightFillCells = Math.max(0, ctx.paddingX + 1 - ctx.cursorOverflow);
		if (ctx.scrollbarThumb && rightFillCells > 0) {
			const interior = leftFill + ctx.pad + padding(rightFillCells - 1);
			return [rail + fill(interior) + ctx.accentColor("█")];
		}
		return [rail + fill(leftFill + ctx.pad + padding(rightFillCells))];
	},

	/** Air under the prompt, then the mode / model label as the panel's last row. */
	renderBottom(ctx: ComposerChromeContext): string {
		const content = ctx.topBorder?.content ?? "";
		const label =
			railCell(ctx) +
			panelFill(ctx)(" " + content + padding(Math.max(0, ctx.width - 2 - (ctx.topBorder?.width ?? 0))));
		const air = blankSurfaceRow(ctx);
		return (ctx.tall ? [air, air, label] : [air, label]).join("\n");
	},
};
