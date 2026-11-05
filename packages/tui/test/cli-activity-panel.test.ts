import { beforeAll, describe, expect, it } from "bun:test";
import { collapsesIntoActivityGroup, ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { fitHints } from "@oh-my-pi/pi-tui/chrome/keybinding-hints";
import { bottomBorder, divider, row, splitRow, topBorder } from "@oh-my-pi/pi-tui/chrome/overlay-box";
import { renderSidePanel } from "@oh-my-pi/pi-tui/chrome/side-panel";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { fitComposerLabel } from "@oh-my-pi/pi-tui/status-line/component";
import { WelcomeComponent } from "@oh-my-pi/pi-tui/prompt/welcome";
import { createTheme, getBuiltinThemes } from "@oh-my-pi/pi-tui/theme/loader";
import { hexToRgb } from "@oh-my-pi/pi-utils/color";
import { TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

beforeAll(async () => {
	await initTheme();
});

const plain = (rows: readonly string[]) =>
	rows
		.map(row => Bun.stripANSI(row).trimEnd())
		.join("\n")
		.trimEnd();

function explored(): ReadToolGroupComponent {
	const group = new ReadToolGroupComponent();
	group.updateArgs({ path: "src/a.ts" }, "r1");
	group.updateResult({ content: [{ type: "text", text: "body" }] }, false, "r1");
	group.updateSearch("grep", { pattern: "needle", path: "src" }, "g1");
	return group;
}

describe("exploration group", () => {
	it("folds reads and searches into one line and names the running call", () => {
		const group = explored();
		expect(plain(group.render(80))).toContain('Exploring "needle" in src');
		group.updateResult(
			{ content: [{ type: "text", text: "src/a.ts:1:needle" }], details: { matchCount: 3 } },
			false,
			"g1",
		);
		expect(plain(group.render(80))).toBe(" • Explored 1 file, 1 search");
	});

	it("expands to rows with the search output", () => {
		const group = explored();
		group.updateResult(
			{ content: [{ type: "text", text: "src/a.ts:1:needle" }], details: { matchCount: 3 } },
			false,
			"g1",
		);
		group.setExpanded(true);
		const text = plain(group.render(80));
		expect(text).toContain("src/a.ts");
		expect(text).toContain('"needle" in src · 3 matches');
		expect(text).toContain("src/a.ts:1:needle");
	});

	it("never folds a failure away", () => {
		const group = explored();
		group.updateResult({ content: [{ type: "text", text: "bad regex" }], isError: true }, false, "g1");
		const text = plain(group.render(80));
		expect(text.split("\n")).toHaveLength(2);
		expect(text).toContain('"needle" in src');
	});

	it("shows a lone search as its own row", () => {
		const group = new ReadToolGroupComponent();
		group.updateSearch("glob", { pattern: "*.ts" }, "g1");
		group.updateResult({ content: [{ type: "text", text: "a.ts" }], details: { fileCount: 1 } }, false, "g1");
		expect(plain(group.render(80))).toContain('Glob "*.ts" · 1 file');
	});

	it("only groups exploration tools", () => {
		expect(collapsesIntoActivityGroup("grep", { pattern: "x" })).toBe(true);
		expect(collapsesIntoActivityGroup("bash", { command: "ls" })).toBe(false);
		expect(collapsesIntoActivityGroup("constructor", {})).toBe(false);
	});
});

describe("bottom info degradation", () => {
	const facts = { mode: "Build", model: "GPT-6.1 Sol", provider: "openai-codex", thinking: "high" };

	it("drops the provider, then thinking, then cuts the model", () => {
		expect(fitComposerLabel(60, facts)).toBe("Build · GPT-6.1 Sol · openai-codex · high");
		expect(fitComposerLabel(30, facts)).toBe("Build · GPT-6.1 Sol · high");
		expect(fitComposerLabel(20, facts)).toBe("Build · GPT-6.1 Sol");
		const cut = fitComposerLabel(12, facts);
		expect(cut.startsWith("Build")).toBe(true);
		expect(visibleWidth(cut)).toBeLessThanOrEqual(12);
	});

	it("drops leading hints first and keeps the last", () => {
		const hints = ["shift+tab thinking", "alt+a agents", "/ commands"];
		expect(fitHints(hints, 80)).toBe(hints.join(" · "));
		expect(fitHints(hints, 25)).toBe("alt+a agents · / commands");
		expect(fitHints(hints, 12)).toBe("/ commands");
		expect(fitHints(hints, 3)).toBe("");
	});
});

describe("side panel", () => {
	const rows = () =>
		renderSidePanel(
			{
				title: "Fix the router",
				directory: "~/code",
				branch: "main",
				contextTokens: 43_000,
				contextWindow: 500_000,
				contextPercent: 8.8,
				plan: "openai-codex · pro",
				limits: [
					{ label: "5 Hour", percent: 23, resetMinutes: 125 },
					{ label: "7 Day", percent: 90, resetMinutes: 2880 },
				],
				cost: 0.23,
				inputTokens: 12_000,
				outputTokens: 800,
				tasksDone: 1,
				tasksTotal: 8,
				openTasks: ["one", "two", "three", "four", "five", "six", "seven"],
			},
			30,
		);

	it("mirrors the desktop rail: environment, context, plan, conversation, todos", () => {
		const text = plain(rows().top);
		for (const fact of [
			"Fix the router",
			"Environment",
			"~/code",
			"⎇ main",
			"Context",
			"43K / 500K",
			"9% used",
			"Plan usage",
			"openai-codex · pro",
			"5 Hour",
			"23% used",
			"Resets in 2h 5m",
			"7 Day",
			"Resets in 2d 0h",
			"This conversation",
			"$0.23",
			"12K",
			"Todo 1/8",
			"… 2 more",
		]) {
			expect(text).toContain(fact);
		}
		expect(text).not.toContain("six");
		const headings = ["Environment", "Context", "Plan usage", "This conversation", "Todo"];
		const order = headings.map(heading => text.indexOf(heading));
		expect(order).toEqual([...order].sort((left, right) => left - right));
		for (const row of rows().top) expect(visibleWidth(row)).toBeLessThanOrEqual(30);
	});

	it("leaves out the plan without a subscription", () => {
		const { top } = renderSidePanel(
			{ title: "t", directory: "~/code", limits: [], tasksDone: 0, tasksTotal: 0, openTasks: [], cost: 1 },
			30,
		);
		const text = plain(top);
		expect(text).not.toContain("Plan usage");
		expect(text).toContain("This conversation");
	});

	async function docked(columns: number, sidePanel: boolean) {
		const terminal = new VirtualTerminal(columns, 24);
		const scheduler = new VirtualRenderScheduler();
		const c = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true, contentWidth: 100, sidePanel },
		});
		c.start();
		await scheduler.settle(terminal);
		const shown: boolean[] = [];
		c.setSidePanel(rows, value => shown.push(value));
		const transcript = new TranscriptContainer();
		transcript.addChild(new UserMessageComponent("hello"));
		c.setRuntimeChildren([transcript, c.editor]);
		return { c, shown };
	}

	it("docks right of the conversation and stays out of terminal history", async () => {
		const { c, shown } = await docked(140, true);
		try {
			const frame = c.renderFrame({ columns: 140, rows: 24 });
			expect(shown).toEqual([true]);
			const title = frame.viewport.find(row => Bun.stripANSI(row).includes("Fix the router"));
			expect(title).toBeDefined();
			expect(Bun.stripANSI(title!).indexOf("Fix the router")).toBe(140 - 34 + 2);
			for (const row of frame.viewport) expect(visibleWidth(row)).toBeLessThanOrEqual(140);
			expect(frame.history?.rows.join("\n") ?? "").not.toContain("Fix the router");
		} finally {
			c.stop();
		}
	});

	it("stays out on a narrow terminal and when turned off", async () => {
		for (const [columns, enabled] of [
			[110, true],
			[140, false],
		] as const) {
			const { c, shown } = await docked(columns, enabled);
			try {
				const frame = c.renderFrame({ columns, rows: 24 });
				expect(shown).toEqual([]);
				expect(frame.viewport.join("\n")).not.toContain("Fix the router");
			} finally {
				c.stop();
			}
		}
	});
});

describe("home screen", () => {
	async function home(columns: number, rows: number) {
		const terminal = new VirtualTerminal(columns, rows);
		const scheduler = new VirtualRenderScheduler();
		const c = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: false, contentWidth: 100, paintBackground: true },
			welcome: { version: "9.9.9" },
		});
		c.start({ playWelcomeIntro: false });
		await scheduler.settle(terminal);
		return c;
	}

	it("keeps the composer to a card and pins the footer to the bottom", async () => {
		const c = await home(140, 40);
		try {
			const rows = c.renderFrame({ columns: 140, rows: 40 }).viewport.map(row => Bun.stripANSI(row));
			expect(rows).toHaveLength(40);
			const footer = rows.findIndex(row => row.includes("v9.9.9"));
			expect(footer).toBe(38);
			expect(rows[footer]!.trimEnd().length).toBeLessThanOrEqual(Math.floor((140 + 75) / 2) + 1);
			expect(rows.join("\n")).not.toContain("Tip:");
		} finally {
			c.stop();
		}
	});

	it("carries a status in the footer", async () => {
		const c = await home(140, 40);
		try {
			c.setHomeStatus("⊙ 2 MCP");
			const footer = c.renderFrame({ columns: 140, rows: 40 }).viewport.find(row => row.includes("v9.9.9"));
			expect(Bun.stripANSI(footer!)).toContain("⊙ 2 MCP");
		} finally {
			c.stop();
		}
	});

	it("widens back to the conversation column after the first message", async () => {
		const c = await home(140, 40);
		try {
			expect(c.onHomeScreen).toBe(true);
			expect(c.contentMargin).toBe(32);
			const transcript = new TranscriptContainer();
			transcript.addChild(new UserMessageComponent("hello"));
			c.setRuntimeChildren([transcript, c.editor]);
			expect(c.onHomeScreen).toBe(false);
			expect(c.contentMargin).toBe(20);
		} finally {
			c.stop();
		}
	});
});

describe("welcome reveal", () => {
	it("holds its first frame, then settles on the resting lockup", () => {
		const trueColor = Object.getOwnPropertyDescriptor(TERMINAL, "trueColor")!;
		Object.defineProperty(TERMINAL, "trueColor", { value: true, configurable: true });
		try {
			const welcome = new WelcomeComponent("1.0.0");
			welcome.setMinimal(true);
			const rest = welcome.render(80);
			welcome.holdIntro();
			expect(welcome.introProgress).toBe(0);
			expect(welcome.isTranscriptBlockFinalized()).toBe(false);
			const held = welcome.render(80);
			expect(held).toHaveLength(rest.length);
			expect(held.map(row => Bun.stripANSI(row))).toEqual(rest.map(row => Bun.stripANSI(row)));
			expect(held.join("\n")).not.toBe(rest.join("\n"));
			welcome.stopIntro();
			expect(welcome.introProgress).toBe(1);
			expect(welcome.isTranscriptBlockFinalized()).toBe(true);
			expect(welcome.render(80).join("\n")).toBe(rest.join("\n"));
		} finally {
			Object.defineProperty(TERMINAL, "trueColor", trueColor);
		}
	});
});

describe("panel chrome", () => {
	it("draws rows of the frame's width with a rail and no box glyphs", () => {
		const rows = [topBorder(40, "Title"), row("body", 40), divider(40), bottomBorder(40)];
		for (const line of rows) {
			expect(visibleWidth(line)).toBe(40);
			expect(Bun.stripANSI(line).startsWith("▎")).toBe(true);
		}
		expect(plain(rows)).not.toMatch(/[╭╮╰╯├┤]/);
		expect(plain([rows[1]!]).slice(2)).toBe("body");
	});

	it("keeps a split row's body column", () => {
		const line = Bun.stripANSI(splitRow("side", "body", 40, 10));
		expect(visibleWidth(line)).toBe(40);
		expect(line.indexOf("body")).toBe(2 + 10 + 3);
	});
});

describe("theme screen background", () => {
	const builtin = getBuiltinThemes();
	const options = { mode: "truecolor" as const };

	it("follows each theme's page colour", () => {
		expect(createTheme(builtin["dark-twilight"]!, options).terminalBackground).toBe("#0f0e21");
		expect(createTheme(builtin["light-monochrome"]!, options).terminalBackground).toBe("#fafafa");
	});

	it("keeps every built-in composer panel visible against the background", () => {
		for (const [name, json] of Object.entries(builtin)) {
			const theme = createTheme(json, options);
			const page = hexToRgb(theme.terminalBackground);
			const panel = hexToRgb(theme.getBgHex("userMessageBg"));
			const distance = Math.abs(page.r - panel.r) + Math.abs(page.g - panel.g) + Math.abs(page.b - panel.b);
			expect(distance, name).toBeGreaterThanOrEqual(8);
		}
	});

	it("falls back when a theme names no page colour", () => {
		const { export: _omitted, ...bare } = builtin.dark!;
		expect(createTheme(bare as typeof builtin.dark, options).terminalBackground).toBe("#0e0e10");
	});
});
