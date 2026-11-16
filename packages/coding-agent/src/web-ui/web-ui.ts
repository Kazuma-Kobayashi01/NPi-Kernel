/**
 * `/web`: drive the session this terminal is running from a browser on the LAN. Like `/rc`, an RPC server
 * runs in this process over the live session ({@link embeddedRpcProcess}); here an HTTP(S) server
 * ({@link WebSessionServer}) serves a small page bound to that one session alone. Dialogs (tool approvals,
 * asks) show in the terminal and the page; the first answer wins.
 */
import * as os from "node:os";
import type { CollabUiRequestDraft } from "@oh-my-pi/pi-wire";
import type { CollabGuestUiResult } from "../collab/host";
import type { ExtensionUIContext } from "../extensibility/extensions";
import type { GuestUiPeer } from "../modes/controllers/guest-ui-peers";
import { RpcClient } from "../modes/rpc/rpc-client";
import type { InteractiveModeContext } from "../modes/types";
import { embeddedRpcProcess, requestUiOverRpc } from "../remote/remote-control";
import { errorMessage } from "../slash-commands/helpers/parse";
import { WebSessionServer } from "./web-server";
import { loadOrCreateWebTls } from "./web-tls";
import { webUiStatus } from "./web-ui-status";

export const WEB_DEFAULT_PORT = 8787;

export interface WebUiOptions {
	hostname: string;
	port: number;
	tls: boolean;
}

/** `/web` arguments: `[--listen host:port] [--tls]`. */
export function parseWebUiArgs(args: string): WebUiOptions {
	const options: WebUiOptions = { hostname: "0.0.0.0", port: WEB_DEFAULT_PORT, tls: false };
	const words = args.split(/\s+/).filter(Boolean);
	for (let i = 0; i < words.length; i++) {
		const word = words[i]!;
		if (word === "--tls") {
			options.tls = true;
		} else if (word === "--listen") {
			const value = words[++i];
			const colon = value?.lastIndexOf(":") ?? -1;
			const port = Number(value?.slice(colon + 1));
			if (!value || colon <= 0 || !Number.isInteger(port) || port < 0 || port > 65535) {
				throw new Error(`Invalid --listen address "${value ?? ""}", expected host:port`);
			}
			options.hostname = value.slice(0, colon).replace(/^\[(.*)\]$/, "$1");
			options.port = port;
		} else {
			throw new Error(`Unknown /web argument "${word}" (usage: /web [--listen host:port] [--tls] | status | stop)`);
		}
	}
	return options;
}

/** IPv4 addresses on this host's non-internal interfaces, for the links `/web` prints. */
export function lanAddresses(): string[] {
	const found: string[] = [];
	for (const entries of Object.values(os.networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family === "IPv4" && !entry.internal) found.push(entry.address);
		}
	}
	return found;
}

export class WebUi implements GuestUiPeer {
	readonly cwd: string;
	readonly #server: WebSessionServer;
	readonly #client: RpcClient;
	readonly #hostname: string;
	#uiContext: ExtensionUIContext | undefined;
	#stopped = false;

	private constructor(cwd: string, hostname: string, server: WebSessionServer, client: RpcClient) {
		this.cwd = cwd;
		this.#hostname = hostname;
		this.#server = server;
		this.#client = client;
	}

	static async start(ctx: InteractiveModeContext, options: WebUiOptions): Promise<WebUi> {
		const cwd = ctx.sessionManager.getCwd();
		const tls = options.tls ? await loadOrCreateWebTls(lanAddresses()) : undefined;
		// The embedded server reports its dialog context once the control below exists.
		const holder: { control?: WebUi } = {};
		const client = new RpcClient({
			spawn: () =>
				embeddedRpcProcess(ctx.session, {
					subagentEventBus: ctx.subagentEventBus,
					onUiContext: uiContext => {
						if (holder.control) holder.control.#uiContext = uiContext;
					},
				}),
		});
		const server = new WebSessionServer({
			link: client,
			hostname: options.hostname,
			port: options.port,
			tls: tls ? { cert: tls.cert, key: tls.key } : undefined,
			cwd,
		});
		const control = new WebUi(cwd, options.hostname, server, client);
		holder.control = control;
		try {
			await client.start();
			await client.setAskDialog(true);
			server.start();
			return control;
		} catch (error) {
			await control.stop();
			throw error;
		}
	}

	get stopped(): boolean {
		return this.#stopped;
	}

	get connections(): number {
		return this.#server.connections;
	}

	/** Links to open, one per reachable address, each carrying the access token. */
	urls(): string[] {
		const scheme = this.#server.secure ? "https" : "http";
		const hosts =
			this.#hostname === "0.0.0.0" || this.#hostname === "::"
				? [...lanAddresses(), "127.0.0.1"]
				: [this.#hostname.includes(":") ? `[${this.#hostname}]` : this.#hostname];
		return hosts.map(host => `${scheme}://${host}:${this.#server.port}/?t=${this.#server.token}`);
	}

	/** A dialog for the page too; withdrawn there when the terminal answers first (`signal`). */
	requestGuestUi(request: CollabUiRequestDraft, signal?: AbortSignal): Promise<CollabGuestUiResult> | null {
		const ui = this.#uiContext;
		if (!ui || this.#stopped) return null;
		return requestUiOverRpc(ui, request, signal);
	}

	async stop(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#uiContext = undefined;
		this.#server.stop();
		await this.#client.stop();
	}
}

/** Start `/web` for this terminal's session and print its links. */
export async function startWebUi(ctx: InteractiveModeContext, args: string): Promise<WebUi | undefined> {
	if (ctx.webUi) return ctx.webUi;
	let control: WebUi;
	try {
		control = await WebUi.start(ctx, parseWebUiArgs(args));
	} catch (err) {
		ctx.showError(`Web UI did not start: ${errorMessage(err)}`);
		return undefined;
	}
	// A `/web` typed while this one was starting already won.
	if (ctx.webUi) {
		await control.stop();
		return ctx.webUi;
	}
	ctx.webUi = control;
	ctx.showStatus(webUiStatus(control));
	return control;
}
