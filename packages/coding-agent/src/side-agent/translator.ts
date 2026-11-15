/**
 * ACP session updates → NPi agent events, so a side agent's turn reaches an RPC host (Desktop) exactly
 * like one of NPi's own: user message, streamed assistant messages, tool executions, tool results.
 *
 * Each ACP tool call closes the assistant message it belongs to (stop reason `toolUse`) and opens a
 * tool execution; the next text starts a fresh assistant message. That keeps the order NPi hosts rely
 * on — an assistant message ends before the results of the tools it called — even though ACP streams
 * text, tool calls and their results interleaved.
 */
import type { AgentEvent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, StopReason, ToolResultMessage, Usage, UserMessage } from "@oh-my-pi/pi-ai";
import type { ContentBlock, SessionUpdate, StopReason as AcpStopReason, ToolCallContent } from "@oh-my-pi/pi-utils/acp";

/** `api` stamped on side agent messages; hosts read it only for display. */
export const SIDE_AGENT_API = "side-agent";

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Text NPi can show for one ACP content block. */
export function contentText(block: ContentBlock): string {
	switch (block.type) {
		case "text":
			return block.text;
		case "resource_link":
			return block.title ?? block.name ?? block.uri;
		case "resource":
			return "text" in block.resource ? block.resource.text : block.resource.uri;
		default:
			return "";
	}
}

/** A tool call's output as text, including diffs (as `path` plus new text) and terminal references. */
function toolOutputText(content: ToolCallContent[] | null | undefined): string {
	const parts: string[] = [];
	for (const item of content ?? []) {
		if (item.type === "content") parts.push(contentText(item.content));
		else if (item.type === "diff") parts.push(`${item.path}\n${item.newText}`);
	}
	return parts.filter(Boolean).join("\n\n");
}

function stopReasonOf(reason: AcpStopReason): StopReason {
	switch (reason) {
		case "cancelled":
			return "aborted";
		case "max_tokens":
			return "length";
		case "refusal":
			return "error";
		default:
			return "stop";
	}
}

interface OpenTool {
	name: string;
	args: Record<string, unknown>;
	content: ToolCallContent[];
	locations: unknown;
}

export class SideAgentTranscript {
	/** Every finished message, oldest first: what `get_messages` returns. */
	readonly messages: AgentMessage[] = [];
	#provider: string;
	#model: string;
	#assistant: AssistantMessage | undefined;
	/** Kind of the block being streamed at the end of {@link #assistant}. */
	#streaming: "text" | "thinking" | undefined;
	#tools = new Map<string, OpenTool>();
	#toolResults: ToolResultMessage[] = [];
	#running = false;

	/** `provider` is the agent id; `model` what the agent reports as its model, shown on messages. */
	constructor(provider: string, model: string) {
		this.#provider = provider;
		this.#model = model;
	}

	get running(): boolean {
		return this.#running;
	}

	set model(model: string) {
		this.#model = model;
	}

	/** Opens a turn with the user's message. */
	beginTurn(text: string): AgentEvent[] {
		this.#running = true;
		this.#toolResults = [];
		const user: UserMessage = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
		this.messages.push(user);
		return [
			{ type: "agent_start" },
			{ type: "turn_start" },
			{ type: "message_start", message: user },
			{ type: "message_end", message: user },
		];
	}

	/** Events for one ACP update; updates that are not transcript content return nothing. */
	apply(update: SessionUpdate): AgentEvent[] {
		if (!this.#running) return [];
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
				return this.#appendStream("text", contentText(update.content));
			case "agent_thought_chunk":
				return this.#appendStream("thinking", contentText(update.content));
			case "tool_call": {
				const events = this.#closeAssistant("toolUse");
				const name = update.name ?? update.kind ?? "tool";
				const raw = update.rawInput;
				const args: Record<string, unknown> = {
					title: update.title,
					...(raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}),
				};
				const call: AssistantMessage = this.#newAssistant();
				call.content.push({ type: "toolCall", id: update.toolCallId, name, arguments: args });
				call.stopReason = "toolUse";
				this.messages.push(call);
				this.#tools.set(update.toolCallId, {
					name,
					args,
					content: update.content ?? [],
					locations: update.locations,
				});
				events.push(
					{ type: "message_start", message: call },
					{ type: "message_end", message: call },
					{ type: "tool_execution_start", toolCallId: update.toolCallId, toolName: name, args },
				);
				if (update.status === "completed" || update.status === "failed") {
					events.push(...this.#finishTool(update.toolCallId, update.status === "failed"));
				}
				return events;
			}
			case "tool_call_update": {
				const tool = this.#tools.get(update.toolCallId);
				if (!tool) return [];
				if (update.content) tool.content = update.content;
				if (update.locations) tool.locations = update.locations;
				if (update.status === "completed" || update.status === "failed") {
					return this.#finishTool(update.toolCallId, update.status === "failed", update.rawOutput);
				}
				const partial = toolOutputText(tool.content);
				if (!partial) return [];
				return [
					{
						type: "tool_execution_update",
						toolCallId: update.toolCallId,
						toolName: tool.name,
						args: tool.args,
						partialResult: { content: [{ type: "text", text: partial }] },
					},
				];
			}
			default:
				return [];
		}
	}

	/**
	 * Closes the turn: the open assistant message ends with the agent's stop reason, tools still running
	 * end as errors (cancelled or abandoned), and the run ends. `error` marks a turn that failed outright.
	 */
	endTurn(reason: AcpStopReason, error?: string): AgentEvent[] {
		if (!this.#running) return [];
		const stop: StopReason = error ? "error" : stopReasonOf(reason);
		const events: AgentEvent[] = [];
		for (const id of this.#tools.keys()) events.push(...this.#finishTool(id, true));
		if (!this.#assistant && (error || stop !== "stop")) {
			// a turn that produced no text still needs a closing assistant message to carry its outcome
			this.#assistant = this.#newAssistant();
			events.push({ type: "message_start", message: this.#assistant });
		}
		const last = this.#assistant;
		if (last && error) last.errorMessage = error;
		events.push(...this.#closeAssistant(stop));
		const final = last ?? this.messages.at(-1);
		this.#running = false;
		if (final) events.push({ type: "turn_end", message: final, toolResults: this.#toolResults });
		events.push({ type: "agent_end", messages: this.messages });
		return events;
	}

	#newAssistant(): AssistantMessage {
		return {
			role: "assistant",
			content: [],
			api: SIDE_AGENT_API,
			provider: this.#provider,
			model: this.#model,
			usage: zeroUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	#appendStream(kind: "text" | "thinking", delta: string): AgentEvent[] {
		if (!delta) return [];
		const events: AgentEvent[] = [];
		let message = this.#assistant;
		if (!message) {
			message = this.#newAssistant();
			this.#assistant = message;
			this.#streaming = undefined;
			events.push({ type: "message_start", message });
		}
		if (this.#streaming !== kind) {
			this.#closeBlock(message, events);
			message.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
			this.#streaming = kind;
			const contentIndex = message.content.length - 1;
			events.push({
				type: "message_update",
				message,
				assistantMessageEvent:
					kind === "text"
						? { type: "text_start", contentIndex, partial: message }
						: { type: "thinking_start", contentIndex, partial: message },
			});
		}
		const contentIndex = message.content.length - 1;
		const block = message.content[contentIndex];
		if (block?.type === "text") block.text += delta;
		else if (block?.type === "thinking") block.thinking += delta;
		events.push({
			type: "message_update",
			message,
			assistantMessageEvent:
				kind === "text"
					? { type: "text_delta", contentIndex, delta, partial: message }
					: { type: "thinking_delta", contentIndex, delta, partial: message },
		});
		return events;
	}

	/** Emits the `*_end` for the block being streamed, if any. */
	#closeBlock(message: AssistantMessage, events: AgentEvent[]): void {
		const contentIndex = message.content.length - 1;
		const block = message.content[contentIndex];
		if (this.#streaming === "text" && block?.type === "text") {
			events.push({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "text_end", contentIndex, content: block.text, partial: message },
			});
		} else if (this.#streaming === "thinking" && block?.type === "thinking") {
			events.push({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "thinking_end", contentIndex, content: block.thinking, partial: message },
			});
		}
		this.#streaming = undefined;
	}

	#closeAssistant(stop: StopReason): AgentEvent[] {
		const message = this.#assistant;
		if (!message) return [];
		const events: AgentEvent[] = [];
		this.#closeBlock(message, events);
		message.stopReason = stop;
		message.completedAt = Date.now();
		this.#assistant = undefined;
		this.messages.push(message);
		events.push({ type: "message_end", message });
		return events;
	}

	#finishTool(toolCallId: string, isError: boolean, rawOutput?: unknown): AgentEvent[] {
		const tool = this.#tools.get(toolCallId);
		if (!tool) return [];
		this.#tools.delete(toolCallId);
		let text = toolOutputText(tool.content);
		if (!text && rawOutput !== undefined && rawOutput !== null) {
			text = typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput, null, 2);
		}
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId,
			toolName: tool.name,
			content: text ? [{ type: "text", text }] : [],
			details: { content: tool.content, locations: tool.locations },
			isError,
			timestamp: Date.now(),
		};
		this.messages.push(result);
		this.#toolResults.push(result);
		return [
			{
				type: "tool_execution_end",
				toolCallId,
				toolName: tool.name,
				result: { content: result.content, details: result.details },
				isError,
			},
			{ type: "message_start", message: result },
			{ type: "message_end", message: result },
		];
	}
}
