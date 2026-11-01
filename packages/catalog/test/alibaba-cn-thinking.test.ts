import { describe, expect, test, vi } from "bun:test";
import { Database } from "bun:sqlite";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as modelsModule from "@oh-my-pi/pi-catalog/models";
import { alibabaCnModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("Alibaba China discovery thinking contracts", () => {
	test("replaces stale bundled tiers and upgrades known reference-less rows without guessing unknown IDs", async () => {
		const original = modelsModule.getBundledModels;
		vi.spyOn(modelsModule, "getBundledModels").mockImplementation((provider => {
			if (provider !== "alibaba-cn") return original(provider);
			const stale = buildModel({
				id: "qwen3.6-plus", name: "Qwen", provider, api: "openai-completions",
				baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", reasoning: true,
				input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000, maxTokens: 4096,
				thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
			});
			return [stale, { ...stale, id: "qwen-unreviewed-future" }];
		}) as typeof modelsModule.getBundledModels);
		try {
			const fetch: FetchImpl = async () => new Response(JSON.stringify({ data: [
				{ id: "qwen3.6-plus" }, { id: "qwen3.8-2.4t-a95b" }, { id: "qwen-unreviewed-future" },
			] }), { status: 200 });
			await using temp = await TempDir.create("@alibaba-cn-thinking-");
			const manager = createModelManager({
				...alibabaCnModelManagerOptions({ apiKey: "test", fetch }),
				cacheDbPath: temp.join("models.db"),
			});
			const { models } = await manager.refresh("online");
			const binary = models.find(model => model.id === "qwen3.6-plus")!;
			const mandatory = models.find(model => model.id === "qwen3.8-2.4t-a95b")!;
			const unknown = models.find(model => model.id === "qwen-unreviewed-future")!;
			expect(binary.thinking?.efforts).toEqual([Effort.Medium]);
			expect(binary.thinking?.requiresEffort).toBeUndefined();
			expect(mandatory.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.XHigh]);
			expect(mandatory.thinking?.requiresEffort).toBe(true);
			expect(unknown.reasoning).toBe(false);
			expect(unknown.thinking).toBeUndefined();
		} finally {
			vi.restoreAllMocks();
		}
	});
	test("refreshes a fresh snapshot written under the previous rules and then reuses the new snapshot", async () => {
		await using temp = await TempDir.create("@alibaba-cn-cache-policy-");
		const cacheDbPath = temp.join("models.db");
		const stale = buildModel({
			id: "qwen3.6-plus", name: "Qwen", provider: "alibaba-cn", api: "openai-completions",
			baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", reasoning: true,
			input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000, maxTokens: 4096,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
		});
		const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "qwen3.6-plus" }] })));
		const options = {
			...alibabaCnModelManagerOptions({ apiKey: "test", fetch }),
			cacheDbPath,
			staticModels: [stale],
		};
		const oldManager = createModelManager({ ...options, fetchDynamicModels: async () => [stale] });
		const old = await oldManager.refresh("online");
		expect(old.models[0]?.thinking?.efforts).toEqual([Effort.Low, Effort.High]);
		const db = new Database(cacheDbPath);
		db.run("UPDATE model_cache SET materialization_policy = ? WHERE provider_id = ?", [
			"previous-rules-policy", "alibaba-cn",
		]);
		db.close();

		const manager = createModelManager(options);
		const fresh = await manager.refresh("online-if-uncached");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fresh.models[0]?.thinking?.efforts).toEqual([Effort.Medium]);
		const cached = await manager.refresh("online-if-uncached");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(cached.models[0]?.thinking?.efforts).toEqual([Effort.Medium]);
	});
});
