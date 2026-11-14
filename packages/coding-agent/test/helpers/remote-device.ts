/**
 * Phone-side reference implementation of the Remote Connect protocol, used by tests.
 * Mirrors what the Flutter client must do: pairing, hello/welcome, sealing, chunking.
 */
import { randomBytes } from "node:crypto";
import {
	canonicalHeaderAad,
	computeX25519SharedSecret,
	deriveRemotePairingSecrets,
	deriveRemoteSessionKeys,
	deriveRemoteStaticKeys,
	fromBase64Url,
	generateX25519KeyPair,
	openRemotePairingAccept,
	openRemotePayload,
	packRemoteEnvelope,
	REMOTE_PROTOCOL_VERSION,
	RemoteChunkAssembler,
	type RemoteEnvelopeHeader,
	type RemotePairingMessage,
	type RemotePairingOffer,
	type RemoteReply,
	type RemoteSessionKeys,
	type RemoteStaticKeys,
	type RemoteWelcomePayload,
	remoteEndpointUrl,
	remoteHelloMacParts,
	remoteMac,
	remotePairingParts,
	remoteWelcomeMacParts,
	ReplayWindow,
	sealRemotePayload,
	splitRemotePlaintext,
	toBase64Url,
	unpackRemoteEnvelope,
	verifyRemoteMac,
	type X25519KeyPairSerialized,
	x25519PublicKeyFromRaw,
	x25519PublicKeyToRaw,
} from "@oh-my-pi/pi-coding-agent/remote";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

export class TestRemoteDevice {
	readonly deviceId: string;
	readonly hostId: string;
	readonly keyPair: X25519KeyPairSerialized;
	readonly #sharedSecret: Uint8Array;
	readonly #statics: RemoteStaticKeys;
	readonly #chunks = new RemoteChunkAssembler();
	#session: { keys: RemoteSessionKeys; replay: ReplayWindow; counter: bigint } | undefined;
	#pendingNonce: string | undefined;
	#msg = 0;

	constructor(options: { hostId: string; hostPubDer: string; deviceId: string; keyPair?: X25519KeyPairSerialized }) {
		this.deviceId = options.deviceId;
		this.hostId = options.hostId;
		this.keyPair = options.keyPair ?? generateX25519KeyPair();
		this.#sharedSecret = computeX25519SharedSecret(this.keyPair.privateKeyDerBase64, options.hostPubDer);
		this.#statics = deriveRemoteStaticKeys({
			sharedSecret: this.#sharedSecret,
			hostId: this.hostId,
			deviceId: this.deviceId,
		});
	}

	get notificationKey(): Uint8Array {
		return this.#statics.notification;
	}

	get hasSession(): boolean {
		return this.#session !== undefined;
	}

	nextMsgId(): string {
		return `m${++this.#msg}`;
	}

	#header(kind: RemoteEnvelopeHeader["kind"], extra: Partial<RemoteEnvelopeHeader> = {}): RemoteEnvelopeHeader {
		return { v: REMOTE_PROTOCOL_VERSION, hostId: this.hostId, deviceId: this.deviceId, kind, ...extra };
	}

	hello(): Uint8Array {
		const deviceNonce = toBase64Url(new Uint8Array(randomBytes(32)));
		this.#pendingNonce = deviceNonce;
		const header = this.#header("hello", { msgId: this.nextMsgId() });
		const mac = remoteMac(this.#statics.helloAuth, remoteHelloMacParts(header, deviceNonce));
		return packRemoteEnvelope(header, TEXT_ENCODER.encode(JSON.stringify({ deviceNonce, mac })));
	}

	/** Seal one request; returns every envelope (several when chunked). */
	seal(kind: "control" | "session", body: unknown, options: { channelId?: string; msgId: string }): Uint8Array[] {
		const session = this.#session;
		if (!session) throw new Error("No session; send hello first");
		const pieces = splitRemotePlaintext(TEXT_ENCODER.encode(JSON.stringify(body)));
		const chunkId = pieces.length > 1 ? `c${options.msgId}` : undefined;
		return pieces.map((piece, index) => {
			const header = this.#header(kind, {
				...(options.channelId ? { channelId: options.channelId } : {}),
				msgId: options.msgId,
				...(chunkId ? { chunk: { id: chunkId, index, count: pieces.length } } : {}),
			});
			return packRemoteEnvelope(
				header,
				sealRemotePayload(session.keys.deviceToHost, session.counter++, canonicalHeaderAad(header), piece),
			);
		});
	}

	/**
	 * Process one host frame. Returns the decrypted body for complete sealed messages,
	 * `undefined` for handshake / header-only / incomplete chunk frames.
	 */
	receive(frame: Uint8Array): { header: RemoteEnvelopeHeader; body: unknown } | undefined {
		const { header, payload } = unpackRemoteEnvelope(frame);
		if (header.kind === "welcome") {
			const welcome = JSON.parse(TEXT_DECODER.decode(payload)) as RemoteWelcomePayload;
			const deviceNonce = this.#pendingNonce;
			if (!deviceNonce) throw new Error("Unexpected welcome");
			if (
				!verifyRemoteMac(
					this.#statics.helloAuth,
					remoteWelcomeMacParts(header, deviceNonce, welcome.hostNonce),
					welcome.mac,
				)
			) {
				throw new Error("Welcome MAC mismatch");
			}
			this.#pendingNonce = undefined;
			this.#session = {
				keys: deriveRemoteSessionKeys({
					sharedSecret: this.#sharedSecret,
					hostId: this.hostId,
					deviceId: this.deviceId,
					deviceNonce: fromBase64Url(deviceNonce),
					hostNonce: fromBase64Url(welcome.hostNonce),
				}),
				replay: new ReplayWindow(),
				counter: 0n,
			};
			return { header, body: undefined };
		}
		if (header.kind === "rehello" || header.kind === "push") {
			if (header.kind === "rehello") this.#session = undefined;
			return { header, body: undefined };
		}
		const session = this.#session;
		if (!session) throw new Error(`Sealed ${header.kind} frame without a session`);
		let plain: Uint8Array | undefined = openRemotePayload(
			session.keys.hostToDevice,
			canonicalHeaderAad(header),
			payload,
			session.replay,
		);
		if (header.chunk) {
			plain = this.#chunks.accept("host", header.chunk, plain);
			if (!plain) return undefined;
		}
		return { header, body: JSON.parse(TEXT_DECODER.decode(plain)) };
	}
}

/** WebSocket wrapper that performs the hello handshake and correlates replies by `msgId`. */
export class TestRemoteConnection {
	readonly device: TestRemoteDevice;
	readonly ws: WebSocket;
	readonly frames: Array<{ header: RemoteEnvelopeHeader; body: unknown }> = [];
	/** Relay control text frames (`relay.host_state`, `pong`); a direct host sends none. */
	readonly relayMessages: unknown[] = [];
	readonly #waiters = new Map<string, (reply: RemoteReply) => void>();
	#welcome = Promise.withResolvers<void>();

	private constructor(device: TestRemoteDevice, ws: WebSocket) {
		this.device = device;
		this.ws = ws;
		ws.addEventListener("message", event => {
			if (typeof event.data === "string") {
				this.relayMessages.push(JSON.parse(event.data));
				return;
			}
			const received = device.receive(new Uint8Array(event.data as ArrayBuffer));
			if (!received) return;
			this.frames.push(received);
			if (received.header.kind === "welcome") {
				this.#welcome.resolve();
				return;
			}
			const msgId = received.header.msgId;
			const waiter = msgId ? this.#waiters.get(msgId) : undefined;
			if (msgId && waiter) {
				this.#waiters.delete(msgId);
				waiter(received.body as RemoteReply);
			}
		});
	}

	static async open(url: string, device: TestRemoteDevice, token: string): Promise<TestRemoteConnection> {
		const ws = new WebSocket(
			remoteEndpointUrl(url, "/ws/client", { hostId: device.hostId, deviceId: device.deviceId }),
			{
				headers: { Authorization: `Bearer ${token}` },
			},
		);
		ws.binaryType = "arraybuffer";
		const opened = Promise.withResolvers<void>();
		ws.addEventListener("open", () => opened.resolve(), { once: true });
		ws.addEventListener("close", event => opened.reject(new Error(`closed ${event.code}`)), { once: true });
		await opened.promise;
		const connection = new TestRemoteConnection(device, ws);
		await connection.handshake();
		return connection;
	}

	async handshake(): Promise<void> {
		this.#welcome = Promise.withResolvers<void>();
		this.ws.send(this.device.hello());
		await this.#welcome.promise;
	}

	async request(kind: "control" | "session", body: unknown, channelId?: string): Promise<RemoteReply> {
		const msgId = this.device.nextMsgId();
		const { promise, resolve } = Promise.withResolvers<RemoteReply>();
		this.#waiters.set(msgId, resolve);
		for (const frame of this.device.seal(kind, body, { channelId, msgId })) this.ws.send(frame);
		return await promise;
	}

	close(): void {
		this.ws.close();
	}
}

/** Phone side of pairing over `/ws/pair`. `confirm` decides what the "user" taps. */
export async function pairTestDevice(options: {
	offer: RemotePairingOffer;
	deviceId: string;
	deviceName: string;
	confirm: boolean;
	tamperSecret?: boolean;
}): Promise<
	| { status: "paired"; token: string; sas: string; keyPair: X25519KeyPairSerialized }
	| { status: "rejected"; reason: string }
> {
	const { offer } = options;
	const keyPair = generateX25519KeyPair();
	const device = {
		deviceId: options.deviceId,
		deviceName: options.deviceName,
		devicePub: x25519PublicKeyToRaw(keyPair.publicKeyDerBase64),
	};
	const secret = fromBase64Url(offer.secret);
	if (options.tamperSecret) secret[0] ^= 0xff;
	const shared = computeX25519SharedSecret(keyPair.privateKeyDerBase64, x25519PublicKeyFromRaw(offer.hostPub));
	const { pairKey, sas } = deriveRemotePairingSecrets(shared, offer, device);

	const ws = new WebSocket(remoteEndpointUrl(offer.url, "/ws/pair", { role: "device", pairingId: offer.pairingId }));
	const result = Promise.withResolvers<
		| { status: "paired"; token: string; sas: string; keyPair: X25519KeyPairSerialized }
		| { status: "rejected"; reason: string }
	>();
	const send = (message: RemotePairingMessage) => ws.send(JSON.stringify(message));
	ws.addEventListener("open", () => {
		send({
			type: "pair.hello",
			pairingId: offer.pairingId,
			...device,
			mac: remoteMac(secret, remotePairingParts("hello", offer, device)),
		});
	});
	ws.addEventListener("message", event => {
		const message = JSON.parse(String(event.data)) as RemotePairingMessage;
		switch (message.type) {
			case "pair.challenge":
				if (!verifyRemoteMac(secret, remotePairingParts("challenge", offer, device), message.mac)) {
					send({ type: "pair.cancel" });
					result.resolve({ status: "rejected", reason: "host challenge MAC mismatch" });
					return;
				}
				if (options.confirm)
					send({ type: "pair.confirm", mac: remoteMac(pairKey, remotePairingParts("confirm", offer, device)) });
				else {
					send({ type: "pair.cancel" });
					result.resolve({ status: "rejected", reason: "cancelled on device" });
				}
				return;
			case "pair.accept":
				result.resolve({
					status: "paired",
					token: openRemotePairingAccept(pairKey, offer, device, message.sealed).deviceToken,
					sas,
					keyPair,
				});
				return;
			case "pair.reject":
				result.resolve({ status: "rejected", reason: message.reason });
				return;
		}
	});
	ws.addEventListener("close", () => result.resolve({ status: "rejected", reason: "socket closed" }));
	try {
		return await result.promise;
	} finally {
		ws.close();
	}
}
