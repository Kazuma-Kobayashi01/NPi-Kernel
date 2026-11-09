import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { searchGoogle } from "@oh-my-pi/pi-coding-agent/web/search/providers/google";

function params(fetch: FetchImpl): SearchParams {
	return { query: "tauri releases", fetch } as unknown as SearchParams;
}

/** One organic result in the shape Google renders: heading inside the result link. */
function result(href: string, title: string, snippet: string): string {
	return `<div class="MjjYud"><div class="tF2Cxc"><a href="${href}"><h3>${title}</h3></a><div class="VwiC3b">${snippet}</div></div></div>`;
}

describe("Google web search provider", () => {
	it("follows /goto result links to their destinations and still reads legacy /url links", async () => {
		const page = `<html><body>${result("/goto?url=TOKEN1&amp;gsessionid=s", "Tauri Releases", "All releases")}${result(
			"/url?q=https://github.com/tauri-apps/tauri/releases&amp;sa=U",
			"Releases · tauri-apps/tauri",
			"GitHub",
		)}${result("/goto?url=TOKEN2", "Broken redirect", "kept as is")}</body></html>`;
		const requested: string[] = [];
		const fetchMock: FetchImpl = async (input, init) => {
			const url = typeof input === "string" ? input : input.toString();
			requested.push(url);
			if (url.includes("/search?"))
				return new Response(page, { status: 200, headers: { "content-type": "text/html" } });
			expect(init?.redirect).toBe("manual");
			if (url.includes("TOKEN1"))
				return new Response(null, { status: 302, headers: { location: "https://v2.tauri.app/release/" } });
			throw new Error("network down");
		};

		const response = await searchGoogle(params(fetchMock));

		expect(response.sources.map(s => s.url)).toEqual([
			"https://v2.tauri.app/release/",
			"https://github.com/tauri-apps/tauri/releases",
			"https://www.google.com/goto?url=TOKEN2",
		]);
		expect(response.sources[0]?.snippet).toBe("All releases");
		expect(requested.filter(u => u.includes("/goto")).length).toBe(2);
	});
});
