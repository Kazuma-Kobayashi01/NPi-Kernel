import { describe, expect, test } from "bun:test";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import {
	alibabaCnModelManagerOptions,
	alibabaModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("Alibaba pay-as-you-go regions", () => {
	for (const [region, options, host] of [
		["international", alibabaModelManagerOptions, "dashscope-intl.aliyuncs.com"],
		["China", alibabaCnModelManagerOptions, "dashscope.aliyuncs.com"],
	] as const) {
		test(`${region} discovers models from its own endpoint and keeps only chat models`, async () => {
			const seen: string[] = [];
			const fetch = async (url: string | URL | Request) => {
				seen.push(String(url));
				const data = [{ id: "qwen3.8-max" }, { id: "qwen-image-2.0-pro" }, { id: "text-embedding-v4" }];
				return new Response(JSON.stringify({ data }), { status: 200 });
			};
			await using temp = await TempDir.create("@alibaba-region-");
			const manager = createModelManager({
				...options({ apiKey: "test", fetch }),
				cacheDbPath: temp.join("models.db"),
			});
			const { models } = await manager.refresh("online");
			expect(seen.some(url => new URL(url).host === host)).toBe(true);
			expect(models.map(model => model.id)).toEqual(["qwen3.8-max"]);
			expect(models[0]!.baseUrl).toContain(host);
			expect([...(models[0]!.thinking?.efforts ?? [])].map(String)).toContain("xhigh");
		});
	}
});

describe("Alibaba published model facts", () => {
	async function discover(ids: string[]) {
		const fetch = async () => new Response(JSON.stringify({ data: ids.map(id => ({ id })) }), { status: 200 });
		await using temp = await TempDir.create("@alibaba-facts-");
		const options = alibabaModelManagerOptions({ apiKey: "test", fetch });
		const { models } = await createModelManager({ ...options, cacheDbPath: temp.join("models.db") }).refresh(
			"online",
		);
		return new Map(models.map(model => [model.id, model]));
	}
	const levels = (model: { thinking?: { efforts?: readonly unknown[] } } | undefined) =>
		model?.thinking?.efforts?.map(String);

	test("fills names, limits, prices and image input the listing omits", async () => {
		const model = (await discover(["qwen3.8-max"])).get("qwen3.8-max")!;
		expect(model.name).toBe("Qwen3.8 Max");
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(131_072);
		expect(model.input).toContain("image");
		expect(model.cost.input).toBe(2);
		expect(model.cost.output).toBe(6);
	});

	test("gives each model the thinking control it really has", async () => {
		const models = await discover([
			"qwen3.8-max",
			"glm-5.2",
			"deepseek-v4-pro",
			"qwen3.7-plus",
			"kimi-k2.7-code",
			"qwen-mt-plus",
			"qwq-plus",
			"qwen-unreviewed-future",
		]);
		expect(levels(models.get("qwen3.8-max"))).toEqual(["low", "medium", "xhigh"]);
		expect(String(models.get("qwen3.8-max")?.thinking?.defaultLevel)).toBe("xhigh");
		expect(levels(models.get("glm-5.2"))).toEqual(["high", "max"]);
		expect(levels(models.get("deepseek-v4-pro"))).toEqual(["high", "max"]);
		expect(levels(models.get("qwen3.7-plus"))).toEqual(["medium"]);
		expect(models.get("kimi-k2.7-code")?.thinking?.requiresEffort).toBe(true);
		expect(models.get("qwen-mt-plus")?.reasoning).toBe(false);
		expect(models.get("qwq-plus")?.reasoning).toBe(false);
		expect(models.get("qwq-plus")?.thinking).toBeUndefined();
		expect(models.get("qwen-unreviewed-future")?.reasoning).toBe(false);
	});
});
