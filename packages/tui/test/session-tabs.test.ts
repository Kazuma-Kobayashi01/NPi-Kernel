import { beforeAll, describe, expect, it } from "bun:test";
import { renderSessionTabs, SessionTabsComponent } from "@oh-my-pi/pi-tui/chrome/session-tabs";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";

beforeAll(async () => {
	await initTheme();
});

const tabs = (n: number, current: number) =>
	Array.from({ length: n }, (_, i) => ({ title: `Session ${i + 1}`, current: i === current }));

describe("session tabs", () => {
	it("stays out with fewer than two tabs", () => {
		expect(renderSessionTabs(tabs(1, 0), 80)).toBe("");
		expect(
			new SessionTabsComponent(
				() => tabs(1, 0),
				() => "",
			).render(80),
		).toEqual([]);
	});

	it("lists every tab that fits, with the hint on the right", () => {
		const row = renderSessionTabs(tabs(3, 1), 100, "alt+S/alt+s switch");
		const text = Bun.stripANSI(row);
		expect(text).toContain(" Session 1  │  Session 2  │  Session 3 ");
		expect(text.trimEnd().endsWith("alt+S/alt+s switch")).toBe(true);
		expect(visibleWidth(row)).toBe(100);
	});

	it("keeps the current tab in view and marks the ones left out", () => {
		const text = Bun.stripANSI(renderSessionTabs(tabs(8, 7), 40));
		expect(text).toContain("Session 8");
		expect(text.startsWith("…")).toBe(true);
		expect(text).not.toContain("Session 1 ");
		expect(visibleWidth(text)).toBeLessThanOrEqual(40);
	});

	it("cuts a long title", () => {
		const long = [
			{ title: "A very long session title that goes on and on", current: true },
			{ title: "Short", current: false },
		];
		const text = Bun.stripANSI(renderSessionTabs(long, 80));
		expect(text).toContain("Short");
		expect(text).not.toContain("goes on and on");
	});
});
