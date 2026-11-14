/**
 * Emits fixed Remote Connect test vectors (JSON on stdout) for non-TS clients (the Flutter app).
 * Every value is derived from the TS reference implementation, so a client passing these
 * vectors is wire-compatible. Randomised outputs (sealed payloads) are produced once and
 * recorded together with their plaintext so the client can open them.
 *
 *   bun scripts/gen-remote-vectors.ts > ../../../../npi-remote/test/vectors.json
 */
import { createPrivateKey, createPublicKey } from "node:crypto";
import {
	canonicalHeaderAad,
	canonicalSummaryAad,
	computeCollapseKey,
	computeX25519SharedSecret,
	deriveRemotePairingSecrets,
	deriveRemoteSessionKeys,
	deriveRemoteStaticKeys,
	hashRemoteToken,
	openRemotePayload,
	packRemoteEnvelope,
	type RemoteEnvelopeHeader,
	remoteHelloMacParts,
	remoteMac,
	remotePairingParts,
	remoteWelcomeMacParts,
	ReplayWindow,
	sealPushSummary,
	sealRemotePairingAccept,
	sealRemotePayload,
	splitRemotePlaintext,
	toBase64Url,
	x25519PublicKeyToRaw,
} from "../src/remote";

const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64u = toBase64Url;

function hex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

function keyPairFromSeed(seedByte: number) {
	const seed = Buffer.alloc(32, seedByte);
	const privateDer = Buffer.concat([PKCS8_X25519_PREFIX, seed]);
	const privateKey = createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
	const publicDer = Buffer.from(createPublicKey(privateKey).export({ type: "spki", format: "der" }));
	return {
		seedHex: seed.toString("hex"),
		privateKeyDerBase64: privateDer.toString("base64"),
		publicKeyDerBase64: publicDer.toString("base64"),
		publicRaw: x25519PublicKeyToRaw(publicDer.toString("base64")),
	};
}

const host = keyPairFromSeed(0x11);
const device = keyPairFromSeed(0x22);
const hostId = "host_AbCdEf0123456789";
const deviceId = "dev_ZyXwVu9876543210";
// Non-ASCII / escaping-sensitive device name exercises JSON.stringify parity.
const deviceName = 'Pixel "9" 手机\t\u0001é/\\';

const shared = computeX25519SharedSecret(device.privateKeyDerBase64, host.publicKeyDerBase64);
const sharedFromHost = computeX25519SharedSecret(host.privateKeyDerBase64, device.publicKeyDerBase64);
if (hex(shared) !== hex(sharedFromHost)) throw new Error("ECDH asymmetric");

const statics = deriveRemoteStaticKeys({ sharedSecret: shared, hostId, deviceId });

const offer = {
	v: 1 as const,
	mode: "relay" as const,
	url: "wss://35.213.93.187/relay",
	hostId,
	hostPub: host.publicRaw,
	pairingId: b64u(Buffer.alloc(16, 0x33)),
	secret: b64u(Buffer.alloc(32, 0x44)),
	exp: 1_900_000_000_000,
};
const deviceInfo = { deviceId, deviceName, devicePub: device.publicRaw };
const pairing = deriveRemotePairingSecrets(shared, offer, deviceInfo);
const secretBytes = new Uint8Array(Buffer.from(offer.secret, "base64url"));
const pairingToken = `token_${b64u(Buffer.alloc(24, 0x55))}`;
const pairingUri = `npi-remote://pair?p=${Buffer.from(JSON.stringify(offer), "utf8").toString("base64url")}`;

const deviceNonce = Buffer.alloc(32, 0x66);
const hostNonce = Buffer.alloc(32, 0x77);
const helloHeader: RemoteEnvelopeHeader = { v: 1, hostId, deviceId, kind: "hello", msgId: "m1" };
const welcomeHeader: RemoteEnvelopeHeader = { v: 1, hostId, deviceId, kind: "welcome", msgId: "m1" };
const sessionKeys = deriveRemoteSessionKeys({ sharedSecret: shared, hostId, deviceId, deviceNonce, hostNonce });

const aadHeaders: RemoteEnvelopeHeader[] = [
	{ v: 1, hostId, deviceId, kind: "control", msgId: "m2" },
	{ v: 1, hostId, deviceId, kind: "session", channelId: "ch_1", msgId: "m3" },
	{ v: 1, hostId, deviceId, kind: "session", channelId: "ch_1", streamEpoch: 2, seq: 40, msgId: "x" },
	{
		v: 1,
		hostId,
		deviceId,
		kind: "session",
		channelId: "ch_1",
		msgId: "m9",
		chunk: { id: "cm9", index: 1, count: 3 },
	},
	{ v: 1, hostId, deviceId, kind: "heartbeat" },
];

const body = { type: "host.info", text: '你好 "quoted" \u2028 line' };
const sealHeader: RemoteEnvelopeHeader = { v: 1, hostId, deviceId, kind: "control", msgId: "m2" };
const sealAad = canonicalHeaderAad(sealHeader);
const sealedHostToDevice = sealRemotePayload(sessionKeys.hostToDevice, 7n, sealAad, enc.encode(JSON.stringify(body)));
const sealedDeviceToHost = sealRemotePayload(sessionKeys.deviceToHost, 0n, sealAad, enc.encode(JSON.stringify(body)));
// sanity: TS can open what it sealed
openRemotePayload(sessionKeys.hostToDevice, sealAad, sealedHostToDevice);

const bigPlain = Buffer.alloc(256 * 1024 * 2 + 5, 0xab);
const pieces = splitRemotePlaintext(bigPlain);

const summaryParams = { hostId, deviceId, channelId: "ch_1", requestId: "req_1", seq: 3 };
const cipherSummary = sealPushSummary(statics.notification, summaryParams, "Approve bash: rm -rf build?");

const packed = packRemoteEnvelope(sealHeader, new Uint8Array([1, 2, 3, 4]));

const replaySequence = [0, 1, 1, 5, 3, 3, 70, 6, 5, 200, 140, 137, 200, 300];
const replayWindow = new ReplayWindow();
const replayExpected = replaySequence.map(counter => replayWindow.accept(BigInt(counter)));

const out = {
	note: "Generated by omp/packages/coding-agent/scripts/gen-remote-vectors.ts. Do not edit.",
	host: { ...host, hostId },
	device: { ...device, deviceId, deviceName },
	sharedSecretHex: hex(shared),
	statics: {
		helloAuthHex: hex(statics.helloAuth),
		notificationHex: hex(statics.notification),
		collapseHmacKeyHex: hex(statics.collapseHmacKey),
	},
	collapseKey: computeCollapseKey(statics.collapseHmacKey, "ch_1"),
	tokenHash: { token: pairingToken, sha256Hex: hashRemoteToken(pairingToken) },
	pairing: {
		uri: pairingUri,
		offer,
		deviceInfo,
		pairKeyHex: hex(pairing.pairKey),
		sas: pairing.sas,
		parts: {
			hello: remotePairingParts("hello", offer, deviceInfo),
			challenge: remotePairingParts("challenge", offer, deviceInfo),
			confirm: remotePairingParts("confirm", offer, deviceInfo),
			accept: remotePairingParts("accept", offer, deviceInfo),
		},
		macs: {
			hello: remoteMac(secretBytes, remotePairingParts("hello", offer, deviceInfo)),
			challenge: remoteMac(secretBytes, remotePairingParts("challenge", offer, deviceInfo)),
			confirm: remoteMac(pairing.pairKey, remotePairingParts("confirm", offer, deviceInfo)),
		},
		deviceToken: pairingToken,
		sealedAccept: sealRemotePairingAccept(pairing.pairKey, offer, deviceInfo, pairingToken),
	},
	handshake: {
		deviceNonce: b64u(deviceNonce),
		hostNonce: b64u(hostNonce),
		helloHeader,
		helloMacParts: remoteHelloMacParts(helloHeader, b64u(deviceNonce)),
		helloMac: remoteMac(statics.helloAuth, remoteHelloMacParts(helloHeader, b64u(deviceNonce))),
		welcomeHeader,
		welcomeMacParts: remoteWelcomeMacParts(welcomeHeader, b64u(deviceNonce), b64u(hostNonce)),
		welcomeMac: remoteMac(statics.helloAuth, remoteWelcomeMacParts(welcomeHeader, b64u(deviceNonce), b64u(hostNonce))),
		hostToDeviceKeyHex: hex(sessionKeys.hostToDevice),
		deviceToHostKeyHex: hex(sessionKeys.deviceToHost),
	},
	aad: aadHeaders.map(header => ({ header, aadUtf8: dec.decode(canonicalHeaderAad(header)) })),
	sealed: {
		header: sealHeader,
		bodyJson: JSON.stringify(body),
		hostToDevice: { counter: 7, sealedHex: hex(sealedHostToDevice) },
		deviceToHost: { counter: 0, sealedHex: hex(sealedDeviceToHost) },
	},
	chunking: {
		plaintextLength: bigPlain.byteLength,
		pieceLengths: pieces.map(piece => piece.byteLength),
	},
	envelope: { header: sealHeader, payloadHex: "01020304", packedHex: hex(packed) },
	pushSummary: {
		params: summaryParams,
		aadUtf8: dec.decode(canonicalSummaryAad(summaryParams)),
		plaintext: "Approve bash: rm -rf build?",
		cipherSummary,
	},
	replay: { sequence: replaySequence, expected: replayExpected },
};

console.log(JSON.stringify(out, null, 2));
