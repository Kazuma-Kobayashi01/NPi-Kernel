import { visibleWidth } from "../utils";

/**
 * Paint a per-column backdrop under a rendered row: every cell the row leaves
 * on the default background (or on the painted terminal background
 * `backdrop`) takes `bgAt(column)`, while cells with a background of their own
 * (the composer box, selections, chips) keep it. Blank cells may also carry a
 * faint decoration glyph from `glyphAt(column)`. The row is padded to
 * `columns`, so the whole screen width carries the backdrop.
 */

type Rgb = readonly [number, number, number];

/** A decoration drawn into blank cells; a wide glyph needs two blank cells. */
export interface BackdropGlyph {
	char: string;
	width: 1 | 2;
	fg: Rgb;
	/** Background under the glyph; `bgAt` when omitted. */
	bg?: Rgb;
}

export interface BackdropPainter {
	bgAt: (column: number) => Rgb | undefined;
	glyphAt?: (column: number) => BackdropGlyph | undefined;
	/** Escape that restores the screen's own background where nothing is drawn. */
	restore: string;
	/** The painted terminal background, treated like the default background. */
	backdrop: Rgb | undefined;
}

const ESC = "\x1b";

function bgEscape(rgb: Rgb): string {
	return `${ESC}[48;2;${Math.round(rgb[0])};${Math.round(rgb[1])};${Math.round(rgb[2])}m`;
}

function fgEscape(rgb: Rgb): string {
	return `${ESC}[38;2;${Math.round(rgb[0])};${Math.round(rgb[1])};${Math.round(rgb[2])}m`;
}

interface SgrState {
	/** Whether the row set a background of its own. */
	explicitBg: boolean;
	/** Escape that re-applies the row's foreground (default foreground when unset). */
	fg: string;
}

/**
 * Apply an SGR parameter list to `state`. Returns whether it touched the
 * background, so a cached backdrop escape must be re-sent.
 */
function applySgr(params: string, state: SgrState, backdrop: Rgb | undefined): boolean {
	const parts = params === "" ? ["0"] : params.split(";");
	let touchedBg = false;
	for (let i = 0; i < parts.length; i++) {
		const code = Number(parts[i] || "0");
		if (code === 0) {
			state.explicitBg = false;
			state.fg = `${ESC}[39m`;
			touchedBg = true;
		} else if (code === 49) {
			state.explicitBg = false;
			touchedBg = true;
		} else if (code === 39) {
			state.fg = `${ESC}[39m`;
		} else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
			state.fg = `${ESC}[${code}m`;
		} else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
			state.explicitBg = true;
			touchedBg = true;
		} else if (code === 38 || code === 48 || code === 58) {
			const mode = Number(parts[i + 1]);
			const take = mode === 2 ? 4 : mode === 5 ? 2 : 1;
			const args = parts.slice(i, i + 1 + take).join(";");
			if (code === 38) state.fg = `${ESC}[${args}m`;
			if (code === 48) {
				touchedBg = true;
				if (mode === 2 && backdrop) {
					const [r, g, b] = [Number(parts[i + 2]), Number(parts[i + 3]), Number(parts[i + 4])];
					state.explicitBg = !(r === backdrop[0] && g === backdrop[1] && b === backdrop[2]);
				} else {
					state.explicitBg = true;
				}
			}
			i += take;
		}
	}
	return touchedBg;
}

export function overlayTileRow(row: string, columns: number, painter: BackdropPainter): string {
	const { bgAt, glyphAt, restore, backdrop } = painter;
	let out = "";
	let col = 0;
	const state: SgrState = { explicitBg: false, fg: `${ESC}[39m` };
	let applied: string | undefined;
	const paintCell = (override?: Rgb): void => {
		if (state.explicitBg) return;
		const tile = override ?? bgAt(col);
		const escape = tile ? bgEscape(tile) : restore;
		if (escape !== applied) {
			out += escape;
			applied = escape;
		}
	};
	/** Draw a decoration over a blank cell; `nextBlank` says whether the cell after it is blank too. */
	const decorate = (nextBlank: boolean): number => {
		if (state.explicitBg || !glyphAt) return 0;
		const glyph = glyphAt(col);
		if (!glyph || (glyph.width === 2 && !nextBlank)) return 0;
		paintCell(glyph.bg);
		out += `${fgEscape(glyph.fg)}${glyph.char}${state.fg}`;
		return glyph.width;
	};
	let i = 0;
	while (i < row.length) {
		const ch = row[i]!;
		if (ch === ESC) {
			const kind = row[i + 1];
			if (kind === "[") {
				let j = i + 2;
				while (j < row.length && (row.charCodeAt(j) < 0x40 || row.charCodeAt(j) > 0x7e)) j++;
				const seq = row.slice(i, j + 1);
				if (row[j] === "m" && applySgr(seq.slice(2, -1), state, backdrop)) applied = undefined;
				out += seq;
				i = j + 1;
				continue;
			}
			if (kind === "]" || kind === "P" || kind === "_") {
				// OSC / DCS / APC: copy through the BEL or ST terminator.
				let j = i + 2;
				while (j < row.length && row[j] !== "\x07" && !(row[j] === ESC && row[j + 1] === "\\")) j++;
				const end = row[j] === "\x07" ? j + 1 : j + 2;
				out += row.slice(i, end);
				i = end;
				continue;
			}
			out += row.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (ch === " ") {
			const drawn = decorate(row[i + 1] === " " || (i + 1 >= row.length && col + 1 < columns));
			if (drawn > 0) {
				col += drawn;
				i += drawn === 2 && row[i + 1] === " " ? 2 : 1;
				continue;
			}
		}
		const code = row.codePointAt(i)!;
		const char = String.fromCodePoint(code);
		const width = visibleWidth(char);
		if (width > 0) paintCell();
		out += char;
		col += width;
		i += char.length;
	}
	if (col < columns) {
		out += `${ESC}[0m`;
		state.explicitBg = false;
		state.fg = `${ESC}[39m`;
		applied = undefined;
		while (col < columns) {
			const drawn = decorate(col + 1 < columns);
			if (drawn > 0) {
				col += drawn;
				continue;
			}
			paintCell();
			out += " ";
			col++;
		}
	}
	return `${out}${ESC}[0m`;
}
