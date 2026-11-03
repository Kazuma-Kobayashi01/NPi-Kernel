import { beforeAll, describe, expect, it } from "bun:test";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

async function composer(contentWidth: number | undefined, columns = 100) {
	const terminal = new VirtualTerminal(columns, 24);
	const scheduler = new VirtualRenderScheduler();
	const c = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true, contentWidth },
	});
	c.start();
	await scheduler.settle(terminal);
	const rows = () => terminal.getViewport().map(row => Bun.stripANSI(row));
	return { c, rows, scheduler, terminal };
}

const indentOf = (row: string): number => row.length - row.trimStart().length;

describe("centred conversation column", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("moves every drawn row of the prompt right by half the spare width", async () => {
		const { c, rows } = await composer(60);
		expect(c.contentMargin).toBe(20);
		const drawn = rows().filter(row => row.trim() !== "");
		expect(drawn.length).toBeGreaterThan(0);
		for (const row of drawn) expect(indentOf(row)).toBeGreaterThanOrEqual(20);
		c.stop();
	});

	it("leaves a terminal no wider than the cap, or no cap at all, at full width", async () => {
		for (const [cap, columns] of [[0, 100], [undefined, 100], [120, 100], [100, 100]] as const) {
			const { c, rows } = await composer(cap, columns);
			expect(c.contentMargin).toBe(0);
			expect(Math.min(...rows().filter(row => row.trim() !== "").map(indentOf))).toBeLessThan(20);
			c.stop();
		}
	});

	it("follows the preference live and ignores a cap too small to read", async () => {
		const { c, scheduler, terminal } = await composer(0);
		c.setPreferences({ contentWidth: 60 });
		await scheduler.settle(terminal);
		expect(c.contentMargin).toBe(20);
		c.setPreferences({ contentWidth: 20 });
		expect(c.contentMargin).toBe(0);
		c.stop();
	});
});
