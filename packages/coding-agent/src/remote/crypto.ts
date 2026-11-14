/**
 * Cryptographic primitives for NPi Remote Connect:
 * - X25519 ECDH; static per-device keys (hello MAC, notification summary, collapse key)
 * - Per-connection session keys from a hello/welcome nonce exchange (HKDF-SHA256)
 * - AES-256-GCM with monotonic counter nonces, ReplayWindow, and mandatory header AAD
 * - Local authorized-device registry (`remote-devices.json`) with hashed device tokens
 */
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	createPrivateKey,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import type { RemoteEnvelopeHeader } from "./protocol";

const KEY_BYTES = 32;
const COUNTER_BYTES = 8;
const SALT_BYTES = 4;
const IV_BYTES = COUNTER_BYTES + SALT_BYTES; // 12B AES-GCM nonce
const TAG_BYTES = 16;
const TEXT_ENCODER = new TextEncoder();
/** SPKI DER prefix of an X25519 public key; the raw 32-byte key follows it. */
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

/** A session is dropped (device must send a fresh hello) once either direction reaches this counter. */
export const REMOTE_SESSION_MAX_MESSAGES = 2n ** 32n;
export const REMOTE_NONCE_BYTES = 32;

export interface X25519KeyPairSerialized {
	publicKeyDerBase64: string;
	privateKeyDerBase64: string;
}

/** Keys that stay fixed for a paired device: they must survive app restarts and lock screens. */
export interface RemoteStaticKeys {
	helloAuth: Uint8Array;
	notification: Uint8Array;
	collapseHmacKey: Uint8Array;
}

/** Keys derived per connection from the hello/welcome nonces. */
export interface RemoteSessionKeys {
	hostToDevice: Uint8Array;
	deviceToHost: Uint8Array;
}

export function toBase64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

export function fromBase64Url(text: string): Uint8Array {
	return new Uint8Array(Buffer.from(text, "base64url"));
}

export function generateX25519KeyPair(): X25519KeyPairSerialized {
	const { publicKey, privateKey } = generateKeyPairSync("x25519");
	const pubDer = publicKey.export({ type: "spki", format: "der" });
	const privDer = privateKey.export({ type: "pkcs8", format: "der" });
	return {
		publicKeyDerBase64: Buffer.from(pubDer).toString("base64"),
		privateKeyDerBase64: Buffer.from(privDer).toString("base64"),
	};
}

/** SPKI DER (base64) → raw 32-byte X25519 key (base64url), the form used on the wire. */
export function x25519PublicKeyToRaw(publicKeyDerBase64: string): string {
	const der = Buffer.from(publicKeyDerBase64, "base64");
	if (
		der.byteLength !== X25519_SPKI_PREFIX.byteLength + KEY_BYTES ||
		!der.subarray(0, 12).equals(X25519_SPKI_PREFIX)
	) {
		throw new Error("Not an X25519 SPKI public key");
	}
	return der.subarray(X25519_SPKI_PREFIX.byteLength).toString("base64url");
}

/** Raw 32-byte X25519 key (base64url) → SPKI DER (base64) for node:crypto. */
export function x25519PublicKeyFromRaw(rawBase64Url: string): string {
	const raw = Buffer.from(rawBase64Url, "base64url");
	if (raw.byteLength !== KEY_BYTES) throw new Error("X25519 public key must be 32 bytes");
	return Buffer.concat([X25519_SPKI_PREFIX, raw]).toString("base64");
}

export function computeX25519SharedSecret(privateKeyDerBase64: string, peerPublicKeyDerBase64: string): Uint8Array {
	const privateKey = createPrivateKey({
		key: Buffer.from(privateKeyDerBase64, "base64"),
		format: "der",
		type: "pkcs8",
	});
	const publicKey = createPublicKey({
		key: Buffer.from(peerPublicKeyDerBase64, "base64"),
		format: "der",
		type: "spki",
	});
	return new Uint8Array(diffieHellman({ privateKey, publicKey }));
}

export function hkdf32(ikm: Uint8Array, salt: Uint8Array, info: string): Uint8Array {
	return new Uint8Array(hkdfSync("sha256", ikm, salt, TEXT_ENCODER.encode(info), KEY_BYTES));
}

export function deriveRemoteStaticKeys(params: {
	sharedSecret: Uint8Array;
	hostId: string;
	deviceId: string;
}): RemoteStaticKeys {
	const salt = TEXT_ENCODER.encode(`${params.hostId}\0${params.deviceId}`);
	return {
		helloAuth: hkdf32(params.sharedSecret, salt, "npi-remote-v1/hello-auth"),
		notification: hkdf32(params.sharedSecret, salt, "npi-remote-v1/notification-summary"),
		collapseHmacKey: hkdf32(params.sharedSecret, salt, "npi-remote-v1/collapse-key"),
	};
}

export function deriveRemoteSessionKeys(params: {
	sharedSecret: Uint8Array;
	hostId: string;
	deviceId: string;
	deviceNonce: Uint8Array;
	hostNonce: Uint8Array;
}): RemoteSessionKeys {
	const salt = Buffer.concat([params.deviceNonce, params.hostNonce]);
	const suffix = `\0${params.hostId}\0${params.deviceId}`;
	return {
		hostToDevice: hkdf32(params.sharedSecret, salt, `npi-remote-v1/session/host-to-device${suffix}`),
		deviceToHost: hkdf32(params.sharedSecret, salt, `npi-remote-v1/session/device-to-host${suffix}`),
	};
}

/** HMAC-SHA256 over `JSON.stringify(parts)`, base64url. Every part is a plain string. */
export function remoteMac(key: Uint8Array, parts: readonly string[]): string {
	return createHmac("sha256", key).update(JSON.stringify(parts)).digest("base64url");
}

export function verifyRemoteMac(key: Uint8Array, parts: readonly string[], mac: string): boolean {
	return constantTimeEqual(remoteMac(key, parts), mac);
}

export function canonicalHeaderAad(header: RemoteEnvelopeHeader): Uint8Array {
	const normalized = {
		v: header.v,
		hostId: header.hostId,
		deviceId: header.deviceId,
		kind: header.kind,
		channelId: header.channelId ?? null,
		streamEpoch: header.streamEpoch ?? null,
		seq: header.seq ?? null,
		msgId: header.msgId ?? null,
		chunk: header.chunk ? { id: header.chunk.id, index: header.chunk.index, count: header.chunk.count } : null,
	};
	return TEXT_ENCODER.encode(JSON.stringify(normalized));
}

export function canonicalSummaryAad(params: {
	hostId: string;
	deviceId: string;
	channelId: string;
	requestId: string;
	seq: number;
}): Uint8Array {
	return TEXT_ENCODER.encode(
		JSON.stringify({
			v: 1,
			hostId: params.hostId,
			deviceId: params.deviceId,
			channelId: params.channelId,
			requestId: params.requestId,
			seq: params.seq,
		}),
	);
}

/** 64-entry sliding window replay guard per directional cipher stream. */
export class ReplayWindow {
	#highest = -1n;
	#bitmap = 0n;
	readonly #windowSize: bigint;

	constructor(windowSize = 64) {
		this.#windowSize = BigInt(windowSize);
	}

	get highest(): bigint {
		return this.#highest;
	}

	accept(counter: bigint): boolean {
		if (counter < 0n) return false;
		if (counter > this.#highest) {
			const shift = counter - this.#highest;
			this.#bitmap =
				shift >= this.#windowSize ? 1n : ((this.#bitmap << shift) | 1n) & ((1n << this.#windowSize) - 1n);
			this.#highest = counter;
			return true;
		}
		const offset = this.#highest - counter;
		if (offset >= this.#windowSize) return false;
		const bit = 1n << offset;
		if ((this.#bitmap & bit) !== 0n) return false;
		this.#bitmap |= bit;
		return true;
	}
}

function sealWithIv(key: Uint8Array, iv: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
	if (key.byteLength !== KEY_BYTES) throw new Error(`Expected ${KEY_BYTES}-byte key`);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(aad);
	const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();
	const out = new Uint8Array(IV_BYTES + encrypted.byteLength + TAG_BYTES);
	out.set(iv, 0);
	out.set(encrypted, IV_BYTES);
	out.set(tag, IV_BYTES + encrypted.byteLength);
	return out;
}

/**
 * Seal payload using `[8B counter BE][4B random][ciphertext][16B GCM authTag]`
 * with mandatory AAD covering outer routing fields. The counter MUST be unique per key.
 */
export function sealRemotePayload(
	key: Uint8Array,
	counter: bigint,
	aad: Uint8Array,
	plaintext: Uint8Array,
): Uint8Array {
	const iv = new Uint8Array(IV_BYTES);
	new DataView(iv.buffer).setBigUint64(0, counter, false);
	iv.set(randomBytes(SALT_BYTES), COUNTER_BYTES);
	return sealWithIv(key, iv, aad, plaintext);
}

export function openRemotePayload(
	key: Uint8Array,
	aad: Uint8Array,
	sealed: Uint8Array,
	replayWindow?: ReplayWindow,
): Uint8Array {
	if (key.byteLength !== KEY_BYTES) throw new Error(`Expected ${KEY_BYTES}-byte key`);
	if (sealed.byteLength < IV_BYTES + TAG_BYTES) {
		throw new Error("Sealed payload too short");
	}
	const iv = sealed.subarray(0, IV_BYTES);
	const counter = new DataView(iv.buffer, iv.byteOffset, COUNTER_BYTES).getBigUint64(0, false);
	const tag = sealed.subarray(sealed.byteLength - TAG_BYTES);
	const ciphertext = sealed.subarray(IV_BYTES, sealed.byteLength - TAG_BYTES);
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAAD(aad);
	decipher.setAuthTag(tag);
	const plaintext = new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
	// Authenticate before touching the window so forged frames cannot burn counters.
	if (replayWindow && !replayWindow.accept(counter)) {
		throw new Error(`Replayed or stale remote message counter: ${counter.toString()}`);
	}
	return plaintext;
}

/**
 * Seal with a fully random 96-bit nonce. Used for keys that outlive a session
 * (notification summaries, pairing), where no persistent counter exists.
 */
export function sealRandomNonce(key: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
	return sealWithIv(key, new Uint8Array(randomBytes(IV_BYTES)), aad, plaintext);
}

export function sealPushSummary(
	notificationKey: Uint8Array,
	aadParams: Parameters<typeof canonicalSummaryAad>[0],
	summary: string,
): string {
	return toBase64Url(sealRandomNonce(notificationKey, canonicalSummaryAad(aadParams), TEXT_ENCODER.encode(summary)));
}

export function openPushSummary(
	notificationKey: Uint8Array,
	aadParams: Parameters<typeof canonicalSummaryAad>[0],
	cipherSummary: string,
): string {
	const plain = openRemotePayload(notificationKey, canonicalSummaryAad(aadParams), fromBase64Url(cipherSummary));
	return new TextDecoder("utf-8", { fatal: true }).decode(plain);
}

export function computeCollapseKey(hmacKey: Uint8Array, channelId: string): string {
	return createHmac("sha256", hmacKey).update(channelId).digest("hex").slice(0, 24);
}

export function generateRemoteToken(): string {
	return randomBytes(32).toString("base64url");
}

export function hashRemoteToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

export function constantTimeEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a, "utf8");
	const bufB = Buffer.from(b, "utf8");
	if (bufA.byteLength !== bufB.byteLength) return false;
	return timingSafeEqual(bufA, bufB);
}

export interface AuthorizedRemoteDevice {
	deviceId: string;
	name: string;
	publicKeyDerBase64: string;
	/** SHA-256 hex of the bearer token the device presents to the Relay / direct listener. */
	tokenHash: string;
	pairedAt: string;
	revokedAt?: string;
}

export interface RemoteDeviceRegistryData {
	version: 1;
	hostId: string;
	hostKeyPair: X25519KeyPairSerialized;
	/** Bearer token the host presents to the Relay (`/ws/host`, `/ws/pair`). */
	relayHostToken: string;
	devices: AuthorizedRemoteDevice[];
}

export function defaultRemoteDevicesPath(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "remote-devices.json");
}

/**
 * Local authorized-device registry owned by the Host Daemon. Reads are cached and
 * revalidated with `stat` on every call, so edits by another `npi remote` process apply live.
 */
export class RemoteDeviceStore {
	readonly filePath: string;
	#cache: { mtimeMs: number; size: number; data: RemoteDeviceRegistryData } | undefined;

	constructor(filePath: string = defaultRemoteDevicesPath()) {
		this.filePath = filePath;
	}

	loadOrCreate(defaultHostId?: string): RemoteDeviceRegistryData {
		const stat = fs.statSync(this.filePath, { throwIfNoEntry: false });
		if (stat) {
			if (this.#cache && this.#cache.mtimeMs === stat.mtimeMs && this.#cache.size === stat.size) {
				return this.#cache.data;
			}
			const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as RemoteDeviceRegistryData;
			if (
				parsed?.version !== 1 ||
				typeof parsed.hostId !== "string" ||
				!parsed.hostKeyPair ||
				typeof parsed.relayHostToken !== "string" ||
				!Array.isArray(parsed.devices)
			) {
				throw new Error(`Invalid remote device store at ${this.filePath}`);
			}
			this.#cache = { mtimeMs: stat.mtimeMs, size: stat.size, data: parsed };
			return parsed;
		}
		const fresh: RemoteDeviceRegistryData = {
			version: 1,
			hostId: defaultHostId ?? `host_${randomUUID()}`,
			hostKeyPair: generateX25519KeyPair(),
			relayHostToken: generateRemoteToken(),
			devices: [],
		};
		this.save(fresh);
		return fresh;
	}

	save(data: RemoteDeviceRegistryData): void {
		fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
		const tmp = `${this.filePath}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
		fs.renameSync(tmp, this.filePath);
		const stat = fs.statSync(this.filePath);
		this.#cache = { mtimeMs: stat.mtimeMs, size: stat.size, data };
	}

	addDevice(device: AuthorizedRemoteDevice): RemoteDeviceRegistryData {
		const data = this.loadOrCreate();
		const next: RemoteDeviceRegistryData = {
			...data,
			devices: [...data.devices.filter(item => item.deviceId !== device.deviceId), device],
		};
		this.save(next);
		return next;
	}

	revokeDevice(deviceId: string): boolean {
		const data = this.loadOrCreate();
		const target = data.devices.find(item => item.deviceId === deviceId);
		if (!target) return false;
		if (!target.revokedAt) {
			target.revokedAt = new Date().toISOString();
			this.save(data);
		}
		return true;
	}

	findActiveDevice(deviceId: string): AuthorizedRemoteDevice | undefined {
		const match = this.loadOrCreate().devices.find(item => item.deviceId === deviceId);
		if (!match || match.revokedAt) return undefined;
		return match;
	}

	/** Active device whose bearer token matches; `undefined` for unknown, revoked, or wrong token. */
	authenticateDevice(deviceId: string, token: string): AuthorizedRemoteDevice | undefined {
		const device = this.findActiveDevice(deviceId);
		if (!device || !constantTimeEqual(device.tokenHash, hashRemoteToken(token))) return undefined;
		return device;
	}

	listDevices(): AuthorizedRemoteDevice[] {
		return this.loadOrCreate().devices;
	}
}
