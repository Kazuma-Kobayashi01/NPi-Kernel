import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { readJsonl, TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { UiPresentDetails } from "../src/modes/rpc/generative-ui";

interface Frame {
	type: string;
	id?: string;
	command?: string;
	success?: boolean;
	data?: unknown;
	error?: string;
	status?: string;
	message?: unknown;
}
function startFixture(root: string, file?: string) {
	const process = Bun.spawn(
		[
			globalThis.process.execPath,
			path.join(import.meta.dir, "fixtures/generative-ui-rpc-agent.ts"),
			root,
			...(file ? [file] : []),
		],
		{
			cwd: root,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				PATH: globalThis.process.env.PATH,
				HOME: root,
				PI_CODING_AGENT_DIR: path.join(root, "agent"),
				PI_NO_TITLE: "1",
			},
		},
	);
	const frames: Frame[] = [];
	const listeners = new Set<() => void>();
	const reader = (async () => {
		for await (const frame of readJsonl<Frame>(process.stdout)) {
			frames.push(frame);
			for (const listener of listeners) listener();
		}
	})();
	const waitFor = async (predicate: (frame: Frame) => boolean): Promise<Frame> => {
		const found = frames.find(predicate);
		if (found) return found;
		const pending = Promise.withResolvers<Frame>();
		const listener = () => {
			const frame = frames.find(predicate);
			if (frame) {
				listeners.delete(listener);
				pending.resolve(frame);
			}
		};
		listeners.add(listener);
		return withTimeout(pending.promise, 15000, "Generative UI RPC fixture did not emit the expected frame");
	};
	let nextId = 0;
	return {
		frames,
		waitFor,
		async request(command: Record<string, unknown>): Promise<Frame> {
			const id = `request-${++nextId}`;
			process.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
			await process.stdin.flush();
			return waitFor(frame => frame.type === "response" && frame.id === id);
		},
		async stop() {
			process.stdin.end();
			await process.exited;
			await reader;
		},
	};
}

describe("Generative UI real RPC", () => {
	it("advertises alongside host tools, persists fullHistory, dispatches a model tool call and restores consumed cards", async () => {
		using root = TempDir.createSync("omp-generative-ui-rpc-");
		const client = startFixture(root.path());
		let file: string;
		let card: UiPresentDetails;
		try {
			await client.waitFor(frame => frame.type === "ready");
			expect((await client.request({ type: "set_generative_ui", enabled: true })).success).toBe(true);
			expect(
				(
					await client.request({
						type: "set_host_tools",
						tools: [
							{
								name: "host_echo",
								description: "Echo",
								label: "Echo",
								parameters: { type: "object", properties: {}, additionalProperties: false },
							},
						],
					})
				).success,
			).toBe(true);
			expect((await client.request({ type: "prompt", message: "show-ui batch" })).success).toBe(true);
			await client.waitFor(frame => frame.type === "prompt_result" && frame.id === "request-3");
			const history = await client.request({ type: "get_messages", fullHistory: true });
			const data = history.data as { messages: AgentMessage[] };
			const present = data.messages.find(
				message => message.role === "custom" && message.customType === "ui.present",
			);
			if (!present || present.role !== "custom") throw new Error("Missing persisted UI card");
			card = present.details as UiPresentDetails;
			expect(card.schema.components).toHaveLength(3);
			expect(card).toMatchObject({ status: "waiting_input", rendered: false, task_id: "ui-call-1" });
			expect(await Bun.file(path.join(root.path(), "side-effect.txt")).exists()).toBe(false);
			expect(client.frames.filter(frame => frame.type === "notice" && String(frame.message).startsWith("offline-model-request:"))).toHaveLength(1);
			const waiting = await client.request({ type: "get_state" });
			const waitingData = waiting.data as { pendingUi: unknown };
			expect(waitingData.pendingUi).toMatchObject({ ui_id: card.ui_id, status: "waiting_input", rendered: false });
			for (let attempt = 0; attempt < 2; attempt++) {
				const rendered = await client.request({ type: "render_ui", ui_id: card.ui_id, session_id: card.session_id });
				expect(rendered.success).toBe(true);
				expect(rendered.data).toMatchObject({ rendered: true, status: "waiting_input" });
			}
			expect(
				(
					await client.request({
						type: "submit_ui",
						ui_id: card.ui_id,
						session_id: "wrong",
						values: { concurrency: 8, reasoning: "high" },
					})
				).success,
			).toBe(false);
			expect(
				(
					await client.request({
						type: "submit_ui",
						ui_id: card.ui_id,
						session_id: card.session_id,
						values: { concurrency: 99, reasoning: "high" },
					})
				).success,
			).toBe(false);
			const submit = {
				type: "submit_ui",
				ui_id: card.ui_id,
				session_id: card.session_id,
				values: { concurrency: 8, reasoning: "high" },
			};
			const [accepted, duplicate] = await Promise.all([client.request(submit), client.request(submit)]);
			expect(accepted.success).toBe(true);
			expect(duplicate.success).toBe(false);
			expect(accepted.data).toMatchObject({ ui_id: card.ui_id, session_id: card.session_id, status: "submitted" });
			await client.waitFor(frame => frame.type === "prompt_result" && frame.id === accepted.id);
			const after = await client.request({ type: "get_messages", fullHistory: true });
			const afterData = after.data as { messages: AgentMessage[] };
			expect(
				afterData.messages.filter(message => message.role === "custom" && message.customType === "ui.submit"),
			).toHaveLength(1);
			expect(JSON.stringify(afterData.messages)).toContain("Received submitted parameters");
			expect(client.frames.filter(frame => frame.type === "notice" && String(frame.message).startsWith("offline-model-request:"))).toHaveLength(2);
			const state = await client.request({ type: "get_state" });
			const stateData = state.data as { sessionFile: string };
			file = stateData.sessionFile;
		} finally {
			await client.stop();
		}
		const restored = startFixture(root.path(), file!);
		try {
			await restored.waitFor(frame => frame.type === "ready");
			await restored.request({ type: "set_generative_ui", enabled: true });
			const history = await restored.request({ type: "get_messages", fullHistory: true });
			const data = history.data as { messages: AgentMessage[] };
			expect(
				data.messages.filter(message => message.role === "custom" && message.customType === "ui.present"),
			).toHaveLength(1);
			expect(
				data.messages.filter(message => message.role === "custom" && message.customType === "ui.submit"),
			).toHaveLength(1);
			expect(
				(
					await restored.request({
						type: "submit_ui",
						ui_id: card!.ui_id,
						session_id: card!.session_id,
						values: { concurrency: 8, reasoning: "high" },
					})
				).success,
			).toBe(false);
			await restored.request({ type: "new_session" });
			expect(
				(
					await restored.request({
						type: "submit_ui",
						ui_id: card!.ui_id,
						session_id: card!.session_id,
						values: { concurrency: 8, reasoning: "high" },
					})
				).success,
			).toBe(false);
		} finally {
			await restored.stop();
		}
	}, 60000);

	it("restores waiting input, cancels without a request, and expires a replaced task", async () => {
		using root = TempDir.createSync("omp-ui-rpc-cancel-");
		let client = startFixture(root.path());
		let file: string;
		let card: { ui_id: string; session_id: string };
		try {
			await client.waitFor(frame => frame.type === "ready");
			await client.request({ type: "set_generative_ui", enabled: true });
			const prompt = await client.request({ type: "prompt", message: "show-ui" });
			await client.waitFor(frame => frame.type === "prompt_result" && frame.id === prompt.id);
			const state = await client.request({ type: "get_state" });
			const stateData = state.data as { sessionFile: string; pendingUi: typeof card };
			file = stateData.sessionFile;
			card = stateData.pendingUi;
		} finally { await client.stop(); }
		client = startFixture(root.path(), file!);
		try {
			await client.waitFor(frame => frame.type === "ready");
			await client.request({ type: "set_generative_ui", enabled: true });
			const restored = await client.request({ type: "get_state" });
			const restoredData = restored.data as { pendingUi: unknown };
			expect(restoredData.pendingUi).toMatchObject(card!);
			const cancelled = await client.request({ type: "cancel_ui", ...card! });
			expect(cancelled.success).toBe(true);
			expect(cancelled.data).toMatchObject({ status: "cancelled" });
			const render = await client.request({ type: "render_ui", ...card! });
			expect(render.success).toBe(true);
			expect(render.data).toMatchObject({ status: "cancelled" });
			expect((await client.request({ type: "submit_ui", ...card!, values: { concurrency: 8, reasoning: "high" } })).success).toBe(false);
			expect(client.frames.filter(frame => frame.type === "notice" && String(frame.message).startsWith("offline-model-request:"))).toHaveLength(0);
			const next = await client.request({ type: "prompt", message: "show-ui" });
			await client.waitFor(frame => frame.type === "prompt_result" && frame.id === next.id);
			const waiting = await client.request({ type: "get_state" });
			const waitingData = waiting.data as { pendingUi: typeof card };
			const replaced = waitingData.pendingUi;
			const newTask = await client.request({ type: "prompt", message: "a different task" });
			await client.waitFor(frame => frame.type === "prompt_result" && frame.id === newTask.id);
			expect((await client.request({ type: "submit_ui", ...replaced, values: { concurrency: 8, reasoning: "high" } })).success).toBe(false);
		} finally { await client.stop(); }
	}, 60000);

	it("returns invalid presentations as ordinary tool errors and does not force forms for prose tasks", async () => {
		using root = TempDir.createSync("omp-ui-rpc-invalid-");
		const client = startFixture(root.path());
		try {
			await client.waitFor(frame => frame.type === "ready");
			await client.request({ type: "set_generative_ui", enabled: true });
			for (const policy of ["aggressive", "minimal", "standard"] as const) {
				const updated = await client.request({ type: "set_interaction_policy", policy });
				expect(updated.success).toBe(true);
				expect(updated.data).toEqual({ policy });
			}
			expect((await client.request({ type: "set_interaction_policy", policy: "invalid" })).success).toBe(false);
			let expectedRequests = 0;
			for (const [message, requests] of [
				["invalid-ui unknown", 2],
				["invalid-ui out-of-range", 2],
				["Explain this idea in prose; do not use tools", 1],
				["Discuss possibilities in an open-ended paragraph", 1],
			] as const) {
				const prompt = await client.request({ type: "prompt", message });
				expect(prompt.success).toBe(true);
				await client.waitFor(frame => frame.type === "prompt_result" && frame.id === prompt.id);
				expectedRequests += requests;
				expect(client.frames.filter(frame => frame.type === "notice" && String(frame.message).startsWith("offline-model-request:"))).toHaveLength(expectedRequests);
				const state = await client.request({ type: "get_state" });
				const stateData = state.data as { pendingUi: unknown };
				expect(stateData.pendingUi).toBeNull();
			}
			const history = await client.request({ type: "get_messages", fullHistory: true });
			const data = history.data as { messages: AgentMessage[] };
			expect(data.messages.filter(message => message.role === "custom" && message.customType === "ui.present")).toHaveLength(0);
			expect(data.messages.filter(message => message.role === "toolResult" && message.toolName === "ui.present" && message.isError)).toHaveLength(2);
		} finally { await client.stop(); }
	}, 60000);
});
