import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, SimpleStreamOptions, Tool, ToolChoice } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

const LOGICAL_NAME = "ui.present";
const WIRE_NAME = "ui_present";

function encodeTools(tools: Tool[] | undefined): Tool[] | undefined {
	if (tools) {
		for (let index = 0; index < tools.length; index++) {
			if (tools[index].name === LOGICAL_NAME) {
				return tools.map(tool => (tool.name === LOGICAL_NAME ? { ...tool, name: WIRE_NAME } : tool));
			}
		}
	}
	return tools;
}

function encodeChoice(choice: ToolChoice | undefined): ToolChoice | undefined {
	if (typeof choice !== "object") return choice;
	if ("function" in choice && choice.function.name === LOGICAL_NAME) {
		return { ...choice, function: { ...choice.function, name: WIRE_NAME } };
	}
	if ("name" in choice && choice.name === LOGICAL_NAME) return { ...choice, name: WIRE_NAME };
	return choice;
}

function hasLogicalCall(message: AssistantMessage): boolean {
	for (let index = 0; index < message.content.length; index++) {
		const block = message.content[index];
		if (block.type === "toolCall" && block.name === LOGICAL_NAME) return true;
	}
	return false;
}

function encodeContext(context: Context): Context {
	const tools = encodeTools(context.tools);
	const inactiveTools = encodeTools(context.inactiveTools);
	let hasHistory = false;
	for (let index = 0; index < context.messages.length; index++) {
		const message = context.messages[index];
		if (
			(message.role === "toolResult" && message.toolName === LOGICAL_NAME) ||
			(message.role === "assistant" && hasLogicalCall(message))
		) {
			hasHistory = true;
			break;
		}
	}
	if (tools === context.tools && inactiveTools === context.inactiveTools && !hasHistory) return context;
	return {
		...context,
		tools,
		inactiveTools,
		messages: hasHistory
			? context.messages.map(message => {
					if (message.role === "toolResult" && message.toolName === LOGICAL_NAME) {
						return { ...message, toolName: WIRE_NAME };
					}
					if (message.role !== "assistant" || !hasLogicalCall(message)) return message;
					return {
						...message,
						content: message.content.map(block =>
							block.type === "toolCall" && block.name === LOGICAL_NAME ? { ...block, name: WIRE_NAME } : block,
						),
					};
				})
			: context.messages,
	};
}

function decodeMessage(message: AssistantMessage): void {
	for (const block of message.content) {
		if (block.type === "toolCall" && block.name === WIRE_NAME) block.name = LOGICAL_NAME;
	}
}

/** Keep the logical tool identity in session state and only use its safe alias at the provider boundary. */
export function withGenerativeUiToolWire(streamFn: StreamFn): StreamFn {
	return (model, context, options) => {
		let declaresLogical = false;
		let declaresWire = false;
		if (context.tools) {
			for (let index = 0; index < context.tools.length; index++) {
				const name = context.tools[index].name;
				if (name === LOGICAL_NAME) declaresLogical = true;
				if (name === WIRE_NAME) declaresWire = true;
			}
		}
		if (declaresLogical && declaresWire) {
			throw new Error("Tool name collision: ui.present and ui_present share the provider wire name ui_present");
		}
		const encodedContext = encodeContext(context);
		const toolChoice = encodeChoice(options?.toolChoice);
		if (encodedContext === context && toolChoice === options?.toolChoice) return streamFn(model, context, options);
		const encodedOptions: SimpleStreamOptions | undefined =
			toolChoice === options?.toolChoice ? options : { ...options, toolChoice };
		const source = streamFn(model, encodedContext, encodedOptions);
		const stream = new AssistantMessageEventStream();
		(async () => {
			try {
				const resolvedSource = await source;
				stream.forwardLocalWorkFrom(resolvedSource);
				for await (const event of resolvedSource) {
					if ("partial" in event) decodeMessage(event.partial);
					if (event.type === "toolcall_end" && event.toolCall.name === WIRE_NAME) {
						event.toolCall.name = LOGICAL_NAME;
					}
					if (event.type === "done") decodeMessage(event.message);
					if (event.type === "error") decodeMessage(event.error);
					stream.push(event);
				}
				const result = await resolvedSource.result();
				decodeMessage(result);
				stream.end(result);
			} catch (error) {
				stream.fail(error);
			} finally {
				stream.forwardLocalWorkFrom(undefined);
			}
		})();
		return stream;
	};
}
