/**
 * `/rc`: let paired phones drive the session this terminal is running, as Remote Connect does for
 * `npi remote start`, but without a second process. The terminal keeps the session: a phone's prompts
 * run in it and show on screen, and a dialog (tool approval, ask) waits for whichever side answers first.
 *
 * An RPC server runs in this process over the live session ({@link runRpcMode} with `embedded`), wired to
 * an {@link RpcClient} through in-memory streams; the host daemon offers that client to phones as a
 * channel next to the ones it spawns for other sessions under the same root.
 */
import { PassThrough, Readable } from "node:stream";
import type { CollabUiRequestDraft } from "@oh-my-pi/pi-wire";
import { APP_NAME, getAgentDir, logger } from "@oh-my-pi/pi-utils";
import type { CollabGuestUiResult } from "../collab/host";
import type { ExtensionUIContext } from "../extensibility/extensions";
import type { GuestUiPeer } from "../modes/controllers/guest-ui-peers";
import { RpcClient, type RpcAgentProcess } from "../modes/rpc/rpc-client";
import { runRpcMode } from "../modes/rpc/rpc-mode";
import type { InteractiveModeContext } from "../modes/types";
import { errorMessage } from "../slash-commands/helpers/parse";
import type { AgentSession } from "../session/agent-session";
import type { EventBus } from "../utils/event-bus";
import { defaultRemoteDevicesPath, RemoteDeviceStore } from "./crypto";
import { RemoteHostDaemon } from "./daemon";
import { remoteControlStatus } from "./remote-control-status";
import { cfgRemoteRelayUrl } from "./settings";
import { RemoteDirectServer, RemoteRelayTunnel, type RemoteTunnelStatus } from "./tunnel";

export type RemoteControlTransport =
	| { kind: "relay"; url: string }
	| { kind: "direct"; hostname: string; port: number };

export interface RemoteControlOptions {
	transport: RemoteControlTransport;
	/** Told when the relay connection comes and goes. */
	onStatusChange?: (status: RemoteTunnelStatus) => void;
}

/**
 * Runs the RPC server over `session` in this process, as the "process" an {@link RpcClient} spawns: what
 * the client writes is the server's input, and killing it only ends that input.
 */
export function embeddedRpcProcess(
	session: AgentSession,
	options: { subagentEventBus?: EventBus; onUiContext: (uiContext: ExtensionUIContext) => void },
): RpcAgentProcess {
	const output = new PassThrough();
	const encoder = new TextEncoder();
	let input: ReadableStreamDefaultController<Uint8Array> | undefined;
	let inputOpen = true;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			input = controller;
		},
	});
	const closeInput = (): void => {
		if (!inputOpen) return;
		inputOpen = false;
		try {
			input?.close();
		} catch {
			// Already closed by the reader.
		}
	};
	const exited = runRpcMode(session, {
		input: stream,
		subagentEventBus: options.subagentEventBus,
		embedded: { output, onUiContext: options.onUiContext },
	}).then(
		() => 0,
		(error: unknown) => {
			logger.warn("Remote control server stopped", { error: String(error) });
			output.end();
			return 1;
		},
	);
	return {
		stdin: {
			write(data) {
				if (inputOpen) input?.enqueue(typeof data === "string" ? encoder.encode(data) : data);
			},
		},
		stdout: Readable.toWeb(output) as ReadableStream<Uint8Array>,
		peekStderr: () => "",
		kill: closeInput,
		exited,
	};
}

/**
 * Ask the RPC client through the server's dialog context. A dialog withdrawn (`signal`) or lost with the
 * client is `unavailable`, never a cancel: the terminal's own dialog is still waiting for an answer.
 */
export function requestUiOverRpc(
	ui: ExtensionUIContext,
	request: CollabUiRequestDraft,
	signal?: AbortSignal,
): Promise<CollabGuestUiResult> | null {
	if (signal?.aborted) return null;
	const answer =
		request.kind === "select"
			? ui.select(request.title, request.options, { signal })
			: ui.editor(request.title, request.prefill, { signal });
	return answer.then(
		(value): CollabGuestUiResult => (signal?.aborted ? { kind: "unavailable" } : { kind: "answered", value }),
		(): CollabGuestUiResult => ({ kind: "unavailable" }),
	);
}

export class RemoteControl implements GuestUiPeer {
	readonly transport: RemoteControlTransport;
	readonly cwd: string;
	readonly #daemon: RemoteHostDaemon;
	#tunnel: RemoteRelayTunnel | undefined;
	#directServer: RemoteDirectServer | undefined;
	#channelId: string | undefined;
	#uiContext: ExtensionUIContext | undefined;
	#stopped = false;

	private constructor(transport: RemoteControlTransport, cwd: string, daemon: RemoteHostDaemon) {
		this.transport = transport;
		this.cwd = cwd;
		this.#daemon = daemon;
	}

	/** Paired phones that may connect (`npi remote pair` adds them). */
	static activeDeviceCount(): number {
		const store = new RemoteDeviceStore(defaultRemoteDevicesPath(getAgentDir()));
		return store.listDevices().filter(device => !device.revokedAt).length;
	}

	static async start(ctx: InteractiveModeContext, options: RemoteControlOptions): Promise<RemoteControl> {
		const store = new RemoteDeviceStore(defaultRemoteDevicesPath(getAgentDir()));
		const cwd = ctx.sessionManager.getCwd();
		const daemon = new RemoteHostDaemon({
			deviceStore: store,
			allowedRoots: [cwd],
			defaultApprovalMode: "write",
			liveOnly: true,
		});
		const control = new RemoteControl(options.transport, cwd, daemon);
		try {
			const client = new RpcClient({
				spawn: () =>
					embeddedRpcProcess(ctx.session, {
						subagentEventBus: ctx.subagentEventBus,
						onUiContext: uiContext => control.#adoptUiContext(uiContext),
					}),
			});
			control.#channelId = await daemon.attachLiveChannel({ cwd, client });
			daemon.startReaper();
			const { transport } = options;
			if (transport.kind === "relay") {
				control.#tunnel = new RemoteRelayTunnel({
					relayUrl: transport.url,
					daemon,
					deviceStore: store,
					onStatusChange: options.onStatusChange,
				});
				control.#tunnel.start();
			} else {
				control.#directServer = new RemoteDirectServer({
					hostname: transport.hostname,
					port: transport.port,
					daemon,
					deviceStore: store,
				});
				control.#directServer.start();
			}
			return control;
		} catch (error) {
			await control.stop();
			throw error;
		}
	}

	#adoptUiContext(uiContext: ExtensionUIContext): void {
		this.#uiContext = uiContext;
	}

	get stopped(): boolean {
		return this.#stopped;
	}

	/** A dialog for the phone too; it is withdrawn there when the terminal answers first (`signal`). */
	requestGuestUi(request: CollabUiRequestDraft, signal?: AbortSignal): Promise<CollabGuestUiResult> | null {
		const ui = this.#uiContext;
		if (!ui || this.#stopped) return null;
		return requestUiOverRpc(ui, request, signal);
	}

	async stop(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#uiContext = undefined;
		this.#tunnel?.close();
		this.#directServer?.stop();
		if (this.#channelId) await this.#daemon.detachLiveChannel(this.#channelId);
		await this.#daemon.stop();
	}
}

/** `/rc` arguments: a relay URL, `--listen host:port`, or nothing for the saved `remote.relayUrl`. */
export function parseRemoteControlTransport(args: string, savedRelay: string): RemoteControlTransport {
	const listen = /^--listen\s+(\S+)$/.exec(args);
	if (listen) {
		const value = listen[1]!;
		const colon = value.lastIndexOf(":");
		const port = Number(value.slice(colon + 1));
		if (colon <= 0 || !Number.isInteger(port) || port < 0 || port > 65535) {
			throw new Error(`Invalid --listen address "${value}", expected host:port`);
		}
		return { kind: "direct", hostname: value.slice(0, colon), port };
	}
	const url = args || savedRelay.trim();
	if (!url) throw new Error("Usage: /rc <wss://relay> (saved for next time) or /rc --listen <host:port>");
	if (!/^wss?:\/\//.test(url)) throw new Error(`Relay URL must start with wss:// or ws://, got "${url}"`);
	return { kind: "relay", url };
}

/**
 * Start remote control for this terminal's session and report it (`/rc`, or `remote.autoStart` at launch).
 * An explicit relay URL is saved as `remote.relayUrl` for the next plain `/rc`.
 */
export async function startRemoteControl(
	ctx: InteractiveModeContext,
	args: string,
	options: { auto?: boolean } = {},
): Promise<RemoteControl | undefined> {
	if (ctx.remoteControl) return ctx.remoteControl;
	const report = (message: string): void => {
		if (options.auto) ctx.showWarning(`Remote control did not start: ${message}`);
		else ctx.showError(message);
	};
	let transport: RemoteControlTransport;
	try {
		transport = parseRemoteControlTransport(args, cfgRemoteRelayUrl.get(ctx.settings));
	} catch (err) {
		report(options.auto ? "no relay set (run /rc <wss://relay> once)" : errorMessage(err));
		return undefined;
	}
	if (RemoteControl.activeDeviceCount() === 0) {
		report(`no phone is paired yet: run \`${APP_NAME} remote pair --relay <url>\` in another terminal, then /rc`);
		return undefined;
	}
	let control: RemoteControl;
	try {
		control = await RemoteControl.start(ctx, {
			transport,
			onStatusChange: status => {
				if (status === "disconnected" && ctx.remoteControl === control) {
					ctx.showWarning("Remote control relay disconnected, reconnecting…");
				}
			},
		});
	} catch (err) {
		report(errorMessage(err));
		return undefined;
	}
	// A `/rc` typed while this one was starting already won.
	if (ctx.remoteControl) {
		await control.stop();
		return ctx.remoteControl;
	}
	ctx.remoteControl = control;
	if (transport.kind === "relay" && args) cfgRemoteRelayUrl.set(ctx.settings, transport.url);
	ctx.showStatus(remoteControlStatus(control), { dim: options.auto === true });
	return control;
}
