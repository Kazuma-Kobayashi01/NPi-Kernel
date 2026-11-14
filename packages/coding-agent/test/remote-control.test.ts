import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { CollabGuestUiResult } from "@oh-my-pi/pi-coding-agent/collab/host";
import { combineGuestUiPeers, type GuestUiPeer } from "@oh-my-pi/pi-coding-agent/modes/controllers/guest-ui-peers";
import { TempDir } from "@oh-my-pi/pi-utils";

const sourceDir = path.join(import.meta.dir, "..", "src");
const helpersDir = path.join(import.meta.dir, "helpers");

/** A peer whose answer the test hands over by hand; records whether its offer was withdrawn. */
function manualPeer() {
	let settle: ((result: CollabGuestUiResult) => void) | undefined;
	const peer = {
		withdrawn: false as boolean,
		answer(result: CollabGuestUiResult) {
			settle?.(result);
		},
		requestGuestUi(_request, signal) {
			const { promise, resolve } = Promise.withResolvers<CollabGuestUiResult>();
			settle = resolve;
			signal?.addEventListener("abort", () => {
				peer.withdrawn = true;
				resolve({ kind: "unavailable" });
			});
			return promise;
		},
	} satisfies GuestUiPeer & { withdrawn: boolean; answer(result: CollabGuestUiResult): void };
	return peer;
}

const select = { kind: "select" as const, title: "Approve?", options: ["Approve", "Deny"] };

describe("guest dialog peers", () => {
	test("the first answer wins and withdraws the dialog from the other peer", async () => {
		const collab = manualPeer();
		const phone = manualPeer();
		const pending = combineGuestUiPeers([collab, phone])!.requestGuestUi(select)!;
		phone.answer({ kind: "answered", value: "Approve" });
		expect(await pending).toEqual({ kind: "answered", value: "Approve" });
		expect(collab.withdrawn).toBe(true);
	});

	test("a peer going away is not an answer: the other one still can answer", async () => {
		const collab = manualPeer();
		const phone = manualPeer();
		const pending = combineGuestUiPeers([collab, phone])!.requestGuestUi(select)!;
		collab.answer({ kind: "unavailable" });
		phone.answer({ kind: "answered", value: "Deny" });
		expect(await pending).toEqual({ kind: "answered", value: "Deny" });
	});

	test("unavailable only when every peer is gone, and no peers means no offer", async () => {
		const collab = manualPeer();
		const phone = manualPeer();
		const pending = combineGuestUiPeers([collab, undefined, phone])!.requestGuestUi(select)!;
		collab.answer({ kind: "unavailable" });
		phone.answer({ kind: "unavailable" });
		expect(await pending).toEqual({ kind: "unavailable" });
		expect(combineGuestUiPeers([undefined, undefined])).toBeUndefined();
	});
});

describe("/rc remote control", () => {
	test("phones join the terminal's live session, answer its dialogs, and leave it running", async () => {
		using temp = TempDir.createSync("@omp-remote-control-");
		const fixturePath = temp.join("fixture.ts");
		await Bun.write(
			fixturePath,
			`
import * as fs from "node:fs";
import { createAgentSession, Settings } from ${JSON.stringify(path.join(sourceDir, "sdk.ts"))};
import { SessionManager } from ${JSON.stringify(path.join(sourceDir, "session/session-manager.ts"))};
import { RpcClient } from ${JSON.stringify(path.join(sourceDir, "modes/rpc/rpc-client.ts"))};
import { embeddedRpcProcess, requestUiOverRpc } from ${JSON.stringify(path.join(sourceDir, "remote/remote-control.ts"))};
import { generateRemoteToken, hashRemoteToken, RemoteDeviceStore, RemoteDirectServer, RemoteHostDaemon } from ${JSON.stringify(path.join(sourceDir, "remote/index.ts"))};
import { TestRemoteConnection, TestRemoteDevice } from ${JSON.stringify(path.join(helpersDir, "remote-device.ts"))};

globalThis.fetch = async () => { throw new Error("offline fixture"); };
const workspace = ${JSON.stringify(temp.join("workspace"))};
fs.mkdirSync(workspace, { recursive: true });
const { session } = await createAgentSession({
	cwd: workspace,
	agentDir: ${JSON.stringify(temp.join("agent"))},
	sessionManager: SessionManager.create(workspace),
	toolNames: [],
	enableMCP: false,
	enableLsp: false,
	disableExtensionDiscovery: true,
	disableComputerUse: true,
	settings: Settings.isolated({ "compaction.enabled": false }),
});

const store = new RemoteDeviceStore(${JSON.stringify(temp.join("remote-devices.json"))});
const registry = store.loadOrCreate("host-rc");
const token = generateRemoteToken();
const device = new TestRemoteDevice({ hostId: registry.hostId, hostPubDer: registry.hostKeyPair.publicKeyDerBase64, deviceId: "phone-rc" });
store.addDevice({ deviceId: "phone-rc", name: "phone-rc", publicKeyDerBase64: device.keyPair.publicKeyDerBase64, tokenHash: hashRemoteToken(token), pairedAt: new Date().toISOString() });

// A session is saved once it has a reply. Another saved session in the same folder must stay hidden from /rc.
const exchange = async (manager, text) => {
	manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
	manager.appendMessage({
		role: "assistant", api: "openai-completions", provider: "test", model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		content: [{ type: "text", text: "ok" }], stopReason: "stop", timestamp: Date.now(),
	});
	await manager.flush();
};
const other = SessionManager.create(workspace);
await exchange(other, "another session");
await exchange(session.sessionManager, "the terminal's session");
const daemon = new RemoteHostDaemon({ deviceStore: store, allowedRoots: [workspace], defaultApprovalMode: "write", liveOnly: true });
let ui;
const client = new RpcClient({ spawn: () => embeddedRpcProcess(session, { onUiContext: u => { ui = u; } }) });
const channelId = await daemon.attachLiveChannel({ cwd: workspace, client });
const server = new RemoteDirectServer({ hostname: "127.0.0.1", port: 0, daemon, deviceStore: store });
const conn = await TestRemoteConnection.open("ws://127.0.0.1:" + server.start(), device, token);

const result = { channelId };
const info = await conn.request("control", { type: "host.info" });
result.listed = info.result.activeChannels.map(c => c.channelId);
result.remoteControlFlag = info.result.remoteControl;
const listed = await conn.request("control", { type: "host.sessions.list", cwd: workspace });
result.listedPaths = listed.result.sessions.map(s => s.path);

result.otherPath = other.getSessionFile();
const otherOpen = await conn.request("control", { type: "host.sessions.open", cwd: workspace, sessionPath: other.getSessionFile() });
result.otherOpenError = otherOpen.ok ? null : otherOpen.error;
const freshOpen = await conn.request("control", { type: "host.sessions.open", cwd: workspace });
result.freshOpenError = freshOpen.ok ? null : freshOpen.error;
const opened = await conn.request("control", { type: "host.sessions.open", cwd: workspace, sessionPath: session.sessionFile });
result.openedChannelId = opened.result.channelId;
const state = await conn.request("session", { kind: "rpc", command: { type: "get_state" } }, channelId);
result.stateSessionFile = state.result.data.sessionFile;
result.stateSessionId = state.result.data.sessionId;
result.sessionId = session.sessionManager.getSessionId();
result.sessionFile = session.sessionFile;
const swapped = await conn.request("session", { kind: "rpc", command: { type: "new_session" } }, channelId);
result.newSessionError = swapped.ok ? null : swapped.error;

const nextDialog = async () => {
	for (let i = 0; i < 200; i++) {
		const frame = conn.frames.map(f => f.body).findLast(b => b?.kind === "rpc_frame" && b.frame?.type === "extension_ui_request" && !seen.has(b.frame.id));
		if (frame) { seen.add(frame.frame.id); return frame.frame; }
		await Bun.sleep(10);
	}
	throw new Error("no dialog reached the phone");
};
const seen = new Set();
const answered = requestUiOverRpc(ui, { kind: "select", title: "Approve write?", options: ["Approve", "Deny"] });
const dialog = await nextDialog();
result.dialog = { method: dialog.method, title: dialog.title, options: dialog.options };
const reply = await conn.request("session", { kind: "ui_response", response: { type: "extension_ui_response", id: dialog.id, value: "Approve" } }, channelId);
result.replyAccepted = reply.result.accepted;
result.answered = await answered;

const withdraw = new AbortController();
const withdrawn = requestUiOverRpc(ui, { kind: "select", title: "Second?", options: ["Yes", "No"] }, withdraw.signal);
const second = await nextDialog();
withdraw.abort();
result.withdrawn = await withdrawn;
await Bun.sleep(50);
result.cancelSent = conn.frames.some(f => f.body?.frame?.method === "cancel" && f.body.frame.targetId === second.id);

const closed = await conn.request("control", { type: "host.sessions.close", channelId });
result.closeReply = closed.result;
result.listedAfterClose = daemon.listChannels().map(c => c.channelId);

conn.close();
server.stop();
await daemon.detachLiveChannel(channelId);
result.listedAfterDetach = daemon.listChannels().length;
// Still the terminal's session after the phone side is gone (an embedded server never disposes it).
result.sessionIdAfter = session.sessionManager.getSessionId();
await daemon.stop();
console.log("RESULT " + JSON.stringify(result));
await session.dispose();
process.exit(0);
`,
		);
		const child = Bun.spawn([process.execPath, fixturePath], {
			cwd: temp.path(),
			env: {
				...Bun.env,
				HOME: temp.join("home"),
				PI_CODING_AGENT_DIR: temp.join("agent"),
				XDG_CONFIG_HOME: temp.join("config"),
				XDG_DATA_HOME: temp.join("data"),
				XDG_CACHE_HOME: temp.join("cache"),
				PI_NO_TITLE: "1",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		const line = stdout.split("\n").find(l => l.startsWith("RESULT "));
		if (!line) throw new Error(`fixture failed (exit ${code}):\n${stdout}\n${stderr}`);
		const result = JSON.parse(line.slice("RESULT ".length));

		expect(result.listed).toContain(result.channelId);
		expect(result.openedChannelId).toBe(result.channelId);
		expect(result.stateSessionFile).toBe(result.sessionFile);
		expect(result.stateSessionId).toBe(result.sessionId);
		expect(result.newSessionError).toMatch(/terminal/);
		expect(result.remoteControlFlag).toBe(true);
		expect(result.listedPaths).toEqual([result.sessionFile]);
		expect(result.otherPath).not.toBe(result.sessionFile);
		expect(result.otherOpenError).toMatch(/Only the session running \/rc/);
		expect(result.freshOpenError).toMatch(/Only the session running \/rc/);
		expect(result.dialog).toEqual({ method: "select", title: "Approve write?", options: ["Approve", "Deny"] });
		expect(result.replyAccepted).toBe(true);
		expect(result.answered).toEqual({ kind: "answered", value: "Approve" });
		expect(result.withdrawn).toEqual({ kind: "unavailable" });
		expect(result.cancelSent).toBe(true);
		expect(result.closeReply).toEqual({ closed: true, channelId: result.channelId });
		expect(result.listedAfterClose).toContain(result.channelId);
		expect(result.listedAfterDetach).toBe(0);
		expect(result.sessionIdAfter).toBe(result.sessionId);
		expect(code).toBe(0);
	}, 60_000);
});
