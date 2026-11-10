import { beforeEach, describe, expect, it } from "bun:test";
import { OfficePanelComponent, type OfficePanelState } from "../src/overlays/office-panel";
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
	const panel = new OfficePanelComponent({
		load: async () => state,
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
	return { ran, press, isClosed: () => closed };
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

	it("goes back one page per Esc and closes from the tabs", async () => {
		const { press, isClosed } = await open(company());
		await press(RIGHT, DOWN, ENTER, ESC);
		expect(isClosed()).toBe(false);
		await press(ESC);
		expect(isClosed()).toBe(true);
	});
});
