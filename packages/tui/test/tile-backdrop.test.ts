import { describe, expect, it } from "bun:test";
import { overlayTileRow } from "@oh-my-pi/pi-tui/prompt/tile-backdrop";

const TILE = "\x1b[48;2;1;2;3m";

describe("overlayTileRow", () => {
	it("tiles default-background cells, keeps cells with their own background, and pads to the width", () => {
		const row = `ab\x1b[48;5;236mBOX\x1b[0mc`;
		const out = overlayTileRow(row, 8, { bgAt: () => [1, 2, 3], restore: "\x1b[49m", backdrop: undefined });
		expect(Bun.stripANSI(out)).toBe("abBOXc  ");
		// "ab" sits on a tile, "BOX" stays on its own background, "c" and the padding get tiles again.
		expect(out.startsWith(`${TILE}ab`)).toBe(true);
		expect(out).toContain("\x1b[48;5;236mBOX");
		expect(out).toMatch(/BOX\x1b\[0m\x1b\[48;2;1;2;3mc/);
	});

	it("treats the painted terminal background as overridable and restores it where no tile sits", () => {
		const painted = "\x1b[48;2;9;9;9m";
		const out = overlayTileRow(`${painted}xy`, 2, {
			bgAt: col => (col === 0 ? [1, 2, 3] : undefined),
			restore: painted,
			backdrop: [9, 9, 9],
		});
		expect(out).toContain(`${TILE}x${painted}y`);
	});

	it("draws decoration glyphs only into blank cells and restores the row's foreground after them", () => {
		const fg = "\x1b[38;2;200;0;0m";
		const out = overlayTileRow(`${fg}a   b`, 6, {
			bgAt: () => undefined,
			glyphAt: col => (col === 2 ? { char: "ア", width: 2, fg: [5, 5, 5] } : undefined),
			restore: "\x1b[49m",
			backdrop: undefined,
		});
		expect(Bun.stripANSI(out)).toBe("a アb ");
		expect(out).toContain(`\x1b[38;2;5;5;5mア${fg}`);
	});
});
