import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import {
	canonicalHeaderAad,
	CommandDedupCache,
	computeX25519SharedSecret,
	createRemotePairingOffer,
	deriveRemoteSessionKeys,
	deriveRemoteStaticKeys,
	generateRemoteToken,
	generateX25519KeyPair,
	hashRemoteToken,
	openPushSummary,
	openRemotePayload,
	PendingDialogTracker,
	REMOTE_CHUNK_PLAINTEXT_BYTES,
	REMOTE_PROTOCOL_VERSION,
	RemoteChunkAssembler,
	RemoteControlPlane,
	RemoteDeviceStore,
	RemoteDirectServer,
	type RemoteEnvelopeHeader,
	RemoteHostDaemon,
	RemoteRelayTunnel,
	RemoteSessionJournal,
	type RelayHostMessage,
	remoteEndpointUrl,
	ReplayWindow,
	runDirectPairing,
	sealPushSummary,
	sealRemotePayload,
	splitRemotePlaintext,
	x25519PublicKeyFromRaw,
	x25519PublicKeyToRaw,
} from "@oh-my-pi/pi-coding-agent/remote";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { ServerWebSocket } from "bun";
import { pairTestDevice, TestRemoteConnection, TestRemoteDevice } from "./helpers/remote-device";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

interface DeltaFrame {
	assistantMessageEvent: { delta: string };
}

interface OpenedChannelBody {
	channelId: string;
	streamEpoch: number;
	state: { approvalMode: string };
}

function addTestDevice(store: RemoteDeviceStore, hostPubDer: string, deviceId: string) {
	const token = generateRemoteToken();
	const device = new TestRemoteDevice({ hostId: store.loadOrCreate().hostId, hostPubDer, deviceId });
	store.addDevice({
		deviceId,
		name: deviceId,
		publicKeyDerBase64: device.keyPair.publicKeyDerBase64,
		tokenHash: hashRemoteToken(token),
		pairedAt: new Date().toISOString(),
	});
	return { device, token };
}

describe("Remote Connect crypto & protocol", () => {
	test("raw X25519 keys round-trip and both sides agree on static and session keys", () => {
		const hostKp = generateX25519KeyPair();
		const devKp = generateX25519KeyPair();
		expect(x25519PublicKeyFromRaw(x25519PublicKeyToRaw(hostKp.publicKeyDerBase64))).toBe(hostKp.publicKeyDerBase64);
		expect(() => x25519PublicKeyFromRaw("AAAA")).toThrow();

		const secretHost = computeX25519SharedSecret(hostKp.privateKeyDerBase64, devKp.publicKeyDerBase64);
		const secretDev = computeX25519SharedSecret(devKp.privateKeyDerBase64, hostKp.publicKeyDerBase64);
		const ids = { hostId: "host-1", deviceId: "dev-1" };
		expect(deriveRemoteStaticKeys({ sharedSecret: secretHost, ...ids })).toEqual(
			deriveRemoteStaticKeys({ sharedSecret: secretDev, ...ids }),
		);
		const nonces = { deviceNonce: new Uint8Array(32).fill(1), hostNonce: new Uint8Array(32).fill(2) };
		const hostSession = deriveRemoteSessionKeys({ sharedSecret: secretHost, ...ids, ...nonces });
		const devSession = deriveRemoteSessionKeys({ sharedSecret: secretDev, ...ids, ...nonces });
		expect(hostSession).toEqual(devSession);
		const otherSession = deriveRemoteSessionKeys({
			sharedSecret: secretHost,
			...ids,
			...nonces,
			hostNonce: new Uint8Array(32).fill(3),
		});
		expect(Buffer.compare(otherSession.hostToDevice, hostSession.hostToDevice)).not.toBe(0);
	});

	test("AAD binds routing and chunk fields; forged frames do not burn replay counters", () => {
		const key = new Uint8Array(32).fill(7);
		const header: RemoteEnvelopeHeader = {
			v: REMOTE_PROTOCOL_VERSION,
			hostId: "host-1",
			deviceId: "dev-1",
			kind: "session",
			channelId: "ch-1",
			streamEpoch: 1,
			seq: 7,
			msgId: "msg-1",
			chunk: { id: "c1", index: 0, count: 2 },
		};
		const sealed = sealRemotePayload(key, 5n, canonicalHeaderAad(header), TEXT_ENCODER.encode('{"ok":true}'));
		const replay = new ReplayWindow();

		const forged = sealed.slice();
		forged[forged.length - 1] ^= 1;
		expect(() => openRemotePayload(key, canonicalHeaderAad(header), forged, replay)).toThrow();
		expect(() =>
			openRemotePayload(
				key,
				canonicalHeaderAad({ ...header, chunk: { id: "c1", index: 1, count: 2 } }),
				sealed,
				replay,
			),
		).toThrow();

		expect(TEXT_DECODER.decode(openRemotePayload(key, canonicalHeaderAad(header), sealed, replay))).toBe(
			'{"ok":true}',
		);
		expect(() => openRemotePayload(key, canonicalHeaderAad(header), sealed, replay)).toThrow(/Replayed/);
	});

	test("push summaries use random nonces and bind their AAD", () => {
		const key = new Uint8Array(32).fill(9);
		const aad = { hostId: "host-1", deviceId: "dev-1", channelId: "ch-1", requestId: "ui-1", seq: 7 };
		const a = sealPushSummary(key, aad, "Approval needed: bash (exec)");
		const b = sealPushSummary(key, aad, "Approval needed: bash (exec)");
		expect(a).not.toBe(b);
		expect(openPushSummary(key, aad, a)).toBe("Approval needed: bash (exec)");
		expect(() => openPushSummary(key, { ...aad, seq: 8 }, a)).toThrow();
	});

	test("chunk split and reassembly, out of order, with header validation", () => {
		const plaintext = new Uint8Array(REMOTE_CHUNK_PLAINTEXT_BYTES * 2 + 10).map((_, i) => i % 251);
		const pieces = splitRemotePlaintext(plaintext);
		expect(pieces).toHaveLength(3);
		expect(splitRemotePlaintext(new Uint8Array(10))).toHaveLength(1);

		const assembler = new RemoteChunkAssembler();
		expect(assembler.accept("dev", { id: "x", index: 2, count: 3 }, pieces[2]!)).toBeUndefined();
		expect(assembler.accept("dev", { id: "x", index: 0, count: 3 }, pieces[0]!)).toBeUndefined();
		expect(() => assembler.accept("dev", { id: "x", index: 0, count: 3 }, pieces[0]!)).toThrow(/Duplicate/);
		const full = assembler.accept("dev", { id: "x", index: 1, count: 3 }, pieces[1]!);
		expect(full && Buffer.compare(full, plaintext)).toBe(0);
		expect(() => assembler.accept("dev", { id: "y", index: 3, count: 3 }, pieces[0]!)).toThrow(/Invalid/);
	});

	test("remoteEndpointUrl keeps a Relay path prefix", () => {
		expect(remoteEndpointUrl("wss://1.2.3.4/relay/", "/ws/host", { hostId: "h" })).toBe(
			"wss://1.2.3.4/relay/ws/host?hostId=h",
		);
		expect(() => remoteEndpointUrl("https://x", "/ws/host")).toThrow();
	});
});

describe("RemoteSessionJournal, PendingDialogTracker, and CommandDedupCache", () => {
	test("coalesces text_delta, replays sinceSeq, and triggers reset on epoch mismatch", () => {
		const journal = new RemoteSessionJournal(2);
		const { seq: s1 } = journal.push({
			type: "message_update",
			messageId: "m1",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
		});
		const { seq: s2, coalesced } = journal.push({
			type: "message_update",
			messageId: "m1",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
		});
		expect(s1).toBe(1);
		expect(s2).toBe(2);
		expect(coalesced).toBe(true);
		expect(journal.bufferedCount).toBe(1);

		const replay = journal.replaySince(2, 0);
		expect(replay.kind).toBe("replay");
		if (replay.kind === "replay") {
			expect(replay.frames).toHaveLength(1);
			const f = replay.frames[0]!.frame as DeltaFrame;
			expect(f.assistantMessageEvent.delta).toBe("Hello");
		}

		expect(journal.replaySince(1, 0).kind).toBe("reset");
	});

	test("PendingDialogTracker tracks interactive prompts and clears on cancel/resolve", () => {
		const tracker = new PendingDialogTracker();
		tracker.observeOutbound({
			type: "extension_ui_request",
			id: "req-1",
			method: "select",
			title: "Approve bash",
			options: ["Approve", "Deny"],
			toolName: "bash",
			tier: "exec",
		});
		tracker.observeOutbound({ type: "extension_ui_request", id: "n1", method: "notify", message: "info" });
		expect(tracker.size).toBe(1);

		tracker.observeOutbound({ type: "extension_ui_request", id: "c1", method: "cancel", targetId: "req-1" });
		expect(tracker.size).toBe(0);
	});

	test("CommandDedupCache caches by (deviceId, msgId) and expires", () => {
		const cache = new CommandDedupCache<string>({ ttlMs: 1000, maxEntries: 10 });
		cache.set("dev-a", "m1", "res-1", 100);
		expect(cache.get("dev-a", "m1", 500)).toBe("res-1");
		expect(cache.get("dev-b", "m1", 500)).toBeUndefined();
		expect(cache.get("dev-a", "m1", 1500)).toBeUndefined();
	});
});

describe("RemoteControlPlane & RemoteHostDaemon E2E", () => {
	test("control plane confines fs, redacts credentials, and manages mcp.json", async () => {
		using temp = TempDir.createSync("@omp-remote-cp-");
		const workspace = temp.join("workspace");
		const subDir = path.join(workspace, "project-a");
		const agentDir = temp.join("agent");
		fs.mkdirSync(subDir, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { docs: { type: "stdio", command: "echo" } }, disabledServers: [] }),
		);

		const cp = new RemoteControlPlane({
			hostId: "host-cp",
			allowedRoots: [workspace],
			agentDir,
		});
		const listRes = (await cp.execute({ type: "host.fs.list", path: workspace })) as {
			directories: Array<{ name: string }>;
		};
		expect(listRes.directories.map(d => d.name)).toEqual(["project-a"]);

		await expect(cp.execute({ type: "host.fs.list", path: "/etc" })).rejects.toThrow();

		const schema = (await cp.execute({ type: "host.config.schema" })) as {
			settings: Array<{ id: string }>;
		};
		expect(schema.settings.length).toBeGreaterThan(10);

		const listed = (await cp.execute({ type: "host.config.list" })) as {
			items: Array<{ id: string; redacted?: true; value?: unknown }>;
		};
		const redactedItems = listed.items.filter(item => item.redacted === true);
		expect(redactedItems.length).toBeGreaterThan(0);
		for (const item of redactedItems) {
			expect(item.value).toBeUndefined();
		}

		await cp.execute({ type: "host.mcp.toggle", name: "docs", enabled: false });
		const mcpList = (await cp.execute({ type: "host.mcp.list" })) as {
			servers: Array<{ name: string; transport: string; enabled: boolean }>;
		};
		expect(mcpList.servers).toEqual([{ name: "docs", transport: "stdio", enabled: false }]);
	});

	test("control plane rejects symlink escapes, dangerous config keys, global yolo and option-like providers", async () => {
		using temp = TempDir.createSync("@omp-remote-cp-sec-");
		const workspace = temp.join("workspace");
		const outside = temp.join("outside");
		const agentDir = temp.join("agent");
		fs.mkdirSync(workspace, { recursive: true });
		fs.mkdirSync(outside, { recursive: true });
		fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
		fs.symlinkSync(outside, path.join(workspace, "escape"));
		await Bun.write(path.join(outside, "s.jsonl"), "{}\n");
		fs.symlinkSync(path.join(outside, "s.jsonl"), path.join(agentDir, "sessions", "link.jsonl"));

		const cp = new RemoteControlPlane({ hostId: "host-sec", allowedRoots: [workspace], agentDir });
		await expect(cp.execute({ type: "host.fs.list", path: path.join(workspace, "escape") })).rejects.toThrow(
			/outside allowed/,
		);
		expect(() => cp.assertManagedSessionPath(path.join(agentDir, "sessions", "link.jsonl"))).toThrow(/outside managed/);
		for (const key of ["tools.approvalMode", "bash.patterns", "shellPath", "searxng.endpoint"]) {
			await expect(cp.execute({ type: "host.config.set", key, value: "x" })).rejects.toThrow(/cannot be modified/);
		}
		await expect(cp.execute({ type: "host.approval_mode.set", mode: "yolo" })).rejects.toThrow(/yolo/);
		await expect(
			cp.execute({ type: "host.account.activate", provider: "--help", credentialId: 1 }),
		).rejects.toThrow(/Invalid account provider/);
		const schema = (await cp.execute({ type: "host.config.schema" })) as { settings: Array<{ id: string }> };
		expect(schema.settings.some(s => s.id === "tools.approvalMode")).toBe(false);
	});

	test("RemoteDirectServer + RemoteHostDaemon E2E over encrypted Binary WSS with real rpc-ui child", async () => {
		using temp = TempDir.createSync("@omp-remote-e2e-");
		const workspace = temp.join("workspace");
		const agentDir = temp.join("agent");
		const homeDir = temp.join("home");
		fs.mkdirSync(workspace, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(homeDir, { recursive: true });
		await Bun.write(path.join(agentDir, "models.yml"), `providers:\n  anthropic:\n    auth: none\n`);

		const store = new RemoteDeviceStore(temp.join("remote-devices.json"));
		const registry = store.loadOrCreate("host-e2e");
		const { device, token } = addTestDevice(store, registry.hostKeyPair.publicKeyDerBase64, "pixel-test-01");

		const cliPath = path.join(import.meta.dir, "..", "src", "cli.ts");
		const daemon = new RemoteHostDaemon({
			deviceStore: store,
			allowedRoots: [workspace],
			defaultApprovalMode: "write",
			createRpcClient: opts =>
				new RpcClient({
					...opts,
					command: [process.execPath, cliPath],
					args: [...(opts.args ?? []), "--no-session", "--no-extensions", "--no-skills"],
					env: {
						...opts.env,
						HOME: homeDir,
						PI_CODING_AGENT_DIR: agentDir,
						XDG_CONFIG_HOME: temp.join("xdg-config"),
						XDG_DATA_HOME: temp.join("xdg-data"),
						XDG_CACHE_HOME: temp.join("xdg-cache"),
						PI_NO_TITLE: "1",
					},
				}),
		});
		const directServer = new RemoteDirectServer({ hostname: "127.0.0.1", port: 0, daemon, deviceStore: store });
		const baseUrl = `ws://127.0.0.1:${directServer.start()}`;

		const rejected = await fetch(`http://127.0.0.1:${directServer.port}/ws/client?deviceId=pixel-test-01`, {
			headers: { Authorization: "Bearer wrong", Upgrade: "websocket", Connection: "Upgrade" },
		});
		expect(rejected.status).toBe(401);

		const conn = await TestRemoteConnection.open(baseUrl, device, token);
		try {
			const opened = await conn.request("control", {
				type: "host.sessions.open",
				cwd: workspace,
				approvalMode: "write",
			});
			expect(opened.ok).toBe(true);
			const channel = (opened as { result: OpenedChannelBody }).result;
			expect(channel.channelId).toMatch(/^ch_/);
			expect(channel.state.approvalMode).toBe("write");

			const state = await conn.request(
				"session",
				{ kind: "rpc", command: { type: "get_state" } },
				channel.channelId,
			);
			expect(state).toMatchObject({ ok: true, result: { success: true, data: { approvalMode: "write" } } });

			const synced = await conn.request("control", {
				type: "host.sessions.sync",
				channelId: channel.channelId,
				streamEpoch: channel.streamEpoch,
				sinceSeq: 0,
			});
			expect(synced).toMatchObject({ ok: true, result: { kind: "replay" } });

			const bash = await conn.request(
				"session",
				{ kind: "rpc", command: { type: "bash", command: "whoami" } },
				channel.channelId,
			);
			expect(bash.ok).toBe(false);
			expect(!bash.ok && bash.error).toMatch(/forbidden/);

			// Inbound message larger than one chunk is reassembled before dispatch.
			const big = await conn.request("control", {
				type: "host.info",
				pad: "x".repeat(REMOTE_CHUNK_PLAINTEXT_BYTES + 1000),
			});
			expect(big).toMatchObject({ ok: true, result: { hostId: "host-e2e" } });

			// A reconnect starts without a session; a new hello restores service.
			conn.close();
			const again = await TestRemoteConnection.open(baseUrl, device, token);
			try {
				const info = await again.request("control", { type: "host.info" });
				expect(info).toMatchObject({ ok: true, result: { hostId: "host-e2e" } });
				// Revocation applies to the live session on the next frame.
				store.revokeDevice("pixel-test-01");
				const [frame] = device.seal("control", { type: "host.info" }, { msgId: device.nextMsgId() });
				await expect(daemon.handleIncomingEnvelope(frame!)).rejects.toThrow(/revoked/);
			} finally {
				again.close();
			}
		} finally {
			directServer.stop();
			await daemon.stop();
		}
	}, 45_000);
});

describe("Remote pairing", () => {
	async function pairOnce(options: { deviceConfirms: boolean; hostConfirms: boolean; tamperSecret?: boolean }) {
		using temp = TempDir.createSync("@omp-remote-pair-");
		const store = new RemoteDeviceStore(temp.join("remote-devices.json"));
		const listening = Promise.withResolvers<number>();
		let hostSas: string | undefined;
		const port = 20000 + Math.floor(Math.random() * 20000);
		const offer = createRemotePairingOffer(store, { mode: "direct", url: `ws://127.0.0.1:${port}`, ttlMs: 30_000 });
		const hostResult = runDirectPairing({
			store,
			offer,
			hostname: "127.0.0.1",
			port,
			onListening: listening.resolve,
			confirmSas: async info => {
				hostSas = info.sas;
				return options.hostConfirms;
			},
		});
		await listening.promise;
		const deviceResult = await pairTestDevice({
			offer,
			deviceId: "dev_pixel_0001",
			deviceName: "Pixel 9",
			confirm: options.deviceConfirms,
			tamperSecret: options.tamperSecret,
		});
		return { host: await hostResult, device: deviceResult, hostSas, devices: store.listDevices() };
	}

	test("both sides confirm: SAS matches, device stored with token hash only", async () => {
		const { host, device, hostSas, devices } = await pairOnce({ deviceConfirms: true, hostConfirms: true });
		expect(host.status).toBe("paired");
		expect(device.status).toBe("paired");
		if (device.status !== "paired") return;
		expect(device.sas).toBe(hostSas!);
		expect(devices).toHaveLength(1);
		expect(devices[0]).toMatchObject({
			deviceId: "dev_pixel_0001",
			name: "Pixel 9",
			tokenHash: hashRemoteToken(device.token),
		});
		expect(devices[0]!.publicKeyDerBase64).toBe(device.keyPair.publicKeyDerBase64);
	});

	test("host rejection, device cancellation, and a wrong pairing secret store nothing", async () => {
		const hostNo = await pairOnce({ deviceConfirms: true, hostConfirms: false });
		expect(hostNo.host).toEqual({ status: "rejected", reason: "rejected on host" });
		expect(hostNo.device).toEqual({ status: "rejected", reason: "rejected on host" });
		expect(hostNo.devices).toHaveLength(0);

		const deviceNo = await pairOnce({ deviceConfirms: false, hostConfirms: true });
		expect(deviceNo.host.status).toBe("rejected");
		expect(deviceNo.devices).toHaveLength(0);

		const forged = await pairOnce({ deviceConfirms: true, hostConfirms: true, tamperSecret: true });
		expect(forged.host).toEqual({ status: "rejected", reason: "pairing secret MAC mismatch" });
		expect(forged.hostSas).toBeUndefined();
		expect(forged.devices).toHaveLength(0);
	});
});

describe("RemoteRelayTunnel", () => {
	test("authenticates to the Relay, syncs devices (incl. revocation), and routes device frames", async () => {
		using temp = TempDir.createSync("@omp-remote-relay-");
		const workspace = temp.join("workspace");
		fs.mkdirSync(workspace, { recursive: true });
		const store = new RemoteDeviceStore(temp.join("remote-devices.json"));
		const registry = store.loadOrCreate("host-relay");
		const { device } = addTestDevice(store, registry.hostKeyPair.publicKeyDerBase64, "pixel-relay-01");

		const syncs: RelayHostMessage[] = [];
		const syncWaiters: Array<() => void> = [];
		const fromHost: Uint8Array[] = [];
		let hostSocket: ServerWebSocket<undefined> | undefined;
		const hostConnected = Promise.withResolvers<void>();
		const relay = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request, server) => {
				const url = new URL(request.url);
				if (url.pathname !== "/relay/ws/host") return new Response("nope", { status: 404 });
				if (request.headers.get("authorization") !== `Bearer ${registry.relayHostToken}`) {
					return new Response("bad token", { status: 401 });
				}
				if (url.searchParams.get("hostId") !== "host-relay") return new Response("bad host", { status: 400 });
				return server.upgrade(request) ? undefined : new Response("upgrade failed", { status: 400 });
			},
			websocket: {
				open: ws => {
					hostSocket = ws;
					hostConnected.resolve();
				},
				message: (_ws, message) => {
					if (typeof message === "string") {
						const parsed = JSON.parse(message) as RelayHostMessage;
						if (parsed.type === "relay.devices") {
							syncs.push(parsed);
							syncWaiters.shift()?.();
						}
						return;
					}
					fromHost.push(new Uint8Array(message));
				},
			},
		});
		const nextSync = () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			syncWaiters.push(resolve);
			return promise;
		};

		const daemon = new RemoteHostDaemon({ deviceStore: store, allowedRoots: [workspace] });
		const tunnel = new RemoteRelayTunnel({
			relayUrl: `ws://127.0.0.1:${relay.port}/relay`,
			daemon,
			deviceStore: store,
		});
		const firstSync = nextSync();
		tunnel.start();
		try {
			await hostConnected.promise;
			await firstSync;
			expect(syncs[0]).toEqual({
				type: "relay.devices",
				devices: [{ deviceId: "pixel-relay-01", tokenHash: store.listDevices()[0]!.tokenHash, revoked: false }],
			});

			const waitForHostFrame = async () => {
				while (fromHost.length === 0) await Bun.sleep(10);
				return fromHost.shift()!;
			};
			hostSocket!.sendBinary(device.hello());
			expect(device.receive(await waitForHostFrame())?.header.kind).toBe("welcome");
			for (const frame of device.seal("control", { type: "host.info" }, { msgId: "relay-1" }))
				hostSocket!.sendBinary(frame);
			const reply = device.receive(await waitForHostFrame());
			expect(reply?.header.msgId).toBe("relay-1");
			expect(reply?.body).toMatchObject({ ok: true, result: { hostId: "host-relay" } });

			const revokedSync = nextSync();
			store.revokeDevice("pixel-relay-01");
			await revokedSync;
			expect(syncs.at(-1)).toMatchObject({ devices: [{ deviceId: "pixel-relay-01", revoked: true }] });
		} finally {
			tunnel.close();
			relay.stop(true);
			await daemon.stop();
		}
	});
});
