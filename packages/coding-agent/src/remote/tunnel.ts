/**
 * Network transport adapters for `npi remote`:
 * - Mode A (`RemoteRelayTunnel`): outbound WebSocket to the Relay's `/ws/host` (bearer = host token)
 *   with 15s ping / 40s silence watchdog, exponential backoff (1s..30s), and authorized-device sync.
 * - Mode B (`RemoteDirectServer`): direct `Bun.serve` listener on `/ws/client`, authenticating
 *   devices by bearer token, enforcing the same E2EE envelope contract.
 *
 * Frames for a device that is not connected are dropped: the device resynchronises
 * through `host.sessions.sync` after its next hello.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { Server, ServerWebSocket } from "bun";
import type { RemoteDeviceStore } from "./crypto";
import type { RemoteHostDaemon } from "./daemon";
import { type RelayHostMessage, type RelayToHostMessage, remoteEndpointUrl, unpackRemoteEnvelope } from "./protocol";

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const PING_INTERVAL_MS = 15_000;
const SILENCE_LIMIT_MS = 40_000;
const DEVICE_SYNC_DEBOUNCE_MS = 200;

export type RemoteTunnelStatus = "connecting" | "connected" | "disconnected";

export interface RemoteRelayTunnelOptions {
	/** Relay base URL, e.g. `wss://relay.example.com` or `wss://203.0.113.5/relay`. */
	relayUrl: string;
	daemon: RemoteHostDaemon;
	deviceStore: RemoteDeviceStore;
	onStatusChange?: (status: RemoteTunnelStatus) => void;
}

/** Device list the Relay uses to authenticate `/ws/client` bearer tokens. */
export function relayDeviceSyncMessage(store: RemoteDeviceStore): RelayHostMessage {
	return {
		type: "relay.devices",
		devices: store.listDevices().map(device => ({
			deviceId: device.deviceId,
			tokenHash: device.tokenHash,
			revoked: device.revokedAt !== undefined,
		})),
	};
}

function readBearer(request: Request): string | undefined {
	const header = request.headers.get("authorization");
	if (!header?.startsWith("Bearer ")) return undefined;
	return header.slice("Bearer ".length).trim() || undefined;
}

export class RemoteRelayTunnel {
	readonly #relayUrl: string;
	readonly #daemon: RemoteHostDaemon;
	readonly #deviceStore: RemoteDeviceStore;
	readonly #onStatusChange?: (status: RemoteTunnelStatus) => void;
	#socket: WebSocket | undefined;
	#closed = false;
	#attempt = 0;
	#lastSeenMs = 0;
	#lastDeviceSync: string | undefined;
	#pingTimer: NodeJS.Timeout | undefined;
	#reconnectTimer: NodeJS.Timeout | undefined;
	#syncTimer: NodeJS.Timeout | undefined;
	#storeWatcher: fs.FSWatcher | undefined;

	constructor(options: RemoteRelayTunnelOptions) {
		this.#relayUrl = options.relayUrl;
		this.#daemon = options.daemon;
		this.#deviceStore = options.deviceStore;
		this.#onStatusChange = options.onStatusChange;
	}

	start(): void {
		this.#closed = false;
		this.#daemon.setSendFrame((_deviceId, bytes) => {
			if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(bytes);
		});
		const storeName = path.basename(this.#deviceStore.filePath);
		this.#storeWatcher = fs.watch(path.dirname(this.#deviceStore.filePath), (_event, filename) => {
			if (filename !== storeName) return;
			clearTimeout(this.#syncTimer);
			this.#syncTimer = setTimeout(() => this.#syncDevices(), DEVICE_SYNC_DEBOUNCE_MS);
		});
		this.#connect();
	}

	close(): void {
		this.#closed = true;
		this.#stopWatchdog();
		clearTimeout(this.#reconnectTimer);
		clearTimeout(this.#syncTimer);
		this.#storeWatcher?.close();
		this.#storeWatcher = undefined;
		this.#socket?.close(1000, "host shutdown");
		this.#socket = undefined;
		this.#onStatusChange?.("disconnected");
	}

	#syncDevices(): void {
		const socket = this.#socket;
		if (socket?.readyState !== WebSocket.OPEN) return;
		const text = JSON.stringify(relayDeviceSyncMessage(this.#deviceStore));
		if (text === this.#lastDeviceSync) return;
		this.#lastDeviceSync = text;
		socket.send(text);
	}

	#connect(): void {
		if (this.#closed) return;
		this.#onStatusChange?.("connecting");
		const registry = this.#deviceStore.loadOrCreate();
		const socket = new WebSocket(remoteEndpointUrl(this.#relayUrl, "/ws/host", { hostId: registry.hostId }), {
			headers: { Authorization: `Bearer ${registry.relayHostToken}` },
		});
		socket.binaryType = "arraybuffer";
		this.#socket = socket;

		socket.addEventListener("open", () => {
			if (this.#socket !== socket) return;
			this.#attempt = 0;
			this.#lastSeenMs = Date.now();
			this.#lastDeviceSync = undefined;
			this.#onStatusChange?.("connected");
			this.#syncDevices();
			this.#startWatchdog(socket);
		});

		socket.addEventListener("message", event => {
			if (this.#socket !== socket) return;
			this.#lastSeenMs = Date.now();
			if (typeof event.data === "string") {
				this.#handleRelayText(event.data);
				return;
			}
			void this.#daemon.handleIncomingEnvelope(new Uint8Array(event.data as ArrayBuffer)).catch(err => {
				logger.warn("RemoteRelayTunnel rejected incoming frame", { error: String(err) });
			});
		});

		socket.addEventListener("close", event => {
			if (this.#socket !== socket) return;
			this.#socket = undefined;
			this.#stopWatchdog();
			this.#onStatusChange?.("disconnected");
			if (event.code === 4401) {
				logger.error("Relay rejected the host token; not reconnecting", { reason: event.reason });
				return;
			}
			this.#scheduleReconnect();
		});

		socket.addEventListener("error", () => {
			if (this.#socket !== socket) return;
			socket.close();
		});
	}

	#handleRelayText(text: string): void {
		let message: RelayToHostMessage;
		try {
			message = JSON.parse(text) as RelayToHostMessage;
		} catch {
			logger.warn("Relay sent malformed control text");
			return;
		}
		switch (message.type) {
			case "pong":
				return;
			case "relay.device_state":
				if (message.state === "offline") this.#daemon.dropDeviceSession(message.deviceId);
				return;
		}
	}

	#startWatchdog(socket: WebSocket): void {
		this.#stopWatchdog();
		this.#pingTimer = setInterval(() => {
			if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) return;
			if (Date.now() - this.#lastSeenMs > SILENCE_LIMIT_MS) {
				logger.warn("RemoteRelayTunnel silence limit exceeded; reconnecting");
				socket.close(4000, "silence timeout");
				return;
			}
			const ping: RelayHostMessage = { type: "ping", ts: Date.now() };
			socket.send(JSON.stringify(ping));
		}, PING_INTERVAL_MS);
		this.#pingTimer.unref();
	}

	#stopWatchdog(): void {
		clearInterval(this.#pingTimer);
		this.#pingTimer = undefined;
	}

	#scheduleReconnect(): void {
		if (this.#closed) return;
		const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.#attempt);
		this.#attempt++;
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = undefined;
			this.#connect();
		}, delay);
		this.#reconnectTimer.unref();
	}
}

export interface RemoteDirectServerOptions {
	hostname?: string;
	port: number;
	daemon: RemoteHostDaemon;
	deviceStore: RemoteDeviceStore;
}

interface DirectSocketData {
	deviceId: string;
}

/**
 * Mode B direct Binary WebSocket listener. A device connects to
 * `/ws/client?deviceId=<id>` with `Authorization: Bearer <deviceToken>`; every
 * binary envelope must name that device and goes through `RemoteHostDaemon`.
 */
export class RemoteDirectServer {
	readonly #hostname: string;
	readonly #port: number;
	readonly #daemon: RemoteHostDaemon;
	readonly #deviceStore: RemoteDeviceStore;
	readonly #clients = new Map<string, ServerWebSocket<DirectSocketData>>();
	#server: Server<DirectSocketData> | undefined;

	constructor(options: RemoteDirectServerOptions) {
		this.#hostname = options.hostname ?? "127.0.0.1";
		this.#port = options.port;
		this.#daemon = options.daemon;
		this.#deviceStore = options.deviceStore;
	}

	get port(): number {
		return this.#server?.port ?? this.#port;
	}

	start(): number {
		this.#daemon.setSendFrame((deviceId, bytes) => {
			this.#clients.get(deviceId)?.sendBinary(bytes);
		});
		this.#server = Bun.serve<DirectSocketData>({
			hostname: this.#hostname,
			port: this.#port,
			fetch: (request, server) => {
				const url = new URL(request.url);
				if (url.pathname !== "/ws/client") {
					return new Response("Not Found", { status: 404 });
				}
				const deviceId = url.searchParams.get("deviceId")?.trim();
				const token = readBearer(request);
				if (!deviceId || !token || !this.#deviceStore.authenticateDevice(deviceId, token)) {
					return new Response("Unauthorized device", { status: 401 });
				}
				if (server.upgrade(request, { data: { deviceId } })) {
					return undefined;
				}
				return new Response("WebSocket upgrade failed", { status: 400 });
			},
			websocket: {
				open: ws => {
					const previous = this.#clients.get(ws.data.deviceId);
					this.#clients.set(ws.data.deviceId, ws);
					if (previous) previous.close(4000, "replaced by a newer connection");
					this.#daemon.dropDeviceSession(ws.data.deviceId);
				},
				message: (ws, message) => {
					if (typeof message === "string") return;
					const bytes = new Uint8Array(message);
					let headerDeviceId: string;
					try {
						headerDeviceId = unpackRemoteEnvelope(bytes).header.deviceId;
					} catch {
						ws.close(1008, "Malformed envelope");
						return;
					}
					if (headerDeviceId !== ws.data.deviceId) {
						ws.close(1008, "Device identity mismatch");
						return;
					}
					void this.#daemon.handleIncomingEnvelope(bytes).catch(err => {
						logger.warn("RemoteDirectServer envelope error", {
							deviceId: ws.data.deviceId,
							error: String(err),
						});
					});
				},
				close: ws => {
					if (this.#clients.get(ws.data.deviceId) === ws) {
						this.#clients.delete(ws.data.deviceId);
						this.#daemon.dropDeviceSession(ws.data.deviceId);
					}
				},
			},
		});
		return this.port;
	}

	stop(): void {
		for (const ws of this.#clients.values()) {
			ws.close(1001, "server shutdown");
		}
		this.#clients.clear();
		this.#server?.stop(true);
		this.#server = undefined;
	}
}
