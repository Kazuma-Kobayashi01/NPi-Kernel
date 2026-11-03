import { beforeAll, describe, expect, it } from "bun:test";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { StatusNotice } from "@oh-my-pi/pi-tui/chrome/status-notice";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
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

	it("keeps CJK message backgrounds inside the centred column and removes shell prompt rewrite markers", async () => {
		const { c, terminal, scheduler } = await composer(100, 140);
		try {
			const transcript = new TranscriptContainer();
			transcript.addChild(new UserMessageComponent("你好啊"));
			c.setRuntimeChildren([transcript, c.editor]);
			const frame = c.renderFrame({ columns: 140, rows: 24 });
			expect(frame.viewport.join("\n")).not.toContain("\x1b]133;");
			c.ui.requestRender();
			await scheduler.settle(terminal);
			const messageRow = terminal.getViewport().findIndex(row => row.includes("你好啊"));
			expect(messageRow).toBeGreaterThanOrEqual(1);
			for (const row of [messageRow - 1, messageRow, messageRow + 1]) {
				const colors = terminal.getViewportRowBackgroundValues(row);
				// Column 20 is the accent bar; the bubble fills the rest of the column.
				expect(colors.slice(21, 120).every(color => color === colors[21])).toBe(true);
				expect(colors[20]).not.toBe(colors[21]);
				expect(colors[19]).not.toBe(colors[21]);
				expect(colors[120]).not.toBe(colors[21]);
			}
		} finally {
			c.stop();
		}
	});

	it("opens rail completions above the input without overflowing the column, and clears them on Escape", async () => {
		for (const columns of [80, 140]) {
			const { c } = await composer(100, columns);
			try {
				const updated = Promise.withResolvers<void>();
				c.editor.onAutocompleteUpdate = () => updated.resolve();
				c.editor.setAutocompleteProvider({
					getSuggestions: async () => ({
						items: Array.from({ length: 20 }, (_, index) => ({
							value: `/example${index}`,
							label: `/example${index}`,
						})),
						prefix: "/",
					}),
					applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
				});
				c.editor.handleInput("/");
				await updated.promise;
				const frame = c.renderFrame({ columns, rows: 24 }).viewport;
				const menuRow = frame.findIndex(row => row.includes("/example0"));
				const inputRow = frame.findIndex(row => row.includes("▎"));
				expect(menuRow).toBeGreaterThanOrEqual(0);
				expect(inputRow).toBeGreaterThan(menuRow + 1);
				expect(Bun.stripANSI(frame[inputRow - 1]!).trim()).toBe("");
				for (const row of frame) expect(visibleWidth(row)).toBeLessThanOrEqual(columns);
				c.editor.handleInput("\x1b");
				expect(c.renderFrame({ columns, rows: 24 }).viewport.join("\n")).not.toContain("/example0");
			} finally {
				c.stop();
			}
		}
	});

	it("moves the empty welcome scene down on tall screens without clipping short ones or padding conversations", () => {
		for (const columns of [80, 120]) {
			const c = new Composer({
				terminal: new VirtualTerminal(columns, 50),
				preferences: { ...COMPOSER_DEFAULTS, contentWidth: 100 },
			});
			c.start();
			try {
				const firstDrawn = (rows: readonly string[]) => rows.findIndex(row => Bun.stripANSI(row).trim() !== "");
				const tall = c.renderFrame({ columns, rows: 50 }).viewport;
				expect(firstDrawn(tall)).toBeGreaterThan(5);
				const short = c.renderFrame({ columns, rows: 20 }).viewport;
				expect(firstDrawn(short)).toBeLessThan(firstDrawn(tall));
				const transcript = new TranscriptContainer();
				c.setRuntimeChildren([transcript, c.editor]);
				expect(firstDrawn(c.renderFrame({ columns, rows: 50 }).viewport)).toBeGreaterThan(5);
				transcript.addChild(new StatusNotice("Connected to MCP servers: example."));
				expect(firstDrawn(c.renderFrame({ columns, rows: 50 }).viewport)).toBeGreaterThan(5);
				transcript.addChild(new Text("FIRST USER MESSAGE", 0, 0));
				const conversation = c.renderFrame({ columns, rows: 50 }).viewport;
				expect(firstDrawn(conversation)).toBeLessThan(5);
				expect(conversation.some(row => Bun.stripANSI(row).includes("FIRST USER MESSAGE"))).toBe(true);
			} finally {
				c.stop();
			}
		}
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
		for (const [cap, columns] of [
			[0, 100],
			[undefined, 100],
			[120, 100],
			[100, 100],
		] as const) {
			const { c, rows } = await composer(cap, columns);
			expect(c.contentMargin).toBe(0);
			expect(
				Math.min(
					...rows()
						.filter(row => row.trim() !== "")
						.map(indentOf),
				),
			).toBeLessThan(20);
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
