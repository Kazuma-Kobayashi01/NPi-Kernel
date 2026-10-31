/**
 * HTTP REST, SSE, and WebSocket PTY server for the NPi Bot Gateway.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { PtySession } from "@oh-my-pi/pi-natives";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { Server, ServerWebSocket } from "bun";
import { GatewayModelCatalog, GatewayRunner } from "./runner";
import type { GatewayShellTarget } from "./sandbox";
import { GatewayStore } from "./store";
import {
	BOT_ID_RE,
	GatewayApiError,
	type GatewayConfig,
	MAX_CHAT_BODY_BYTES,
	MAX_MANAGEMENT_BODY_BYTES,
	MAX_SYNCED_CHAT_BYTES,
	MAX_UPLOAD_BYTES,
} from "./types";

interface ShellSocketData {
	botId: string;
	application: string;
	args: string[];
	cwd?: string;
	env?: Record<string, string>;
	cols: number;
	rows: number;
	pty?: PtySession;
}

const BOT_ROUTE_RE =
	/^\/m\/v1\/bots\/([a-z0-9][a-z0-9-]{0,40})(\/restore|\/chat\/completions|\/files|\/shell|\/runs\/([A-Za-z0-9_.:-]{1,120})\/approval)?$/;
const CHATS_ROUTE_RE = /^\/m\/v1\/chats\/([a-z0-9][a-z0-9-]{0,40})(?:\/([A-Za-z0-9-]{1,64}))?$/;
const DIRECT_PROFILE_ROUTE_RE =
	/^\/p\/([a-z][a-z0-9-]{0,30})\/v1\/(models|capabilities|chat\/completions|runs\/([A-Za-z0-9_.:-]{1,120})\/approval)$/;

function constantTimeBearerEquals(headerValue: string | null, expectedToken: string): boolean {
	if (!headerValue || !expectedToken) return false;
	const a = Buffer.from(headerValue, "utf8");
	const b = Buffer.from(`Bearer ${expectedToken}`, "utf8");
	if (a.byteLength !== b.byteLength) return false;
	return crypto.timingSafeEqual(a, b);
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function errorResponse(err: GatewayApiError): Response {
	return jsonResponse(err.status, {
		error: {
			code: err.code,
			message: err.message,
		},
	});
}

async function readJsonBody(req: Request, maxBytes = MAX_MANAGEMENT_BODY_BYTES): Promise<Record<string, unknown>> {
	const contentLength = Number.parseInt(req.headers.get("content-length") ?? "0", 10);
	if (Number.isFinite(contentLength) && contentLength > maxBytes) {
		throw new GatewayApiError(413, "too_large", "request body too large");
	}
	const buf = new Uint8Array(await req.arrayBuffer());
	if (buf.byteLength > maxBytes) {
		throw new GatewayApiError(413, "too_large", "request body too large");
	}
	if (buf.byteLength === 0) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(buf));
	} catch {
		throw new GatewayApiError(400, "bad_request", "invalid JSON");
	}
	if (!isRecord(parsed)) {
		throw new GatewayApiError(400, "bad_request", "expected a JSON object");
	}
	return parsed;
}

function clampPtySize(val: string | null, fallback: number, min: number, max: number): number {
	const parsed = Number.parseInt(val ?? "", 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, parsed));
}

export interface StartedBotGateway {
	readonly server: Server<ShellSocketData>;
	readonly port: number;
	readonly store: GatewayStore;
	readonly runner: GatewayRunner;
	stop(closeActiveConnections?: boolean): Promise<void>;
}

export function startBotGateway(
	cfg: GatewayConfig,
	options: { catalog?: GatewayModelCatalog } = {},
): StartedBotGateway {
	if (cfg.managerKey.length < 24) {
		throw new Error("Gateway managerKey must be at least 24 characters");
	}
	const store = new GatewayStore(cfg);
	const catalog = options.catalog ?? new GatewayModelCatalog(cfg.catalogPath ?? "");
	const runner = new GatewayRunner(cfg, store, catalog);

	const requireManagerAuth = (req: Request): void => {
		if (!constantTimeBearerEquals(req.headers.get("authorization"), cfg.managerKey)) {
			throw new GatewayApiError(401, "unauthorized", "invalid manager key");
		}
	};

	const requireProfileOrManagerAuth = (req: Request, profile: string): void => {
		const authHeader = req.headers.get("authorization");
		const profileKey = cfg.profileKeys[profile];
		if (
			constantTimeBearerEquals(authHeader, cfg.managerKey) ||
			(profileKey && constantTimeBearerEquals(authHeader, profileKey))
		) {
			return;
		}
		throw new GatewayApiError(401, "unauthorized", "invalid bot key");
	};

	const resolveShellTarget = async (botId: string): Promise<GatewayShellTarget> => {
		store.ensureAppBot(botId);
		if (!BOT_ID_RE.test(botId)) {
			if (cfg.adminSshHost) {
				return {
					application: "ssh",
					args: ["-t", "-o", "BatchMode=yes", cfg.adminSshHost],
				};
			}
			if (cfg.adminLocalTools) {
				return {
					application: "/bin/sh",
					args: ["-c", "command -v bash >/dev/null && exec bash -l || exec sh -l"],
					cwd: store.workspaceDir(botId),
				};
			}
			throw new GatewayApiError(403, "no_terminal", "admin terminal is not enabled on this gateway");
		}
		const bot = store.getBot(botId, "active");
		if (!bot.sandboxed) {
			throw new GatewayApiError(403, "no_terminal", "this bot was made without a sandbox, so it has no terminal");
		}
		return runner.sandbox.shellTarget(botId);
	};

	const server = Bun.serve<ShellSocketData>({
		hostname: cfg.host,
		port: cfg.port,
		// Match the model proxy: worker startup and non-streaming replies can be quiet for minutes.
		idleTimeout: 255,
		async fetch(req, srv) {
			try {
				const url = new URL(req.url);
				const pathname = url.pathname;
				const method = req.method.toUpperCase();

				if (method === "GET" && pathname === "/m/v1/health") {
					return jsonResponse(200, { ok: true });
				}

				// Direct profile routes (`/p/<profile>/v1/...`) for Android default Lab bot when no managerKey is set.
				const directMatch = DIRECT_PROFILE_ROUTE_RE.exec(pathname);
				if (directMatch) {
					const [, profile, route, runId] = directMatch;
					if (!profile || !cfg.localProfiles.includes(profile)) {
						throw new GatewayApiError(404, "not_found", "not found");
					}
					requireProfileOrManagerAuth(req, profile);
					if (route === "models" && method === "GET") {
						const models = catalog
							.offered()
							.providers.flatMap(p =>
								p.models.map(m => ({ id: `${p.id}/${m.id}`, object: "model", owned_by: p.id })),
							);
						return jsonResponse(200, {
							object: "list",
							data: [{ id: "lab-bot", object: "model", owned_by: "npi" }, ...models],
						});
					}
					if (route === "capabilities" && method === "GET") {
						return jsonResponse(200, {
							streaming: true,
							approvals: true,
							vision: true,
						});
					}
					if (route === "chat/completions" && method === "POST") {
						const body = await readJsonBody(req, MAX_CHAT_BODY_BYTES);
						const convId =
							req.headers.get("x-lab-conversation-id")?.trim() ||
							(typeof body.conversation_id === "string" ? body.conversation_id.trim() : undefined);
						return await runner.handleChatCompletions(profile, body, {
							conversationId: convId,
							signal: req.signal,
						});
					}
					if (runId && method === "POST") {
						const res = runner.answerApproval(profile, runId, await readJsonBody(req));
						return jsonResponse(res.status, res.data);
					}
					throw new GatewayApiError(405, "method_not_allowed", "method not allowed");
				}

				const isKnownManagerPath =
					pathname === "/m/v1/bots" ||
					pathname === "/m/v1/models" ||
					pathname === "/m/v1/media" ||
					BOT_ROUTE_RE.test(pathname) ||
					CHATS_ROUTE_RE.test(pathname);
				if (!isKnownManagerPath) {
					throw new GatewayApiError(404, "not_found", "not found");
				}

				requireManagerAuth(req);

				if (pathname === "/m/v1/media") {
					if (method !== "GET") {
						throw new GatewayApiError(405, "method_not_allowed", "method not allowed");
					}
					const botId = url.searchParams.get("bot") ?? "";
					const mediaPath = url.searchParams.get("path") ?? "";
					const resolved = store.resolveMediaFile(botId, mediaPath, (b, p, d) =>
						runner.copyOutFromSandbox(b, p, d),
					);
					const bytes = fs.readFileSync(resolved.realPath);
					return new Response(bytes, {
						status: 200,
						headers: {
							"Content-Type": resolved.contentType,
							"Content-Length": String(resolved.size),
							"Cache-Control": "private, max-age=86400",
							"X-Content-Type-Options": "nosniff",
						},
					});
				}

				const chatMatch = CHATS_ROUTE_RE.exec(pathname);
				if (chatMatch) {
					const [, botId, convId] = chatMatch;
					if (!botId || (!BOT_ID_RE.test(botId) && !cfg.localProfiles.includes(botId))) {
						throw new GatewayApiError(404, "not_found", "not found");
					}
					if (!convId) {
						if (method !== "GET") {
							throw new GatewayApiError(405, "method_not_allowed", "method not allowed");
						}
						return jsonResponse(200, store.chatList(botId));
					}
					if (method === "GET") {
						return jsonResponse(200, store.chatGet(botId, convId));
					}
					if (method === "PUT") {
						const body = await readJsonBody(req, MAX_SYNCED_CHAT_BYTES);
						return jsonResponse(200, store.chatPut(botId, convId, body));
					}
					if (method === "DELETE") {
						return jsonResponse(200, store.chatDelete(botId, convId));
					}
					throw new GatewayApiError(405, "method_not_allowed", "method not allowed");
				}

				if (pathname === "/m/v1/models") {
					if (method !== "GET") {
						throw new GatewayApiError(405, "method_not_allowed", "method not allowed");
					}
					return jsonResponse(200, catalog.offered());
				}

				if (pathname === "/m/v1/bots") {
					if (method === "GET") {
						return jsonResponse(
							200,
							store.listBots(id => runner.sandboxStatus(id)),
						);
					}
					if (method === "POST") {
						const body = await readJsonBody(req);
						const created = store.createBot(
							body,
							(p, m, r) => catalog.check(p, m, r),
							id => runner.sandboxStatus(id),
						);
						try {
							await runner.sandbox.ensure(created.id);
						} catch (error) {
							try {
								runner.sandbox.remove(created.id);
							} catch {
								// Preserve the original prerequisite error if Docker cleanup is also unavailable.
							}
							store.trashBot(created.id);
							store.purgeBot(created.id);
							throw error;
						}
						return jsonResponse(201, created);
					}
					throw new GatewayApiError(405, "method_not_allowed", "method not allowed");
				}

				const botMatch = BOT_ROUTE_RE.exec(pathname);
				if (botMatch) {
					const [, botId, tail, runId] = botMatch;
					if (
						!botId ||
						(!BOT_ID_RE.test(botId) &&
							(!cfg.localProfiles.includes(botId) ||
								!tail ||
								!(
									tail.startsWith("/files") ||
									tail.startsWith("/runs/") ||
									tail.startsWith("/chat/") ||
									tail.startsWith("/shell")
								)))
					) {
						throw new GatewayApiError(404, "not_found", "not found");
					}

					if (tail === "/shell" && method === "GET") {
						const upgradeHeader = req.headers.get("upgrade")?.toLowerCase() ?? "";
						if (upgradeHeader !== "websocket") {
							throw new GatewayApiError(400, "bad_request", "expected a WebSocket upgrade");
						}
						const target = await resolveShellTarget(botId);
						const cols = clampPtySize(url.searchParams.get("cols"), 80, 20, 400);
						const rows = clampPtySize(url.searchParams.get("rows"), 24, 5, 200);
						const upgraded = srv.upgrade(req, {
							data: {
								botId,
								application: target.application,
								args: target.args,
								cwd: target.cwd,
								env: target.env,
								cols,
								rows,
							},
						});
						if (upgraded) return undefined as unknown as Response;
						throw new GatewayApiError(400, "bad_request", "WebSocket upgrade failed");
					}

					if (tail && tail.startsWith("/runs/") && runId && method === "POST") {
						const res = runner.answerApproval(botId, runId, await readJsonBody(req));
						return jsonResponse(res.status, res.data);
					}

					if (tail === "/restore" && method === "POST") {
						const restored = store.restoreBot(botId, id => runner.sandboxStatus(id));
						await runner.sandbox.ensure(botId);
						return jsonResponse(200, restored);
					}

					if (tail === "/chat/completions" && method === "POST") {
						const body = await readJsonBody(req, MAX_CHAT_BODY_BYTES);
						const convId =
							req.headers.get("x-lab-conversation-id")?.trim() ||
							(typeof body.conversation_id === "string" ? body.conversation_id.trim() : undefined);
						return await runner.handleChatCompletions(botId, body, {
							conversationId: convId,
							signal: req.signal,
						});
					}

					if (tail === "/files" && method === "POST") {
						const contentLength = Number.parseInt(req.headers.get("content-length") ?? "0", 10);
						if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
							throw new GatewayApiError(413, "too_large", "file too large (at most 25 MB)");
						}
						const rawFilename = decodeURIComponent(req.headers.get("x-filename") ?? "");
						const bytes = new Uint8Array(await req.arrayBuffer());
						const stored = store.storeUpload(botId, rawFilename, bytes);
						return jsonResponse(201, stored);
					}

					if (!tail && method === "PATCH") {
						const body = await readJsonBody(req);
						return jsonResponse(
							200,
							store.updateBot(
								botId,
								body,
								(p, m, r) => catalog.check(p, m, r),
								id => runner.sandboxStatus(id),
							),
						);
					}

					if (!tail && method === "DELETE") {
						const purge = req.headers.get("x-purge") === "1" || url.searchParams.get("purge") === "1";
						if (purge) {
							store.purgeBot(botId, id => {
								runner.sandbox.remove(id);
								runner.stopBotRuns(id);
							});
						} else {
							store.trashBot(botId, id => {
								runner.sandbox.stop(id);
								runner.stopBotRuns(id);
							});
						}
						return jsonResponse(200, { ok: true });
					}
				}

				throw new GatewayApiError(405, "method_not_allowed", "method not allowed");
			} catch (err) {
				if (err instanceof GatewayApiError) {
					return errorResponse(err);
				}
				logger.error("Gateway unhandled error", {
					error: err instanceof Error ? err.message : String(err),
				});
				return errorResponse(new GatewayApiError(500, "internal", "internal error"));
			}
		},
		websocket: {
			open(ws: ServerWebSocket<ShellSocketData>) {
				const { application, args, cwd, env, cols, rows } = ws.data;
				const pty = new PtySession();
				ws.data.pty = pty;
				const cleanEnv: Record<string, string> = {};
				for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SHELL"] as const) {
					const val = process.env[key];
					if (val) cleanEnv[key] = val;
				}
				cleanEnv.TERM = "xterm-256color";
				cleanEnv.LANG = "C.UTF-8";
				const encoder = new TextEncoder();
				void pty
					.startArgv(
						{
							application,
							args,
							cwd,
							env: env ?? cleanEnv,
							cols,
							rows,
						},
						(err, chunk) => {
							if (err || !chunk) return;
							try {
								ws.sendBinary(encoder.encode(chunk));
							} catch {
								// Socket already closed.
							}
						},
					)
					.then(
						() => {
							try {
								ws.close(1000);
							} catch {
								// Ignore.
							}
						},
						() => {
							try {
								ws.close(1011);
							} catch {
								// Ignore.
							}
						},
					);
			},
			message(ws: ServerWebSocket<ShellSocketData>, message: string | Buffer) {
				const pty = ws.data.pty;
				if (!pty) return;
				if (typeof message === "string") {
					try {
						const parsed: unknown = JSON.parse(message);
						if (isRecord(parsed) && Array.isArray(parsed.resize) && parsed.resize.length === 2) {
							const c = Number(parsed.resize[0]);
							const r = Number(parsed.resize[1]);
							if (Number.isFinite(c) && Number.isFinite(r) && c > 0 && r > 0) {
								pty.resize(
									Math.max(20, Math.min(400, Math.trunc(c))),
									Math.max(5, Math.min(200, Math.trunc(r))),
								);
								return;
							}
						}
					} catch {
						// Not a JSON control frame; write as terminal input.
					}
					try {
						pty.write(message);
					} catch {
						// PTY already exited.
					}
					return;
				}
				try {
					pty.write(new TextDecoder().decode(message));
				} catch {
					// PTY already exited.
				}
			},
			close(ws: ServerWebSocket<ShellSocketData>) {
				try {
					ws.data.pty?.kill();
				} catch {
					// Ignore.
				}
				ws.data.pty = undefined;
			},
		},
	});

	const janitorTimer = setInterval(() => {
		try {
			store.expireTrash(id => {
				runner.stopBotRuns(id);
				runner.sandbox.remove(id);
			});
		} catch {
			// Ignore background janitor errors.
		}
	}, 300_000);
	janitorTimer.unref?.();

	return {
		server,
		port: server.port ?? cfg.port,
		store,
		runner,
		async stop(closeActiveConnections = true) {
			clearInterval(janitorTimer);
			for (const bot of store.listBots().bots) {
				runner.stopBotRuns(bot.id);
				try {
					runner.sandbox.stop(bot.id);
				} catch {
					logger.warn("Gateway shutdown could not stop a bot sandbox", { botId: bot.id });
				}
			}
			for (const profile of cfg.localProfiles) {
				runner.stopBotRuns(profile);
				try {
					runner.sandbox.stop(profile);
				} catch {
					logger.warn("Gateway shutdown could not stop a profile sandbox", { profile });
				}
			}
			await server.stop(closeActiveConnections);
			store.close();
		},
	};
}
