import { TERMINAL } from "../terminal-capabilities";

/**
 * The welcome's living backdrop, in the theme's own colours: the logo gradient
 * drifts slowly with a soft sheen passing over it. The backdrop behind the
 * whole home screen is the composer's `HomeScene`.
 * A still frame uses `now = 0`.
 */

export type Rgb = readonly [number, number, number];

interface Cell {
	char: string;
	fg: Rgb | undefined;
	bg: Rgb | undefined;
	bold: boolean;
}

/** Seconds for the logo gradient to drift through one full cycle. */
const FLOW_PERIOD_MS = 9000;
/** One sheen pass over the lockup, then a rest before the next. */
const SHEEN_PERIOD_MS = 5200;
const SHEEN_PASS = 0.45;
const SHEEN_HALF_WIDTH = 0.16;
/** How much colour the lockup keeps before the reveal reaches it. */
const REVEAL_GHOST = 0.12;

export interface AmbientPaint {
	/** Uncolored art rows, left-aligned as one block. */
	art: readonly string[];
	/** Terminal columns; the band spans all of them. */
	width: number;
	/** Columns of the logo; glyphs right of it are the wordmark. */
	logoWidth: number;
	/** Theme gradient stops (text → accent → border accent). */
	stops: readonly Rgb[];
	/** Exact terminal background, or `undefined` when unknown (no band is painted then). */
	backdrop: Rgb | undefined;
	/** Colour of plain text cells (the version). */
	textRgb: Rgb;
	/** Whether the art cell at column `x`, row `y` is plain text. */
	isText: (x: number, y: number) => boolean;
	/** Clock in ms; 0 paints the still frame. */
	now: number;
	/** Reveal progress in [0, 1]. */
	reveal: number;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
	return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function gradientAt(stops: readonly Rgb[], t: number): Rgb {
	const clamped = Math.max(0, Math.min(1, t));
	const seg = clamped * (stops.length - 1);
	const i = Math.min(stops.length - 2, Math.floor(seg));
	return mix(stops[i]!, stops[i + 1]!, seg - i);
}

function smoothstep(t: number): number {
	const x = Math.max(0, Math.min(1, t));
	return x * x * (3 - 2 * x);
}

function rgbEscape(rgb: Rgb, layer: 38 | 48): string {
	const [r, g, b] = rgb.map(channel => Math.max(0, Math.min(255, Math.round(channel))));
	if (TERMINAL.trueColor) return `\x1b[${layer};2;${r};${g};${b}m`;
	const fg = Bun.color(`rgb(${r}, ${g}, ${b})`, "ansi-256") ?? "";
	return layer === 38 ? fg : fg.replace("[38;", "[48;");
}

function serialize(cells: readonly Cell[]): string {
	let out = "";
	let prev = "";
	for (const cell of cells) {
		const style =
			(cell.bold ? "\x1b[1m" : "") +
			(cell.fg && cell.char !== " " ? rgbEscape(cell.fg, 38) : "") +
			(cell.bg ? rgbEscape(cell.bg, 48) : "");
		if (style !== prev) {
			out += prev === "" ? style : `\x1b[0m${style}`;
			prev = style;
		}
		out += cell.char;
	}
	if (prev !== "") out += "\x1b[0m";
	return out;
}

/**
 * The lockup centered in `width` columns.
 * The row count never depends on the clock, so frames replace each other in place.
 */
export function paintAmbientWelcome(p: AmbientPaint): string[] {
	const { art, width, logoWidth, stops, backdrop, textRgb, isText, now, reveal } = p;
	const artWidth = Math.max(0, ...art.map(row => row.length));
	const indent = Math.max(0, Math.floor((width - artWidth) / 2));
	const rows = art.length;
	const lit = REVEAL_GHOST + (1 - REVEAL_GHOST) * smoothstep(reveal);
	const ghostBase = backdrop ?? ([16, 16, 20] as const);
	const highlight = stops[0]!;

	// The drift is a smooth cycle (no wrap seam): the gradient position swings
	// around its resting value instead of jumping from the last stop to the first.
	const drift = now === 0 ? 0 : 0.22 * Math.sin((2 * Math.PI * now) / FLOW_PERIOD_MS);
	const sheenPhase = now === 0 ? -1 : (now % SHEEN_PERIOD_MS) / SHEEN_PERIOD_MS / SHEEN_PASS;
	const sheenPos = -SHEEN_HALF_WIDTH + sheenPhase * (1 + 2 * SHEEN_HALF_WIDTH);
	const xSpan = Math.max(1, logoWidth - 1);
	const ySpan = Math.max(1, art.length - 1);

	const out: string[] = [];
	for (let y = 0; y < rows; y++) {
		const cells: Cell[] = [];
		const artRow = art[y];
		for (let x = 0; x < width; x++) {
			const ax = x - indent;
			const char = artRow !== undefined && ax >= 0 && ax < artRow.length ? artRow[ax]! : " ";
			if (char === " ") {
				cells.push({ char, fg: undefined, bg: undefined, bold: false });
				continue;
			}
			const ay = y;
			if (isText(ax, ay)) {
				cells.push({ char, fg: mix(ghostBase, textRgb, lit), bg: undefined, bold: false });
				continue;
			}
			const inLogo = ax < logoWidth;
			const base = inLogo ? (ax / xSpan + ay / ySpan) / 2 : 0;
			let color = gradientAt(stops, inLogo ? base + drift * (1 - Math.abs(base * 2 - 1)) : 0);
			const along = inLogo ? base : Math.min(1, (ax - logoWidth) / Math.max(1, artWidth - logoWidth));
			const sheen = Math.max(0, 1 - Math.abs(along - sheenPos) / SHEEN_HALF_WIDTH);
			if (sheen > 0) color = mix(color, highlight, sheen * 0.55);
			cells.push({ char, fg: mix(ghostBase, color, lit), bg: undefined, bold: !inLogo });
		}
		// Trailing blanks without a tile would only widen the row.
		out.push(serialize(cells).replace(/ +$/, ""));
	}
	return out;
}
