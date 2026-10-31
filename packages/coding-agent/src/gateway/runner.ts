/**
 * Model catalog, conversation history seeding, RPC worker runner, and SSE/approval bridge.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { MAX_RPC_FRAME_BYTES, RpcFrameDecoder } from "../modes/rpc/rpc-frame";
import type { RpcApprovalSelectChoice, RpcExtensionUIRequest } from "../modes/rpc/rpc-types";
import { SessionManager } from "../session/session-manager";
import { GATEWAY_WORKER_GID, GATEWAY_WORKER_UID, GatewaySandbox } from "./sandbox";
import type { GatewayStore } from "./store";
import {
	APPROVAL_CHOICES,
	BOT_ID_RE,
	CONVERSATION_ID_RE,
	GATEWAY_EFFORTS,
	type GatewayApprovalChoice,
	GatewayApiError,
	type GatewayCatalogData,
	type GatewayCatalogProvider,
	type GatewayConfig,
	MARKDOWN_HINT,
	MAX_IMAGE_DATA_URL_BYTES,
	MAX_IMAGES_PER_MESSAGE,
	MAX_TEXT_PART_CHARS,
	type NormalizedChatMessage,
	type NormalizedMessagePart,
	RUN_ID_RE,
} from "./types";

const IMAGE_DATA_URL_PREFIXES = [
	"data:image/png;base64,",
	"data:image/jpeg;base64,",
	"data:image/webp;base64,",
	"data:image/gif;base64,",
] as const;

const FAST_PROVIDER_IDS: Readonly<Record<string, true>> = {
	openai: true,
	"openai-codex": true,
	anthropic: true,
};

const COMMAND_KIND_PATTERNS: ReadonlyArray<readonly [string, readonly RegExp[]]> = [
	[
		"system",
		[
			/\b(?:reboot|shutdown|poweroff|halt)\b/i,
			/\bsystemctl\s+(?:-\S+\s+)*(?:stop|disable|mask|restart|kill|isolate|reboot|poweroff|halt)\b/i,
			/\bservice\s+\S+\s+(?:stop|restart)\b/i,
			/\b(?:incus|lxc)\s+(?:delete|rm|stop|restart|move|rename|config\s+(?:set|unset|device|edit))\b/i,
			/\bdocker\s+(?:rm|rmi|stop|kill|restart|(?:system|volume|image|container|network|builder)\s+(?:rm|prune|stop|kill))\b/i,
			/(?:^|[\s;&|()`$]|\b)(?:kill|pkill|killall)\s/i,
			/\b(?:ufw|iptables|ip6tables|nft|firewall-cmd)\s+\S/i,
			/\b(?:useradd|userdel|usermod|groupdel|passwd|chpasswd|visudo)\b/i,
			/>>?\s*\/(?:etc|boot|usr|var\/lib)\/|\btee\s+(?:-a\s+)?\/(?:etc|boot)\//i,
		],
	],
	[
		"install",
		[
			/\b(?:pip3?|pipx)\s+(?:install|download)\b/i,
			/\bpython3?(?:\.\d+)?\s+-m\s+pip\s+(?:install|download)\b/i,
			/\buv\s+(?:pip\s+install|add|sync|tool\s+install)\b/i,
			/\b(?:conda|mamba|micromamba)\s+(?:install|update|create|upgrade)\b/i,
			/\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|update|upgrade|ci)\b/i,
			/\b(?:npx|bunx|pnpx)\s+\S/i,
			/\bapt(?:-get)?\s+(?:-\S+\s+)*(?:install|update|upgrade|dist-upgrade|full-upgrade)\b/i,
			/\b(?:apk)\s+(?:add|update|upgrade)\b/i,
			/\b(?:cargo|gem|go|brew)\s+(?:install|get|update|upgrade)\b/i,
		],
	],
	[
		"download",
		[
			/(?:^|[\s;&|()`$]|\b)(?:curl|wget|aria2c|axel)\b/i,
			/\bgit\s+(?:clone|pull|fetch|submodule\s+update)\b/i,
			/\b(?:scp|sftp|ftp|rsync)\s+\S+:\S*/i,
			/\bdocker\s+pull\b/i,
		],
	],
	[
		"delete",
		[
			/(?:^|[\s;&|()`$]|\b)rm(?:\s|$)/i,
			/\b(?:rmdir|unlink|shred)\b/i,
			/\bfind\b[^|;&]*\s-(?:delete|exec\s+rm)\b/i,
			/\bgit\s+(?:clean|reset\s+--hard|rm)\b/i,
		],
	],
];

export function classifyCommandKind(commandText: string): string {
	for (const [kind, patterns] of COMMAND_KIND_PATTERNS) {
		if (patterns.some(re => re.test(commandText))) {
			return `lablink-${kind}`;
		}
	}
	return "danger";
}

export class GatewayModelCatalog {
	readonly #catalogPath: string;
	readonly #modelRegistry?: ModelRegistry;
	#mtimeMs = -1;
	#cachedFileData: GatewayCatalogData | null = null;

	constructor(catalogPath: string, modelRegistry?: ModelRegistry) {
		this.#catalogPath = catalogPath;
		this.#modelRegistry = modelRegistry;
	}

	#readFileCatalog(): GatewayCatalogData | null {
		if (!this.#catalogPath) return null;
		try {
			const stat = fs.statSync(this.#catalogPath);
			if (stat.mtimeMs !== this.#mtimeMs || !this.#cachedFileData) {
				const raw = JSON.parse(fs.readFileSync(this.#catalogPath, "utf8")) as GatewayCatalogData;
				if (raw && Array.isArray(raw.providers)) {
					this.#cachedFileData = {
						providers: raw.providers.map(provider => ({
							id: provider.id,
							name: provider.name ?? provider.id,
							models: (provider.models ?? []).map(model => ({
								id: model.id,
								name: model.name ?? model.id,
								efforts: Array.isArray(model.efforts) && model.efforts.length > 0 ? model.efforts : ["none"],
								fast: typeof model.fast === "boolean" ? model.fast : FAST_PROVIDER_IDS[provider.id] === true,
							})),
						})),
					};
					this.#mtimeMs = stat.mtimeMs;
				}
			}
			return this.#cachedFileData;
		} catch {
			return null;
		}
	}

	offered(): GatewayCatalogData {
		const fromFile = this.#readFileCatalog();
		if (fromFile) return fromFile;
		if (!this.#modelRegistry) return { providers: [] };

		const available = this.#modelRegistry.getAvailable();
		const byProvider = new Map<string, GatewayCatalogProvider>();
		for (const model of available) {
			let group = byProvider.get(model.provider);
			if (!group) {
				group = {
					id: model.provider,
					name: model.provider,
					models: [],
				};
				byProvider.set(model.provider, group);
			}
			const supported = getSupportedEfforts(model).filter(e => (GATEWAY_EFFORTS as readonly string[]).includes(e));
			const efforts = model.reasoning
				? ["none", ...(supported.length > 0 ? supported : ["low", "medium", "high"])]
				: ["none"];
			group.models.push({
				id: model.id,
				name: model.name || model.id,
				efforts: Array.from(new Set(efforts)),
				fast: FAST_PROVIDER_IDS[model.provider] === true,
			});
		}
		return { providers: Array.from(byProvider.values()) };
	}

	findModel(provider: string, modelId: string) {
		for (const p of this.offered().providers) {
			if (p.id === provider) {
				for (const m of p.models) {
					if (m.id === modelId) return m;
				}
			}
		}
		return null;
	}

	fastOk(provider: string, modelId: string): boolean {
		return FAST_PROVIDER_IDS[provider] === true && this.findModel(provider, modelId) !== null;
	}

	check(provider: string, modelId: string, reasoning: string): void {
		if (!provider && !modelId) {
			if (reasoning) {
				throw new GatewayApiError(400, "bad_request", "reasoning needs a model");
			}
			return;
		}
		const found = this.findModel(provider, modelId);
		if (!found) {
			throw new GatewayApiError(400, "unknown_model", "that model is not available");
		}
		if (reasoning && !found.efforts.includes(reasoning)) {
			throw new GatewayApiError(400, "unknown_reasoning", "that thinking level is not available for this model");
		}
	}
}

export function cleanMessageContent(content: unknown): string | NormalizedMessagePart[] {
	if (typeof content === "string") {
		if (content.length > MAX_TEXT_PART_CHARS) {
			throw new GatewayApiError(413, "too_large", "message is too long");
		}
		return content;
	}
	if (!Array.isArray(content) || content.length === 0) {
		throw new GatewayApiError(400, "bad_request", "bad message content");
	}
	const parts: NormalizedMessagePart[] = [];
	let images = 0;
	for (const item of content) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			throw new GatewayApiError(400, "bad_request", "bad message part");
		}
		const part = item as Record<string, unknown>;
		if (part.type === "text") {
			const text = part.text;
			if (typeof text !== "string" || text.length > MAX_TEXT_PART_CHARS) {
				throw new GatewayApiError(400, "bad_request", "bad text part");
			}
			parts.push({ type: "text", text });
		} else if (part.type === "image_url") {
			images++;
			if (images > MAX_IMAGES_PER_MESSAGE) {
				throw new GatewayApiError(400, "bad_request", `at most ${MAX_IMAGES_PER_MESSAGE} images in a message`);
			}
			const imgObj = part.image_url;
			const url = isRecord(imgObj) ? imgObj.url : undefined;
			if (
				typeof url !== "string" ||
				!IMAGE_DATA_URL_PREFIXES.some(prefix => url.startsWith(prefix)) ||
				url.length > MAX_IMAGE_DATA_URL_BYTES
			) {
				throw new GatewayApiError(
					400,
					"bad_request",
					"images must be inline data:image/(png|jpeg|webp|gif);base64 URLs",
				);
			}
			parts.push({ type: "image_url", image_url: { url } });
		} else {
			throw new GatewayApiError(400, "bad_request", "unsupported message part");
		}
	}
	return parts;
}

export function extractTextAndImages(content: string | NormalizedMessagePart[]): {
	text: string;
	images: ImageContent[];
} {
	if (typeof content === "string") {
		return { text: content, images: [] };
	}
	const texts: string[] = [];
	const images: ImageContent[] = [];
	for (const part of content) {
		if (part.type === "text" && part.text) {
			texts.push(part.text);
		} else if (part.type === "image_url" && part.image_url?.url) {
			const url = part.image_url.url;
			const commaIndex = url.indexOf(",");
			const header = commaIndex > 0 ? url.slice(5, commaIndex) : "";
			const mimeType = header.split(";")[0] || "image/jpeg";
			const data = commaIndex > 0 ? url.slice(commaIndex + 1) : "";
			if (data) {
				images.push({ type: "image", mimeType, data });
			}
		}
	}
	return { text: texts.join("\n"), images };
}

interface StoredSessionBinding {
	sessionFile: string;
	transcript: Array<{ role: "user" | "assistant"; text: string }>;
}

interface PendingGatewayApproval {
	requestId: string;
	options: string[];
	choices: RpcApprovalSelectChoice[];
	targetKeys?: readonly string[];
	sessionKey?: string;
}

interface ActiveGatewayRun {
	runId: string;
	botId: string;
	convKey: string;
	sendFrame: (frame: object) => void;
	pendingApproval: PendingGatewayApproval | null;
	abort: () => void;
}

interface WorkerStdoutProcess {
	readonly stdout: ReadableStream<Uint8Array> | number | null | undefined;
}

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export class GatewayRunner {
	readonly sandbox: GatewaySandbox;
	readonly #cfg: GatewayConfig;
	readonly #store: GatewayStore;
	readonly #catalog: GatewayModelCatalog;
	readonly #sessionBindings = new Map<string, StoredSessionBinding>();
	readonly #activeByConv = new Map<string, ActiveGatewayRun>();
	readonly #activeByRunId = new Map<string, ActiveGatewayRun>();
	readonly #admittedConversations = new Map<string, symbol>();
	/** Core-issued capability/resource keys or explicit core session-subject scopes. */
	readonly #sessionGrants = new Map<string, Set<string>>();

	constructor(cfg: GatewayConfig, store: GatewayStore, catalog: GatewayModelCatalog) {
		this.#cfg = cfg;
		this.#store = store;
		this.#catalog = catalog;
		this.sandbox = new GatewaySandbox(cfg, store);
	}

	get catalog(): GatewayModelCatalog {
		return this.#catalog;
	}

	/** Stop any active runs and clear cached session state for `botId` (on trash/purge). */
	stopBotRuns(botId: string): void {
		for (const [key, run] of this.#activeByConv.entries()) {
			if (run.botId === botId) {
				run.abort();
				this.#activeByConv.delete(key);
				this.#activeByRunId.delete(run.runId);
			}
		}
		for (const key of this.#sessionBindings.keys()) {
			if (key.startsWith(`${botId}\u0000`)) {
				this.#sessionBindings.delete(key);
			}
		}
		for (const key of this.#sessionGrants.keys()) {
			if (key.startsWith(`${botId}\u0000`)) {
				this.#sessionGrants.delete(key);
			}
		}
	}

	sandboxStatus(botId: string): "running" | "idle" | "unknown" {
		for (const run of this.#activeByConv.values()) {
			if (run.botId === botId) return "running";
		}
		return this.sandbox.status(botId);
	}

	copyOutFromSandbox(botId: string, containerPath: string, destPath: string): boolean {
		return this.sandbox.copyOut(botId, containerPath, destPath);
	}

	/** Answer a pending tool approval (`POST /m/v1/bots/<id>/runs/<runId>/approval`). */
	answerApproval(botId: string, runId: string, body: unknown): { status: number; data: Record<string, unknown> } {
		this.#store.ensureAppBot(botId);
		if (!RUN_ID_RE.test(runId)) {
			throw new GatewayApiError(400, "bad_request", "bad run_id");
		}
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			throw new GatewayApiError(400, "bad_request", "expected a JSON object");
		}
		const input = body as Record<string, unknown>;
		const rawChoice = typeof input.choice === "string" ? input.choice.trim().toLowerCase() : "";
		if (!(APPROVAL_CHOICES as readonly string[]).includes(rawChoice)) {
			throw new GatewayApiError(400, "bad_request", `choice must be one of ${APPROVAL_CHOICES.join(", ")}`);
		}
		const choice = rawChoice as GatewayApprovalChoice;
		const requestId = input.request_id;
		if (requestId !== undefined && (typeof requestId !== "string" || !RUN_ID_RE.test(requestId))) {
			throw new GatewayApiError(400, "bad_request", "bad request_id");
		}
		const active = this.#activeByRunId.get(runId);
		if (!active || active.botId !== botId || !active.pendingApproval) {
			throw new GatewayApiError(404, "not_found", "no pending approval for this run");
		}
		const pending = active.pendingApproval;
		if (requestId !== undefined && requestId !== pending.requestId) {
			throw new GatewayApiError(409, "stale_approval", "approval request_id does not match");
		}

		// Match the requested choice against the structured choices offered by the worker.
		// When both "target" and "folder" grants exist for "session" or "always", prefer "target" (least privilege).
		let matchedIndex = -1;
		for (let i = 0; i < pending.choices.length; i++) {
			const c = pending.choices[i]!;
			if (c.action !== choice) continue;
			if (matchedIndex === -1 || c.grant === "target" || c.grant === undefined) {
				matchedIndex = i;
				if (c.grant === "target" || c.grant === undefined) break;
			}
		}
		if (matchedIndex < 0 || matchedIndex >= pending.options.length) {
			throw new GatewayApiError(400, "bad_request", `choice "${choice}" is not offered for this approval`);
		}
		const selectedLabel = pending.options[matchedIndex]!;
		const selected = pending.choices[matchedIndex]!;
		const sessionKeys =
			selected.grant === "target"
				? pending.targetKeys?.map(key => `target\0${key}`)
				: selected.grant === undefined && pending.sessionKey
					? [`subject\0${pending.sessionKey}`]
					: undefined;
		if (choice === "session" && sessionKeys?.length) {
			let grants = this.#sessionGrants.get(active.convKey);
			if (!grants) {
				grants = new Set<string>();
				this.#sessionGrants.set(active.convKey, grants);
			}
			for (const key of sessionKeys) {
				if (grants.size < 256) grants.add(key);
			}
		}
		active.pendingApproval = null;
		active.sendFrame({
			type: "extension_ui_response",
			id: pending.requestId,
			value: selectedLabel,
		});
		return { status: 200, data: { ok: true, choice } };
	}

	/**
	 * Prepare or reuse a session file for `(botId, conversationId)` without duplicating history.
	 * Handles Android's 24-message sliding window as a valid suffix of the stored transcript, and
	 * creates a fresh seeded session when history diverges (edit / retract / regenerate).
	 */
	async #prepareSession(
		botId: string,
		conversationId: string | undefined,
		priorMessages: Array<{ role: "user" | "assistant"; text: string }>,
		modelProvider: string,
		modelId: string,
	): Promise<{
		sessionFile: string;
		commitTurn: (userText: string, assistantText: string) => void;
	}> {
		const workspaceDir = this.#store.workspaceDir(botId);
		const sessionsDir = this.#store.sessionsDir(botId);
		const bindingKey = conversationId ? `${botId}\u0000${conversationId}` : undefined;

		if (bindingKey) {
			const existing = this.#sessionBindings.get(bindingKey);
			if (existing && fs.existsSync(existing.sessionFile)) {
				// Suffix match: covers both exact match and Android's MAX_HISTORY=24 tail truncation.
				if (
					priorMessages.length <= existing.transcript.length &&
					priorMessages.every((msg, idx) => {
						const stored = existing.transcript[existing.transcript.length - priorMessages.length + idx];
						return stored !== undefined && stored.role === msg.role && stored.text === msg.text;
					})
				) {
					return {
						sessionFile: existing.sessionFile,
						commitTurn: (userText, assistantText) => {
							existing.transcript.push({ role: "user", text: userText });
							existing.transcript.push({ role: "assistant", text: assistantText });
						},
					};
				}
			}
		}

		const manager = SessionManager.create(workspaceDir, sessionsDir);
		const sessionFile = manager.getSessionFile();
		try {
			let ts = Date.now() - priorMessages.length * 1000;
			for (const msg of priorMessages) {
				ts += 100;
				if (msg.role === "user") {
					manager.appendMessage({
						role: "user",
						content: msg.text,
						timestamp: ts,
					});
				} else {
					manager.appendMessage({
						role: "assistant",
						content: [{ type: "text", text: msg.text }],
						api: "openai-completions",
						provider: modelProvider || "gateway",
						model: modelId || "gateway-model",
						usage: ZERO_USAGE,
						stopReason: "stop",
						timestamp: ts,
					});
				}
			}
			await manager.ensureOnDisk();
			await manager.flush();
		} finally {
			await manager.close();
		}
		if (!sessionFile)
			throw new GatewayApiError(500, "session_unavailable", "could not create the conversation session");
		if (this.#cfg.sandboxBackend === "docker" && process.getuid?.() === 0) {
			const fd = fs.openSync(sessionFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
			try {
				fs.fchownSync(fd, GATEWAY_WORKER_UID, GATEWAY_WORKER_GID);
			} finally {
				fs.closeSync(fd);
			}
		}

		const transcript = [...priorMessages];
		if (bindingKey) {
			// Eviction forgets approvals too: remembering less can only ask again.
			if (this.#sessionBindings.size >= 128) {
				const oldest = this.#sessionBindings.keys().next().value;
				if (oldest !== undefined) {
					this.#sessionBindings.delete(oldest);
					this.#sessionGrants.delete(oldest);
				}
			}
			this.#sessionGrants.delete(bindingKey);
			this.#sessionBindings.set(bindingKey, { sessionFile, transcript });
		}
		return {
			sessionFile,
			commitTurn: (userText, assistantText) => {
				transcript.push({ role: "user", text: userText });
				transcript.push({ role: "assistant", text: assistantText });
			},
		};
	}

	/** Handle `POST /m/v1/bots/<id>/chat/completions` and `/p/<profile>/v1/chat/completions`. */
	async handleChatCompletions(
		botId: string,
		body: unknown,
		options: { conversationId?: string; signal?: AbortSignal } = {},
	): Promise<Response> {
		const isCustomBot = BOT_ID_RE.test(botId);
		const botRecord = isCustomBot ? this.#store.getBot(botId, "active") : null;
		this.#store.ensureAppBot(botId);

		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			throw new GatewayApiError(400, "bad_request", "expected a JSON object");
		}
		const reqBody = body as Record<string, unknown>;
		const rawMessages = reqBody.messages;
		if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
			throw new GatewayApiError(400, "bad_request", "messages is required");
		}

		const clientSystemParts: string[] = [];
		const turnMessages: NormalizedChatMessage[] = [];
		for (const item of rawMessages) {
			if (typeof item !== "object" || item === null || Array.isArray(item)) {
				throw new GatewayApiError(400, "bad_request", "bad message");
			}
			const m = item as Record<string, unknown>;
			const role = m.role;
			if (role !== "user" && role !== "assistant" && role !== "system") {
				throw new GatewayApiError(400, "bad_request", "bad message role");
			}
			const cleanedContent = cleanMessageContent(m.content ?? "");
			if (role === "system") {
				if (!isCustomBot) {
					const { text } = extractTextAndImages(cleanedContent);
					if (text.trim()) clientSystemParts.push(text.trim());
				}
			} else {
				turnMessages.push({ role, content: cleanedContent });
			}
		}

		const lastMessage = turnMessages.at(-1);
		if (!lastMessage || lastMessage.role !== "user") {
			throw new GatewayApiError(400, "bad_request", "last message must be a user message");
		}

		// Resolve model, provider, and reasoning effort.
		let provider = "";
		let modelId = "";
		let reasoning = "";
		if (reqBody.modelId || reqBody.modelProvider) {
			provider = typeof reqBody.modelProvider === "string" ? reqBody.modelProvider.trim() : "";
			modelId = typeof reqBody.modelId === "string" ? reqBody.modelId.trim() : "";
			reasoning = typeof reqBody.reasoning === "string" ? reqBody.reasoning.trim().toLowerCase() : "";
		} else if (!isCustomBot && typeof reqBody.provider === "string" && typeof reqBody.model === "string") {
			provider = reqBody.provider.trim();
			modelId = reqBody.model.trim();
			const modelOpts = isRecord(reqBody.model_options) ? reqBody.model_options : undefined;
			const reasoningOpts = modelOpts && isRecord(modelOpts.reasoning) ? modelOpts.reasoning : undefined;
			if (reasoningOpts) {
				reasoning =
					reasoningOpts.enabled === false
						? "none"
						: typeof reasoningOpts.effort === "string"
							? reasoningOpts.effort
							: "";
			}
		} else if (botRecord) {
			provider = botRecord.modelProvider;
			modelId = botRecord.modelId;
			reasoning = botRecord.reasoning;
		}
		this.#catalog.check(provider, modelId, reasoning);

		// Tool availability and execution isolation are independent: even readonly bots use the sandbox.
		const sandboxed = isCustomBot ? botRecord!.sandboxed : this.#cfg.adminLocalTools === true;

		const convId =
			options.conversationId && CONVERSATION_ID_RE.test(options.conversationId) ? options.conversationId : undefined;
		const convKey = `${botId}\u0000${convId ?? `ephemeral-${crypto.randomBytes(6).toString("hex")}`}`;
		if (this.#admittedConversations.has(convKey)) {
			throw new GatewayApiError(409, "busy", "a reply is already streaming for this conversation");
		}
		if (this.#admittedConversations.size >= Math.max(1, this.#cfg.maxBots + this.#cfg.localProfiles.length)) {
			throw new GatewayApiError(429, "busy", "the gateway has reached its concurrent reply limit");
		}
		const admission = Symbol(convKey);
		this.#admittedConversations.set(convKey, admission);
		try {
			await this.sandbox.ensure(botId);
			if (options.signal?.aborted) throw new GatewayApiError(499, "aborted", "request was cancelled");

			const priorTranscript = turnMessages.slice(0, -1).map(m => ({
				role: m.role as "user" | "assistant",
				text: extractTextAndImages(m.content).text,
			}));
			const { text: rawPromptText, images: promptImages } = extractTextAndImages(lastMessage.content);
			const prepared = await this.#prepareSession(botId, convId, priorTranscript, provider, modelId);

			// Compose system prompt.
			const systemBlocks: string[] = [];
			if (isCustomBot) {
				if (botRecord!.systemPrompt.trim()) systemBlocks.push(botRecord!.systemPrompt.trim());
			} else if (clientSystemParts.length > 0) {
				systemBlocks.push(clientSystemParts.join("\n\n"));
			}
			if (reqBody.markdown === true) {
				systemBlocks.push(MARKDOWN_HINT);
			}
			const systemPrompt = systemBlocks.join("\n\n");

			const runId = `run_${crypto.randomBytes(8).toString("hex")}`;
			const streamMode = reqBody.stream !== false;
			const fastRequested =
				(reqBody.fast === true || (isRecord(reqBody.model_options) && reqBody.model_options.fast === true)) &&
				provider &&
				modelId &&
				this.#catalog.fastOk(provider, modelId);

			const cliArgs: string[] = [
				"--mode",
				"rpc-ui",
				"--restrict-tools",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"--no-context-files",
				"--no-lsp",
				"--no-title",
				"--no-pty",
			];
			cliArgs.push("--resume", prepared.sessionFile);
			if (provider && modelId) {
				cliArgs.push("--model", `${provider}/${modelId}`);
			}
			if (reasoning) {
				cliArgs.push("--thinking", reasoning === "none" ? "off" : reasoning);
			}
			if (systemPrompt) {
				cliArgs.push("--system-prompt", systemPrompt);
			}
			if (sandboxed) {
				cliArgs.push(
					"--tools",
					"read,write,edit,bash,grep,glob,web_search,todo",
					"--approval-mode",
					"always-ask-cached",
				);
			} else {
				cliArgs.push("--tools", "web_search,todo", "--approval-mode", "yolo");
			}

			const worker = this.sandbox.workerCommand(botId, cliArgs, runId);
			const child = Bun.spawn(worker.cmd, {
				cwd: worker.cwd,
				env: worker.env,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "ignore",
			});

			const sendFrame = (frame: object) => {
				try {
					child.stdin.write(`${JSON.stringify(frame)}\n`);
					child.stdin.flush();
				} catch {
					// Child stdin already closed.
				}
			};
			const forceStopWorker = () => {
				if (child.exitCode !== null) return;
				try {
					this.sandbox.killWorker(botId, runId);
				} finally {
					child.kill();
				}
			};

			let aborted = false;
			let heartbeatTimer: Timer | undefined;
			const abortRun = () => {
				if (aborted) return;
				aborted = true;
				clearInterval(heartbeatTimer);
				sendFrame({ id: "abort-run", type: "abort" });
				setTimeout(() => {
					try {
						forceStopWorker();
					} catch {
						// Already exited.
					}
				}, 1500).unref();
			};

			const activeRun: ActiveGatewayRun = {
				runId,
				botId,
				convKey,
				sendFrame,
				pendingApproval: null,
				abort: abortRun,
			};
			this.#activeByConv.set(convKey, activeRun);
			this.#activeByRunId.set(runId, activeRun);
			options.signal?.addEventListener("abort", abortRun, { once: true });
			if (options.signal?.aborted) abortRun();
			const runTimeout = setTimeout(abortRun, 30 * 60 * 1000);
			runTimeout.unref();

			let cleanupPromise: Promise<void> | undefined;
			const cleanupRun = () => {
				cleanupPromise ??= (async () => {
					clearTimeout(runTimeout);
					clearInterval(heartbeatTimer);
					options.signal?.removeEventListener("abort", abortRun);
					try {
						child.stdin.end();
					} catch {
						// Ignore.
					}
					const killTimer = setTimeout(() => {
						try {
							forceStopWorker();
						} catch {
							// Already exited.
						}
					}, 1500);
					killTimer.unref();
					await child.exited.catch(() => {});
					clearTimeout(killTimer);
					if (this.#activeByConv.get(convKey) === activeRun) this.#activeByConv.delete(convKey);
					this.#activeByRunId.delete(runId);
					if (this.#admittedConversations.get(convKey) === admission) this.#admittedConversations.delete(convKey);
					if (!convId) this.#sessionGrants.delete(convKey);
				})();
				return cleanupPromise;
			};

			const encoder = new TextEncoder();
			const chunkBase = {
				id: `chatcmpl_${runId}`,
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1000),
				model: modelId || "npi-bot",
			};

			if (!streamMode) {
				let fullText = "";
				let fullReasoning = "";
				let promptFailed: string | undefined;
				try {
					await this.#driveWorkerFrames(child, {
						onReady: () => {
							if (fastRequested) sendFrame({ id: "fast-1", type: "set_fast_mode", enabled: true });
							sendFrame({
								id: runId,
								type: "prompt",
								message: rawPromptText,
								...(promptImages.length > 0 ? { images: promptImages } : {}),
							});
						},
						onTextDelta: delta => {
							fullText += delta;
						},
						onThinkingDelta: delta => {
							fullReasoning += delta;
						},
						onToolStart: () => {},
						onToolEnd: () => {},
						onApprovalSelect: req => {
							// Non-streaming requests cannot interactively approve; deny by default.
							const denyIdx = req.approval.choices.findIndex(c => c.action === "deny");
							sendFrame({
								type: "extension_ui_response",
								id: req.id,
								value: req.options[denyIdx >= 0 ? denyIdx : req.options.length - 1] ?? "Deny",
							});
						},
						onPromptResult: (status, errText) => {
							if (status !== "completed")
								promptFailed =
									errText || (status === "aborted" ? "Agent reply aborted" : "Agent prompt failed");
						},
					});
				} finally {
					await cleanupRun();
				}
				if (promptFailed) {
					throw new GatewayApiError(502, "upstream", promptFailed);
				}
				prepared.commitTurn(rawPromptText, fullText);
				this.#store.rescueReplyMedia(botId, fullText, (b, p, d) => this.copyOutFromSandbox(b, p, d));
				return Response.json({
					id: `chatcmpl_${runId}`,
					object: "chat.completion",
					created: Math.floor(Date.now() / 1000),
					model: modelId || "npi-bot",
					choices: [
						{
							index: 0,
							message: {
								role: "assistant",
								content: fullText,
								...(fullReasoning ? { reasoning_content: fullReasoning } : {}),
							},
							finish_reason: "stop",
						},
					],
				});
			}

			const toolCommands = new Map<string, { command: string; startedAt: number }>();
			const sseStream = new ReadableStream<Uint8Array>({
				start: async controller => {
					let fullText = "";
					const writeSse = (raw: string) => {
						if (aborted) return;
						try {
							controller.enqueue(encoder.encode(raw));
						} catch {
							abortRun();
						}
					};
					// Keep both Bun and the native clients connected while tools or approvals are quiet.
					heartbeatTimer = setInterval(() => writeSse(": keep-alive\n\n"), 10_000);
					heartbeatTimer.unref();
					writeSse(": connected\n\n");
					try {
						await this.#driveWorkerFrames(child, {
							onReady: () => {
								if (fastRequested) sendFrame({ id: "fast-1", type: "set_fast_mode", enabled: true });
								sendFrame({
									id: runId,
									type: "prompt",
									message: rawPromptText,
									...(promptImages.length > 0 ? { images: promptImages } : {}),
								});
							},
							onTextDelta: delta => {
								fullText += delta;
								writeSse(
									`data: ${JSON.stringify({
										...chunkBase,
										choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
									})}\n\n`,
								);
							},
							onThinkingDelta: delta => {
								writeSse(
									`data: ${JSON.stringify({
										...chunkBase,
										choices: [{ index: 0, delta: { reasoning_content: delta }, finish_reason: null }],
									})}\n\n`,
								);
							},
							onToolStart: (toolCallId, toolName, args) => {
								const wireTool = toolName === "bash" ? "terminal" : toolName;
								const cmd = typeof args?.command === "string" ? args.command : "";
								if (toolName === "bash") {
									toolCommands.set(toolCallId, { command: cmd, startedAt: Date.now() });
								}
								writeSse(
									`event: hermes.tool.progress\ndata: ${JSON.stringify({
										toolCallId,
										status: "running",
										tool: wireTool,
										label: cmd || toolName,
									})}\n\n`,
								);
								if (toolName === "bash") {
									writeSse(
										`event: lablink.tool\ndata: ${JSON.stringify({
											toolCallId,
											status: "running",
											command: cmd,
										})}\n\n`,
									);
								}
							},
							onToolEnd: (toolCallId, toolName, result, isError) => {
								const wireTool = toolName === "bash" ? "terminal" : toolName;
								writeSse(
									`event: hermes.tool.progress\ndata: ${JSON.stringify({
										toolCallId,
										status: "completed",
										tool: wireTool,
									})}\n\n`,
								);
								if (toolName === "bash") {
									const meta = toolCommands.get(toolCallId);
									toolCommands.delete(toolCallId);
									const outputText = GatewayRunner.#extractToolOutputText(result);
									const durationMs = meta ? Math.max(0, Date.now() - meta.startedAt) : 0;
									writeSse(
										`event: lablink.tool\ndata: ${JSON.stringify({
											toolCallId,
											status: "completed",
											command: meta?.command ?? "",
											output: outputText,
											exitCode: isError ? 1 : 0,
											error: isError ? outputText.slice(0, 300) : null,
											durationMs,
										})}\n\n`,
									);
								}
							},
							onApprovalSelect: req => {
								const keys = req.approval.targetKeys;
								const sessionKey = req.approval.sessionKey;
								const sessionGrants = this.#sessionGrants.get(convKey);
								const targetApproved = keys?.length && keys.every(key => sessionGrants?.has(`target\0${key}`));
								const subjectApproved = sessionKey && sessionGrants?.has(`subject\0${sessionKey}`);
								if (targetApproved || subjectApproved) {
									const onceIdx = req.approval.choices.findIndex(c => c.action === "once");
									if (onceIdx >= 0 && req.options[onceIdx]) {
										sendFrame({ type: "extension_ui_response", id: req.id, value: req.options[onceIdx] });
										return;
									}
								}

								const choices: RpcApprovalSelectChoice[] = [];
								const labels: string[] = [];
								for (let i = 0; i < req.approval.choices.length; i++) {
									const choice = req.approval.choices[i]!;
									if (choice.action === "session") {
										const exactTarget = choice.grant === "target" && keys?.length;
										const coreSubject = choice.grant === undefined && sessionKey;
										if (!exactTarget && !coreSubject) continue;
									}
									const label = req.options[i];
									if (label === undefined) continue;
									choices.push(choice);
									labels.push(label);
								}
								activeRun.pendingApproval = {
									requestId: req.id,
									options: labels,
									choices,
									targetKeys: keys,
									sessionKey,
								};
								const cmdLine =
									req.title
										.split("\n")
										.find(line => line.startsWith("Command: "))
										?.slice("Command: ".length) ?? req.title;
								const patternKey = req.approval.toolName === "bash" ? classifyCommandKind(cmdLine) : "danger";
								const offeredActions = APPROVAL_CHOICES.filter(action =>
									choices.some(c => c.action === action),
								);
								writeSse(
									`event: approval.request\ndata: ${JSON.stringify({
										run_id: runId,
										request_id: req.id,
										pattern_key: patternKey,
										description: req.title,
										command: cmdLine,
										choices: offeredActions,
									})}\n\n`,
								);
							},
							onPromptResult: (status, errText) => {
								if (status === "completed") {
									prepared.commitTurn(rawPromptText, fullText);
									this.#store.rescueReplyMedia(botId, fullText, (b, p, d) => this.copyOutFromSandbox(b, p, d));
									writeSse(
										`data: ${JSON.stringify({
											...chunkBase,
											choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
										})}\n\ndata: [DONE]\n\n`,
									);
								} else if (status === "error") {
									writeSse(
										`data: ${JSON.stringify({
											...chunkBase,
											choices: [
												{
													index: 0,
													delta: { content: `\n[Error: ${errText ?? "upstream failure"}]` },
													finish_reason: "error",
												},
											],
										})}\n\ndata: [DONE]\n\n`,
									);
								}
							},
						});
					} catch (error) {
						writeSse(
							`data: ${JSON.stringify({
								...chunkBase,
								choices: [
									{
										index: 0,
										delta: {
											content: `\n[Error: ${error instanceof Error ? error.message : "upstream failure"}]`,
										},
										finish_reason: "error",
									},
								],
							})}\n\ndata: [DONE]\n\n`,
						);
					} finally {
						await cleanupRun();
						try {
							controller.close();
						} catch {
							// Stream already closed.
						}
					}
				},
				cancel: () => {
					abortRun();
					return cleanupRun();
				},
			});

			return new Response(sseStream, {
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					"X-Accel-Buffering": "no",
				},
			});
		} catch (error) {
			if (this.#admittedConversations.get(convKey) === admission) this.#admittedConversations.delete(convKey);
			throw error;
		}
	}

	static #extractToolOutputText(result: unknown): string {
		if (!isRecord(result)) return "";
		const content = result.content;
		if (!Array.isArray(content)) return "";
		return content.map(item => (isRecord(item) && typeof item.text === "string" ? item.text : "")).join("");
	}

	async #driveWorkerFrames(
		child: WorkerStdoutProcess,
		handlers: {
			onReady: () => void;
			onTextDelta: (delta: string) => void;
			onThinkingDelta: (delta: string) => void;
			onToolStart: (toolCallId: string, toolName: string, args: Record<string, unknown> | undefined) => void;
			onToolEnd: (toolCallId: string, toolName: string, result: unknown, isError: boolean) => void;
			onApprovalSelect: (
				req: Extract<RpcExtensionUIRequest, { method: "select" }> & {
					approval: NonNullable<Extract<RpcExtensionUIRequest, { method: "select" }>["approval"]>;
				},
			) => void;
			onPromptResult: (status: "completed" | "aborted" | "error", errorMessage?: string) => void;
		},
	): Promise<void> {
		const stdout = child.stdout;
		if (!stdout || typeof stdout === "number") throw new GatewayApiError(502, "upstream", "worker has no RPC output");
		const reader = stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const frames = new RpcFrameDecoder();
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let newlineIdx = buffer.indexOf("\n");
				if (buffer.length > MAX_RPC_FRAME_BYTES && !buffer.includes("\n")) {
					throw new GatewayApiError(502, "upstream", "worker exceeded the RPC frame limit");
				}
				while (newlineIdx >= 0) {
					const line = buffer.slice(0, newlineIdx).trim();
					if (Buffer.byteLength(line) > MAX_RPC_FRAME_BYTES) {
						throw new GatewayApiError(502, "upstream", "worker exceeded the RPC frame limit");
					}
					buffer = buffer.slice(newlineIdx + 1);
					if (line) {
						let frame: Record<string, unknown> | null = null;
						try {
							const decoded = frames.push(JSON.parse(line));
							frame = isRecord(decoded) ? decoded : null;
						} catch {
							throw new GatewayApiError(502, "upstream", "worker returned an invalid RPC frame");
						}
						if (frame) {
							const type = frame.type;
							if (type === "ready") {
								handlers.onReady();
							} else if (type === "message_update") {
								const ev = frame.assistantMessageEvent as { type?: string; delta?: string } | undefined;
								if (ev?.type === "text_delta" && typeof ev.delta === "string") {
									handlers.onTextDelta(ev.delta);
								} else if (ev?.type === "thinking_delta" && typeof ev.delta === "string") {
									handlers.onThinkingDelta(ev.delta);
								}
							} else if (type === "tool_execution_start") {
								handlers.onToolStart(
									String(frame.toolCallId ?? ""),
									String(frame.toolName ?? ""),
									frame.args as Record<string, unknown> | undefined,
								);
							} else if (type === "tool_execution_end") {
								handlers.onToolEnd(
									String(frame.toolCallId ?? ""),
									String(frame.toolName ?? ""),
									frame.result,
									frame.isError === true,
								);
							} else if (
								type === "extension_ui_request" &&
								frame.method === "select" &&
								typeof frame.approval === "object" &&
								frame.approval !== null
							) {
								handlers.onApprovalSelect(
									frame as unknown as Extract<RpcExtensionUIRequest, { method: "select" }> & {
										approval: NonNullable<Extract<RpcExtensionUIRequest, { method: "select" }>["approval"]>;
									},
								);
							} else if (type === "prompt_result") {
								const status = (frame.status as "completed" | "aborted" | "error") ?? "completed";
								const errObj = frame.error;
								const errMsg =
									typeof errObj === "string"
										? errObj
										: isRecord(errObj) && typeof errObj.message === "string"
											? errObj.message
											: undefined;
								handlers.onPromptResult(status, errMsg);
								return;
							}
						}
					}
					newlineIdx = buffer.indexOf("\n");
				}
			}
			handlers.onPromptResult("error", "Agent worker exited before completing the reply");
		} finally {
			reader.releaseLock();
		}
	}
}
