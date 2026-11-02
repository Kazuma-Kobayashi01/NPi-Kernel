import { describe, expect, it } from "bun:test";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	SimpleStreamOptions,
	Tool,
	ToolChoice,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { withGenerativeUiToolWire } from "../src/generative-ui/tool-wire";

const model = {} as Model;

function tool(name: string): Tool {
	return { name, description: name, parameters: { type: "object", properties: {} } };
}

function message(name = "ui_present"): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "ui-1", name, arguments: { title: "Example" } },
			{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "file.txt" } },
		],
		api: "openai-completions",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
}

function capture(source = new AssistantMessageEventStream()): {
	fn: StreamFn;
	calls: { context: Context; options?: SimpleStreamOptions }[];
	source: AssistantMessageEventStream;
} {
	const calls: { context: Context; options?: SimpleStreamOptions }[] = [];
	return {
		fn: (_model, context, options) => {
			calls.push({ context, options });
			return source;
		},
		calls,
		source,
	};
}

function expectLogical(value: AssistantMessage): void {
	expect(value.content[0]).toMatchObject({ type: "toolCall", name: "ui.present" });
	expect(value.content[1]).toMatchObject({ type: "toolCall", name: "read" });
}

describe("generative UI provider wire boundary", () => {
	it("encodes declarations and replay without mutating the logical context", () => {
		const context: Context = {
			systemPrompt: ["test"],
			tools: [tool("ui.present"), tool("read")],
			inactiveTools: [tool("ui.present")],
			messages: [
				message("ui.present"),
				{
					role: "toolResult",
					toolCallId: "ui-1",
					toolName: "ui.present",
					content: [],
					isError: false,
					timestamp: 0,
				},
				{ role: "user", content: "next", timestamp: 1 },
			],
		};
		const original = structuredClone(context);
		const base = capture();
		withGenerativeUiToolWire(base.fn)(model, context);
		const wire = base.calls[0].context;
		expect(wire.tools?.map(entry => entry.name)).toEqual(["ui_present", "read"]);
		for (const entry of wire.tools ?? []) expect(entry.name).toMatch(/^[a-zA-Z0-9_-]+$/);
		expect(wire.tools?.[0].parameters).toBe(context.tools?.[0].parameters);
		expect(wire.tools?.[1]).toBe(context.tools?.[1]);
		expect(wire.inactiveTools?.[0].name).toBe("ui_present");
		expect(wire.messages[0]).toMatchObject({ content: [{ name: "ui_present" }, { name: "read" }] });
		expect(wire.messages[1]).toMatchObject({ toolName: "ui_present" });
		expect(wire.messages[2]).toBe(context.messages[2]);
		expect(context).toEqual(original);
		base.source.end(message());
	});

	it("encodes history even after ui.present leaves the active tool set", () => {
		const base = capture();
		withGenerativeUiToolWire(base.fn)(model, { tools: [tool("read")], messages: [message("ui.present")] });
		expect(base.calls[0].context.messages[0]).toMatchObject({ content: [{ name: "ui_present" }, { name: "read" }] });
		base.source.end(message());
	});

	for (const choice of [
		{ type: "function", name: "ui.present" },
		{ type: "function", function: { name: "ui.present" } },
		{ type: "tool", name: "ui.present" },
	] satisfies ToolChoice[]) {
		it(`encodes forced choice ${JSON.stringify(choice)}`, () => {
			const base = capture();
			const options: SimpleStreamOptions = { toolChoice: choice, temperature: 0.5 };
			const original = structuredClone(options);
			withGenerativeUiToolWire(base.fn)(model, { messages: [] }, options);
			expect(base.calls[0].options?.toolChoice).toEqual(
				"function" in choice
					? { type: "function", function: { name: "ui_present" } }
					: { ...choice, name: "ui_present" },
			);
			expect(base.calls[0].options?.temperature).toBe(0.5);
			expect(options).toEqual(original);
			base.source.end(message());
		});
	}

	it("passes unrelated context, options and the original stream through by identity", () => {
		const base = capture();
		const context: Context = {
			tools: [tool("ui_present"), tool("other.present")],
			messages: [message("other.present")],
		};
		const options: SimpleStreamOptions = { toolChoice: { type: "function", name: "ui_present" } };
		expect(withGenerativeUiToolWire(base.fn)(model, context, options)).toBe(base.source);
		expect(base.calls[0]).toEqual({ context, options });
		expect(base.calls[0].context).toBe(context);
		expect(base.calls[0].options).toBe(options);
	});

	it("preserves an asynchronous source promise on the no-conversion path", () => {
		const promise = Promise.resolve(new AssistantMessageEventStream());
		expect(withGenerativeUiToolWire(() => promise)(model, { messages: [] })).toBe(promise);
	});

	it("rejects ambiguous declarations before the provider is invoked", () => {
		const base = capture();
		expect(() =>
			withGenerativeUiToolWire(base.fn)(model, {
				tools: [tool("ui.present"), tool("ui_present")],
				messages: [],
			}),
		).toThrow("Tool name collision");
		expect(base.calls).toHaveLength(0);
	});

	it("decodes every partial event, detached toolcall_end, done and result", async () => {
		const base = capture();
		const stream = await withGenerativeUiToolWire(base.fn)(model, { tools: [tool("ui.present")], messages: [] });
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: message() },
			{ type: "toolcall_start", contentIndex: 0, partial: message() },
			{ type: "toolcall_delta", contentIndex: 0, delta: "{}", partial: message() },
			{ type: "text_start", contentIndex: 0, partial: message() },
			{ type: "text_delta", contentIndex: 0, delta: "text", partial: message() },
			{ type: "text_end", contentIndex: 0, content: "text", partial: message() },
			{ type: "thinking_start", contentIndex: 0, partial: message() },
			{ type: "thinking_delta", contentIndex: 0, delta: "thinking", partial: message() },
			{ type: "thinking_end", contentIndex: 0, content: "thinking", partial: message() },
			{
				type: "image_end",
				contentIndex: 0,
				content: { type: "image", data: "", mimeType: "image/png" },
				partial: message(),
			},
			{
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { type: "toolCall", id: "detached", name: "ui_present", arguments: {} },
				partial: message(),
			},
			{ type: "done", reason: "toolUse", message: message() },
		];
		for (const event of events) base.source.push(event);
		base.source.end();
		let count = 0;
		for await (const event of stream) {
			count++;
			if ("partial" in event) expectLogical(event.partial);
			if (event.type === "toolcall_end") expect(event.toolCall.name).toBe("ui.present");
			if (event.type === "done") expectLogical(event.message);
		}
		expect(count).toBe(events.length);
		expectLogical(await stream.result());
	});

	it("decodes terminal errors and result-only streams from asynchronous providers", async () => {
		for (const terminal of ["error", "result-only"] as const) {
			const source = new AssistantMessageEventStream();
			const stream = await withGenerativeUiToolWire(() => Promise.resolve(source))(model, {
				tools: [tool("ui.present")],
				messages: [],
			});
			const final = message();
			if (terminal === "error") {
				final.stopReason = "aborted";
				source.push({ type: "error", reason: "aborted", error: final });
				source.end();
			} else source.end(final);
			for await (const event of stream) if (event.type === "error") expectLogical(event.error);
			expectLogical(await stream.result());
		}
	});

	it("propagates provider stream failures to both consumers", async () => {
		const base = capture();
		const stream = await withGenerativeUiToolWire(base.fn)(model, { tools: [tool("ui.present")], messages: [] });
		const error = new Error("transport failed");
		base.source.fail(error);
		await expect(stream.result()).rejects.toBe(error);
		const consume = async () => {
			for await (const _event of stream) {
				/* Drain provider events. */
			}
		};
		await expect(consume()).rejects.toBe(error);
	});
});
