/**
 * Binary envelope codec, command allowlists, and control-plane wire types for
 * NPi Android Remote Connect (`npi remote`).
 */
import type { ApprovalMode, ToolTier } from "../tools/approval";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse, RpcSessionState } from "../modes/rpc/rpc-types";
import type { SessionInfo } from "../session/session-listing";

export const REMOTE_PROTOCOL_VERSION = 1 as const;
export const MAX_REMOTE_HEADER_BYTES = 64 * 1024;
export const MAX_REMOTE_ENVELOPE_BYTES = 1024 * 1024;
export const MAX_REMOTE_UPLOAD_IMAGE_BYTES = 700 * 1024;
/** Plaintext above this size is split into `chunk` envelopes, each sealed on its own. */
export const REMOTE_CHUNK_PLAINTEXT_BYTES = 256 * 1024;
export const MAX_REMOTE_CHUNK_COUNT = 128;
/** Largest plaintext a receiver reassembles from chunks. */
export const MAX_REMOTE_REASSEMBLED_BYTES = REMOTE_CHUNK_PLAINTEXT_BYTES * MAX_REMOTE_CHUNK_COUNT;
const CHUNK_TTL_MS = 60_000;

/**
 * - `hello` (device→host, plaintext JSON `{deviceNonce, mac}`) / `welcome` (host→device, `{hostNonce, mac}`):
 *   per-connection key agreement, MAC'd with the static hello key.
 * - `rehello` (host→device, empty payload): the host has no session for the device; send `hello` again.
 * - `push` (host→Relay, empty payload): push-only hint for a device without a live session.
 * - `control` / `session`: sealed with session keys; requests carry `msgId` and get a {@link RemoteReply}.
 */
export type RemoteEnvelopeKind =
	| "hello"
	| "welcome"
	| "rehello"
	| "push"
	| "control"
	| "session"
	| "heartbeat"
	| "app_state"
	| "ack";

export type RemotePushCategory = "approval" | "ask" | "done" | "error" | "dismiss";

export interface RemotePushHint {
	category: RemotePushCategory;
	requestId: string;
	collapseKey: string;
	pendingCount: number;
	cipherSummary?: string;
}

export interface RemoteChunkHeader {
	id: string;
	index: number;
	count: number;
}

export interface RemoteEnvelopeHeader {
	v: number;
	hostId: string;
	deviceId: string;
	kind: RemoteEnvelopeKind;
	channelId?: string;
	streamEpoch?: number;
	seq?: number;
	msgId?: string;
	chunk?: RemoteChunkHeader;
	pushHint?: RemotePushHint;
}

/** Reply body for every `control` / `session` request (matched by `msgId`). */
export type RemoteReply = { ok: true; result: unknown } | { ok: false; error: string };

export interface RemoteHelloPayload {
	deviceNonce: string;
	mac: string;
}

export interface RemoteWelcomePayload {
	hostNonce: string;
	mac: string;
}

export function remoteHelloMacParts(header: RemoteEnvelopeHeader, deviceNonce: string): string[] {
	return ["npi-remote-v1/hello", header.hostId, header.deviceId, header.msgId ?? "", deviceNonce];
}

export function remoteWelcomeMacParts(header: RemoteEnvelopeHeader, deviceNonce: string, hostNonce: string): string[] {
	return ["npi-remote-v1/welcome", header.hostId, header.deviceId, header.msgId ?? "", deviceNonce, hostNonce];
}

/** Text frames between host and Relay on `/ws/host` (binary frames carry device envelopes). */
export type RelayHostMessage =
	| { type: "ping"; ts: number }
	| { type: "relay.devices"; devices: Array<{ deviceId: string; tokenHash: string; revoked: boolean }> };

export type RelayToHostMessage =
	| { type: "pong"; ts: number }
	| { type: "relay.device_state"; deviceId: string; state: "online" | "offline" };

/** Split plaintext into chunks of at most {@link REMOTE_CHUNK_PLAINTEXT_BYTES}; one piece means no chunking. */
export function splitRemotePlaintext(plaintext: Uint8Array): Uint8Array[] {
	if (plaintext.byteLength <= REMOTE_CHUNK_PLAINTEXT_BYTES) return [plaintext];
	if (plaintext.byteLength > MAX_REMOTE_REASSEMBLED_BYTES) {
		throw new Error(`Remote message exceeds ${MAX_REMOTE_REASSEMBLED_BYTES} bytes`);
	}
	const pieces: Uint8Array[] = [];
	for (let offset = 0; offset < plaintext.byteLength; offset += REMOTE_CHUNK_PLAINTEXT_BYTES) {
		pieces.push(plaintext.subarray(offset, offset + REMOTE_CHUNK_PLAINTEXT_BYTES));
	}
	return pieces;
}

interface PendingChunks {
	count: number;
	received: number;
	bytes: number;
	pieces: Array<Uint8Array | undefined>;
	expiresAt: number;
}

/** Reassembles decrypted chunk pieces per `(deviceId, chunk.id)`; incomplete sets expire. */
export class RemoteChunkAssembler {
	readonly #pending = new Map<string, PendingChunks>();

	/** Returns the full plaintext once every piece arrived, otherwise `undefined`. */
	accept(deviceId: string, chunk: RemoteChunkHeader, piece: Uint8Array, now = Date.now()): Uint8Array | undefined {
		for (const [key, entry] of this.#pending) {
			if (entry.expiresAt < now) this.#pending.delete(key);
		}
		if (
			!Number.isInteger(chunk.count) ||
			chunk.count < 2 ||
			chunk.count > MAX_REMOTE_CHUNK_COUNT ||
			!Number.isInteger(chunk.index) ||
			chunk.index < 0 ||
			chunk.index >= chunk.count ||
			piece.byteLength > REMOTE_CHUNK_PLAINTEXT_BYTES
		) {
			throw new Error("Invalid remote chunk header");
		}
		const key = `${deviceId}\0${chunk.id}`;
		let entry = this.#pending.get(key);
		if (!entry) {
			entry = {
				count: chunk.count,
				received: 0,
				bytes: 0,
				pieces: Array.from({ length: chunk.count }),
				expiresAt: now + CHUNK_TTL_MS,
			};
			this.#pending.set(key, entry);
		}
		if (entry.count !== chunk.count) throw new Error("Remote chunk count changed mid-message");
		if (entry.pieces[chunk.index]) throw new Error("Duplicate remote chunk");
		entry.pieces[chunk.index] = piece;
		entry.received++;
		entry.bytes += piece.byteLength;
		if (entry.received < entry.count) return undefined;
		this.#pending.delete(key);
		const out = new Uint8Array(entry.bytes);
		let offset = 0;
		for (const part of entry.pieces as Uint8Array[]) {
			out.set(part, offset);
			offset += part.byteLength;
		}
		return out;
	}

	dropDevice(deviceId: string): void {
		for (const key of this.#pending.keys()) {
			if (key.startsWith(`${deviceId}\0`)) this.#pending.delete(key);
		}
	}
}

/** Append a WebSocket path to a base URL, keeping any path prefix (e.g. `wss://ip/relay` → `wss://ip/relay/ws/host`). */
export function remoteEndpointUrl(baseUrl: string, pathname: string, params: Record<string, string> = {}): string {
	const url = new URL(baseUrl);
	if (url.protocol !== "ws:" && url.protocol !== "wss:") {
		throw new Error(`Remote URL must use ws:// or wss://: ${baseUrl}`);
	}
	url.pathname = `${url.pathname.replace(/\/+$/, "")}${pathname}`;
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
	return url.toString();
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * Pack `[4B headerLen BE][UTF-8 JSON header][payload bytes]` for Binary WSS frames.
 */
export function packRemoteEnvelope(header: RemoteEnvelopeHeader, payload: Uint8Array): Uint8Array {
	const headerBytes = TEXT_ENCODER.encode(JSON.stringify(header));
	if (headerBytes.byteLength > MAX_REMOTE_HEADER_BYTES) {
		throw new Error(`Remote envelope header exceeds ${MAX_REMOTE_HEADER_BYTES} bytes`);
	}
	const totalBytes = 4 + headerBytes.byteLength + payload.byteLength;
	if (totalBytes > MAX_REMOTE_ENVELOPE_BYTES) {
		throw new Error(`Remote envelope exceeds ${MAX_REMOTE_ENVELOPE_BYTES} bytes`);
	}
	const out = new Uint8Array(totalBytes);
	const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
	view.setUint32(0, headerBytes.byteLength, false);
	out.set(headerBytes, 4);
	out.set(payload, 4 + headerBytes.byteLength);
	return out;
}

export function unpackRemoteEnvelope(frame: Uint8Array): { header: RemoteEnvelopeHeader; payload: Uint8Array } {
	if (frame.byteLength < 4 || frame.byteLength > MAX_REMOTE_ENVELOPE_BYTES) {
		throw new Error(`Invalid remote envelope byte length: ${frame.byteLength}`);
	}
	const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	const headerLength = view.getUint32(0, false);
	if (headerLength === 0 || headerLength > MAX_REMOTE_HEADER_BYTES || 4 + headerLength > frame.byteLength) {
		throw new Error(`Invalid remote envelope header length: ${headerLength}`);
	}
	const headerBytes = frame.subarray(4, 4 + headerLength);
	const parsed: unknown = JSON.parse(TEXT_DECODER.decode(headerBytes));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Remote envelope header must be a JSON object");
	}
	const record = parsed as Record<string, unknown>;
	if (
		record.v !== REMOTE_PROTOCOL_VERSION ||
		typeof record.hostId !== "string" ||
		typeof record.deviceId !== "string" ||
		typeof record.kind !== "string"
	) {
		throw new Error("Remote envelope header is missing required routing fields");
	}
	return {
		header: parsed as RemoteEnvelopeHeader,
		payload: frame.subarray(4 + headerLength),
	};
}
export const REMOTE_ALLOWED_SESSION_COMMANDS: Readonly<Record<string, true>> = {
	prompt: true,
	steer: true,
	follow_up: true,
	remove_queued_message: true,
	promote_queued_message: true,
	abort: true,
	abort_and_prompt: true,
	abort_and_restore_queue: true,
	set_model: true,
	cycle_model: true,
	get_available_models: true,
	set_thinking_level: true,
	cycle_thinking_level: true,
	get_available_thinking_levels: true,
	set_fast_mode: true,
	set_slow_mode: true,
	set_steering_mode: true,
	set_follow_up_mode: true,
	set_interrupt_mode: true,
	compact: true,
	set_auto_compaction: true,
	set_auto_retry: true,
	abort_retry: true,
	get_state: true,
	get_messages: true,
	get_messages_page: true,
	get_entries: true,
	get_tree: true,
	navigate_tree: true,
	branch: true,
	fork: true,
	switch_session: true,
	new_session: true,
	set_session_name: true,
	get_session_stats: true,
	get_subagents: true,
	get_subagent_messages: true,
	cancel_subagent: true,
	steer_subagent: true,
	render_ui: true,
	submit_ui: true,
	cancel_ui: true,
	btw: true,
	btw_cancel: true,
	get_btw_history: true,
};

/** Explicitly denied commands (documented for clarity & auditability). */
export const REMOTE_DENIED_SESSION_COMMANDS: Readonly<Record<string, true>> = {
	bash: true,
	abort_bash: true,
	set_host_tools: true,
	set_host_uri_schemes: true,
	export_html: true,
	restore_files: true,
	plan_file_restore: true,
	set_computer_use: true,
	get_computer_use: true,
	stop_computer_use: true,
	computer_activity_ack: true,
	set_computer_activity_ack: true,
	live_start: true,
	live_connect: true,
	live_stop: true,
	live_mute: true,
	dictation_start: true,
	dictation_stop: true,
	office_command: true,
	set_office_enabled: true,
	get_office_state: true,
	get_office_report: true,
	login: true,
	logout: true,
	get_login_providers: true,
	get_logout_accounts: true,
};

/** Commands owned exclusively by the Host Daemon (clients cannot override). */
export const REMOTE_DAEMON_OWNED_COMMANDS: Readonly<Record<string, true>> = {
	negotiate_protocol: true,
	set_event_filter: true,
	set_ask_dialog: true,
	set_subagent_subscription: true,
	set_generative_ui: true,
	set_approval_mode: true,
};

export type RemoteControlCommand =
	| { type: "host.info" }
	| { type: "host.fs.roots" }
	| { type: "host.fs.list"; path: string }
	| { type: "host.sessions.list"; cwd?: string; limit?: number }
	| {
			type: "host.sessions.open";
			cwd: string;
			channelId?: string;
			sessionPath?: string;
			profile?: string;
			approvalMode?: ApprovalMode;
	  }
	| { type: "host.sessions.close"; channelId: string }
	| { type: "host.sessions.delete"; sessionPath: string }
	| { type: "host.sessions.rename"; sessionPath: string; name: string }
	| { type: "host.sessions.sync"; channelId: string; streamEpoch: number; sinceSeq: number }
	| { type: "host.models.list"; profile?: string }
	| { type: "host.models.roles_get"; profile?: string; cwd?: string }
	| {
			type: "host.models.roles_set";
			role: string;
			selector: string | null;
			scope?: "global" | "project";
			cwd?: string;
			profile?: string;
	  }
	| { type: "host.config.schema" }
	| { type: "host.config.list"; scope?: "global" | "project"; cwd?: string; profile?: string }
	| {
			type: "host.config.set";
			key: string;
			value: unknown;
			scope?: "global" | "project";
			cwd?: string;
			profile?: string;
	  }
	| { type: "host.config.reset"; key: string; scope?: "global" | "project"; cwd?: string; profile?: string }
	| { type: "host.approval_mode.get"; channelId?: string; profile?: string; cwd?: string }
	| { type: "host.approval_mode.set"; mode: ApprovalMode; channelId?: string; profile?: string; cwd?: string }
	| { type: "host.account.list"; profile?: string }
	| { type: "host.account.activate"; provider: string; credentialId: number; profile?: string }
	| { type: "host.account.rotate"; provider: string; profile?: string }
	| { type: "host.usage.get"; force?: boolean; profile?: string }
	| { type: "host.mcp.list"; profile?: string; cwd?: string }
	| { type: "host.mcp.toggle"; name: string; enabled: boolean; profile?: string };

export interface RemoteChannelSummary {
	channelId: string;
	streamEpoch: number;
	cwd: string;
	profile?: string;
	sessionId?: string;
	sessionFile?: string;
	approvalMode: ApprovalMode;
	isSettled: boolean;
	pendingDialogCount: number;
	seq: number;
}

export interface RemoteSyncReplayResult {
	kind: "replay";
	channelId: string;
	streamEpoch: number;
	currentSeq: number;
	frames: Array<{ seq: number; frame: unknown }>;
	pendingDialogs: RpcExtensionUIRequest[];
}

export interface RemoteSyncResetResult {
	kind: "reset";
	channelId: string;
	streamEpoch: number;
	currentSeq: number;
	state: RpcSessionState;
	messages: unknown[];
	pendingDialogs: RpcExtensionUIRequest[];
}

export type RemoteSessionInbound =
	| { kind: "rpc"; command: { id?: string; type: string; [key: string]: unknown } }
	| { kind: "ui_response"; response: RpcExtensionUIResponse };

export type RemoteSessionOutbound =
	| { kind: "rpc_frame"; frame: unknown }
	| { kind: "ui_resolved"; requestId: string; byDeviceId: string }
	| { kind: "session_forked_notice"; oldSessionFile?: string; newSessionFile?: string; message: string }
	| { kind: "approval_hint"; toolCallId?: string; toolName?: string; tier?: ToolTier };

export interface RemoteSessionSummaryView {
	id: string;
	path: string;
	cwd: string;
	title?: string;
	/** First user prompt (≤200 chars): the display name of a session without a title. */
	firstMessage?: string;
	modified: string;
	messageCount: number;
	status?: SessionInfo["status"];
}
