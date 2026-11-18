/**
 * A web_search backend that refuses with 429 (rate limit or bot block) moves to
 * the end of the chain for the configured cooldown, so later searches stop
 * paying its failure latency first. The cooldown lives in a shared file: a
 * fresh table on the same path (another agent process) sees it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	cfgProvidersWebSearchCooldownMinutes,
	cfgRetryFallbackChains,
} from "@oh-my-pi/pi-coding-agent/session/settings";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import { SearchCooldowns } from "@oh-my-pi/pi-coding-agent/web/search/cooldown";
import * as provider from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import {
	SearchProviderError,
	type SearchProviderId,
	type SearchResponse,
} from "@oh-my-pi/pi-coding-agent/web/search/types";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

type Outcome = "ok" | "blocked" | "broken";

describe("web search backend cooldown", () => {
	let tempDir: string;
	let cooldownPath: string;
	let now: number;
	let settings: Settings;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let attempted: string[];
	const outcomes = new Map<string, Outcome>();

	function fakeProvider(id: SearchProviderId): provider.SearchProvider {
		return {
			id,
			label: id,
			isAvailable: () => true,
			isExplicitlyAvailable: () => true,
			search: async (_params: SearchParams): Promise<SearchResponse> => {
				attempted.push(id);
				const outcome = outcomes.get(id) ?? "ok";
				if (outcome === "blocked") throw new SearchProviderError(id, `${id} blocked the search`, 429);
				if (outcome === "broken") throw new SearchProviderError(id, `${id} returned garbage`, 502);
				return { provider: id, sources: [{ title: `${id} result`, url: `https://example.com/${id}` }] };
			},
		};
	}

	/** A fresh table per search, as a separate agent process would open it. */
	function search() {
		attempted = [];
		const cooldowns = new SearchCooldowns({ path: cooldownPath, now: () => now });
		return runSearchQuery({ query: "anything" }, { authStorage, modelRegistry, cooldowns });
	}

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-search-cooldown-"));
		cooldownPath = path.join(tempDir, "web-search-cooldowns.json");
		now = Date.UTC(2026, 10, 18, 8, 0, 0);
		outcomes.clear();
		settings = await Settings.init({ inMemory: true });
		settings.setModelRole("web", "web/google");
		cfgRetryFallbackChains.set(settings, { web: ["web/parallel", "web/exa"] });
		cfgProvidersWebSearchCooldownMinutes.set(settings, 15);
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
		const providers = new Map(["google", "parallel", "exa"].map(id => [id, fakeProvider(id as SearchProviderId)]));
		vi.spyOn(provider, "getSearchProvider").mockImplementation(async id => {
			const match = providers.get(id);
			if (!match) throw new Error(`Unexpected provider: ${id}`);
			return match;
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		authStorage.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("tries a backend that refused with 429 last until the cooldown expires", async () => {
		outcomes.set("google", "blocked");
		const first = await search();
		expect(attempted).toEqual(["google", "parallel"]);
		expect(first.details.response.provider).toBe("parallel");

		const second = await search();
		expect(attempted).toEqual(["parallel"]);
		expect(second.details.response.provider).toBe("parallel");

		now += 15 * 60_000 + 1;
		await search();
		expect(attempted).toEqual(["google", "parallel"]);
	});

	it("still falls back to a cooling backend when every other backend fails, and a success clears it", async () => {
		outcomes.set("google", "blocked");
		await search();

		outcomes.set("google", "ok");
		outcomes.set("parallel", "broken");
		outcomes.set("exa", "broken");
		const rescued = await search();
		expect(attempted).toEqual(["parallel", "exa", "google"]);
		expect(rescued.details.response.provider).toBe("google");

		outcomes.set("parallel", "ok");
		await search();
		expect(attempted).toEqual(["google"]);
	});

	it("does not cool down a backend whose failure was not a refusal", async () => {
		outcomes.set("google", "broken");
		await search();
		outcomes.set("google", "ok");
		await search();
		expect(attempted).toEqual(["google"]);
	});

	it("keeps the configured order when cooldowns are turned off", async () => {
		cfgProvidersWebSearchCooldownMinutes.set(settings, 0);
		outcomes.set("google", "blocked");
		await search();
		await search();
		expect(attempted).toEqual(["google", "parallel"]);
	});
});
