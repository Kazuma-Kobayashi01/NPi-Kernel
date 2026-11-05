import { beforeAll, describe, expect, it } from "bun:test";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

/** A virtual terminal that records what the composer asks of the terminal's default background. */
class PaintTerminal extends VirtualTerminal {
	readonly paints: Array<string | undefined> = [];
	setDefaultBackground(color: string | undefined): void {
		this.paints.push(color);
	}
}

function composer(preferences: Partial<typeof COMPOSER_DEFAULTS> = {}) {
	const terminal = new PaintTerminal(100, 30);
	const scheduler = new VirtualRenderScheduler();
	const c = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true, paintBackground: true, ...preferences },
	});
	return { c, terminal };
}

describe("terminal background paint", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("paints the theme's background once the composer starts, and gives it back when asked", () => {
		const { c, terminal } = composer();
		expect(terminal.paints).toEqual([]);
		c.start();
		expect(terminal.paints).toEqual([theme.terminalBackground]);
		c.setPreferences({ paintBackground: false });
		expect(terminal.paints).toEqual([theme.terminalBackground, undefined]);
		c.setPreferences({ paintBackground: true });
		expect(terminal.paints.at(-1)).toBe(theme.terminalBackground);
		c.stop();
	});

	it("leaves the terminal alone when the preference is off from the start", () => {
		const { c, terminal } = composer({ paintBackground: false });
		c.start();
		expect(terminal.paints.every(color => color === undefined)).toBe(true);
		c.stop();
	});

	it("is a solid colour from the active theme", () => {
		expect(theme.terminalBackground).toMatch(/^#[0-9a-f]{6}$/i);
	});
});

describe("painted rows", () => {
	beforeAll(async () => {
		await initTheme();
	});

	async function screen(preferences: Partial<typeof COMPOSER_DEFAULTS>) {
		const terminal = new VirtualTerminal(80, 12);
		const scheduler = new VirtualRenderScheduler();
		const c = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true, ...preferences },
		});
		c.start();
		await scheduler.settle(terminal);
		return { c, terminal };
	}

	it("fills every row of the screen with the background, edge to edge", async () => {
		const { c, terminal } = await screen({ paintBackground: true });
		for (let row = 0; row < 12; row++) {
			// Every cell of the row has a background (the cells the text leaves empty included).
			expect(terminal.getViewportRowBackgroundColumns(row).length).toBe(80);
		}
		c.stop();
	});

	it("draws no background of its own when painting is off", async () => {
		const { c, terminal } = await screen({});
		const painted = Array.from({ length: 12 }, (_, row) => terminal.getViewportRowBackgroundColumns(row).length);
		// Only the composer's own panel fills the row.
		expect(painted.filter(columns => columns === 80).length).toBeLessThan(12);
		c.stop();
	});
});
