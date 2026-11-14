/**
 * Remote Host Daemon (`npi remote`):
 * - Spawns & multiplexes `npi --mode rpc-ui --no-computer-use --no-voice` channels
 * - Enforces session allowlists, `(deviceId, msgId)` deduplication, and `ui_resolved` broadcasts
 * - Maintains `streamEpoch/seq` replay buffers and independent `PendingDialogTracker`
 * - Runs the per-connection hello/welcome handshake and seals every frame with session keys
 *   (AES-256-GCM + header AAD), chunking large messages in both directions
 */
import { randomBytes, randomUUID } from "node:crypto";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { RpcClient, type RpcClientOptions } from "../modes/rpc/rpc-client";
import type { RpcCommand, RpcExtensionUIRequest, RpcSessionState } from "../modes/rpc/rpc-types";
import { type ApprovalMode, isApprovalMode } from "../tools/approval";
import { RemoteControlPlane, type RemoteAuditEntry, selfLaunchCommand } from "./control-plane";
import {
	type AuthorizedRemoteDevice,
	canonicalHeaderAad,
	computeCollapseKey,
	computeX25519SharedSecret,
	deriveRemoteSessionKeys,
	deriveRemoteStaticKeys,
	fromBase64Url,
	openRemotePayload,
	REMOTE_NONCE_BYTES,
	REMOTE_SESSION_MAX_MESSAGES,
	type RemoteDeviceStore,
	type RemoteSessionKeys,
	type RemoteStaticKeys,
	remoteMac,
	ReplayWindow,
	sealPushSummary,
	sealRemotePayload,
	toBase64Url,
	verifyRemoteMac,
} from "./crypto";
import { CommandDedupCache, PendingDialogTracker, RemoteSessionJournal } from "./journal";
import {
	REMOTE_ALLOWED_SESSION_COMMANDS,
	packRemoteEnvelope,
	REMOTE_PROTOCOL_VERSION,
	type RemoteChannelSummary,
	RemoteChunkAssembler,
	type RemoteControlCommand,
	type RemoteEnvelopeHeader,
	type RemoteHelloPayload,
	type RemotePushHint,
	type RemoteReply,
	type RemoteSessionInbound,
	type RemoteSyncResetResult,
	type RemoteWelcomePayload,
	remoteHelloMacParts,
	remoteWelcomeMacParts,
	splitRemotePlaintext,
	unpackRemoteEnvelope,
} from "./protocol";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const MAX_MOBILE_TOOL_PREVIEW_CHARS = 8192;

export interface RemoteHostDaemonOptions {
	deviceStore: RemoteDeviceStore;
	allowedRoots: string[];
	defaultProfile?: string;
	defaultApprovalMode?: ApprovalMode;
	maxActiveChannels?: number;
	/**
	 * Serve only the sessions terminals offer with {@link RemoteHostDaemon.attachLiveChannel} (`/rc`): the
	 * history lists just those, and phones can neither open other sessions nor start new ones.
	 */
	liveOnly?: boolean;
	idleTimeoutMs?: number;
	/** Optional factory override for spawning child `RpcClient` processes in tests. */
	createRpcClient?: (options: RpcClientOptions) => RpcClient;
	/** Optional CLI runner override forwarded to {@link RemoteControlPlane}. */
	runCliJson?: (args: string[], profile?: string) => Promise<unknown>;
	onAudit?: (entry: RemoteAuditEntry) => void;
	/** Transport sink used by the tunnel/direct server to emit sealed binary frames to a device. */
	sendFrame?: (deviceId: string, frameBytes: Uint8Array) => void | Promise<void>;
}

interface DeviceStaticState {
	sharedSecret: Uint8Array;
	keys: RemoteStaticKeys;
	/** Recent hello nonces, so a replayed hello cannot reset the live session. */
	seenNonces: Set<string>;
}

interface DeviceSession {
	keys: RemoteSessionKeys;
	inboundReplay: ReplayWindow;
	outboundCounter: bigint;
}

const MAX_REMEMBERED_HELLO_NONCES = 64;

interface ManagedChannel {
	channelId: string;
	streamEpoch: number;
	cwd: string;
	profile?: string;
	approvalMode: ApprovalMode;
	client: RpcClient;
	journal: RemoteSessionJournal;
	pendingDialogs: PendingDialogTracker;
	attachedDevices: Set<string>;
	isSettled: boolean;
	sessionId?: string;
	sessionFile?: string;
	lastActivityAt: number;
	unsubscribers: Array<() => void>;
	/**
	 * The session a terminal is running (`/rc`): it outlives every phone, so it is never reaped or closed
	 * from a phone, and commands that would swap the terminal's session out from under it are refused.
	 */
	live?: boolean;
}

/** Session changes the terminal owns: from a phone they would replace the conversation on the user's screen. */
const LIVE_CHANNEL_TERMINAL_COMMANDS: ReadonlySet<string> = new Set([
	"new_session",
	"switch_session",
	"branch",
	"fork",
	"navigate_tree",
]);

function truncateToolPreviewFrame(frame: unknown): unknown {
	if (!isRecord(frame)) return frame;
	if (frame.type !== "tool_execution_update" && frame.type !== "tool_stream_update") {
		return frame;
	}
	const partial = frame.partialResult;
	if (!isRecord(partial) || !Array.isArray(partial.content)) return frame;
	let changed = false;
	const truncatedContent = partial.content.map(block => {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return block;
		if (block.text.length <= MAX_MOBILE_TOOL_PREVIEW_CHARS) return block;
		changed = true;
		return {
			...block,
			text: `${block.text.slice(0, MAX_MOBILE_TOOL_PREVIEW_CHARS)}\n… [truncated for mobile preview; ${block.text.length} chars total]`,
		};
	});
	if (!changed) return frame;
	return {
		...frame,
		partialResult: { ...partial, content: truncatedContent },
		truncatedForMobile: true,
	};
}

function summarizeApprovalRequest(request: RpcExtensionUIRequest): string {
	if (request.method === "ask") {
		const first = request.questions[0]?.question ?? "Waiting for answer";
		return `Ask: ${first.slice(0, 120)}`;
	}
	if (request.method === "select") {
		if (request.toolName) {
			const tier = request.tier ? ` (${request.tier})` : "";
			return `Approval needed: ${request.toolName}${tier}`;
		}
		return `Select: ${request.title.split("\n", 1)[0]?.slice(0, 120) ?? "Action required"}`;
	}
	if (request.method === "confirm") {
		return `Confirm: ${request.title.slice(0, 120)}`;
	}
	if (request.method === "input" || request.method === "editor") {
		return `Input requested: ${request.title.slice(0, 120)}`;
	}
	return "Agent needs your attention";
}

export class RemoteHostDaemon {
	readonly hostId: string;
	readonly controlPlane: RemoteControlPlane;
	readonly #deviceStore: RemoteDeviceStore;
	readonly #defaultProfile?: string;
	readonly #defaultApprovalMode: ApprovalMode;
	readonly #maxActiveChannels: number;
	readonly #liveOnly: boolean;
	readonly #idleTimeoutMs: number;
	readonly #createRpcClient: (options: RpcClientOptions) => RpcClient;
	readonly #channels = new Map<string, ManagedChannel>();
	readonly #deviceStatic = new Map<string, DeviceStaticState>();
	readonly #sessions = new Map<string, DeviceSession>();
	readonly #chunks = new RemoteChunkAssembler();
	readonly #dedup = new CommandDedupCache<RemoteReply>();
	#sendFrame?: (deviceId: string, frameBytes: Uint8Array) => void | Promise<void>;
	#nextEpoch = 1;
	#reapTimer: NodeJS.Timeout | undefined;

	constructor(options: RemoteHostDaemonOptions) {
		this.#deviceStore = options.deviceStore;
		const registry = this.#deviceStore.loadOrCreate();
		this.hostId = registry.hostId;
		this.#defaultProfile = options.defaultProfile;
		this.#defaultApprovalMode = options.defaultApprovalMode ?? "write";
		if (this.#defaultApprovalMode === "yolo") {
			throw new Error("RemoteHostDaemon refuses yolo as defaultApprovalMode");
		}
		this.#maxActiveChannels = options.maxActiveChannels ?? 4;
		this.#liveOnly = options.liveOnly === true;
		this.#idleTimeoutMs = options.idleTimeoutMs ?? 15 * 60 * 1000;
		this.#createRpcClient =
			options.createRpcClient ?? (clientOpts => new RpcClient({ command: selfLaunchCommand(), ...clientOpts }));
		this.#sendFrame = options.sendFrame;
		this.controlPlane = new RemoteControlPlane({
			hostId: this.hostId,
			allowedRoots: options.allowedRoots,
			defaultProfile: this.#defaultProfile,
			runCliJson: options.runCliJson,
			getActiveChannels: () => this.listChannels(),
			onChannelApprovalModeSet: (channelId, mode) => this.setChannelApprovalMode(channelId, mode),
			onAudit: options.onAudit,
		});
	}

	setSendFrame(sendFrame: (deviceId: string, frameBytes: Uint8Array) => void | Promise<void>): void {
		this.#sendFrame = sendFrame;
	}

	startReaper(): void {
		if (this.#reapTimer) return;
		this.#reapTimer = setInterval(() => {
			void this.reapIdleChannels();
		}, 60_000);
		this.#reapTimer.unref();
	}

	async stop(): Promise<void> {
		if (this.#reapTimer) {
			clearInterval(this.#reapTimer);
			this.#reapTimer = undefined;
		}
		const channels = Array.from(this.#channels.values());
		this.#channels.clear();
		await Promise.allSettled(channels.map(channel => this.#disposeChannel(channel)));
	}

	/**
	 * Offer the session a terminal is running to paired phones (`/rc`), over `client` (an RPC server embedded
	 * in that terminal's process). Its approval mode stays the terminal's. Returns the channel id.
	 */
	async attachLiveChannel(options: { cwd: string; client: RpcClient; profile?: string }): Promise<string> {
		const { client } = options;
		await client.start();
		await client.setEventFilter(null, "delta");
		// Progress needs the terminal's subagent bus; without it the phone just shows no subagent rows.
		await client.setSubagentSubscription("progress").catch(() => {});
		await client.setAskDialog(true);
		const state = await client.getState();
		const channelId = `ch_live_${randomUUID()}`;
		const streamEpoch = this.#nextEpoch++;
		const channel: ManagedChannel = {
			channelId,
			streamEpoch,
			cwd: options.cwd,
			profile: options.profile,
			approvalMode: state.approvalMode,
			client,
			journal: new RemoteSessionJournal(streamEpoch),
			pendingDialogs: new PendingDialogTracker(),
			attachedDevices: new Set(),
			isSettled: state.isSettled,
			sessionId: state.sessionId,
			sessionFile: state.sessionFile,
			lastActivityAt: Date.now(),
			unsubscribers: [],
			live: true,
		};
		this.#bindChannelListeners(channel);
		this.#channels.set(channelId, channel);
		return channelId;
	}

	/** Withdraw a channel added by {@link attachLiveChannel}; its embedded server stops, the session stays. */
	async detachLiveChannel(channelId: string): Promise<void> {
		const channel = this.#channels.get(channelId);
		if (!channel?.live) return;
		this.#channels.delete(channelId);
		await this.#disposeChannel(channel);
	}

	listChannels(): RemoteChannelSummary[] {
		return Array.from(this.#channels.values()).map(channel => ({
			channelId: channel.channelId,
			streamEpoch: channel.streamEpoch,
			cwd: channel.cwd,
			profile: channel.profile,
			sessionId: channel.sessionId,
			sessionFile: channel.sessionFile,
			approvalMode: channel.approvalMode,
			isSettled: channel.isSettled,
			pendingDialogCount: channel.pendingDialogs.size,
			seq: channel.journal.currentSeq,
		}));
	}

	async setChannelApprovalMode(channelId: string, mode: ApprovalMode): Promise<ApprovalMode> {
		if (!isApprovalMode(mode)) throw new Error(`Invalid approval mode: ${String(mode)}`);
		const channel = this.#channels.get(channelId);
		if (!channel) throw new Error(`Unknown channel: ${channelId}`);
		const applied = await channel.client.setApprovalMode(mode);
		channel.approvalMode = applied;
		return applied;
	}

	/** Forget the live session of a device (transport disconnect); its next frame must be a hello. */
	dropDeviceSession(deviceId: string): void {
		this.#sessions.delete(deviceId);
		this.#chunks.dropDevice(deviceId);
	}

	/** Handle one binary envelope from a device (already routed by the transport). */
	async handleIncomingEnvelope(frameBytes: Uint8Array): Promise<void> {
		const { header, payload } = unpackRemoteEnvelope(frameBytes);
		if (header.hostId !== this.hostId) {
			throw new Error(`Envelope hostId mismatch: ${header.hostId}`);
		}
		const device = this.#deviceStore.findActiveDevice(header.deviceId);
		if (!device) {
			this.dropDeviceSession(header.deviceId);
			this.#deviceStatic.delete(header.deviceId);
			throw new Error(`Remote device "${header.deviceId}" is revoked or unauthorized`);
		}
		if (header.kind === "hello") {
			await this.#handleHello(device, header, payload);
			return;
		}
		const session = this.#sessions.get(header.deviceId);
		if (!session) {
			await this.#sendHeaderOnly(header.deviceId, "rehello");
			return;
		}
		let plaintext: Uint8Array | undefined = openRemotePayload(
			session.keys.deviceToHost,
			canonicalHeaderAad(header),
			payload,
			session.inboundReplay,
		);
		if (session.inboundReplay.highest >= REMOTE_SESSION_MAX_MESSAGES) {
			this.dropDeviceSession(header.deviceId);
			await this.#sendHeaderOnly(header.deviceId, "rehello");
			return;
		}
		if (header.chunk) {
			plaintext = this.#chunks.accept(header.deviceId, header.chunk, plaintext);
			if (!plaintext) return;
		}

		if (header.kind === "heartbeat" || header.kind === "app_state" || header.kind === "ack") {
			return;
		}
		if (header.kind !== "control" && header.kind !== "session") {
			throw new Error(`Unsupported remote envelope kind: ${String(header.kind)}`);
		}
		const msgId = header.msgId;
		if (!msgId) throw new Error(`Remote ${header.kind} request requires msgId`);

		let reply = this.#dedup.get(header.deviceId, msgId);
		if (!reply) {
			try {
				const body: unknown = JSON.parse(TEXT_DECODER.decode(plaintext));
				let result: unknown;
				if (header.kind === "control") {
					result = await this.#handleControl(header.deviceId, body as RemoteControlCommand);
				} else {
					if (!header.channelId) throw new Error("Session frame requires channelId");
					result = await this.#handleSessionInbound(
						header.deviceId,
						header.channelId,
						body as RemoteSessionInbound,
					);
				}
				reply = { ok: true, result };
			} catch (err) {
				reply = { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
			this.#dedup.set(header.deviceId, msgId, reply);
		}
		await this.#emitEncrypted(header.deviceId, {
			kind: header.kind,
			channelId: header.channelId,
			streamEpoch: header.channelId ? this.#channels.get(header.channelId)?.streamEpoch : undefined,
			msgId,
			payload: reply,
		});
	}

	async #handleHello(
		device: AuthorizedRemoteDevice,
		header: RemoteEnvelopeHeader,
		payload: Uint8Array,
	): Promise<void> {
		const hello = JSON.parse(TEXT_DECODER.decode(payload)) as RemoteHelloPayload;
		if (!isRecord(hello) || typeof hello.deviceNonce !== "string" || typeof hello.mac !== "string") {
			throw new Error("Invalid hello payload");
		}
		const deviceNonce = fromBase64Url(hello.deviceNonce);
		if (deviceNonce.byteLength !== REMOTE_NONCE_BYTES) throw new Error("Invalid hello nonce");
		const statics = this.#resolveStatic(device);
		if (!verifyRemoteMac(statics.keys.helloAuth, remoteHelloMacParts(header, hello.deviceNonce), hello.mac)) {
			throw new Error(`Hello MAC mismatch for device "${device.deviceId}"`);
		}
		if (statics.seenNonces.has(hello.deviceNonce)) {
			throw new Error(`Replayed hello from device "${device.deviceId}"`);
		}
		statics.seenNonces.add(hello.deviceNonce);
		if (statics.seenNonces.size > MAX_REMEMBERED_HELLO_NONCES) {
			statics.seenNonces.delete(statics.seenNonces.values().next().value!);
		}

		const hostNonce = new Uint8Array(randomBytes(REMOTE_NONCE_BYTES));
		this.dropDeviceSession(device.deviceId);
		this.#sessions.set(device.deviceId, {
			keys: deriveRemoteSessionKeys({
				sharedSecret: statics.sharedSecret,
				hostId: this.hostId,
				deviceId: device.deviceId,
				deviceNonce,
				hostNonce,
			}),
			inboundReplay: new ReplayWindow(),
			outboundCounter: 0n,
		});
		const welcomeHeader: RemoteEnvelopeHeader = {
			v: REMOTE_PROTOCOL_VERSION,
			hostId: this.hostId,
			deviceId: device.deviceId,
			kind: "welcome",
			...(header.msgId ? { msgId: header.msgId } : {}),
		};
		const hostNonceText = toBase64Url(hostNonce);
		const welcome: RemoteWelcomePayload = {
			hostNonce: hostNonceText,
			mac: remoteMac(statics.keys.helloAuth, remoteWelcomeMacParts(welcomeHeader, hello.deviceNonce, hostNonceText)),
		};
		await this.#sendFrame?.(
			device.deviceId,
			packRemoteEnvelope(welcomeHeader, TEXT_ENCODER.encode(JSON.stringify(welcome))),
		);
	}

	/** Reap settled idle channels; NEVER sleeps a channel with unsettled work or pending dialogs. */
	async reapIdleChannels(now = Date.now()): Promise<number> {
		let reaped = 0;
		for (const channel of Array.from(this.#channels.values())) {
			if (channel.live || !channel.isSettled || channel.pendingDialogs.size > 0) continue;
			if (now - channel.lastActivityAt < this.#idleTimeoutMs) continue;
			this.#channels.delete(channel.channelId);
			await this.#disposeChannel(channel);
			reaped++;
		}
		return reaped;
	}

	async #handleControl(deviceId: string, command: RemoteControlCommand): Promise<unknown> {
		if (!command || typeof command !== "object" || typeof command.type !== "string") {
			throw new Error("Invalid control command");
		}
		switch (command.type) {
			case "host.sessions.open":
				return await this.#openChannel(deviceId, command);
			case "host.sessions.close": {
				const channel = this.#channels.get(command.channelId);
				if (!channel) return { closed: false, channelId: command.channelId };
				if (channel.live) {
					// The terminal keeps its session: the phone only stops following it.
					channel.attachedDevices.delete(deviceId);
					return { closed: true, channelId: command.channelId };
				}
				this.#channels.delete(channel.channelId);
				await this.#disposeChannel(channel);
				return { closed: true, channelId: command.channelId };
			}
			case "host.sessions.sync":
				return await this.#syncChannel(deviceId, command.channelId, command.streamEpoch, command.sinceSeq);
			case "host.info": {
				if (this.#liveOnly) await this.#liveSessionFiles();
				const info = (await this.controlPlane.execute(command, deviceId)) as Record<string, unknown>;
				return this.#liveOnly ? { ...info, remoteControl: true } : info;
			}
			case "host.sessions.list": {
				const listed = (await this.controlPlane.execute(command, deviceId)) as {
					sessions: Array<{ path: string }>;
				};
				if (!this.#liveOnly) return listed;
				const live = new Set(await this.#liveSessionFiles());
				return { ...listed, sessions: listed.sessions.filter(session => live.has(session.path)) };
			}
			case "host.sessions.delete":
				if (this.#liveOnly && (await this.#liveSessionFiles()).includes(command.sessionPath)) {
					throw new Error("This session is running in a terminal with /rc; delete it there");
				}
				return await this.controlPlane.execute(command, deviceId);
			default:
				return await this.controlPlane.execute(command, deviceId);
		}
	}

	async #openChannel(
		deviceId: string,
		command: Extract<RemoteControlCommand, { type: "host.sessions.open" }>,
	): Promise<{
		channelId: string;
		streamEpoch: number;
		seq: number;
		state: RpcSessionState;
		pendingDialogs: RpcExtensionUIRequest[];
	}> {
		const cwd = this.controlPlane.assertAllowedCwd(command.cwd);
		const profile = command.profile ?? this.#defaultProfile;
		const existing =
			(command.channelId ? this.#channels.get(command.channelId) : undefined) ??
			// Opening the terminal's session from the history joins it rather than starting a second writer.
			(command.sessionPath ? await this.#liveChannelFor(command.sessionPath) : undefined);
		if (existing) {
			existing.attachedDevices.add(deviceId);
			existing.lastActivityAt = Date.now();
			const state = await existing.client.getState();
			existing.sessionId = state.sessionId;
			existing.sessionFile = state.sessionFile;
			return {
				channelId: existing.channelId,
				streamEpoch: existing.streamEpoch,
				seq: existing.journal.currentSeq,
				state,
				pendingDialogs: existing.pendingDialogs.listPending(),
			};
		}

		if (this.#liveOnly) {
			throw new Error("Only the session running /rc in a terminal can be opened; run /rc there");
		}
		if (this.#channels.size >= this.#maxActiveChannels) {
			await this.reapIdleChannels();
			if (this.#channels.size >= this.#maxActiveChannels) {
				throw new Error(`Maximum active remote channels (${this.#maxActiveChannels}) reached`);
			}
		}

		const channelId = command.channelId ?? `ch_${randomUUID()}`;
		const streamEpoch = this.#nextEpoch++;
		const args = ["--no-computer-use", "--no-voice"];
		if (profile) args.push("--profile", profile);
		if (command.sessionPath) {
			args.push("--resume", this.controlPlane.assertManagedSessionPath(command.sessionPath, profile));
		}

		const client = this.#createRpcClient({
			cwd,
			mode: "rpc-ui",
			args,
		});
		await client.start();

		const approvalMode = command.approvalMode ?? this.#defaultApprovalMode;
		if (approvalMode === "yolo" && command.approvalMode === undefined) {
			throw new Error("Refusing implicit yolo approval mode for remote session");
		}
		await client.setEventFilter(null, "delta");
		await client.setSubagentSubscription("progress");
		await client.setAskDialog(true);
		const appliedMode = await client.setApprovalMode(approvalMode);
		const initialState = await client.getState();

		const channel: ManagedChannel = {
			channelId,
			streamEpoch,
			cwd,
			profile,
			approvalMode: appliedMode,
			client,
			journal: new RemoteSessionJournal(streamEpoch),
			pendingDialogs: new PendingDialogTracker(),
			attachedDevices: new Set([deviceId]),
			isSettled: initialState.isSettled,
			sessionId: initialState.sessionId,
			sessionFile: initialState.sessionFile,
			lastActivityAt: Date.now(),
			unsubscribers: [],
		};

		this.#bindChannelListeners(channel);
		this.#channels.set(channelId, channel);

		return {
			channelId,
			streamEpoch,
			seq: channel.journal.currentSeq,
			state: initialState,
			pendingDialogs: channel.pendingDialogs.listPending(),
		};
	}

	/** The terminals' current session files, read afresh: `/new` or `/resume` there moves a live channel. */
	async #liveSessionFiles(): Promise<string[]> {
		const files: string[] = [];
		for (const channel of this.#channels.values()) {
			if (!channel.live) continue;
			try {
				const state = await channel.client.getState();
				channel.sessionFile = state.sessionFile;
				channel.sessionId = state.sessionId;
			} catch {
				// Keep the last known file; the channel's own frames report a dead server.
			}
			if (channel.sessionFile) files.push(channel.sessionFile);
		}
		return files;
	}

	async #liveChannelFor(sessionPath: string): Promise<ManagedChannel | undefined> {
		await this.#liveSessionFiles();
		for (const channel of this.#channels.values()) {
			if (channel.live && channel.sessionFile === sessionPath) return channel;
		}
		return undefined;
	}

	async #syncChannel(
		deviceId: string,
		channelId: string,
		streamEpoch: number,
		sinceSeq: number,
	): Promise<
		| RemoteSyncResetResult
		| {
				kind: "replay";
				channelId: string;
				streamEpoch: number;
				currentSeq: number;
				frames: Array<{ seq: number; frame: unknown }>;
				pendingDialogs: RpcExtensionUIRequest[];
		  }
	> {
		const channel = this.#channels.get(channelId);
		if (!channel) throw new Error(`Unknown channel: ${channelId}`);
		channel.attachedDevices.add(deviceId);
		channel.lastActivityAt = Date.now();
		const replay = channel.journal.replaySince(streamEpoch, sinceSeq);
		if (replay.kind === "replay") {
			return {
				kind: "replay",
				channelId,
				streamEpoch: channel.streamEpoch,
				currentSeq: channel.journal.currentSeq,
				frames: replay.frames,
				pendingDialogs: channel.pendingDialogs.listPending(),
			};
		}
		const state = await channel.client.getState();
		// `RpcClient.getMessages()` automatically falls back to `get_messages`
		// when `get_messages_page` returns `session_busy`.
		const messages = await channel.client.getMessages();
		return {
			kind: "reset",
			channelId,
			streamEpoch: channel.streamEpoch,
			currentSeq: channel.journal.currentSeq,
			state,
			messages,
			pendingDialogs: channel.pendingDialogs.listPending(),
		};
	}

	async #handleSessionInbound(deviceId: string, channelId: string, inbound: RemoteSessionInbound): Promise<unknown> {
		const channel = this.#channels.get(channelId);
		if (!channel) throw new Error(`Unknown channel: ${channelId}`);
		channel.attachedDevices.add(deviceId);
		channel.lastActivityAt = Date.now();

		if (inbound.kind === "ui_response") {
			const response = inbound.response;
			const resolved = channel.pendingDialogs.resolve(response.id);
			if (!resolved) {
				return { accepted: false, alreadyResolved: true, requestId: response.id };
			}
			channel.client.sendExtensionUIResponse(response);
			await this.#broadcastToChannel(
				channel,
				{ kind: "ui_resolved", requestId: response.id, byDeviceId: deviceId },
				{
					category: "dismiss",
					requestId: response.id,
					pendingCount: channel.pendingDialogs.size,
				},
			);
			return { accepted: true, requestId: response.id };
		}

		if (inbound.kind === "rpc") {
			const command = inbound.command;
			if (!isRecord(command) || typeof command.type !== "string") {
				throw new Error("Invalid session RPC command");
			}
			if (!Object.hasOwn(REMOTE_ALLOWED_SESSION_COMMANDS, command.type)) {
				throw new Error(`Command "${command.type}" is forbidden on remote channels`);
			}
			if (channel.live && LIVE_CHANNEL_TERMINAL_COMMANDS.has(command.type)) {
				throw new Error(`"${command.type}" changes the terminal's session; run it in the terminal`);
			}
			if (command.type === "prompt" || command.type === "steer" || command.type === "abort_and_prompt") {
				channel.isSettled = false;
			}
			return await channel.client.sendCommand(command as RpcCommand);
		}

		throw new Error("Unsupported session inbound frame");
	}

	#bindChannelListeners(channel: ManagedChannel): void {
		const unsubSession = channel.client.onSessionEvent(event => {
			channel.lastActivityAt = Date.now();
			const filtered = truncateToolPreviewFrame(event);
			if (isRecord(event) && event.type === "notice" && event.source === "session-persistence") {
				void channel.client.getState().then(
					state => {
						if (state.sessionFile && state.sessionFile !== channel.sessionFile) {
							const previous = channel.sessionFile;
							channel.sessionFile = state.sessionFile;
							channel.sessionId = state.sessionId;
							void this.#broadcastToChannel(channel, {
								kind: "session_forked_notice",
								oldSessionFile: previous,
								newSessionFile: state.sessionFile,
								message:
									typeof event.message === "string" ? event.message : "Session forked due to lease contention",
							});
						}
					},
					() => {},
				);
			}
			void this.#broadcastToChannel(channel, { kind: "rpc_frame", frame: filtered });
		});

		const unsubUi = channel.client.onExtensionUIRequest(request => {
			channel.lastActivityAt = Date.now();
			channel.pendingDialogs.observeOutbound(request);
			const pushHint =
				request.method === "cancel"
					? {
							category: "dismiss" as const,
							requestId: request.targetId,
							pendingCount: channel.pendingDialogs.size,
						}
					: request.method === "ask" ||
						  request.method === "select" ||
						  request.method === "confirm" ||
						  request.method === "input" ||
						  request.method === "editor"
						? {
								category: request.method === "ask" ? ("ask" as const) : ("approval" as const),
								requestId: request.id,
								pendingCount: channel.pendingDialogs.size,
								summaryText: summarizeApprovalRequest(request),
							}
						: undefined;
			void this.#broadcastToChannel(channel, { kind: "rpc_frame", frame: request }, pushHint);
		});

		const unsubPromptResult = channel.client.onPromptResult(result => {
			channel.lastActivityAt = Date.now();
			if (result.sessionSettled) channel.isSettled = true;
			const pushHint =
				result.status === "error"
					? {
							category: "error" as const,
							requestId: result.id ?? `err_${Date.now()}`,
							pendingCount: channel.pendingDialogs.size,
							summaryText: `Agent error: ${result.error?.message?.slice(0, 100) ?? "failed"}`,
						}
					: undefined;
			void this.#broadcastToChannel(channel, { kind: "rpc_frame", frame: result }, pushHint);
		});

		const unsubSettled = channel.client.onSessionSettled(() => {
			channel.lastActivityAt = Date.now();
			channel.isSettled = true;
			void this.#broadcastToChannel(
				channel,
				{ kind: "rpc_frame", frame: { type: "session_settled" } },
				{
					category: "done",
					requestId: `done_${channel.journal.currentSeq + 1}`,
					pendingCount: channel.pendingDialogs.size,
					summaryText: "Task settled",
				},
			);
		});

		const unsubSubagent = channel.client.onSubagentProgress(payload => {
			void this.#broadcastToChannel(channel, {
				kind: "rpc_frame",
				frame: { type: "subagent_progress", payload },
			});
		});

		channel.unsubscribers.push(unsubSession, unsubUi, unsubPromptResult, unsubSettled, unsubSubagent);
	}

	async #broadcastToChannel(
		channel: ManagedChannel,
		payload: unknown,
		hint?: {
			category: RemotePushHint["category"];
			requestId: string;
			pendingCount: number;
			summaryText?: string;
		},
	): Promise<void> {
		const { seq } = channel.journal.push(payload);
		for (const deviceId of channel.attachedDevices) {
			try {
				const device = this.#deviceStore.findActiveDevice(deviceId);
				if (!device) {
					channel.attachedDevices.delete(deviceId);
					this.dropDeviceSession(deviceId);
					this.#deviceStatic.delete(deviceId);
					continue;
				}
				const statics = this.#resolveStatic(device);
				const pushHint: RemotePushHint | undefined = hint
					? {
							category: hint.category,
							requestId: hint.requestId,
							collapseKey: computeCollapseKey(statics.keys.collapseHmacKey, channel.channelId),
							pendingCount: hint.pendingCount,
							...(hint.summaryText
								? {
										cipherSummary: sealPushSummary(
											statics.keys.notification,
											{
												hostId: this.hostId,
												deviceId,
												channelId: channel.channelId,
												requestId: hint.requestId,
												seq,
											},
											hint.summaryText,
										),
									}
								: {}),
						}
					: undefined;
				const delivered = await this.#emitEncrypted(deviceId, {
					kind: "session",
					channelId: channel.channelId,
					streamEpoch: channel.streamEpoch,
					seq,
					pushHint,
					payload,
				});
				if (!delivered && pushHint) {
					// No live session: the Relay still needs the hint to wake the phone via FCM.
					await this.#sendHeaderOnly(deviceId, "push", {
						channelId: channel.channelId,
						streamEpoch: channel.streamEpoch,
						seq,
						pushHint,
					});
				}
			} catch (err) {
				logger.warn("Failed to deliver remote channel frame", {
					deviceId,
					channelId: channel.channelId,
					error: String(err),
				});
			}
		}
	}

	/** Seal and send; returns `false` when the device has no live session (nothing sent). */
	async #emitEncrypted(
		deviceId: string,
		options: {
			kind: RemoteEnvelopeHeader["kind"];
			channelId?: string;
			streamEpoch?: number;
			seq?: number;
			msgId?: string;
			pushHint?: RemotePushHint;
			payload: unknown;
		},
	): Promise<boolean> {
		const session = this.#sessions.get(deviceId);
		if (!this.#sendFrame || !session) return false;
		const pieces = splitRemotePlaintext(TEXT_ENCODER.encode(JSON.stringify(options.payload)));
		const chunkId = pieces.length > 1 ? randomUUID() : undefined;
		for (let index = 0; index < pieces.length; index++) {
			const header: RemoteEnvelopeHeader = {
				v: REMOTE_PROTOCOL_VERSION,
				hostId: this.hostId,
				deviceId,
				kind: options.kind,
				...(options.channelId ? { channelId: options.channelId } : {}),
				...(options.streamEpoch !== undefined ? { streamEpoch: options.streamEpoch } : {}),
				...(options.seq !== undefined ? { seq: options.seq } : {}),
				...(options.msgId ? { msgId: options.msgId } : {}),
				...(chunkId ? { chunk: { id: chunkId, index, count: pieces.length } } : {}),
				...(options.pushHint && index === 0 ? { pushHint: options.pushHint } : {}),
			};
			const sealed = sealRemotePayload(
				session.keys.hostToDevice,
				session.outboundCounter++,
				canonicalHeaderAad(header),
				pieces[index]!,
			);
			await this.#sendFrame(deviceId, packRemoteEnvelope(header, sealed));
		}
		if (session.outboundCounter >= REMOTE_SESSION_MAX_MESSAGES) {
			this.dropDeviceSession(deviceId);
			await this.#sendHeaderOnly(deviceId, "rehello");
		}
		return true;
	}

	/** Unsealed, payload-less frame (`rehello`, `push`): carries routing metadata only. */
	async #sendHeaderOnly(
		deviceId: string,
		kind: "rehello" | "push",
		extra: Pick<RemoteEnvelopeHeader, "channelId" | "streamEpoch" | "seq" | "pushHint"> = {},
	): Promise<void> {
		if (!this.#sendFrame) return;
		const header: RemoteEnvelopeHeader = {
			v: REMOTE_PROTOCOL_VERSION,
			hostId: this.hostId,
			deviceId,
			kind,
			...extra,
		};
		await this.#sendFrame(deviceId, packRemoteEnvelope(header, new Uint8Array(0)));
	}

	#resolveStatic(device: AuthorizedRemoteDevice): DeviceStaticState {
		const existing = this.#deviceStatic.get(device.deviceId);
		if (existing) return existing;
		const registry = this.#deviceStore.loadOrCreate();
		const sharedSecret = computeX25519SharedSecret(
			registry.hostKeyPair.privateKeyDerBase64,
			device.publicKeyDerBase64,
		);
		const created: DeviceStaticState = {
			sharedSecret,
			keys: deriveRemoteStaticKeys({ sharedSecret, hostId: this.hostId, deviceId: device.deviceId }),
			seenNonces: new Set(),
		};
		this.#deviceStatic.set(device.deviceId, created);
		return created;
	}

	async #disposeChannel(channel: ManagedChannel): Promise<void> {
		for (const unsub of channel.unsubscribers) unsub();
		channel.unsubscribers = [];
		channel.pendingDialogs.clear();
		await channel.client.stop();
	}
}
