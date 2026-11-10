import { beforeEach, describe, expect, it } from "bun:test";
import {
	bookUsage,
	OfficePanelComponent,
	type OfficePanelBooking,
	type OfficePanelState,
	type OfficePanelUsage,
} from "../src/overlays/office-panel";
import { ensureThemeSync } from "../src/theme/theme";

const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const ENTER = "\r";
const ESC = "\x1b";

function company(): OfficePanelState {
	return {
		enabled: false,
		scale: "team",
		offices: [
			{
				number: 1,
				members: [
					{ id: "Worker-aaaaaa", role: "leader", capability: "expert", model: "" },
					{ id: "Worker-bbbbbb", role: "worker", capability: "common", model: "" },
					{ id: "Worker-cccccc", role: "worker", capability: "common", model: "" },
				],
			},
		],
		company: { baseBranch: "main" },
		pulls: [
			{
				number: 4,
				kind: "office",
				office: 1,
				author: "Worker-aaaaaa",
				title: "Add greeting",
				body: "",
				target: "main",
				status: "approved",
				reviews: [],
			},
		],
		memory: [{ office: 1, notes: [], log: [] }],
	};
}

async function open(state: OfficePanelState) {
	const ran: string[][] = [];
	let closed = false;
	let loads = 0;
	let watching: { change: () => void; usage: (booking: OfficePanelBooking) => void } | undefined;
	const panel = new OfficePanelComponent({
		load: async () => {
			loads++;
			return state;
		},
		thinkingLevels: model => (model ? ["off", "low", "high"] : ["off", "minimal", "low", "medium", "high", "xhigh"]),
		watch: listeners => {
			watching = listeners;
			return () => {
				watching = undefined;
			};
		},
		run: async args => {
			ran.push(args);
			return { text: "ok" };
		},
		models: ["anthropic/claude-opus-5-5"],
		scales: [
			{ id: "team", offices: 1 },
			{ id: "studio", offices: 3 },
		],
		capabilities: ["common", "professional", "expert"],
		minMembers: 3,
		maxMembers: 6,
		requestRender: () => {},
		onClose: () => {
			closed = true;
		},
	});
	await Bun.sleep(0);
	const press = async (...keys: string[]) => {
		for (const key of keys) {
			panel.render(100);
			panel.handleInput(key);
			await Bun.sleep(0);
		}
		return Bun.stripANSI(panel.render(100).join("\n"));
	};
	return { ran, press, isClosed: () => closed, loads: () => loads, watching: () => watching };
}

describe("office panel", () => {
	beforeEach(() => ensureThemeSync());

	it("toggles Virtual Office with Enter on the first row", async () => {
		const { ran, press } = await open(company());
		await press(ENTER);
		expect(ran).toEqual([["on"]]);
	});

	it("changes a member's capability through the office tab", async () => {
		const { ran, press } = await open(company());
		// Office 1 tab → second member → Capability → "expert".
		const screen = await press(RIGHT, DOWN, ENTER, DOWN, ENTER, DOWN, DOWN, ENTER);
		expect(ran).toEqual([["set", "Worker-bbbbbb", "capability", "expert"]]);
		expect(screen).toContain("Worker-bbbbbb");
	});

	it("merges an approved office pull request only after confirming", async () => {
		const { ran, press } = await open(company());
		// Pull requests tab → #4 → Merge → confirmation opens on Cancel.
		await press(RIGHT, RIGHT, ENTER, DOWN, DOWN, DOWN, ENTER);
		expect(ran).toEqual([]);
		await press(DOWN, ENTER);
		expect(ran).toEqual([["merge", "4"]]);
	});

	it("sends a pull request back with the typed reason", async () => {
		const { ran, press } = await open(company());
		await press(RIGHT, RIGHT, ENTER, DOWN, DOWN, DOWN, DOWN, ENTER, ..."no tests", ENTER);
		expect(ran).toEqual([["reject", "4", "no tests"]]);
	});

	it("sets a member's thinking effort from the levels of their model", async () => {
		const state = company();
		state.offices[0].members[1].model = "anthropic/claude-opus-5-5";
		const { ran, press } = await open(state);
		// Office 1 tab → second member → Thinking effort (third row) → picker: default, off, low, high.
		const screen = await press(RIGHT, DOWN, ENTER, DOWN, DOWN, ENTER);
		expect(screen).not.toContain("xhigh");
		await press(DOWN, DOWN, DOWN, ENTER);
		expect(ran).toEqual([["set", "Worker-bbbbbb", "thinking", "high"]]);
	});

	it("adds booked usage locally and re-reads the company only on a change", async () => {
		const state = company();
		state.company = { baseBranch: "main", checkout: "/repo" };
		const today = new Date();
		const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
		const amount = { tokens: 0, cost: 0, requests: 0 };
		state.usage = { day, members: {}, today: { ...amount }, total: { ...amount } };
		const { press, loads, watching, isClosed } = await open(state);
		const before = loads();
		watching()?.usage({
			checkout: "/repo",
			member: "Worker-bbbbbb",
			day,
			amount: { tokens: 1500, cost: 2.5, requests: 1 },
		});
		watching()?.usage({
			checkout: "/other",
			member: "Worker-bbbbbb",
			day,
			amount: { tokens: 9, cost: 9, requests: 1 },
		});
		const screen = await press();
		expect(screen).toContain("1.5k tokens · $2.50 · 1 requests");
		expect(loads()).toBe(before);
		watching()?.change();
		await Bun.sleep(200);
		expect(loads()).toBe(before + 1);
		await press(ESC);
		expect(isClosed()).toBe(true);
		expect(watching()).toBeUndefined();
	});

	it("frees disk space from the company tab", async () => {
		const { ran, press } = await open(company());
		// Virtual Office → Company size → Base branch (information) → Free disk space.
		await press(DOWN, DOWN, DOWN, ENTER);
		expect(ran).toEqual([["clean"]]);
	});

	it("goes back one page per Esc and closes from the tabs", async () => {
		const { press, isClosed } = await open(company());
		await press(RIGHT, DOWN, ENTER, ESC);
		expect(isClosed()).toBe(false);
		await press(ESC);
		expect(isClosed()).toBe(true);
	});
});

describe("office panel usage", () => {
	const amount = (tokens: number) => ({ tokens, cost: tokens / 100, requests: 1 });
	const usage = (): OfficePanelUsage => ({
		day: "2026-11-10",
		members: { a: { today: amount(10), total: amount(50) } },
		today: amount(10),
		total: amount(50),
	});

	it("starts today over on a later day and counts a late booking only in the total", () => {
		const next = bookUsage(usage(), { checkout: "", member: "b", day: "2026-11-11", amount: amount(5) });
		expect(next.day).toBe("2026-11-11");
		expect(next.today.tokens).toBe(5);
		expect(next.members.a).toEqual({ today: { tokens: 0, cost: 0, requests: 0 }, total: amount(50) });
		const late = bookUsage(next, { checkout: "", member: "a", day: "2026-11-10", amount: amount(3) });
		expect(late.today.tokens).toBe(5);
		expect(late.members.a.total.tokens).toBe(53);
		expect(late.total.tokens).toBe(58);
	});
});
