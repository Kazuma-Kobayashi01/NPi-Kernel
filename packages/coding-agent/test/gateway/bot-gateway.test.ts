import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "bun";
import {
	DEFAULT_SANDBOX_ATTACHMENTS,
	type GatewayConfig,
	GatewayModelCatalog,
	type StartedBotGateway,
	startBotGateway,
} from "../../src/gateway";

interface RecordedModelRequest {
	messages: Array<{ role: string; text: string }>;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part =>
			typeof part === "object" && part !== null && "text" in part
				? String((part as { text?: unknown }).text ?? "")
				: "",
		)
		.join("");
}

describe("NPi Bot Gateway end-to-end contract", () => {
	let tempRoot: string;
	let agentDir: string;
	let dataDir: string;
	let fakeModelServer: Server<undefined>;
	let recordedRequests: RecordedModelRequest[];
	let gateway: StartedBotGateway | undefined;
	const managerKey = "test-manager-secret-key-0123456789";

	beforeEach(async () => {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "npi-bot-gateway-test-"));
		agentDir = path.join(tempRoot, "agent");
		dataDir = path.join(tempRoot, "gateway-data");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(dataDir, { recursive: true });
		recordedRequests = [];

		fakeModelServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			idleTimeout: 255,
			async fetch(req) {
				const url = new URL(req.url);
				if (url.pathname.endsWith("/models")) {
					return Response.json({
						object: "list",
						data: [{ id: "fake-model", object: "model", owned_by: "fake" }],
					});
				}
				if (!url.pathname.endsWith("/chat/completions")) {
					return new Response("not found", { status: 404 });
				}
				const body = (await req.json()) as {
					messages?: Array<{ role: string; content?: unknown }>;
				};
				const rawMsgs = body.messages ?? [];
				const nonSystem = rawMsgs
					.filter(m => m.role !== "system")
					.map(m => ({ role: m.role, text: extractText(m.content) }));
				recordedRequests.push({ messages: nonSystem });

				const last = rawMsgs.at(-1);
				const lastText = last ? extractText(last.content) : "";
				const delayedReply = last?.role === "user" && lastText.includes("delayed reply");
				if (delayedReply) {
					await Bun.sleep(12_000);
				}
				const base = {
					id: "chatcmpl-fake",
					object: "chat.completion.chunk",
					created: 0,
					model: "fake-model",
				};
				const encoder = new TextEncoder();
				const sse = (obj: unknown) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);

				if (last?.role === "tool") {
					return new Response(
						new ReadableStream({
							start(c) {
								c.enqueue(
									sse({
										...base,
										choices: [
											{
												index: 0,
												delta: {
													role: "assistant",
													content: `tool finished: ${lastText.trim()}`,
												},
												finish_reason: null,
											},
										],
									}),
								);
								c.enqueue(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
								c.enqueue(encoder.encode("data: [DONE]\n\n"));
								c.close();
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				}

				if (last?.role === "user" && lastText.includes("run bash")) {
					const call = {
						index: 0,
						id: "call_bash_1",
						type: "function",
						function: {
							name: "bash",
							arguments: JSON.stringify({ command: "curl --version && echo gateway-ok" }),
						},
					};
					return new Response(
						new ReadableStream({
							start(c) {
								c.enqueue(
									sse({
										...base,
										choices: [
											{ index: 0, delta: { role: "assistant", tool_calls: [call] }, finish_reason: null },
										],
									}),
								);
								c.enqueue(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
								c.enqueue(encoder.encode("data: [DONE]\n\n"));
								c.close();
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				}

				return new Response(
					new ReadableStream({
						start(c) {
							c.enqueue(
								sse({
									...base,
									choices: [
										{
											index: 0,
											delta: {
												role: "assistant",
												content: delayedReply ? "delayed-completion" : `reply:${lastText.trim()}`,
											},
											finish_reason: null,
										},
									],
								}),
							);
							c.enqueue(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
							c.enqueue(encoder.encode("data: [DONE]\n\n"));
							c.close();
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});

		await Bun.write(
			path.join(agentDir, "models.yml"),
			[
				"providers:",
				"  fake:",
				`    baseUrl: http://127.0.0.1:${fakeModelServer.port}/v1`,
				"    auth: none",
				"    api: openai-completions",
				"    models:",
				"      - id: fake-model",
				"        name: Fake Model",
				"        reasoning: false",
				"",
			].join("\n"),
		);

		const catalogPath = path.join(dataDir, "catalog.json");
		await Bun.write(
			catalogPath,
			JSON.stringify({
				providers: [
					{
						id: "fake",
						name: "Fake",
						models: [{ id: "fake-model", name: "Fake Model", efforts: ["none", "low", "high"], fast: false }],
					},
				],
			}),
		);
	});

	afterEach(async () => {
		if (gateway) {
			await gateway.stop(true);
			gateway = undefined;
		}
		fakeModelServer.stop(true);
		fs.rmSync(tempRoot, { recursive: true, force: true });
	});

	function createConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
		return {
			host: "127.0.0.1",
			port: 0,
			dataDir,
			agentDir,
			managerKey,
			profileKeys: { labbot: "labbot-direct-secret-key-0123456789" },
			localProfiles: ["labbot"],
			maxBots: 2,
			maxTrash: 5,
			trashDays: 7,
			botStorageBytes: 10 * 1024 * 1024,
			sandboxAttachmentsDir: DEFAULT_SANDBOX_ATTACHMENTS,
			catalogPath: path.join(dataDir, "catalog.json"),
			sandboxBackend: "host-unsafe",
			dockerImage: "python:3.12-slim",
			...overrides,
		};
	}

	it("enforces auth, bot lifecycle quotas, chat sync tombstones, and file/media path isolation", async () => {
		const cfg = createConfig();
		gateway = startBotGateway(cfg, { catalog: new GatewayModelCatalog(cfg.catalogPath!) });
		const base = `http://127.0.0.1:${gateway.port}/m/v1`;
		const headers = {
			Authorization: `Bearer ${managerKey}`,
			"Content-Type": "application/json",
		};

		const health = await fetch(`${base}/health`);
		expect(health.status).toBe(200);
		expect(await health.json()).toEqual({ ok: true });

		const unauth = await fetch(`${base}/bots`);
		expect(unauth.status).toBe(401);

		// Create 2 bots up to limit, third must fail with 409 limit_reached
		const b1Res = await fetch(`${base}/bots`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				name: "Coder",
				role: " Dev ",
				sandboxed: true,
				modelProvider: "fake",
				modelId: "fake-model",
			}),
		});
		expect(b1Res.status).toBe(201);
		const b1 = (await b1Res.json()) as { id: string; sandboxed: boolean; role: string };
		expect(b1.sandboxed).toBe(true);
		expect(b1.role).toBe("Dev");

		const b2Res = await fetch(`${base}/bots`, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: "Writer", sandboxed: false }),
		});
		expect(b2Res.status).toBe(201);
		const b2 = (await b2Res.json()) as { id: string; sandboxed: boolean };

		const b3Res = await fetch(`${base}/bots`, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: "Overflow" }),
		});
		expect(b3Res.status).toBe(409);

		// Active bot cannot be purged directly without trashing first
		const prematurePurge = await fetch(`${base}/bots/${b2.id}?purge=1`, {
			method: "DELETE",
			headers,
		});
		expect(prematurePurge.status).toBe(409);

		// Trash -> restore -> trash -> purge
		expect((await fetch(`${base}/bots/${b2.id}`, { method: "DELETE", headers })).status).toBe(200);
		expect((await fetch(`${base}/bots/${b2.id}/restore`, { method: "POST", headers })).status).toBe(200);
		expect((await fetch(`${base}/bots/${b2.id}`, { method: "DELETE", headers })).status).toBe(200);
		expect((await fetch(`${base}/bots/${b2.id}?purge=1`, { method: "DELETE", headers })).status).toBe(200);

		// Conversation sync: newer edit wins and delete tombstone blocks older restore
		const chatUrl = `${base}/chats/${b1.id}/conv-sync-1`;
		const put1 = await fetch(chatUrl, {
			method: "PUT",
			headers,
			body: JSON.stringify({
				conversation: {
					id: "conv-sync-1",
					title: "First",
					created: 10,
					updated: 200,
					pinned: true,
					renamed: false,
				},
				messages: [{ role: "user", content: "hello" }],
			}),
		});
		expect(((await put1.json()) as { stored: boolean }).stored).toBe(true);

		const stalePut = await fetch(chatUrl, {
			method: "PUT",
			headers,
			body: JSON.stringify({
				conversation: { id: "conv-sync-1", title: "Stale", created: 10, updated: 100 },
				messages: [{ role: "user", content: "old" }],
			}),
		});
		expect(((await stalePut.json()) as { stored: boolean }).stored).toBe(false);

		const delChat = await fetch(chatUrl, { method: "DELETE", headers });
		expect(delChat.status).toBe(200);

		const resurrectAttempt = await fetch(chatUrl, {
			method: "PUT",
			headers,
			body: JSON.stringify({
				conversation: { id: "conv-sync-1", title: "Resurrect", created: 10, updated: 200 },
				messages: [{ role: "user", content: "hello" }],
			}),
		});
		expect(((await resurrectAttempt.json()) as { stored: boolean }).stored).toBe(false);

		// File upload sanitizes traversal names; media endpoint serves images inside bot workspace and blocks traversal
		const uploadRes = await fetch(`${base}/bots/${b1.id}/files`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${managerKey}`,
				"X-Filename": encodeURIComponent("../../secret/notes.txt"),
			},
			body: new TextEncoder().encode("safe attachment content"),
		});
		expect(uploadRes.status).toBe(201);
		const uploaded = (await uploadRes.json()) as { name: string; path: string; size: number };
		expect(uploaded.name).toBe("notes.txt");

		// Write a valid PNG into b1 workspace and verify /media serves it for b1, blocks b2 and blocks traversal
		const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		fs.writeFileSync(path.join(gateway.store.workspaceDir(b1.id), "plot.png"), pngBytes);
		const mediaOk = await fetch(`${base}/media?bot=${b1.id}&path=${encodeURIComponent("/workspace/plot.png")}`, {
			headers: { Authorization: `Bearer ${managerKey}` },
		});
		expect(mediaOk.status).toBe(200);
		expect(new Uint8Array(await mediaOk.arrayBuffer())).toEqual(pngBytes);

		const traversalRes = await fetch(
			`${base}/media?bot=${b1.id}&path=${encodeURIComponent("/workspace/../../gateway.db")}`,
			{ headers: { Authorization: `Bearer ${managerKey}` } },
		);
		expect(traversalRes.status).toBe(415);

		const crossBotRes = await fetch(
			`${base}/media?bot=labbot&path=${encodeURIComponent(path.join(gateway.store.workspaceDir(b1.id), "plot.png"))}`,
			{ headers: { Authorization: `Bearer ${managerKey}` } },
		);
		expect(crossBotRes.status).toBe(404);
	});

	it("keeps slow JSON replies and pending SSE approvals alive across idle periods", async () => {
		const cfg = createConfig();
		gateway = startBotGateway(cfg, { catalog: new GatewayModelCatalog(cfg.catalogPath!) });
		const base = `http://127.0.0.1:${gateway.port}/m/v1`;
		const headers = {
			Authorization: `Bearer ${managerKey}`,
			"Content-Type": "application/json",
		};
		const botRes = await fetch(`${base}/bots`, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: "SlowBot", sandboxed: true, modelProvider: "fake", modelId: "fake-model" }),
		});
		const bot = (await botRes.json()) as { id: string };
		const slowReply = await fetch(`${base}/bots/${bot.id}/chat/completions`, {
			method: "POST",
			headers: { ...headers, "X-Lab-Conversation-Id": "slow-json" },
			body: JSON.stringify({ stream: false, messages: [{ role: "user", content: "delayed reply" }] }),
		});
		expect(slowReply.status).toBe(200);
		expect(
			((await slowReply.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content,
		).toBe("delayed-completion");

		const abort = new AbortController();
		const deadline = setTimeout(() => abort.abort(), 25_000);
		try {
			const response = await fetch(`${base}/bots/${bot.id}/chat/completions`, {
				method: "POST",
				headers: { ...headers, "X-Lab-Conversation-Id": "idle-approval" },
				body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "run bash after waiting" }] }),
				signal: abort.signal,
			});
			const reader = response.body!.getReader();
			const decoder = new TextDecoder();
			let text = "";
			let approval: { run_id: string; request_id: string } | undefined;
			while (!approval) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error("reply ended before approval");
				text += decoder.decode(chunk.value, { stream: true });
				for (const block of text.split("\n\n")) {
					if (!block.startsWith("event: approval.request")) continue;
					const data = block.split("\n").find(line => line.startsWith("data: "));
					if (data) approval = JSON.parse(data.slice(6));
				}
			}
			const waitingSince = Date.now();
			let whileWaiting = "";
			while (!/(?:^|\n):[^\n]*\n\n/.test(whileWaiting)) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error("reply ended while waiting for approval");
				whileWaiting += decoder.decode(chunk.value, { stream: true });
			}
			await Bun.sleep(Math.max(0, 12_000 - (Date.now() - waitingSince)));
			const approved = await fetch(`${base}/bots/${bot.id}/runs/${approval.run_id}/approval`, {
				method: "POST",
				headers,
				body: JSON.stringify({ choice: "once", request_id: approval.request_id }),
			});
			expect(approved.status).toBe(200);
			text += whileWaiting;
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				text += decoder.decode(chunk.value, { stream: true });
			}
			expect(text).toContain("gateway-ok");
			expect(text).toContain("data: [DONE]");
		} finally {
			clearTimeout(deadline);
			abort.abort();
		}
	}, 45_000);

	it("streams SSE chat, seeds history without duplication, bridges structured approvals per conversation, and connects PTY shell", async () => {
		const cfg = createConfig();
		gateway = startBotGateway(cfg, { catalog: new GatewayModelCatalog(cfg.catalogPath!) });
		const base = `http://127.0.0.1:${gateway.port}/m/v1`;
		const headers = {
			Authorization: `Bearer ${managerKey}`,
			"Content-Type": "application/json",
		};

		const botRes = await fetch(`${base}/bots`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				name: "SandboxBot",
				sandboxed: true,
				modelProvider: "fake",
				modelId: "fake-model",
			}),
		});
		const bot = (await botRes.json()) as { id: string };

		// Turn 1: seeded history + fresh user prompt with X-Lab-Conversation-Id: conv-a
		const turn1 = await fetch(`${base}/bots/${bot.id}/chat/completions`, {
			method: "POST",
			headers: { ...headers, "X-Lab-Conversation-Id": "conv-a" },
			body: JSON.stringify({
				stream: true,
				messages: [
					{ role: "user", content: "seed question" },
					{ role: "assistant", content: "seed answer" },
					{ role: "user", content: "hello turn 1" },
				],
			}),
		});
		expect(turn1.status).toBe(200);
		const turn1Text = await turn1.text();
		const turn1Reply = turn1Text
			.split("\n")
			.filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
			.map(line => JSON.parse(line.slice(6)) as { choices?: Array<{ delta?: { content?: string } }> })
			.flatMap(chunk => chunk.choices ?? [])
			.map(choice => choice.delta?.content ?? "")
			.join("");
		expect(turn1Text).toContain("data: [DONE]");
		expect(recordedRequests).toHaveLength(1);
		expect(recordedRequests[0]!.messages.map(m => m.role)).toEqual(["user", "assistant", "user"]);
		expect(recordedRequests[0]!.messages[1]!.text).toBe("seed answer");

		// Turn 2 on conv-a: simulate Android tail-window (only last 2 messages in prior history) + tool call requiring approval
		const turn2Promise = fetch(`${base}/bots/${bot.id}/chat/completions`, {
			method: "POST",
			headers: { ...headers, "X-Lab-Conversation-Id": "conv-a" },
			body: JSON.stringify({
				stream: true,
				messages: [
					{ role: "user", content: "hello turn 1" },
					{ role: "assistant", content: turn1Reply },
					{ role: "user", content: "please run bash now" },
				],
			}),
		});

		const turn2Res = await turn2Promise;
		expect(turn2Res.status).toBe(200);
		const reader = turn2Res.body!.getReader();
		const decoder = new TextDecoder();
		let accumulated = "";
		let approvalEvent: {
			run_id: string;
			request_id: string;
			pattern_key: string;
			choices: string[];
		} | null = null;

		while (!approvalEvent) {
			const { value, done } = await reader.read();
			if (done) break;
			accumulated += decoder.decode(value, { stream: true });
			for (const block of accumulated.split("\n\n")) {
				if (block.includes("event: approval.request")) {
					const dataLine = block.split("\n").find(l => l.startsWith("data: "));
					if (dataLine) {
						approvalEvent = JSON.parse(dataLine.slice(6));
					}
				}
			}
		}

		expect(approvalEvent).not.toBeNull();
		expect(approvalEvent!.pattern_key).toBe("lablink-download");
		expect(approvalEvent!.choices).toEqual(["once", "session", "deny"]);

		// Wrong request_id or unoffered choice ("always") must be rejected
		const badChoice = await fetch(`${base}/bots/${bot.id}/runs/${approvalEvent!.run_id}/approval`, {
			method: "POST",
			headers,
			body: JSON.stringify({ choice: "always", request_id: approvalEvent!.request_id }),
		});
		expect(badChoice.status).toBe(400);

		// Approve for this session ("conv-a")
		const okApprove = await fetch(`${base}/bots/${bot.id}/runs/${approvalEvent!.run_id}/approval`, {
			method: "POST",
			headers,
			body: JSON.stringify({ choice: "session", request_id: approvalEvent!.request_id }),
		});
		expect(okApprove.status).toBe(200);

		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			accumulated += decoder.decode(value, { stream: true });
		}
		expect(accumulated).toContain("event: hermes.tool.progress");
		expect(accumulated).toContain("event: lablink.tool");
		expect(accumulated).toContain("gateway-ok");
		expect(accumulated).toContain("tool finished:");
		expect(accumulated).toContain("data: [DONE]");

		// Verify history was reused without duplicating prior messages (seed + turn1 + turn2 = 5 messages before tool result)
		expect(recordedRequests[1]!.messages.map(m => m.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
		]);

		// Turn 3 on conv-a: standing "session" grant auto-approves bash without emitting approval.request
		const turn3Res = await fetch(`${base}/bots/${bot.id}/chat/completions`, {
			method: "POST",
			headers: { ...headers, "X-Lab-Conversation-Id": "conv-a" },
			body: JSON.stringify({
				stream: true,
				messages: [{ role: "user", content: "run bash second time" }],
			}),
		});
		const turn3Text = await turn3Res.text();
		expect(turn3Text).not.toContain("event: approval.request");
		expect(turn3Text).toContain("tool finished:");

		// Turn on a DIFFERENT conversation (conv-b) must NOT inherit conv-a's session grant; test aborting it via disconnect
		const abortCtrl = new AbortController();
		const convBRes = await fetch(`${base}/bots/${bot.id}/chat/completions`, {
			method: "POST",
			headers: { ...headers, "X-Lab-Conversation-Id": "conv-b" },
			body: JSON.stringify({
				stream: true,
				messages: [{ role: "user", content: "run bash in conv-b" }],
			}),
			signal: abortCtrl.signal,
		});
		const convBReader = convBRes.body!.getReader();
		let convBText = "";
		while (!convBText.includes("event: approval.request")) {
			const { value, done } = await convBReader.read();
			if (done) break;
			convBText += decoder.decode(value, { stream: true });
		}
		expect(convBText).toContain("event: approval.request");
		abortCtrl.abort();

		// WebSocket PTY shell: works for sandboxed bot, strips managerKey from env
		const wsOutput = Promise.withResolvers<string>();
		let collectedPty = "";
		const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/m/v1/bots/${bot.id}/shell?cols=90&rows=25`, {
			headers: { Authorization: `Bearer ${managerKey}` },
		});
		ws.binaryType = "arraybuffer";
		ws.onopen = () => {
			ws.send(JSON.stringify({ resize: [100, 30] }));
			ws.send('printf "PTY_OK:%s:END\\n" "$MANAGER_KEY"\nexit\n');
		};
		ws.onmessage = ev => {
			if (ev.data instanceof ArrayBuffer) {
				collectedPty += new TextDecoder().decode(ev.data);
				if (collectedPty.includes("PTY_OK::END")) {
					wsOutput.resolve(collectedPty);
				}
			}
		};
		const ptyResult = await wsOutput.promise;
		expect(ptyResult).toContain("PTY_OK::END");
		ws.close();
	}, 90_000);
});
