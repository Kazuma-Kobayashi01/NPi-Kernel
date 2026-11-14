/**
 * `npi remote` — run the Remote Connect Host Daemon, pair phones, and manage authorized devices.
 */
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { getAgentDir, getProjectDir } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { renderUnicodeCompact } from "uqr";
import { remoteHelp as commandHelp } from "../cli/command-help";
import {
	createRemotePairingOffer,
	defaultRemoteDevicesPath,
	encodeRemotePairingUri,
	RemoteDeviceStore,
	RemoteDirectServer,
	RemoteHostDaemon,
	type RemotePairingResult,
	RemoteRelayTunnel,
	runDirectPairing,
	runRelayPairing,
	x25519PublicKeyToRaw,
} from "../remote";
import { isApprovalMode } from "../tools/approval";

const REMOTE_ACTIONS = ["start", "pair", "devices", "revoke", "status"] as const;
type RemoteAction = (typeof REMOTE_ACTIONS)[number];

function parseListen(value: string): { hostname: string; port: number } {
	const lastColon = value.lastIndexOf(":");
	if (lastColon <= 0) throw new Error(`Invalid --listen value "${value}", expected <host:port>`);
	const hostname = value.slice(0, lastColon);
	const port = Number(value.slice(lastColon + 1));
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port in --listen: ${value}`);
	return { hostname, port };
}

async function confirmSasInTerminal(
	info: { sas: string; deviceId: string; deviceName: string },
	signal: AbortSignal,
): Promise<boolean> {
	if (!process.stdin.isTTY) throw new Error("Pairing needs an interactive terminal to confirm the code");
	const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = await rl.question(
			`\nDevice "${info.deviceName}" (${info.deviceId}) wants to pair.\n` +
				`Verification code: ${info.sas.slice(0, 3)} ${info.sas.slice(3)}\n` +
				"Does the phone show the same code? [y/N] ",
			{ signal },
		);
		return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
	} catch (err) {
		if (signal.aborted) return false;
		throw err;
	} finally {
		rl.close();
	}
}

export default class Remote extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Sub-command: start | pair | devices | revoke | status",
			required: false,
			options: [...REMOTE_ACTIONS],
		}),
		target: Args.string({
			description: "Device id for `revoke`",
			required: false,
		}),
	};

	static flags = {
		relay: Flags.string({
			description: "Relay base URL (Mode A, e.g. wss://relay.example.com or wss://1.2.3.4/relay)",
		}),
		listen: Flags.string({ description: "Direct listen address host:port (Mode B, e.g. 127.0.0.1:8787)" }),
		"public-url": Flags.string({
			description: "URL the phone uses to reach --listen (pair, Mode B; default ws://<listen>)",
		}),
		root: Flags.string({
			description: "Allowed workspace root directory (repeatable; defaults to current working directory)",
			multiple: true,
		}),
		"approval-mode": Flags.string({
			description: "Default approval mode for remote sessions (always-ask, always-ask-cached, write)",
			default: "write",
		}),
		ttl: Flags.integer({ description: "Pairing offer lifetime in seconds (pair)", default: 300 }),
		json: Flags.boolean({ description: "Output JSON" }),
	};

	static examples = [
		"npi remote pair --relay wss://relay.example.com",
		"npi remote start --relay wss://relay.example.com --root ~/Documents/NPi/Code",
		"npi remote pair --listen 127.0.0.1:8787   # then: adb reverse tcp:8787 tcp:8787",
		"npi remote start --listen 127.0.0.1:8787 --root ~/Documents/NPi/Code",
		"npi remote devices --json",
		"npi remote revoke dev_pixel9_3f2a1c",
		"npi remote status --json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Remote);
		if (!args.action) {
			renderCommandHelp("omp", "remote", Remote);
			return;
		}
		const action = args.action as RemoteAction;
		const store = new RemoteDeviceStore(defaultRemoteDevicesPath(getAgentDir()));

		switch (action) {
			case "devices": {
				const devices = store.listDevices().map(({ tokenHash: _tokenHash, ...rest }) => rest);
				if (flags.json) {
					console.log(JSON.stringify({ devices }, null, 2));
					return;
				}
				if (devices.length === 0) {
					console.log("No remote devices paired.");
					return;
				}
				for (const d of devices) {
					const status = d.revokedAt ? `revoked (${d.revokedAt})` : "active";
					console.log(`${d.deviceId}\t${d.name}\t${status}\tpaired=${d.pairedAt}`);
				}
				return;
			}

			case "revoke": {
				const target = args.target?.trim();
				if (!target) throw new Error("Usage: npi remote revoke <deviceId>");
				if (!store.revokeDevice(target)) {
					console.error(`Unknown device: ${target}`);
					process.exitCode = 1;
					return;
				}
				console.log(`Revoked remote device: ${target}`);
				return;
			}

			case "status": {
				const data = store.loadOrCreate();
				const activeDevices = data.devices.filter(d => !d.revokedAt);
				const summary = {
					hostId: data.hostId,
					hostPublicKey: x25519PublicKeyToRaw(data.hostKeyPair.publicKeyDerBase64),
					devicesFile: store.filePath,
					activeDeviceCount: activeDevices.length,
					totalDeviceCount: data.devices.length,
				};
				if (flags.json) {
					console.log(JSON.stringify(summary, null, 2));
					return;
				}
				for (const [key, value] of Object.entries(summary)) console.log(`${key}: ${value}`);
				return;
			}

			case "pair": {
				await this.#pair(store, flags);
				return;
			}

			case "start": {
				await this.#start(store, flags);
				return;
			}
		}
	}

	async #pair(
		store: RemoteDeviceStore,
		flags: { relay?: string; listen?: string; "public-url"?: string; ttl: number; json?: boolean },
	): Promise<void> {
		if (Boolean(flags.relay) === Boolean(flags.listen)) {
			throw new Error("Specify exactly one of --relay <wss://...> (Mode A) or --listen <host:port> (Mode B)");
		}
		const ttlMs = Math.max(30, flags.ttl) * 1000;
		const listen = flags.listen ? parseListen(flags.listen) : undefined;
		const offer = createRemotePairingOffer(store, {
			mode: flags.relay ? "relay" : "direct",
			url: flags.relay ?? flags["public-url"] ?? `ws://${flags.listen}`,
			ttlMs,
		});
		const uri = encodeRemotePairingUri(offer);
		if (flags.json) {
			console.log(JSON.stringify({ uri, hostId: offer.hostId, pairingId: offer.pairingId, exp: offer.exp }));
		} else {
			process.stderr.write(`${renderUnicodeCompact(uri, { border: 2 })}\n`);
			process.stderr.write(`Scan with NPi Remote, or paste:\n${uri}\n`);
			process.stderr.write(`Expires at ${new Date(offer.exp).toLocaleTimeString()}. Waiting for the phone…\n`);
		}

		const abort = new AbortController();
		const onSignal = () => abort.abort();
		process.once("SIGINT", onSignal);
		let result: RemotePairingResult;
		try {
			result = listen
				? await runDirectPairing({
						store,
						offer,
						confirmSas: confirmSasInTerminal,
						signal: abort.signal,
						hostname: listen.hostname,
						port: listen.port,
					})
				: await runRelayPairing({
						store,
						offer,
						confirmSas: confirmSasInTerminal,
						signal: abort.signal,
						relayUrl: flags.relay!,
						hostToken: store.loadOrCreate().relayHostToken,
					});
		} finally {
			process.off("SIGINT", onSignal);
		}
		if (result.status === "paired") {
			console.log(
				flags.json
					? JSON.stringify({ status: "paired", deviceId: result.device.deviceId, name: result.device.name })
					: `Paired "${result.device.name}" (${result.device.deviceId}).`,
			);
			return;
		}
		console.error(flags.json ? JSON.stringify(result) : `Pairing failed: ${result.reason}`);
		process.exitCode = 1;
	}

	async #start(
		store: RemoteDeviceStore,
		flags: { relay?: string; listen?: string; root?: string[]; "approval-mode"?: string },
	): Promise<void> {
		if (Boolean(flags.relay) === Boolean(flags.listen)) {
			throw new Error("Specify exactly one of --relay <wss://...> (Mode A) or --listen <host:port> (Mode B)");
		}
		const approvalMode = flags["approval-mode"];
		if (!isApprovalMode(approvalMode) || approvalMode === "yolo") {
			throw new Error(
				`Invalid --approval-mode ${JSON.stringify(approvalMode)}; expected always-ask, always-ask-cached, or write`,
			);
		}
		const roots = (flags.root && flags.root.length > 0 ? flags.root : [getProjectDir()]).map(r => path.resolve(r));
		const daemon = new RemoteHostDaemon({
			deviceStore: store,
			allowedRoots: roots,
			defaultApprovalMode: approvalMode,
			onAudit: entry => {
				console.error(`[remote-audit] ${entry.timestamp} ${entry.deviceId} ${entry.action}`);
			},
		});
		daemon.startReaper();

		const tunnel = flags.relay
			? new RemoteRelayTunnel({
					relayUrl: flags.relay,
					daemon,
					deviceStore: store,
					onStatusChange: status => console.error(`[remote-relay] ${status}`),
				})
			: undefined;
		tunnel?.start();

		let directServer: RemoteDirectServer | undefined;
		if (flags.listen) {
			const { hostname, port } = parseListen(flags.listen);
			directServer = new RemoteDirectServer({ hostname, port, daemon, deviceStore: store });
			const boundPort = directServer.start();
			console.error(`[remote-direct] listening on ws://${hostname}:${boundPort}/ws/client`);
		}

		const { promise, resolve } = Promise.withResolvers<void>();
		const shutdown = () => {
			tunnel?.close();
			directServer?.stop();
			void daemon.stop().finally(resolve);
		};
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
		await promise;
	}
}
