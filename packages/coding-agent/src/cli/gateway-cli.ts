/**
 * `npi gateway` CLI command handlers (`serve | token | status`).
 */
import * as path from "node:path";
import { getAgentDir, isRecord, logger } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { parseBind } from "@oh-my-pi/pi-ai/utils/parse-bind";
import {
	DEFAULT_BOT_STORAGE_MB,
	DEFAULT_GATEWAY_HOST,
	DEFAULT_GATEWAY_PORT,
	DEFAULT_MAX_BOTS,
	DEFAULT_MAX_TRASH,
	DEFAULT_SANDBOX_ATTACHMENTS,
	DEFAULT_TRASH_DAYS,
	type GatewayConfig,
	type GatewayBotModelConfig,
	type GatewayCatalogData,
	GatewayModelCatalog,
	startBotGateway,
} from "../gateway";
import { generateToken, readTokenFile, writeTokenFile } from "./token-file";

export const GATEWAY_ACTIONS = ["serve", "token", "status"] as const;
export type GatewayAction = (typeof GATEWAY_ACTIONS)[number];

export interface GatewayCommandArgs {
	action: GatewayAction;
	flags: {
		json?: boolean;
		bind?: string;
		dataDir?: string;
		regenerate?: boolean;
		maxBots?: number;
		sandboxBackend?: "docker" | "host-unsafe";
		dockerImage?: string;
		dockerNetwork?: string;
		sandboxModelConfigDir?: string;
		sandboxClientsFile?: string;
		sandboxQuotaRoot?: string;
		sandboxQuotaCommand?: string;
		adminSshHost?: string;
		adminLocalTools?: boolean;
	};
}

async function ensureManagerToken(dataDir: string, regenerate = false): Promise<string> {
	const envToken = process.env.NPI_GATEWAY_KEY || process.env.MANAGER_KEY;
	if (!regenerate && envToken && envToken.trim().length >= 24) {
		return envToken.trim();
	}
	const tokenFile = path.join(dataDir, "manager.key");
	if (!regenerate) {
		const existing = await readTokenFile(tokenFile);
		if (existing && existing.length >= 24) return existing;
	}
	const token = generateToken();
	await writeTokenFile(tokenFile, token);
	return token;
}

export async function runGatewayCommand(cmd: GatewayCommandArgs): Promise<void> {
	const rawDir = cmd.flags.dataDir || process.env.NPI_GATEWAY_DIR;
	const dataDir = rawDir ? path.resolve(rawDir) : path.join(getAgentDir(), "bot-gateway");
	switch (cmd.action) {
		case "token": {
			const token = await ensureManagerToken(dataDir, cmd.flags.regenerate === true);
			if (cmd.flags.json) {
				process.stdout.write(`${JSON.stringify({ token, dataDir })}\n`);
			} else {
				process.stdout.write(`${token}\n`);
			}
			return;
		}
		case "status": {
			const tokenFile = path.join(dataDir, "manager.key");
			const token =
				(await readTokenFile(tokenFile)) ?? process.env.NPI_GATEWAY_KEY ?? process.env.MANAGER_KEY ?? null;
			const bindRaw =
				cmd.flags.bind || process.env.NPI_GATEWAY_BIND || `${DEFAULT_GATEWAY_HOST}:${DEFAULT_GATEWAY_PORT}`;
			const { hostname: host, port } = parseBind(bindRaw);
			const payload = {
				dataDir,
				tokenConfigured: Boolean(token && token.length >= 24),
				bind: `${host}:${port}`,
			};
			if (cmd.flags.json) {
				process.stdout.write(`${JSON.stringify(payload)}\n`);
			} else {
				process.stdout.write(`${chalk.bold("NPi Bot Gateway")}\n`);
				process.stdout.write(`  Data directory: ${payload.dataDir}\n`);
				process.stdout.write(`  Default bind:   http://${payload.bind}\n`);
				process.stdout.write(
					`  Manager key:    ${payload.tokenConfigured ? "configured" : "not created yet (run `npi gateway token`)"}\n`,
				);
			}
			return;
		}
		case "serve": {
			const managerKey = await ensureManagerToken(dataDir, false);
			const bindRaw =
				cmd.flags.bind || process.env.NPI_GATEWAY_BIND || `${DEFAULT_GATEWAY_HOST}:${DEFAULT_GATEWAY_PORT}`;
			const { hostname: host, port } = parseBind(bindRaw);
			const agentDir = getAgentDir();

			const labbotKey = process.env.LABBOT_KEY?.trim() || managerKey;
			const cfg: GatewayConfig = {
				host,
				port,
				dataDir,
				agentDir,
				managerKey,
				profileKeys: { labbot: labbotKey },
				localProfiles: ["labbot"],
				maxBots: cmd.flags.maxBots ?? Number.parseInt(process.env.MAX_BOTS ?? String(DEFAULT_MAX_BOTS), 10),
				maxTrash: DEFAULT_MAX_TRASH,
				trashDays: DEFAULT_TRASH_DAYS,
				botStorageBytes: DEFAULT_BOT_STORAGE_MB * 1024 * 1024,
				sandboxAttachmentsDir: DEFAULT_SANDBOX_ATTACHMENTS,
				catalogPath: process.env.CATALOG_PATH || path.join(dataDir, "catalog.json"),
				sandboxBackend:
					cmd.flags.sandboxBackend ??
					(process.env.NPI_GATEWAY_SANDBOX === "host-unsafe" ? "host-unsafe" : "docker"),
				dockerImage:
					cmd.flags.dockerImage ??
					process.env.NPI_GATEWAY_IMAGE ??
					process.env.SANDBOX_IMAGE ??
					"npi-worker:withbot",
				dockerNetwork: cmd.flags.dockerNetwork ?? process.env.NPI_GATEWAY_NETWORK ?? "npi-bots",
				sandboxModelConfigDir: cmd.flags.sandboxModelConfigDir ?? process.env.NPI_GATEWAY_MODEL_CONFIG_DIR,
				sandboxClientsFile: cmd.flags.sandboxClientsFile ?? process.env.NPI_GATEWAY_MODEL_CLIENTS_FILE,
				sandboxQuotaRoot: cmd.flags.sandboxQuotaRoot ?? process.env.NPI_GATEWAY_QUOTA_ROOT,
				sandboxQuotaCommand: cmd.flags.sandboxQuotaCommand ?? process.env.NPI_GATEWAY_QUOTA_COMMAND,
				adminSshHost: cmd.flags.adminSshHost ?? process.env.ADMIN_SSH_HOST,
				adminLocalTools: cmd.flags.adminLocalTools === true || process.env.NPI_GATEWAY_ADMIN_LOCAL === "1",
			};

			if (cfg.sandboxModelConfigDir && !process.env.CATALOG_PATH) {
				const template: unknown = await Bun.file(path.join(cfg.sandboxModelConfigDir, "template.json")).json();
				if (!isRecord(template) || !Array.isArray(template.providers) || Object.hasOwn(template, "token")) {
					throw new Error("Model template requires providers and must not contain shared credentials");
				}
				const providers = template.providers as GatewayBotModelConfig["providers"];
				const metadata: GatewayCatalogData = {
					providers: providers.map(provider => ({
						id: provider.id,
						name: provider.id,
						models: provider.models.map(model => ({
							id: model.id,
							name: model.name ?? model.id,
							efforts: model.reasoning ? ["none", "low", "medium", "high"] : ["none"],
							fast: false,
						})),
					})),
				};
				await Bun.write(cfg.catalogPath!, JSON.stringify(metadata, null, 2));
			}
			const catalog = new GatewayModelCatalog(cfg.catalogPath ?? "");
			const started = startBotGateway(cfg, { catalog });
			logger.info("npi gateway listening", {
				host,
				port: started.port,
				dataDir,
				sandboxBackend: cfg.sandboxBackend,
			});
			process.stdout.write(`NPi Bot Gateway listening on http://${host}:${started.port} (data: ${dataDir})\n`);

			const stopSignal = Promise.withResolvers<void>();
			const onSignal = () => stopSignal.resolve();
			process.once("SIGINT", onSignal);
			process.once("SIGTERM", onSignal);
			await stopSignal.promise;
			await started.stop(true);
			return;
		}
	}
}
