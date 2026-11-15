/**
 * `npi --mode rpc-ui --side-agent <id>`: an RPC host (Desktop tab, `/rc` phone) talking to an external ACP
 * agent through the same protocol as NPi's own sessions.
 *
 * Covered: prompts (queued while a turn runs), abort, state, transcript, slash commands, the agent's
 * permission requests as approval dialogs, sign-in. Commands that only mean something for NPi's own
 * agent (compaction, models, computer use, …) answer as no-ops when they set something and as
 * `unsupported` errors when they ask for something, so a host built for NPi keeps working.
 */
import type { Writable } from "node:stream";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type {
	AuthMethod,
	AvailableCommand,
	ContentBlock,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionNotification,
	StopReason,
} from "@oh-my-pi/pi-utils/acp";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RpcFrameEncoder } from "../modes/rpc/rpc-frame";
import { readRpcInputFrames } from "../modes/rpc/rpc-input";
import { RpcOutputWriter } from "../modes/rpc/rpc-output";
import type {
	RpcAvailableSlashCommand,
	RpcExtensionUIResponse,
	RpcPromptResultFrame,
	RpcSessionState,
} from "../modes/rpc/rpc-types";
import type { ApprovalMode } from "../tools/approval";
import { SideAgentAuthRequiredError, SideAgentConnection, type SideAgentLaunch } from "./connection";
import { SideAgentTranscript } from "./translator";

export interface SideAgentRpcOptions {
	/** Registry id, used as the messages' provider. */
	agentId: string;
	/** Name shown to the user ("Google Antigravity"). */
	agentName: string;
	launch: SideAgentLaunch;
	cwd: string;
	/** `yolo` lets the agent's permission requests through without asking; anything else asks. */
	approvalMode: ApprovalMode;
	input: ReadableStream<Uint8Array>;
	output: Writable;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** How the user signs in with `method`, when NPi cannot do it inside the protocol. */
function signInHint(method: AuthMethod, launch: SideAgentLaunch): string | undefined {
	if (method.type === "env_var") return `Set ${method.variable} in NPi's environment, then send your message again.`;
	if (method.type === "terminal") {
		const command = [method.command ?? launch.command, ...(method.args ?? [])].join(" ");
		return `Run \`${command}\` in a terminal to sign in, then send your message again.`;
	}
	return undefined;
}

class SideAgentRpcHost {
	#options: SideAgentRpcOptions;
	#encoder = new RpcFrameEncoder();
	#writer: RpcOutputWriter;
	#transcript: SideAgentTranscript;
	#connection: Promise<SideAgentConnection> | undefined;
	#session: Promise<string> | undefined;
	#sessionId: string | undefined;
	#sessionName: string | undefined;
	#commands: AvailableCommand[] = [];
	#queue: Array<{ id?: string; text: string; images?: ImageContent[] }> = [];
	#turn: Promise<void> | undefined;
	#pendingUi = new Map<string, (response: RpcExtensionUIResponse) => void>();
	#nextUiId = 0;
	#unsettledReported = false;

	constructor(options: SideAgentRpcOptions) {
		this.#options = options;
		this.#transcript = new SideAgentTranscript(options.agentId, options.agentName);
		this.#writer = new RpcOutputWriter(options.output, failure => {
			logger.error("Side agent RPC output failed", { error: String(failure) });
		});
	}

	async run(): Promise<void> {
		this.#emit({
			type: "ready",
			protocolVersion: 1,
			supportedProtocolVersions: [1, 2],
			maxFrameBytes: MAX_RPC_FRAME_BYTES,
			maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
		});
		// Start the agent right away so the first prompt does not wait for its boot.
		void this.#ensureSession().catch(() => {});
		await readRpcInputFrames(
			this.#options.input,
			frame => void this.#dispatch(frame),
			message => this.#emit({ type: "response", command: "parse", success: false, error: message }),
		);
		await this.#shutdown();
	}

	#emit(frame: object): void {
		this.#writer.write(this.#encoder.encodeFrames(frame));
	}

	#emitEvents(events: AgentEvent[]): void {
		for (const event of events) this.#emit(event);
	}

	#respond(id: string | undefined, command: string, data?: object): void {
		this.#emit({ id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) });
	}

	#fail(id: string | undefined, command: string, message: string, code?: string): void {
		this.#emit({ id, type: "response", command, success: false, error: message, ...(code ? { code } : {}) });
	}

	async #dispatch(frame: unknown): Promise<void> {
		if (!isRecord(frame) || typeof frame.type !== "string") return;
		if (frame.type === "extension_ui_response" && typeof frame.id === "string") {
			const resolve = this.#pendingUi.get(frame.id);
			this.#pendingUi.delete(frame.id);
			resolve?.(frame as unknown as RpcExtensionUIResponse);
			return;
		}
		const id = typeof frame.id === "string" ? frame.id : undefined;
		const type = frame.type;
		try {
			await this.#command(id, type, frame);
		} catch (error) {
			this.#fail(id, type, errorText(error));
		}
	}

	async #command(id: string | undefined, type: string, frame: Json): Promise<void> {
		switch (type) {
			case "negotiate_protocol":
				if (frame.protocolVersion !== 2) {
					this.#fail(id, type, `Unsupported RPC protocol version: ${String(frame.protocolVersion)}`);
					return;
				}
				this.#respond(id, type, { protocolVersion: 2 });
				this.#encoder.setProtocolVersion(2);
				return;
			case "prompt":
			case "steer":
			case "follow_up": {
				const text = typeof frame.message === "string" ? frame.message : "";
				const images = Array.isArray(frame.images) ? (frame.images as ImageContent[]) : undefined;
				if (!text.trim() && !images?.length) {
					this.#fail(id, type, "Message is empty");
					return;
				}
				// ACP has no steering: a message sent mid-turn waits for the turn to end.
				this.#queue.push({ id: type === "prompt" ? id : undefined, text, images });
				this.#respond(id, type);
				this.#drain();
				return;
			}
			case "abort":
				await this.#abort();
				this.#respond(id, type);
				return;
			case "abort_and_prompt": {
				await this.#abort();
				await this.#command(id, "prompt", frame);
				return;
			}
			case "get_state":
				this.#respond(id, type, this.#state());
				return;
			case "get_messages":
				this.#respond(id, type, { messages: this.#transcript.messages });
				return;
			case "get_available_commands":
				this.#respond(id, type, { commands: this.#slashCommands() });
				return;
			case "get_available_models":
				this.#respond(id, type, { models: [] });
				return;
			case "get_available_thinking_levels":
				this.#respond(id, type, { levels: [] });
				return;
			case "set_session_name":
				if (typeof frame.name !== "string" || !frame.name.trim()) {
					this.#fail(id, type, "Session name cannot be empty");
					return;
				}
				this.#sessionName = frame.name.trim();
				this.#respond(id, type);
				return;
			case "new_session":
				await this.#abort();
				await this.#turn;
				this.#session = undefined;
				this.#sessionId = undefined;
				this.#sessionName = undefined;
				this.#transcript = new SideAgentTranscript(this.#options.agentId, this.#options.agentName);
				void this.#ensureSession().catch(() => {});
				this.#respond(id, type, { cancelled: false });
				return;
			default:
				// Settings for NPi's own agent have nothing to change here; queries have nothing to report.
				if (type.startsWith("set_")) this.#respond(id, type);
				else this.#fail(id, type, `${this.#options.agentName} does not support "${type}"`, "unsupported");
		}
	}

	#state(): RpcSessionState {
		const queued = this.#queue.map(item => item.text);
		return {
			thinkingLevel: undefined,
			isStreaming: this.#transcript.running,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			interruptMode: "wait",
			sessionId: this.#sessionId ?? "",
			sessionName: this.#sessionName,
			approvalMode: this.#options.approvalMode,
			pendingUi: null,
			autoCompactionEnabled: false,
			fastModeEnabled: false,
			fastModeActive: false,
			slowModeSupported: false,
			slowModeEnabled: false,
			tokensPerSecond: null,
			messageCount: this.#transcript.messages.length,
			queuedMessageCount: queued.length,
			hasPendingAsyncWork: false,
			isSettled: !this.#turn && queued.length === 0,
			queuedMessages: { steering: [], followUp: queued, liveSteered: 0 },
			todoPhases: [],
			goal: null,
		};
	}

	#slashCommands(): RpcAvailableSlashCommand[] {
		return this.#commands.map(command => ({
			name: command.name,
			description: command.description,
			...(command.input?.hint ? { input: { hint: command.input.hint } } : {}),
			source: "extension",
		}));
	}

	// ── agent lifecycle ─────────────────────────────────────────────────────────────

	#connect(): Promise<SideAgentConnection> {
		this.#connection ??= SideAgentConnection.start(
			this.#options.launch,
			{
				onSessionUpdate: notification => this.#onUpdate(notification),
				requestPermission: (request, signal) => this.#askPermission(request, signal),
				onClosed: error => {
					this.#connection = undefined;
					this.#session = undefined;
					if (error) logger.warn("Side agent stopped", { agent: this.#options.agentId, error: error.message });
				},
			},
			{ cwd: this.#options.cwd },
		).catch(error => {
			this.#connection = undefined;
			throw error;
		});
		return this.#connection;
	}

	/** The agent's session id, starting the agent and the session on first use. A failed attempt is retried next time. */
	#ensureSession(): Promise<string> {
		this.#session ??= (async () => {
			const connection = await this.#connect();
			const session = await connection.newSession({ cwd: this.#options.cwd });
			this.#sessionId = session.sessionId;
			return session.sessionId;
		})().catch(error => {
			this.#session = undefined;
			throw error;
		});
		return this.#session;
	}

	/** Lets the user pick a sign-in method; methods NPi cannot run come back as instructions. */
	async #signIn(error: SideAgentAuthRequiredError): Promise<void> {
		const connection = await this.#connect();
		if (error.methods.length === 0) throw new Error(`${this.#options.agentName} needs you to sign in`);
		const choice = await this.#select(
			`Sign in to ${this.#options.agentName}`,
			error.methods.map(method => method.name),
		);
		const method = error.methods.find(m => m.name === choice);
		if (!method) throw new Error("Sign-in cancelled");
		const hint = signInHint(method, this.#options.launch);
		if (hint) throw new Error(hint);
		await connection.authenticate(method.id);
	}

	#onUpdate(notification: SessionNotification): void {
		if (notification.sessionId !== this.#sessionId) return;
		const update = notification.update;
		switch (update.sessionUpdate) {
			case "available_commands_update":
				this.#commands = update.availableCommands;
				this.#emit({ type: "available_commands_update", commands: this.#slashCommands() });
				return;
			case "session_info_update":
				if (update.title) this.#sessionName = update.title;
				return;
			default:
				this.#emitEvents(this.#transcript.apply(update));
		}
	}

	// ── turns ───────────────────────────────────────────────────────────────────────

	#drain(): void {
		if (this.#turn) return;
		const next = this.#queue.shift();
		if (!next) return;
		this.#turn = this.#runTurn(next).finally(() => {
			this.#turn = undefined;
			if (this.#queue.length > 0) this.#drain();
			else if (this.#unsettledReported) {
				this.#unsettledReported = false;
				this.#emit({ type: "session_settled" });
			}
		});
	}

	async #runTurn(item: { id?: string; text: string; images?: ImageContent[] }): Promise<void> {
		this.#emitEvents(this.#transcript.beginTurn(item.text));
		let stop: StopReason = "end_turn";
		let failure: string | undefined;
		try {
			let sessionId: string;
			try {
				sessionId = await this.#ensureSession();
			} catch (error) {
				if (!(error instanceof SideAgentAuthRequiredError)) throw error;
				await this.#signIn(error);
				sessionId = await this.#ensureSession();
			}
			const connection = await this.#connect();
			const prompt: ContentBlock[] = [{ type: "text", text: item.text }];
			if (connection.capabilities.image) {
				for (const image of item.images ?? []) {
					prompt.push({ type: "image", data: image.data, mimeType: image.mimeType });
				}
			}
			stop = (await connection.prompt(sessionId, prompt)).stopReason;
		} catch (error) {
			failure = errorText(error);
		}
		this.#emitEvents(this.#transcript.endTurn(stop, failure));
		const settled = this.#queue.length === 0;
		if (!settled) this.#unsettledReported = true;
		const result: RpcPromptResultFrame = {
			type: "prompt_result",
			...(item.id ? { id: item.id } : {}),
			agentInvoked: true,
			status: failure ? "error" : stop === "cancelled" ? "aborted" : "completed",
			...(failure ? { error: { message: failure, provider: this.#options.agentId, retryable: false } } : {}),
			sessionSettled: settled,
		};
		this.#emit(result);
	}

	async #abort(): Promise<void> {
		this.#queue = [];
		const sessionId = this.#sessionId;
		const connection = this.#connection ? await this.#connection.catch(() => undefined) : undefined;
		if (this.#turn && sessionId && connection) await connection.cancel(sessionId);
	}

	// ── dialogs ─────────────────────────────────────────────────────────────────────

	/** Shows a select dialog; resolves with the chosen option, or `undefined` when cancelled. */
	#select(title: string, options: string[], extra: Json = {}, signal?: AbortSignal): Promise<string | undefined> {
		const id = `side_${++this.#nextUiId}`;
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		this.#pendingUi.set(id, response => resolve("value" in response ? response.value : undefined));
		const onAbort = () => {
			if (!this.#pendingUi.delete(id)) return;
			this.#emit({ type: "extension_ui_request", id: `side_${++this.#nextUiId}`, method: "cancel", targetId: id });
			resolve(undefined);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		this.#emit({ type: "extension_ui_request", id, method: "select", title, options, ...extra });
		return promise.finally(() => signal?.removeEventListener("abort", onAbort));
	}

	async #askPermission(request: RequestPermissionRequest, signal?: AbortSignal): Promise<RequestPermissionResponse> {
		const options = request.options;
		if (this.#options.approvalMode === "yolo") {
			const allow = options.find(o => o.kind === "allow_once") ?? options.find(o => o.kind === "allow_always");
			if (allow) return { outcome: { outcome: "selected", optionId: allow.optionId } };
		}
		const labels = options.map((option, index) =>
			options.findIndex(o => o.name === option.name) === index ? option.name : `${option.name} (${index + 1})`,
		);
		const choice = await this.#select(
			request.toolCall.title ?? "Allow this action?",
			labels,
			{ toolCallId: request.toolCall.toolCallId, toolName: request.toolCall.kind ?? "tool" },
			signal,
		);
		const picked = choice === undefined ? undefined : options[labels.indexOf(choice)];
		if (!picked) return { outcome: { outcome: "cancelled" } };
		return { outcome: { outcome: "selected", optionId: picked.optionId } };
	}

	async #shutdown(): Promise<void> {
		for (const resolve of this.#pendingUi.values())
			resolve({ type: "extension_ui_response", id: "", cancelled: true });
		this.#pendingUi.clear();
		await this.#abort().catch(() => {});
		const connection = this.#connection ? await this.#connection.catch(() => undefined) : undefined;
		await connection?.close();
	}
}

/** Serves one side agent over RPC until the input stream ends. */
export async function runSideAgentRpcMode(options: SideAgentRpcOptions): Promise<void> {
	await new SideAgentRpcHost(options).run();
}
