/**
 * The HTTP(S) + WebSocket server behind `/web`: a small page on the LAN that drives the one session the
 * terminal is running. It knows nothing about the TUI; it talks to an RPC client over that session
 * ({@link WebSessionLink}) and forwards only the commands a browser may send ({@link WEB_ALLOWED_COMMANDS}).
 *
 * Auth: a random token printed in the URL (`/?t=…`) is swapped on first visit for an HttpOnly cookie, and
 * every other route (assets, `/ws`) requires that cookie. The WebSocket upgrade also requires an `Origin`
 * whose host matches `Host`, so another site open in the same browser cannot ride the cookie.
 */
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { Server, ServerWebSocket } from "bun";
import type { RpcClient } from "../modes/rpc/rpc-client";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse, RpcSessionState } from "../modes/rpc/rpc-types";
import { PendingDialogTracker } from "../remote/journal";
import appCss from "./assets/app.css" with { type: "text" };
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import appJs from "./assets/app.js" with { type: "text" };
import indexHtmlBundle from "./assets/index.html" with { type: "text" };

/** What the server needs from the RPC client over the live session. */
export type WebSessionLink = Pick<
	RpcClient,
	| "onSessionEvent"
	| "onExtensionUIRequest"
	| "onPromptResult"
	| "onSessionSettled"
	| "sendExtensionUIResponse"
	| "sendCommand"
	| "getState"
	| "getMessages"
>;

/**
 * Commands a browser may send. Everything that would leave this session (new/switch/fork/branch), change
 * the model or profile, run shell commands or touch files on the host is refused.
 */
export const WEB_ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"abort_and_prompt",
	"remove_queued_message",
	"get_state",
	"get_messages",
]);

/** Text fields a browser command may carry; images are not accepted. */
const COMMAND_TEXT_FIELDS: Readonly<Record<string, readonly string[]>> = {
	prompt: ["message", "streamingBehavior"],
	steer: ["message"],
	follow_up: ["message"],
	abort_and_prompt: ["message"],
	remove_queued_message: ["message", "queue"],
};

export const WEB_COOKIE = "npi_web";
const MAX_INBOUND_BYTES = 256 * 1024;
const MAX_MESSAGE_CHARS = 100_000;
const MAX_SOCKETS = 16;
const MAX_FRAME_STRING = 32 * 1024;
const UPDATE_COALESCE_MS = 80;
/** With `type: "text"` Bun hands over the file's text; its typings only know HTML imports as bundles. */
const indexHtml = indexHtmlBundle as unknown as string;

export interface WebServerOptions {
	link: WebSessionLink;
	hostname: string;
	port: number;
	/** PEM certificate and key; plain HTTP when absent. */
	tls?: { cert: string; key: string };
	/** Folder the session runs in, shown in the page header. */
	cwd: string;
	/** Fixed token for tests; random otherwise. */
	token?: string;
}

interface SocketData {
	/** Latest coalesced `message_update` waiting to be sent, and its timer. */
	pendingUpdate?: unknown;
	updateTimer?: NodeJS.Timeout;
}

type WebSocket = ServerWebSocket<SocketData>;

function randomToken(bytes = 16): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

/** Constant-time string comparison for secrets of a known format. */
export function secretEquals(a: string, b: string): boolean {
	const left = new TextEncoder().encode(a);
	const right = new TextEncoder().encode(b);
	let diff = left.length ^ right.length;
	for (let i = 0; i < Math.max(left.length, right.length); i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
	return diff === 0;
}

function readCookie(header: string | null, name: string): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return undefined;
}

/**
 * A copy of `value` safe to hand a browser: image data is dropped and long strings are cut, so one huge
 * tool result cannot stall every page.
 */
export function boundFrame(value: unknown, depth = 0): unknown {
	if (typeof value === "string") {
		return value.length > MAX_FRAME_STRING
			? `${value.slice(0, MAX_FRAME_STRING)}\n… (${value.length - MAX_FRAME_STRING} more characters)`
			: value;
	}
	if (depth > 24 || value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(item => boundFrame(item, depth + 1));
	if ("type" in value && value.type === "image" && "data" in value) return { type: "image", omitted: true };
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) out[key] = boundFrame(item, depth + 1);
	return out;
}

/** The part of the session state the page shows; the system prompt and tool dumps stay on the host. */
function pageState(state: RpcSessionState): Record<string, unknown> {
	return {
		model: state.model ? { provider: state.model.provider, id: state.model.id, name: state.model.name } : null,
		thinkingLevel: state.thinkingLevel ?? null,
		isStreaming: state.isStreaming,
		isCompacting: state.isCompacting,
		sessionName: state.sessionName ?? null,
		queuedMessages: state.queuedMessages,
		isSettled: state.isSettled,
	};
}

/** A browser command checked against {@link WEB_ALLOWED_COMMANDS}, with only the fields it may carry. */
export function sanitizeWebCommand(command: unknown): { type: string; [key: string]: unknown } {
	if (!isRecord(command) || typeof command.type !== "string") throw new Error("Invalid command");
	const type = command.type;
	if (!WEB_ALLOWED_COMMANDS.has(type)) throw new Error(`"${type}" is not available from the web page`);
	const clean: { type: string; [key: string]: unknown } = { type };
	for (const field of COMMAND_TEXT_FIELDS[type] ?? []) {
		const value = command[field];
		if (value === undefined) continue;
		if (typeof value !== "string") throw new Error(`"${field}" must be text`);
		if (value.length > MAX_MESSAGE_CHARS) throw new Error("Message is too long");
		clean[field] = value;
	}
	if (type === "prompt" && clean.streamingBehavior !== undefined) {
		if (clean.streamingBehavior !== "steer" && clean.streamingBehavior !== "followUp") {
			throw new Error("Invalid streamingBehavior");
		}
	}
	if (type === "remove_queued_message" && clean.queue !== "steering" && clean.queue !== "followUp") {
		throw new Error("Invalid queue");
	}
	if (COMMAND_TEXT_FIELDS[type]?.includes("message") && typeof clean.message !== "string") {
		throw new Error("Message is required");
	}
	return clean;
}

/** A browser's answer to a dialog, reduced to the shapes {@link RpcExtensionUIResponse} allows. */
function sanitizeUiResponse(value: unknown): RpcExtensionUIResponse {
	if (!isRecord(value) || typeof value.id !== "string") throw new Error("Invalid dialog answer");
	const id = value.id;
	if (value.cancelled === true) return { type: "extension_ui_response", id, cancelled: true };
	if (typeof value.confirmed === "boolean") return { type: "extension_ui_response", id, confirmed: value.confirmed };
	if (typeof value.value === "string" && value.value.length <= MAX_MESSAGE_CHARS) {
		return { type: "extension_ui_response", id, value: value.value };
	}
	if (Array.isArray(value.answers)) {
		const answers = value.answers.map(answer => {
			if (!isRecord(answer) || typeof answer.id !== "string" || !Array.isArray(answer.selectedOptions)) {
				throw new Error("Invalid ask answer");
			}
			const selectedOptions = answer.selectedOptions.filter(
				(option): option is string => typeof option === "string",
			);
			const customInput =
				typeof answer.customInput === "string" ? answer.customInput.slice(0, MAX_MESSAGE_CHARS) : undefined;
			return { id: answer.id, selectedOptions, ...(customInput !== undefined ? { customInput } : {}) };
		});
		return { type: "extension_ui_response", id, answers };
	}
	throw new Error("Invalid dialog answer");
}

export class WebSessionServer {
	readonly token: string;
	readonly #cookieSecret = randomToken(24);
	readonly #options: WebServerOptions;
	readonly #dialogs = new PendingDialogTracker();
	readonly #sockets = new Set<WebSocket>();
	readonly #unsubscribers: Array<() => void> = [];
	#server: Server<SocketData> | undefined;

	constructor(options: WebServerOptions) {
		this.#options = options;
		this.token = options.token ?? randomToken();
	}

	get port(): number {
		return this.#server?.port ?? this.#options.port;
	}

	get secure(): boolean {
		return this.#options.tls !== undefined;
	}

	get connections(): number {
		return this.#sockets.size;
	}

	/** Listen; when the asked port is taken, fall back to any free one. */
	start(): void {
		this.#bindLink();
		try {
			this.#server = this.#serve(this.#options.port);
		} catch (error) {
			if (this.#options.port === 0 || !String(error).includes("EADDRINUSE")) {
				this.#unbindLink();
				throw error;
			}
			this.#server = this.#serve(0);
		}
	}

	stop(): void {
		this.#unbindLink();
		for (const ws of this.#sockets) {
			clearTimeout(ws.data.updateTimer);
			ws.close(1001, "Server stopped");
		}
		this.#sockets.clear();
		this.#server?.stop(true);
		this.#server = undefined;
	}

	#serve(port: number): Server<SocketData> {
		return Bun.serve<SocketData>({
			hostname: this.#options.hostname,
			port,
			...(this.#options.tls ? { tls: this.#options.tls } : {}),
			fetch: (req, server) => this.#fetch(req, server),
			websocket: {
				maxPayloadLength: MAX_INBOUND_BYTES,
				idleTimeout: 120,
				sendPings: true,
				open: ws => void this.#onOpen(ws),
				message: (ws, message) => void this.#onMessage(ws, message),
				close: ws => {
					clearTimeout(ws.data.updateTimer);
					this.#sockets.delete(ws);
				},
			},
		});
	}

	#headers(contentType: string): Headers {
		return new Headers({
			"Content-Type": contentType,
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
			"X-Frame-Options": "DENY",
			"Content-Security-Policy":
				"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
		});
	}

	#authorized(req: Request): boolean {
		const cookie = readCookie(req.headers.get("cookie"), WEB_COOKIE);
		return cookie !== undefined && secretEquals(cookie, this.#cookieSecret);
	}

	#refuse(): Response {
		return new Response("Open the link printed by /web in the terminal (it carries the access token).\n", {
			status: 401,
			headers: this.#headers("text/plain; charset=utf-8"),
		});
	}

	#fetch(req: Request, server: Server<SocketData>): Response | undefined {
		const url = new URL(req.url);
		if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
		if (url.pathname === "/" && url.searchParams.has("t")) {
			if (!secretEquals(url.searchParams.get("t") ?? "", this.token)) return this.#refuse();
			const headers = this.#headers("text/plain; charset=utf-8");
			headers.set("Location", "/");
			headers.append(
				"Set-Cookie",
				`${WEB_COOKIE}=${this.#cookieSecret}; Path=/; HttpOnly; SameSite=Strict${this.secure ? "; Secure" : ""}`,
			);
			return new Response(null, { status: 303, headers });
		}
		if (!this.#authorized(req)) return this.#refuse();
		switch (url.pathname) {
			case "/":
				return new Response(indexHtml, { headers: this.#headers("text/html; charset=utf-8") });
			case "/app.js":
				return new Response(appJs, { headers: this.#headers("text/javascript; charset=utf-8") });
			case "/app.css":
				return new Response(appCss, { headers: this.#headers("text/css; charset=utf-8") });
			case "/ws": {
				const origin = req.headers.get("origin");
				let sameOrigin = false;
				try {
					sameOrigin = origin !== null && new URL(origin).host === req.headers.get("host");
				} catch {
					sameOrigin = false;
				}
				if (!sameOrigin) return new Response("Cross-origin WebSocket refused", { status: 403 });
				if (this.#sockets.size >= MAX_SOCKETS) return new Response("Too many open pages", { status: 503 });
				if (server.upgrade(req, { data: {} })) return undefined;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}
			default:
				return new Response("Not found", { status: 404, headers: this.#headers("text/plain; charset=utf-8") });
		}
	}

	#send(ws: WebSocket, payload: unknown): void {
		ws.send(JSON.stringify(payload));
	}

	#broadcast(payload: unknown): void {
		const text = JSON.stringify(payload);
		for (const ws of this.#sockets) ws.send(text);
	}

	async #onOpen(ws: WebSocket): Promise<void> {
		this.#sockets.add(ws);
		try {
			const [state, messages] = await Promise.all([this.#options.link.getState(), this.#options.link.getMessages()]);
			this.#send(ws, {
				kind: "hello",
				cwd: this.#options.cwd,
				state: pageState(state),
				messages: boundFrame(messages),
				pendingDialogs: this.#dialogs.listPending(),
			});
		} catch (error) {
			logger.warn("Web UI could not send the session snapshot", { error: String(error) });
			this.#send(ws, { kind: "error", message: "Could not read the session" });
		}
	}

	async #onMessage(ws: WebSocket, raw: string | Buffer): Promise<void> {
		let inbound: unknown;
		try {
			inbound = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
		} catch {
			this.#send(ws, { kind: "error", message: "Invalid frame" });
			return;
		}
		if (!isRecord(inbound)) return;
		const reqId = typeof inbound.reqId === "string" ? inbound.reqId.slice(0, 64) : undefined;
		try {
			if (inbound.kind === "rpc") {
				const command = sanitizeWebCommand(inbound.command);
				const response = await this.#options.link.sendCommand(command as Parameters<RpcClient["sendCommand"]>[0]);
				const failed = !response.success;
				const reply: Record<string, unknown> = { kind: "result", reqId, ok: !failed };
				if (failed) reply.error = "error" in response ? String(response.error) : "Command failed";
				else if (command.type === "get_state" && "data" in response) {
					reply.data = pageState(response.data as RpcSessionState);
				} else if (command.type === "get_messages" && "data" in response) reply.data = boundFrame(response.data);
				this.#send(ws, reply);
				return;
			}
			if (inbound.kind === "ui_response") {
				const response = sanitizeUiResponse(inbound.response);
				if (!this.#dialogs.resolve(response.id)) {
					this.#send(ws, { kind: "result", reqId, ok: false, error: "Already answered" });
					return;
				}
				this.#options.link.sendExtensionUIResponse(response);
				this.#broadcast({ kind: "ui_resolved", id: response.id });
				this.#send(ws, { kind: "result", reqId, ok: true });
				return;
			}
			throw new Error("Unknown frame");
		} catch (error) {
			this.#send(ws, {
				kind: "result",
				reqId,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** Stream `message_update` at most every {@link UPDATE_COALESCE_MS} per page, always ending on the latest. */
	#sendUpdate(frame: unknown): void {
		for (const ws of this.#sockets) {
			ws.data.pendingUpdate = frame;
			if (ws.data.updateTimer) continue;
			ws.data.updateTimer = setTimeout(() => {
				ws.data.updateTimer = undefined;
				const pending = ws.data.pendingUpdate;
				ws.data.pendingUpdate = undefined;
				if (pending !== undefined) this.#send(ws, { kind: "event", frame: pending });
			}, UPDATE_COALESCE_MS);
		}
	}

	/** Send a pending coalesced update before a frame that must follow it. */
	#flushUpdates(): void {
		for (const ws of this.#sockets) {
			if (!ws.data.updateTimer) continue;
			clearTimeout(ws.data.updateTimer);
			ws.data.updateTimer = undefined;
			const pending = ws.data.pendingUpdate;
			ws.data.pendingUpdate = undefined;
			if (pending !== undefined) this.#send(ws, { kind: "event", frame: pending });
		}
	}

	#bindLink(): void {
		const link = this.#options.link;
		this.#unsubscribers.push(
			link.onSessionEvent(event => {
				if (this.#sockets.size === 0) return;
				const frame = boundFrame(event);
				if (isRecord(event) && event.type === "message_update") {
					this.#sendUpdate(frame);
					return;
				}
				this.#flushUpdates();
				this.#broadcast({ kind: "event", frame });
			}),
			link.onExtensionUIRequest((request: RpcExtensionUIRequest) => {
				this.#dialogs.observeOutbound(request);
				if (this.#sockets.size === 0) return;
				this.#flushUpdates();
				this.#broadcast({ kind: "ui", request: boundFrame(request) });
			}),
			link.onPromptResult(result => {
				this.#flushUpdates();
				this.#broadcast({ kind: "event", frame: boundFrame(result) });
			}),
			link.onSessionSettled(() => {
				this.#flushUpdates();
				this.#broadcast({ kind: "event", frame: { type: "session_settled" } });
			}),
		);
	}

	#unbindLink(): void {
		for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
		this.#dialogs.clear();
	}
}
