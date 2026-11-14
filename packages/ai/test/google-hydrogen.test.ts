import { describe, expect, it } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveVariantSelector } from "@oh-my-pi/pi-catalog/compat/collapse";
import { fetchAntigravityDiscoveryModels } from "@oh-my-pi/pi-catalog/discovery/antigravity";
import { fetchGeminiModels } from "@oh-my-pi/pi-catalog/discovery/gemini";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { defaultSupportedEffort, getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";

const ID = "gemini-4-hydrogen";
const EFFORTS = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh];
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

interface GenerationConfig {
	maxOutputTokens?: number;
	thinkingConfig?: { includeThoughts?: boolean; thinkingLevel?: string; thinkingBudget?: number };
}

interface RequestBody {
	model?: string;
	generationConfig?: GenerationConfig;
	request?: { generationConfig?: GenerationConfig; labels?: Record<string, string> };
}

async function captureRequest(model: Model<Api>, reasoning?: Effort): Promise<RequestBody> {
	let body: RequestBody | undefined;
	const response = {
		candidates: [{ content: { role: "model", parts: [{ text: "Hydrogen response" }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
	};
	const oauth = model.api === "google-gemini-cli";
	const fetcher: FetchImpl = async (_input, init) => {
		body = JSON.parse(String(init?.body)) as RequestBody;
		return new Response(`data: ${JSON.stringify(oauth ? { response } : response)}\n\n`, {
			headers: { "Content-Type": "text/event-stream" },
		});
	};
	const result = await streamSimple(model, context, {
		apiKey: oauth ? JSON.stringify({ token: "fixture", projectId: "fixture-project" }) : "fixture",
		reasoning,
		fetch: fetcher,
	}).result();
	expect(result.stopReason).toBe("stop");
	expect(result.content).toContainEqual({ type: "text", text: "Hydrogen response" });
	if (!body) throw new Error("No request reached the transport");
	return body;
}

async function discoverHydrogen() {
	const result = await fetchAntigravityDiscoveryModels({
		token: "fixture",
		userAgent: "fixture",
		fetcher: async () =>
			Response.json({
				models: Object.fromEntries(
					EFFORTS.map((effort, index) => [
						`${ID}-${effort}`,
						{
							displayName: `Gemini 4 Hydrogen ${effort}`,
							supportsThinking: true,
							supportsImages: true,
							maxTokens: 1_048_576,
							maxOutputTokens: 65_536,
							model: `FIXTURE_${effort}`,
							// Unknown future enum values must not replace a native level with a budget.
							thinkingLevel: effort === Effort.XHigh ? 99 : index + 1,
							thinkingBudget: -1,
						},
					]),
				),
			}),
	});
	if (!result || result.rejectedStatus !== undefined) throw new Error("Fixture discovery failed");
	return result.models;
}

describe("Gemini 4 Hydrogen", () => {
	it("repairs neutral API discovery metadata and defaults to high", () => {
		const model = buildModel({
			id: ID,
			name: ID,
			provider: "google",
			api: "google-generative-ai",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 65_536,
		});
		expect(model.reasoning).toBe(true);
		expect(getSupportedEfforts(model)).toEqual(EFFORTS);
		expect(defaultSupportedEffort(model)).toBe(Effort.High);
	});

	it("sends all four API Key levels and uses high when effort is omitted", async () => {
		const specs = await fetchGeminiModels({
			apiKey: "fixture",
			fetch: async () =>
				Response.json({
					models: [
						{
							name: `models/${ID}`,
							supportedGenerationMethods: ["generateContent"],
							inputTokenLimit: 1_048_576,
							outputTokenLimit: 65_536,
						},
					],
				}),
		});
		if (!specs?.[0]) throw new Error("API discovery returned no Hydrogen model");
		const model = buildModel(specs[0]);
		for (const effort of [...EFFORTS, undefined]) {
			const body = await captureRequest(model, effort);
			expect(body.generationConfig?.thinkingConfig).toEqual({
				includeThoughts: true,
				thinkingLevel: (effort ?? Effort.High).toUpperCase(),
			});
			expect(body.generationConfig?.maxOutputTokens).toBeLessThanOrEqual(65_536);
		}
	});

	it("collapses subscription SKUs and sends the selected level, label and fixed cap", async () => {
		const specs = await discoverHydrogen();
		expect(specs.map(spec => spec.id)).toEqual([ID]);
		const model = buildModel(specs[0]!);
		expect(getSupportedEfforts(model)).toEqual(EFFORTS);
		for (const effort of [...EFFORTS, undefined]) {
			const selected = effort ?? Effort.High;
			const body = await captureRequest(model, effort);
			expect(body.model).toBe(`${ID}-${selected}`);
			expect(body.request?.labels?.model_enum).toBe(`FIXTURE_${selected}`);
			expect(body.request?.generationConfig).toEqual({
				maxOutputTokens: 65_536,
				thinkingConfig: { includeThoughts: true, thinkingLevel: selected.toUpperCase() },
			});
			expect(resolveVariantSelector("google-antigravity", `${ID}-${selected}`)).toBe(ID);
		}
	});
});
