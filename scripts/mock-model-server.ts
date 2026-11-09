#!/usr/bin/env bun
/**
 * Deterministic OpenAI-compatible chat-completions endpoint for offline
 * acceptance runs (no paid model, no real credentials).
 *
 * Usage: bun scripts/mock-model-server.ts <scenario.json> [--port 18080]
 *
 * The scenario is `[{ "match": "<substring of the latest user message>",
 * "steps": [{ "name": "<tool>", "args": {...}} | { "text": "..." }] }]`.
 * A request picks the first scenario whose `match` occurs in the latest user
 * message (so multi-turn sessions and subagents, which receive a different
 * prompt, get their own script), then answers with `steps[<number of tool
 * results since that message>]`. Past the
 * last step the answer is `ALL-DONE`. Every request is logged as one JSON line
 * on stdout (`mock-request`), including the tool results the model was shown.
 */
import * as fs from "node:fs";

interface Step {
	name?: string;
	args?: unknown;
	text?: string;
}
interface Scenario {
	match: string;
	steps: Step[];
}
interface ChatMessage {
	role: string;
	content: unknown;
}

const args = Bun.argv.slice(2);
const portIndex = args.indexOf("--port");
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 18080;
const scenarioFile = args.find((arg, i) => !arg.startsWith("--") && (portIndex < 0 || i !== portIndex + 1));
if (!scenarioFile) throw new Error("usage: mock-model-server.ts <scenario.json> [--port N]");
const scenarios = JSON.parse(fs.readFileSync(scenarioFile, "utf8")) as Scenario[];

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : "")).join("");
}

const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;

Bun.serve({
	port,
	hostname: "::",
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "mock-1", object: "model" }] });
		const body = (await req.json()) as { messages: ChatMessage[] };
		const lastUserIndex = body.messages.findLastIndex(message => message.role === "user");
		const lastUser = text(body.messages[lastUserIndex]?.content);
		const toolResults = body.messages.slice(lastUserIndex + 1).filter(message => message.role === "tool");
		const steps = scenarios.find(scenario => lastUser.includes(scenario.match))?.steps ?? [];
		const step = steps[toolResults.length];
		console.log(
			JSON.stringify({
				"mock-request": { toolResults: toolResults.length, step: step ?? null, lastResult: text(toolResults.at(-1)?.content).slice(0, 400) },
			}),
		);
		const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: "mock-1" };
		const chunks: string[] = [];
		if (step?.name) {
			const call = { index: 0, id: `call_${toolResults.length}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args ?? {}) } };
			chunks.push(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }] }));
			chunks.push(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
		} else {
			const content = step?.text ?? "ALL-DONE";
			chunks.push(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] }));
			chunks.push(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
		}
		chunks.push(sse({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
		chunks.push("data: [DONE]\n\n");
		return new Response(chunks.join(""), { headers: { "content-type": "text/event-stream" } });
	},
});
console.log(`mock up on ${port}`);
