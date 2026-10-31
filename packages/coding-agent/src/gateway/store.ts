/**
 * SQLite and filesystem storage for the NPi Bot Gateway.
 */
import { Database } from "bun:sqlite";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	BOT_ID_RE,
	type BotListResponse,
	type BotRecord,
	type BotState,
	type BotView,
	CONVERSATION_ID_RE,
	type ConversationMeta,
	GATEWAY_EFFORTS,
	GatewayApiError,
	type GatewayConfig,
	MAX_MEDIA_BYTES,
	MAX_UPLOAD_BYTES,
} from "./types";

const MEDIA_TYPES: Readonly<Record<string, string>> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

const MOUNTED_PREFIXES = ["/root/.hermes/", "/workspace/", "/root/"] as const;
const MEDIA_TOKEN_RE = /MEDIA:(\/\S+)/g;

interface BotRow {
	id: string;
	state: BotState;
	name: string;
	role: string;
	color: number;
	system_prompt: string;
	model_provider: string;
	model_id: string;
	reasoning: string;
	sandboxed: number;
	created_at: number;
	trashed_at: number | null;
}

interface ChatRow {
	bot_id: string;
	conv_id: string;
	title: string;
	created: number;
	updated: number;
	pinned: number;
	renamed: number;
	deleted: number;
	messages_json: string;
}

export interface CleanedBotSpec {
	name?: string;
	role?: string;
	systemPrompt?: string;
	color?: number;
	sandboxed?: boolean;
	modelProvider?: string;
	modelId?: string;
	reasoning?: string;
}

export class GatewayStore {
	readonly #cfg: GatewayConfig;
	readonly #db: Database;

	constructor(cfg: GatewayConfig) {
		this.#cfg = cfg;
		fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
		fs.mkdirSync(this.botsRootDir(), { recursive: true, mode: 0o700 });
		for (const profile of cfg.localProfiles) {
			this.#ensureBotDirs(profile);
		}
		this.#db = new Database(path.join(cfg.dataDir, "gateway.db"));
		this.#db.exec("PRAGMA journal_mode = WAL;");
		this.#db.exec("PRAGMA synchronous = NORMAL;");
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS bots (
				id TEXT PRIMARY KEY,
				state TEXT NOT NULL,
				name TEXT NOT NULL,
				role TEXT NOT NULL DEFAULT '',
				color INTEGER NOT NULL DEFAULT 4283778784,
				system_prompt TEXT NOT NULL DEFAULT '',
				model_provider TEXT NOT NULL DEFAULT '',
				model_id TEXT NOT NULL DEFAULT '',
				reasoning TEXT NOT NULL DEFAULT '',
				sandboxed INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				trashed_at INTEGER
			);
			CREATE TABLE IF NOT EXISTS chats (
				bot_id TEXT NOT NULL,
				conv_id TEXT NOT NULL,
				title TEXT NOT NULL DEFAULT '',
				created INTEGER NOT NULL DEFAULT 0,
				updated INTEGER NOT NULL,
				pinned INTEGER NOT NULL DEFAULT 0,
				renamed INTEGER NOT NULL DEFAULT 0,
				deleted INTEGER NOT NULL DEFAULT 0,
				messages_json TEXT NOT NULL DEFAULT '[]',
				PRIMARY KEY (bot_id, conv_id)
			);
		`);
	}

	close(): void {
		this.#db.close();
	}

	botsRootDir(): string {
		return path.join(this.#cfg.dataDir, "bots");
	}

	botDir(botId: string): string {
		return path.join(this.botsRootDir(), botId);
	}

	workspaceDir(botId: string): string {
		return path.join(this.botDir(botId), "workspace");
	}

	attachmentsDir(botId: string): string {
		return path.join(this.botDir(botId), "attachments");
	}

	sessionsDir(botId: string): string {
		return path.join(this.botDir(botId), "sessions");
	}

	mediaRescueDir(botId: string): string {
		return path.join(this.botDir(botId), "media-rescue");
	}

	#ensureBotDirs(botId: string): void {
		fs.mkdirSync(this.workspaceDir(botId), { recursive: true, mode: 0o700 });
		fs.mkdirSync(this.attachmentsDir(botId), { recursive: true, mode: 0o700 });
		fs.mkdirSync(path.join(this.workspaceDir(botId), "attachments"), { recursive: true, mode: 0o700 });
		fs.mkdirSync(this.sessionsDir(botId), { recursive: true, mode: 0o700 });
		fs.mkdirSync(this.mediaRescueDir(botId), { recursive: true, mode: 0o700 });
	}

	/** Verify `botId` is either an active sandbox/custom bot or a configured local profile (`labbot`). */
	ensureAppBot(botId: string): string {
		if (BOT_ID_RE.test(botId)) {
			this.getBot(botId, "active");
			this.#ensureBotDirs(botId);
			return this.botDir(botId);
		}
		if (!this.#cfg.localProfiles.includes(botId)) {
			throw new GatewayApiError(404, "not_found", "no such bot");
		}
		this.#ensureBotDirs(botId);
		return this.botDir(botId);
	}

	static cleanBotSpec(spec: unknown, partial = false): CleanedBotSpec {
		if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
			throw new GatewayApiError(400, "bad_request", "expected a JSON object");
		}
		const input = spec as Record<string, unknown>;
		const out: CleanedBotSpec = {};
		const rules: ReadonlyArray<readonly ["name" | "role" | "systemPrompt", number, number]> = [
			["name", 1, 40],
			["role", 0, 200],
			["systemPrompt", 0, 8000],
		];
		for (const [key, minLen, maxLen] of rules) {
			if (key in input) {
				const raw = input[key];
				if (typeof raw !== "string") {
					throw new GatewayApiError(400, "bad_request", `${key} must be a string`);
				}
				const trimmed = raw.trim();
				if (trimmed.length < minLen || trimmed.length > maxLen) {
					throw new GatewayApiError(400, "bad_request", `${key} must be ${minLen}..${maxLen} characters`);
				}
				out[key] = trimmed;
			} else if (!partial && key === "name") {
				throw new GatewayApiError(400, "bad_request", "name is required");
			}
		}
		if ("color" in input) {
			const c = input.color;
			if (typeof c !== "number" || !Number.isInteger(c)) {
				throw new GatewayApiError(400, "bad_request", "color must be an integer");
			}
			out.color = c >>> 0;
		}
		if ("sandboxed" in input && !partial) {
			if (typeof input.sandboxed !== "boolean") {
				throw new GatewayApiError(400, "bad_request", "sandboxed must be true or false");
			}
			out.sandboxed = input.sandboxed;
		}
		for (const [key, maxLen] of [
			["modelProvider", 60],
			["modelId", 120],
		] as const) {
			if (key in input) {
				const raw = input[key];
				if (typeof raw !== "string") {
					throw new GatewayApiError(400, "bad_request", `${key} must be a string`);
				}
				const trimmed = raw.trim();
				if (trimmed.length > maxLen || (trimmed.length > 0 && !/^[A-Za-z0-9._:/-]+$/.test(trimmed))) {
					throw new GatewayApiError(400, "bad_request", `invalid ${key}`);
				}
				out[key] = trimmed;
			}
		}
		if ("reasoning" in input) {
			const raw = input.reasoning;
			if (typeof raw !== "string") {
				throw new GatewayApiError(400, "bad_request", "reasoning must be a string");
			}
			const trimmed = raw.trim().toLowerCase();
			if (trimmed.length > 0 && !(GATEWAY_EFFORTS as readonly string[]).includes(trimmed)) {
				throw new GatewayApiError(400, "bad_request", `reasoning must be one of ${GATEWAY_EFFORTS.join(", ")}`);
			}
			out.reasoning = trimmed;
		}
		if (partial && Object.keys(out).length === 0) {
			throw new GatewayApiError(400, "bad_request", "nothing to update");
		}
		return out;
	}

	#rowToRecord(row: BotRow): BotRecord {
		return {
			id: row.id,
			state: row.state,
			name: row.name,
			role: row.role,
			color: row.color >>> 0,
			systemPrompt: row.system_prompt,
			modelProvider: row.model_provider,
			modelId: row.model_id,
			reasoning: row.reasoning,
			sandboxed: row.sandboxed !== 0,
			createdAt: row.created_at,
			trashedAt: row.trashed_at,
		};
	}

	toView(bot: BotRecord, sandboxProbe?: (botId: string) => "running" | "idle" | "unknown"): BotView {
		const view: BotView = {
			id: bot.id,
			name: bot.name,
			role: bot.role,
			color: bot.color,
			systemPrompt: bot.systemPrompt,
			createdAt: bot.createdAt,
			modelProvider: bot.modelProvider,
			modelId: bot.modelId,
			reasoning: bot.reasoning,
			sandboxed: bot.sandboxed,
		};
		if (bot.state === "trashed") {
			view.trashedAt = bot.trashedAt;
			if (this.#cfg.trashDays > 0 && bot.trashedAt) {
				view.expiresAt = bot.trashedAt + this.#cfg.trashDays * 86400;
			}
		} else {
			view.sandbox = sandboxProbe ? sandboxProbe(bot.id) : "idle";
		}
		return view;
	}

	countByState(state: BotState): number {
		const row = this.#db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM bots WHERE state = ?").get(state);
		return row?.n ?? 0;
	}

	getBot(botId: string, expectedState?: BotState): BotRecord {
		const row = this.#db.query<BotRow, [string]>("SELECT * FROM bots WHERE id = ?").get(botId);
		if (!row || (expectedState && row.state !== expectedState)) {
			throw new GatewayApiError(404, "not_found", "no such bot");
		}
		return this.#rowToRecord(row);
	}

	listBots(sandboxProbe?: (botId: string) => "running" | "idle" | "unknown"): BotListResponse {
		const rows = this.#db.query<BotRow, []>("SELECT * FROM bots ORDER BY created_at ASC, id ASC").all();
		const bots: BotView[] = [];
		const trash: BotView[] = [];
		for (const row of rows) {
			const record = this.#rowToRecord(row);
			if (record.state === "active") {
				bots.push(this.toView(record, sandboxProbe));
			} else if (record.state === "trashed") {
				trash.push(this.toView(record, sandboxProbe));
			}
		}
		return {
			bots,
			trash,
			limit: this.#cfg.maxBots,
			trashLimit: this.#cfg.maxTrash,
			trashDays: this.#cfg.trashDays,
		};
	}

	createBot(
		spec: unknown,
		checkModel: (provider: string, modelId: string, reasoning: string) => void,
		sandboxProbe?: (botId: string) => "running" | "idle" | "unknown",
	): BotView {
		const data = GatewayStore.cleanBotSpec(spec, false);
		checkModel(data.modelProvider ?? "", data.modelId ?? "", data.reasoning ?? "");
		if (this.countByState("active") >= this.#cfg.maxBots) {
			throw new GatewayApiError(409, "limit_reached", `at most ${this.#cfg.maxBots} bots; delete one first`);
		}
		let botId = "";
		for (let i = 0; i < 8; i++) {
			const candidate = `b${crypto.randomBytes(5).toString("hex")}`;
			const exists = this.#db.query<{ id: string }, [string]>("SELECT id FROM bots WHERE id = ?").get(candidate);
			if (!exists) {
				botId = candidate;
				break;
			}
		}
		if (!botId) {
			throw new GatewayApiError(500, "create_failed", "could not allocate bot id");
		}
		const now = Math.floor(Date.now() / 1000);
		const record: BotRecord = {
			id: botId,
			state: "active",
			name: data.name!,
			role: data.role ?? "",
			color: data.color ?? 0xff5546e0,
			systemPrompt: data.systemPrompt ?? "",
			modelProvider: data.modelProvider ?? "",
			modelId: data.modelId ?? "",
			reasoning: data.reasoning ?? "",
			sandboxed: data.sandboxed ?? false,
			createdAt: now,
			trashedAt: null,
		};
		try {
			this.#ensureBotDirs(botId);
			fs.writeFileSync(path.join(this.botDir(botId), "SOUL.md"), record.systemPrompt || `You are ${record.name}.`, {
				mode: 0o600,
			});
			this.#db
				.query(
					`INSERT INTO bots (id, state, name, role, color, system_prompt, model_provider, model_id, reasoning, sandboxed, created_at, trashed_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
				)
				.run(
					record.id,
					record.state,
					record.name,
					record.role,
					record.color,
					record.systemPrompt,
					record.modelProvider,
					record.modelId,
					record.reasoning,
					record.sandboxed ? 1 : 0,
					record.createdAt,
				);
		} catch (err) {
			try {
				fs.rmSync(this.botDir(botId), { recursive: true, force: true });
			} catch {
				// Best-effort cleanup of half-created directory.
			}
			if (err instanceof GatewayApiError) throw err;
			throw new GatewayApiError(500, "create_failed", "could not create the bot");
		}
		return this.toView(record, sandboxProbe);
	}

	updateBot(
		botId: string,
		spec: unknown,
		checkModel: (provider: string, modelId: string, reasoning: string) => void,
		sandboxProbe?: (botId: string) => "running" | "idle" | "unknown",
	): BotView {
		const data = GatewayStore.cleanBotSpec(spec, true);
		const current = this.getBot(botId, "active");
		const nextProvider = data.modelProvider !== undefined ? data.modelProvider : current.modelProvider;
		const nextModel = data.modelId !== undefined ? data.modelId : current.modelId;
		const nextReasoning = data.reasoning !== undefined ? data.reasoning : current.reasoning;
		if ("modelProvider" in data || "modelId" in data || "reasoning" in data) {
			checkModel(nextProvider, nextModel, nextReasoning);
		}
		const updated: BotRecord = {
			...current,
			name: data.name ?? current.name,
			role: data.role ?? current.role,
			color: data.color ?? current.color,
			systemPrompt: data.systemPrompt ?? current.systemPrompt,
			modelProvider: nextProvider,
			modelId: nextModel,
			reasoning: nextReasoning,
		};
		this.#ensureBotDirs(botId);
		fs.writeFileSync(path.join(this.botDir(botId), "SOUL.md"), updated.systemPrompt || `You are ${updated.name}.`, {
			mode: 0o600,
		});
		this.#db
			.query(
				`UPDATE bots
				 SET name = ?, role = ?, color = ?, system_prompt = ?, model_provider = ?, model_id = ?, reasoning = ?
				 WHERE id = ?`,
			)
			.run(
				updated.name,
				updated.role,
				updated.color,
				updated.systemPrompt,
				updated.modelProvider,
				updated.modelId,
				updated.reasoning,
				botId,
			);
		return this.toView(updated, sandboxProbe);
	}

	trashBot(botId: string, onStopBot?: (botId: string) => void): void {
		this.getBot(botId, "active");
		if (this.countByState("trashed") >= this.#cfg.maxTrash) {
			throw new GatewayApiError(409, "trash_full", `trash holds at most ${this.#cfg.maxTrash} bots; empty it first`);
		}
		onStopBot?.(botId);
		const now = Math.floor(Date.now() / 1000);
		this.#db.query("UPDATE bots SET state = 'trashed', trashed_at = ? WHERE id = ?").run(now, botId);
	}

	restoreBot(botId: string, sandboxProbe?: (botId: string) => "running" | "idle" | "unknown"): BotView {
		const current = this.getBot(botId, "trashed");
		if (this.countByState("active") >= this.#cfg.maxBots) {
			throw new GatewayApiError(409, "limit_reached", `at most ${this.#cfg.maxBots} bots; delete one first`);
		}
		this.#ensureBotDirs(botId);
		this.#db.query("UPDATE bots SET state = 'active', trashed_at = NULL WHERE id = ?").run(botId);
		return this.toView({ ...current, state: "active", trashedAt: null }, sandboxProbe);
	}

	purgeBot(botId: string, onStopBot?: (botId: string) => void): void {
		const row = this.#db.query<BotRow, [string]>("SELECT * FROM bots WHERE id = ?").get(botId);
		if (!row) {
			throw new GatewayApiError(404, "not_found", "no such bot");
		}
		if (row.state === "active") {
			throw new GatewayApiError(409, "not_in_trash", "move the bot to the trash first");
		}
		onStopBot?.(botId);
		this.#db.query("DELETE FROM chats WHERE bot_id = ?").run(botId);
		this.#db.query("DELETE FROM bots WHERE id = ?").run(botId);
		fs.rmSync(this.botDir(botId), { recursive: true, force: true });
	}

	expireTrash(onStopBot?: (botId: string) => void): number {
		if (this.#cfg.trashDays <= 0) return 0;
		const cutoff = Math.floor(Date.now() / 1000) - this.#cfg.trashDays * 86400;
		const expired = this.#db
			.query<{ id: string }, [number]>(
				"SELECT id FROM bots WHERE state = 'trashed' AND trashed_at IS NOT NULL AND trashed_at < ?",
			)
			.all(cutoff);
		for (const { id } of expired) {
			this.purgeBot(id, onStopBot);
		}
		return expired.length;
	}

	// ---------------------------------------------------------------------------
	// Shared conversations (`/m/v1/chats/<bot>[/<cid>]`)
	// ---------------------------------------------------------------------------

	static #cleanConversation(raw: unknown, convId: string): ConversationMeta {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			throw new GatewayApiError(400, "bad_request", "conversation must be an object");
		}
		const c = raw as Record<string, unknown>;
		const title = typeof c.title === "string" ? c.title.slice(0, 200) : "";
		for (const key of ["created", "updated"] as const) {
			const val = c[key];
			if (typeof val !== "number" || !Number.isInteger(val) || val < 0) {
				throw new GatewayApiError(400, "bad_request", `${key} must be a time in milliseconds`);
			}
		}
		return {
			id: convId,
			title,
			created: c.created as number,
			updated: c.updated as number,
			pinned: c.pinned === true,
			renamed: c.renamed === true,
		};
	}

	static #rowToConversationMeta(row: ChatRow): ConversationMeta {
		if (row.deleted !== 0) {
			return {
				id: row.conv_id,
				deleted: true,
				updated: row.updated,
			};
		}
		return {
			id: row.conv_id,
			title: row.title,
			created: row.created,
			updated: row.updated,
			pinned: row.pinned !== 0,
			renamed: row.renamed !== 0,
		};
	}

	chatList(botId: string): { conversations: ConversationMeta[] } {
		this.ensureAppBot(botId);
		const rows = this.#db
			.query<ChatRow, [string]>("SELECT * FROM chats WHERE bot_id = ? ORDER BY updated DESC")
			.all(botId);
		return {
			conversations: rows.map(row => GatewayStore.#rowToConversationMeta(row)),
		};
	}

	chatGet(botId: string, convId: string): { conversation: ConversationMeta; messages: unknown[] } {
		this.ensureAppBot(botId);
		if (!CONVERSATION_ID_RE.test(convId)) {
			throw new GatewayApiError(404, "not_found", "no such chat");
		}
		const row = this.#db
			.query<ChatRow, [string, string]>("SELECT * FROM chats WHERE bot_id = ? AND conv_id = ?")
			.get(botId, convId);
		if (!row) {
			throw new GatewayApiError(404, "not_found", "no such chat");
		}
		const meta = GatewayStore.#rowToConversationMeta(row);
		if (meta.deleted) {
			return { conversation: meta, messages: [] };
		}
		let messages: unknown[] = [];
		try {
			const parsed: unknown = JSON.parse(row.messages_json);
			if (Array.isArray(parsed)) messages = parsed;
		} catch {
			messages = [];
		}
		return { conversation: meta, messages };
	}

	chatPut(botId: string, convId: string, body: unknown): { stored: boolean; conversation: ConversationMeta } {
		this.ensureAppBot(botId);
		if (!CONVERSATION_ID_RE.test(convId)) {
			throw new GatewayApiError(400, "bad_request", "bad chat id");
		}
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			throw new GatewayApiError(400, "bad_request", "expected a JSON object");
		}
		const payload = body as Record<string, unknown>;
		const meta = GatewayStore.#cleanConversation(payload.conversation, convId);
		const messages = payload.messages;
		if (
			!Array.isArray(messages) ||
			!messages.every(item => typeof item === "object" && item !== null && !Array.isArray(item))
		) {
			throw new GatewayApiError(400, "bad_request", "messages must be a list of objects");
		}
		const existing = this.#db
			.query<ChatRow, [string, string]>("SELECT * FROM chats WHERE bot_id = ? AND conv_id = ?")
			.get(botId, convId);
		if (existing && existing.updated > meta.updated) {
			return {
				stored: false,
				conversation: GatewayStore.#rowToConversationMeta(existing),
			};
		}
		this.#db
			.query(
				`INSERT INTO chats (bot_id, conv_id, title, created, updated, pinned, renamed, deleted, messages_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
				 ON CONFLICT(bot_id, conv_id) DO UPDATE SET
				   title = excluded.title,
				   created = excluded.created,
				   updated = excluded.updated,
				   pinned = excluded.pinned,
				   renamed = excluded.renamed,
				   deleted = 0,
				   messages_json = excluded.messages_json`,
			)
			.run(
				botId,
				convId,
				meta.title ?? "",
				meta.created ?? 0,
				meta.updated,
				meta.pinned ? 1 : 0,
				meta.renamed ? 1 : 0,
				JSON.stringify(messages),
			);
		return { stored: true, conversation: meta };
	}

	chatDelete(botId: string, convId: string): { ok: true; conversation: ConversationMeta } {
		this.ensureAppBot(botId);
		if (!CONVERSATION_ID_RE.test(convId)) {
			throw new GatewayApiError(400, "bad_request", "bad chat id");
		}
		const updated = Date.now();
		const meta: ConversationMeta = { id: convId, deleted: true, updated };
		this.#db
			.query(
				`INSERT INTO chats (bot_id, conv_id, title, created, updated, pinned, renamed, deleted, messages_json)
				 VALUES (?, ?, '', 0, ?, 0, 0, 1, '[]')
				 ON CONFLICT(bot_id, conv_id) DO UPDATE SET
				   title = '',
				   updated = excluded.updated,
				   pinned = 0,
				   renamed = 0,
				   deleted = 1,
				   messages_json = '[]'`,
			)
			.run(botId, convId, updated);
		return { ok: true, conversation: meta };
	}

	// ---------------------------------------------------------------------------
	// Attachments & Media (`/m/v1/bots/<id>/files`, `/m/v1/media`)
	// ---------------------------------------------------------------------------

	static safeFilename(rawName: string): string {
		const leaf = (rawName || "").replaceAll("\\", "/").split("/").at(-1) ?? "";
		const cleaned = Array.from(leaf)
			.filter(ch => {
				const code = ch.charCodeAt(0);
				return code >= 0x20 && code !== 0x7f && !'<>:"|?*'.includes(ch);
			})
			.join("")
			.trim()
			.replace(/^\.+/, "");
		if (!cleaned || cleaned === "." || cleaned === "..") {
			return "file";
		}
		if (cleaned.length <= 120) return cleaned;
		const ext = path.extname(cleaned);
		const stem = path.basename(cleaned, ext);
		return `${stem.slice(0, Math.max(1, 120 - ext.length))}${ext.slice(0, 20)}`;
	}

	storeUpload(botId: string, rawFilename: string, bytes: Uint8Array): { name: string; size: number; path: string } {
		this.ensureAppBot(botId);
		if (bytes.byteLength <= 0) {
			throw new GatewayApiError(400, "bad_request", "empty file");
		}
		if (bytes.byteLength > MAX_UPLOAD_BYTES) {
			throw new GatewayApiError(413, "too_large", "file too large (at most 25 MB)");
		}
		const base = GatewayStore.safeFilename(rawFilename);
		const folder = this.attachmentsDir(botId);
		fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
		let usedBytes = 0;
		for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
			if (entry.isFile() && !entry.name.startsWith(".")) {
				try {
					usedBytes += fs.statSync(path.join(folder, entry.name)).size;
				} catch {
					// Ignore concurrent removal.
				}
			}
		}
		if (usedBytes + bytes.byteLength > this.#cfg.botStorageBytes) {
			throw new GatewayApiError(507, "storage_full", "this bot's attachment folder is full");
		}
		const ext = path.extname(base);
		const stem = path.basename(base, ext);
		let chosenName = base;
		let seq = 2;
		while (fs.existsSync(path.join(folder, chosenName))) {
			chosenName = `${stem}-${seq}${ext}`;
			seq++;
		}
		const tmpPath = path.join(folder, `.${crypto.randomBytes(6).toString("hex")}.part`);
		const finalPath = path.join(folder, chosenName);
		try {
			const fd = fs.openSync(tmpPath, "wx", 0o600);
			try {
				fs.writeFileSync(fd, bytes);
				// The controller's restrictive umask must not hide completed uploads from the non-root worker.
				if (this.#cfg.sandboxBackend === "docker") fs.fchmodSync(fd, 0o644);
			} finally {
				fs.closeSync(fd);
			}
			fs.renameSync(tmpPath, finalPath);
			// Docker mounts the canonical upload directory read-only at workspace/attachments.
			// Never let the privileged controller copy through a worker-controlled workspace path.
			if (this.#cfg.sandboxBackend !== "docker") {
				const workspaceCopy = path.join(this.workspaceDir(botId), "attachments", chosenName);
				fs.copyFileSync(finalPath, workspaceCopy, fs.constants.COPYFILE_EXCL);
			}
		} catch (err) {
			try {
				if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
			} catch {
				// Ignore cleanup error.
			}
			if (err instanceof GatewayApiError) throw err;
			throw new GatewayApiError(500, "upload_failed", "could not store uploaded file");
		}
		return {
			name: chosenName,
			size: bytes.byteLength,
			path: `${this.#cfg.sandboxAttachmentsDir}/${chosenName}`,
		};
	}

	#rescuedMediaPath(botId: string, rawPath: string): string {
		const ext = path.extname(rawPath).toLowerCase();
		const digest = crypto.createHash("sha1").update(rawPath).digest("hex").slice(0, 24);
		return path.join(this.mediaRescueDir(botId), `${digest}${ext}`);
	}

	resolveMediaFile(
		botId: string,
		rawPath: string,
		copyOutFromContainer?: (botId: string, containerPath: string, destPath: string) => boolean,
	): { realPath: string; contentType: string; size: number } {
		const home = this.ensureAppBot(botId);
		const trimmed = (rawPath || "").trim();
		if (!trimmed.startsWith("/") || trimmed.includes("\0")) {
			throw new GatewayApiError(400, "bad_request", "bad path");
		}
		const ext = path.extname(trimmed).toLowerCase();
		const contentType = MEDIA_TYPES[ext];
		if (!contentType) {
			throw new GatewayApiError(415, "unsupported_type", "only images are served here");
		}
		const candidates: string[] = [];
		if (trimmed.startsWith("/root/.hermes/attachments/")) {
			candidates.push(path.join(this.attachmentsDir(botId), trimmed.slice("/root/.hermes/attachments/".length)));
		} else if (trimmed.startsWith("/root/.hermes/")) {
			candidates.push(path.join(home, trimmed.slice("/root/.hermes/".length)));
		} else if (trimmed.startsWith("/workspace/")) {
			candidates.push(path.join(this.workspaceDir(botId), trimmed.slice("/workspace/".length)));
		} else if (trimmed.startsWith("/root/")) {
			candidates.push(path.join(this.workspaceDir(botId), trimmed.slice("/root/".length)));
		} else {
			candidates.push(trimmed);
		}
		const rescued = this.#rescuedMediaPath(botId, trimmed);
		candidates.push(rescued);

		const realHome = fs.realpathSync(home);
		for (const candidate of candidates) {
			let real: string;
			try {
				real = fs.realpathSync(candidate);
			} catch {
				continue;
			}
			if (real !== realHome && !real.startsWith(`${realHome}${path.sep}`)) {
				continue;
			}
			let stat: fs.Stats;
			try {
				stat = fs.statSync(real);
			} catch {
				continue;
			}
			if (stat.isFile() && stat.size > 0 && stat.size <= MAX_MEDIA_BYTES) {
				return { realPath: real, contentType, size: stat.size };
			}
		}

		if (
			copyOutFromContainer &&
			!MOUNTED_PREFIXES.some(prefix => trimmed.startsWith(prefix)) &&
			!trimmed.startsWith(`${realHome}${path.sep}`)
		) {
			fs.mkdirSync(path.dirname(rescued), { recursive: true, mode: 0o700 });
			const tmp = `${rescued}.${crypto.randomBytes(4).toString("hex")}.tmp`;
			try {
				if (copyOutFromContainer(botId, trimmed, tmp)) {
					const stat = fs.statSync(tmp);
					if (stat.size <= MAX_MEDIA_BYTES) {
						fs.renameSync(tmp, rescued);
						return { realPath: rescued, contentType, size: stat.size };
					}
				}
			} finally {
				try {
					if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
				} catch {
					// Ignore temp cleanup failure.
				}
			}
		}
		throw new GatewayApiError(404, "not_found", "no such media file");
	}

	/** Extract `MEDIA:/path` tokens from a reply and rescue any unmounted container paths. */
	rescueReplyMedia(
		botId: string,
		text: string,
		copyOutFromContainer?: (botId: string, containerPath: string, destPath: string) => boolean,
	): void {
		if (!copyOutFromContainer) return;
		const seen = new Set<string>();
		for (const match of text.matchAll(MEDIA_TOKEN_RE)) {
			const mediaPath = match[1]?.replace(/[.,;:!?)'"`>\]]+$/, "") ?? "";
			if (!mediaPath || seen.has(mediaPath)) continue;
			seen.add(mediaPath);
			const ext = path.extname(mediaPath).toLowerCase();
			if (!(ext in MEDIA_TYPES) || MOUNTED_PREFIXES.some(prefix => mediaPath.startsWith(prefix))) {
				continue;
			}
			const rescued = this.#rescuedMediaPath(botId, mediaPath);
			if (fs.existsSync(rescued)) continue;
			fs.mkdirSync(path.dirname(rescued), { recursive: true, mode: 0o700 });
			const tmp = `${rescued}.${crypto.randomBytes(4).toString("hex")}.tmp`;
			try {
				if (copyOutFromContainer(botId, mediaPath, tmp)) {
					const stat = fs.statSync(tmp);
					if (stat.size <= MAX_MEDIA_BYTES) {
						fs.renameSync(tmp, rescued);
					}
				}
			} catch {
				// Best-effort media rescue.
			} finally {
				try {
					if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
				} catch {
					// Ignore temp cleanup.
				}
			}
		}
	}
}
