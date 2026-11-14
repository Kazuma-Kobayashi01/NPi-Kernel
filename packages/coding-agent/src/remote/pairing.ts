/**
 * Device pairing for NPi Remote Connect.
 *
 * The QR code carries a one-shot offer (host public key + pairing secret). Over a
 * JSON text WebSocket (`/ws/pair`, direct or piped by the Relay):
 *
 * 1. device → `pair.hello`     {deviceId, deviceName, devicePub, mac = HMAC(secret, hello parts)}
 * 2. host   → `pair.challenge` {mac = HMAC(secret, challenge parts)}; both sides show the 6-digit SAS
 * 3. device → `pair.confirm`   {mac = HMAC(pairKey, confirm parts)} once the user accepts the SAS
 * 4. host   → `pair.accept`    {sealed = AES-GCM(pairKey, {deviceToken})} once the host user also accepts
 *    or either side → `pair.reject` / `pair.cancel`.
 *
 * `pairKey`/SAS come from HKDF over the X25519 secret salted with the pairing secret,
 * so a Relay that never saw the QR code can neither inject a device nor read the token.
 */
import { createHmac, randomBytes } from "node:crypto";
import { logger } from "@oh-my-pi/pi-utils";
import type { Server, ServerWebSocket } from "bun";
import {
	type AuthorizedRemoteDevice,
	computeX25519SharedSecret,
	fromBase64Url,
	generateRemoteToken,
	hashRemoteToken,
	hkdf32,
	openRemotePayload,
	type RemoteDeviceStore,
	remoteMac,
	sealRandomNonce,
	toBase64Url,
	verifyRemoteMac,
	x25519PublicKeyFromRaw,
	x25519PublicKeyToRaw,
} from "./crypto";
import { remoteEndpointUrl } from "./protocol";

export const REMOTE_PAIRING_URI_PREFIX = "npi-remote://pair?p=";
const TEXT_ENCODER = new TextEncoder();
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_DEVICE_NAME_CHARS = 64;

export interface RemotePairingOffer {
	v: 1;
	mode: "relay" | "direct";
	/** Base WebSocket URL; the device appends `/ws/pair` and later `/ws/client`. */
	url: string;
	hostId: string;
	/** Raw 32-byte X25519 host public key, base64url. */
	hostPub: string;
	pairingId: string;
	/** 32 random bytes, base64url. Never leaves the QR code. */
	secret: string;
	/** Expiry, Unix epoch milliseconds. */
	exp: number;
}

export type RemotePairingMessage =
	| { type: "pair.hello"; pairingId: string; deviceId: string; deviceName: string; devicePub: string; mac: string }
	| { type: "pair.challenge"; mac: string }
	| { type: "pair.confirm"; mac: string }
	| { type: "pair.accept"; sealed: string }
	| { type: "pair.reject"; reason: string }
	| { type: "pair.cancel" };

export interface RemotePairingDeviceInfo {
	deviceId: string;
	deviceName: string;
	devicePub: string;
}

export type RemotePairingResult =
	| { status: "paired"; device: AuthorizedRemoteDevice }
	| { status: "rejected"; reason: string };

export function createRemotePairingOffer(
	store: RemoteDeviceStore,
	options: { mode: RemotePairingOffer["mode"]; url: string; ttlMs: number; now?: number },
): RemotePairingOffer {
	const registry = store.loadOrCreate();
	return {
		v: 1,
		mode: options.mode,
		url: options.url,
		hostId: registry.hostId,
		hostPub: x25519PublicKeyToRaw(registry.hostKeyPair.publicKeyDerBase64),
		pairingId: randomBytes(16).toString("base64url"),
		secret: randomBytes(32).toString("base64url"),
		exp: (options.now ?? Date.now()) + options.ttlMs,
	};
}

export function encodeRemotePairingUri(offer: RemotePairingOffer): string {
	return `${REMOTE_PAIRING_URI_PREFIX}${Buffer.from(JSON.stringify(offer), "utf8").toString("base64url")}`;
}

export function decodeRemotePairingUri(uri: string): RemotePairingOffer {
	if (!uri.startsWith(REMOTE_PAIRING_URI_PREFIX)) throw new Error("Not an npi-remote pairing URI");
	const offer = JSON.parse(
		Buffer.from(uri.slice(REMOTE_PAIRING_URI_PREFIX.length), "base64url").toString("utf8"),
	) as RemotePairingOffer;
	if (offer.v !== 1) throw new Error(`Unsupported pairing offer version: ${String(offer.v)}`);
	return offer;
}

/** Strings MAC'd at each pairing step; identical on host and device. */
export function remotePairingParts(
	label: "hello" | "challenge" | "sas" | "confirm" | "accept",
	offer: Pick<RemotePairingOffer, "hostId" | "pairingId" | "hostPub">,
	device: RemotePairingDeviceInfo,
): string[] {
	return [
		"npi-remote-pair-v1",
		label,
		offer.hostId,
		offer.pairingId,
		offer.hostPub,
		device.deviceId,
		device.deviceName,
		device.devicePub,
	];
}

export function deriveRemotePairingSecrets(
	sharedSecret: Uint8Array,
	offer: Pick<RemotePairingOffer, "hostId" | "pairingId" | "hostPub" | "secret">,
	device: RemotePairingDeviceInfo,
): { pairKey: Uint8Array; sas: string } {
	const salt = fromBase64Url(offer.secret);
	const pairKey = hkdf32(sharedSecret, salt, "npi-remote-v1/pair-key");
	const sasKey = hkdf32(sharedSecret, salt, "npi-remote-v1/sas");
	const digest = createHmac("sha256", sasKey)
		.update(JSON.stringify(remotePairingParts("sas", offer, device)))
		.digest();
	const sas = String((digest.readUInt32BE(0) & 0x7fff_ffff) % 1_000_000).padStart(6, "0");
	return { pairKey, sas };
}

export function sealRemotePairingAccept(
	pairKey: Uint8Array,
	offer: RemotePairingOffer,
	device: RemotePairingDeviceInfo,
	deviceToken: string,
): string {
	const aad = TEXT_ENCODER.encode(JSON.stringify(remotePairingParts("accept", offer, device)));
	return toBase64Url(sealRandomNonce(pairKey, aad, TEXT_ENCODER.encode(JSON.stringify({ deviceToken }))));
}

export function openRemotePairingAccept(
	pairKey: Uint8Array,
	offer: RemotePairingOffer,
	device: RemotePairingDeviceInfo,
	sealed: string,
): { deviceToken: string } {
	const aad = TEXT_ENCODER.encode(JSON.stringify(remotePairingParts("accept", offer, device)));
	const plain = openRemotePayload(pairKey, aad, fromBase64Url(sealed));
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)) as { deviceToken: string };
}

export interface RemotePairingHostOptions {
	store: RemoteDeviceStore;
	offer: RemotePairingOffer;
	send: (message: RemotePairingMessage) => void;
	/** Ask the host user whether the SAS matches the phone; resolve `false` to reject. */
	confirmSas: (info: { sas: string; deviceId: string; deviceName: string }, signal: AbortSignal) => Promise<boolean>;
	now?: () => number;
}

/** Host side of one pairing offer. Accepts exactly one device, then settles {@link done}. */
export class RemotePairingHost {
	readonly done: Promise<RemotePairingResult>;
	readonly #options: RemotePairingHostOptions;
	readonly #abort = new AbortController();
	readonly #resolveDone: (result: RemotePairingResult) => void;
	readonly #deviceDecision = Promise.withResolvers<boolean>();
	readonly #expiryTimer: NodeJS.Timeout;
	#device: RemotePairingDeviceInfo | undefined;
	#pairKey: Uint8Array | undefined;
	#settled = false;

	constructor(options: RemotePairingHostOptions) {
		this.#options = options;
		const { promise, resolve } = Promise.withResolvers<RemotePairingResult>();
		this.done = promise;
		this.#resolveDone = resolve;
		const now = options.now ?? Date.now;
		this.#expiryTimer = setTimeout(() => this.cancel("expired"), Math.max(0, options.offer.exp - now()));
		this.#expiryTimer.unref();
	}

	/** Feed one text frame from the device. */
	handle(text: string): void {
		if (this.#settled) return;
		let message: RemotePairingMessage;
		try {
			message = JSON.parse(text) as RemotePairingMessage;
		} catch {
			this.cancel("malformed message");
			return;
		}
		switch (message.type) {
			case "pair.hello":
				void this.#onHello(message);
				return;
			case "pair.confirm":
				if (!this.#device || !this.#pairKey) {
					this.cancel("confirm before hello");
					return;
				}
				if (
					!verifyRemoteMac(
						this.#pairKey,
						remotePairingParts("confirm", this.#options.offer, this.#device),
						message.mac,
					)
				) {
					this.cancel("device confirmation MAC mismatch");
					return;
				}
				this.#deviceDecision.resolve(true);
				return;
			case "pair.cancel":
				this.#deviceDecision.resolve(false);
				this.#finish({ status: "rejected", reason: "cancelled on device" }, false);
				return;
			default:
				this.cancel(`unexpected message ${String((message as { type?: unknown }).type)}`);
		}
	}

	/** Abort pairing (expiry, transport loss, Ctrl+C) and tell the device. */
	cancel(reason: string): void {
		this.#deviceDecision.resolve(false);
		this.#finish({ status: "rejected", reason }, true);
	}

	async #onHello(message: Extract<RemotePairingMessage, { type: "pair.hello" }>): Promise<void> {
		const { offer, store } = this.#options;
		if (this.#device) {
			this.cancel("second hello");
			return;
		}
		if (message.pairingId !== offer.pairingId) {
			this.cancel("unknown pairing id");
			return;
		}
		if (
			typeof message.deviceId !== "string" ||
			!DEVICE_ID_PATTERN.test(message.deviceId) ||
			typeof message.deviceName !== "string" ||
			message.deviceName.trim().length === 0 ||
			message.deviceName.length > MAX_DEVICE_NAME_CHARS ||
			typeof message.devicePub !== "string" ||
			typeof message.mac !== "string"
		) {
			this.cancel("invalid hello");
			return;
		}
		// MACs and SAS bind the name exactly as the device sent it; only the stored label is trimmed.
		const device: RemotePairingDeviceInfo = {
			deviceId: message.deviceId,
			deviceName: message.deviceName,
			devicePub: message.devicePub,
		};
		if (!verifyRemoteMac(fromBase64Url(offer.secret), remotePairingParts("hello", offer, device), message.mac)) {
			this.cancel("pairing secret MAC mismatch");
			return;
		}
		if (store.findActiveDevice(device.deviceId)) {
			this.cancel("device id already paired");
			return;
		}
		let devicePubDer: string;
		try {
			devicePubDer = x25519PublicKeyFromRaw(device.devicePub);
		} catch {
			this.cancel("invalid device public key");
			return;
		}
		const registry = store.loadOrCreate();
		const shared = computeX25519SharedSecret(registry.hostKeyPair.privateKeyDerBase64, devicePubDer);
		const { pairKey, sas } = deriveRemotePairingSecrets(shared, offer, device);
		this.#device = device;
		this.#pairKey = pairKey;
		this.#options.send({
			type: "pair.challenge",
			mac: remoteMac(fromBase64Url(offer.secret), remotePairingParts("challenge", offer, device)),
		});

		let hostAccepted: boolean;
		try {
			hostAccepted = await this.#options.confirmSas(
				{ sas, deviceId: device.deviceId, deviceName: device.deviceName },
				this.#abort.signal,
			);
		} catch (err) {
			if (!this.#settled) this.cancel(`host confirmation failed: ${String(err)}`);
			return;
		}
		if (this.#settled) return;
		if (!hostAccepted) {
			this.cancel("rejected on host");
			return;
		}
		const deviceAccepted = await this.#deviceDecision.promise;
		if (this.#settled) return;
		if (!deviceAccepted) {
			this.cancel("rejected on device");
			return;
		}

		const deviceToken = generateRemoteToken();
		const authorized: AuthorizedRemoteDevice = {
			deviceId: device.deviceId,
			name: device.deviceName.trim(),
			publicKeyDerBase64: devicePubDer,
			tokenHash: hashRemoteToken(deviceToken),
			pairedAt: new Date().toISOString(),
		};
		store.addDevice(authorized);
		this.#options.send({ type: "pair.accept", sealed: sealRemotePairingAccept(pairKey, offer, device, deviceToken) });
		this.#finish({ status: "paired", device: authorized }, false);
	}

	#finish(result: RemotePairingResult, notifyDevice: boolean): void {
		if (this.#settled) return;
		this.#settled = true;
		clearTimeout(this.#expiryTimer);
		this.#abort.abort();
		if (notifyDevice && result.status === "rejected") {
			try {
				this.#options.send({ type: "pair.reject", reason: result.reason });
			} catch (err) {
				logger.debug("Remote pairing reject could not be delivered", { error: String(err) });
			}
		}
		this.#resolveDone(result);
	}
}

interface PairingSocketData {
	pairingId: string;
}

export interface RemotePairingRunOptions {
	store: RemoteDeviceStore;
	offer: RemotePairingOffer;
	confirmSas: RemotePairingHostOptions["confirmSas"];
	/** Aborting cancels the offer (e.g. Ctrl+C). */
	signal?: AbortSignal;
}

function bindAbort(host: RemotePairingHost, signal: AbortSignal | undefined): void {
	if (!signal) return;
	if (signal.aborted) host.cancel("interrupted");
	else signal.addEventListener("abort", () => host.cancel("interrupted"), { once: true });
}

/**
 * Mode B: serve `/ws/pair?pairingId=` on `hostname:port` until the offer settles.
 * Only one device socket is accepted.
 */
export async function runDirectPairing(
	options: RemotePairingRunOptions & { hostname: string; port: number; onListening?: (port: number) => void },
): Promise<RemotePairingResult> {
	let active: ServerWebSocket<PairingSocketData> | undefined;
	const host = new RemotePairingHost({
		store: options.store,
		offer: options.offer,
		confirmSas: options.confirmSas,
		send: message => {
			active?.sendText(JSON.stringify(message));
		},
	});
	bindAbort(host, options.signal);
	const server: Server<PairingSocketData> = Bun.serve<PairingSocketData>({
		hostname: options.hostname,
		port: options.port,
		fetch: (request, srv) => {
			const url = new URL(request.url);
			if (url.pathname !== "/ws/pair") return new Response("Not Found", { status: 404 });
			if (url.searchParams.get("pairingId") !== options.offer.pairingId) {
				return new Response("Unknown pairing", { status: 404 });
			}
			if (active) return new Response("Pairing in progress", { status: 409 });
			if (srv.upgrade(request, { data: { pairingId: options.offer.pairingId } })) return undefined;
			return new Response("WebSocket upgrade failed", { status: 400 });
		},
		websocket: {
			open: ws => {
				if (active) {
					ws.close(1008, "Pairing in progress");
					return;
				}
				active = ws;
			},
			message: (ws, message) => {
				if (ws !== active) return;
				if (typeof message !== "string") {
					host.cancel("binary frame on pairing socket");
					return;
				}
				host.handle(message);
			},
			close: ws => {
				if (ws === active) host.cancel("device disconnected");
			},
		},
	});
	options.onListening?.(server.port ?? options.port);
	try {
		return await host.done;
	} finally {
		active?.close(1000, "pairing finished");
		server.stop(false);
	}
}

/**
 * Mode A: hold `/ws/pair?role=host` on the Relay (bearer = host token), which pipes
 * text frames to the device that opened `/ws/pair?role=device` with the same pairing id.
 */
export async function runRelayPairing(
	options: RemotePairingRunOptions & { relayUrl: string; hostToken: string; onConnected?: () => void },
): Promise<RemotePairingResult> {
	const { offer } = options;
	const socket = new WebSocket(
		remoteEndpointUrl(options.relayUrl, "/ws/pair", {
			role: "host",
			hostId: offer.hostId,
			pairingId: offer.pairingId,
			exp: String(offer.exp),
		}),
		{ headers: { Authorization: `Bearer ${options.hostToken}` } },
	);
	const host = new RemotePairingHost({
		store: options.store,
		offer,
		confirmSas: options.confirmSas,
		send: message => {
			if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
		},
	});
	bindAbort(host, options.signal);
	socket.addEventListener("open", () => options.onConnected?.());
	socket.addEventListener("message", event => {
		if (typeof event.data !== "string") {
			host.cancel("binary frame on pairing socket");
			return;
		}
		host.handle(event.data);
	});
	socket.addEventListener("close", event =>
		host.cancel(`relay pairing socket closed (${event.code} ${event.reason})`),
	);
	try {
		return await host.done;
	} finally {
		socket.close(1000, "pairing finished");
	}
}
