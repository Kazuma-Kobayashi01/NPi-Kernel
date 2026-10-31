/**
 * Types and error contracts for the NPi Bot Gateway (`/m/v1` and `/p/<profile>/v1`).
 */

export const BOT_ID_RE = /^b[0-9a-f]{10}$/;
export const PROFILE_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
export const CONVERSATION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
export const RUN_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

export const MAX_MANAGEMENT_BODY_BYTES = 1024 * 1024;
export const MAX_CHAT_BODY_BYTES = 24 * 1024 * 1024;
export const MAX_SYNCED_CHAT_BYTES = 8 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_DATA_URL_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 8;
export const MAX_TEXT_PART_CHARS = 400_000;
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

export const DEFAULT_GATEWAY_HOST = "127.0.0.1";
export const DEFAULT_GATEWAY_PORT = 8651;
export const DEFAULT_MAX_BOTS = 5;
export const DEFAULT_MAX_TRASH = 20;
export const DEFAULT_TRASH_DAYS = 7;
export const DEFAULT_BOT_STORAGE_MB = 500;
export const DEFAULT_SANDBOX_ATTACHMENTS = "/workspace/attachments";

export const GATEWAY_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type GatewayEffort = (typeof GATEWAY_EFFORTS)[number];

export const APPROVAL_CHOICES = ["once", "session", "always", "deny"] as const;
export type GatewayApprovalChoice = (typeof APPROVAL_CHOICES)[number];

export const MARKDOWN_HINT =
	"Format replies in Markdown where it helps reading: headings for long answers, bullet or numbered lists for " +
	"steps and options, tables for comparisons, **bold** for key terms, and fenced code blocks with a language " +
	"tag for code, commands and config. Keep short conversational replies as plain sentences.";

export class GatewayApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "GatewayApiError";
		this.status = status;
		this.code = code;
	}
}

/** Trusted provisioner output; tokens must authorize only this bot at the model proxy. */
export interface GatewayBotModelConfig {
	baseUrl: string;
	token: string;
	providers: {
		id: string;
		api: "openai-responses" | "openai-completions" | "anthropic-messages";
		models: {
			id: string;
			name?: string;
			reasoning?: boolean;
			input?: ("text" | "image")[];
			contextWindow?: number;
			maxTokens?: number;
		}[];
	}[];
}

export interface GatewayConfig {
	host: string;
	port: number;
	dataDir: string;
	agentDir: string;
	managerKey: string;
	profileKeys: Readonly<Record<string, string>>;
	localProfiles: readonly string[];
	maxBots: number;
	maxTrash: number;
	trashDays: number;
	botStorageBytes: number;
	sandboxAttachmentsDir: string;
	catalogPath?: string;
	/**
	 * Execution backend for `sandboxed: true` bots:
	 * - `"docker"`: run inside per-bot Docker containers (default; fails closed when Docker is unavailable)
	 * - `"host-unsafe"`: run in isolated local directories on this host (for local development/testing only)
	 */
	sandboxBackend: "docker" | "host-unsafe";
	dockerImage: string;
	/** Pre-created bridge with externally managed egress policy; never created by the gateway. */
	dockerNetwork?: string;
	/** Trusted directory containing `<botId>.json` GatewayBotModelConfig records. */
	sandboxModelConfigDir?: string;
	/** Auth gateway --clients JSON file, atomically updated by the trusted provisioner. */
	sandboxClientsFile?: string;
	/** Required production XFS project-quota mount containing all per-bot directories. */
	sandboxQuotaRoot?: string;
	/** Optional absolute trusted quota helper, invoked with the validated bot id only. */
	sandboxQuotaCommand?: string;
	/** Optional trusted provisioner; its result is never populated from HTTP request data. */
	provisionBotModels?: (botId: string) => Promise<GatewayBotModelConfig>;
	/** Optional SSH host for the admin profile's `/shell` terminal (disabled when omitted). */
	adminSshHost?: string;
	/** Allow the default admin profile (`labbot`) to execute host tools in its workspace. */
	adminLocalTools?: boolean;
	/** Custom CLI spawn command override `[exe, ...prefixArgs]` for testing/embedding. */
	cliCommand?: readonly string[];
}

export type BotState = "active" | "trashed";

export interface BotRecord {
	id: string;
	state: BotState;
	name: string;
	role: string;
	color: number;
	systemPrompt: string;
	modelProvider: string;
	modelId: string;
	reasoning: string;
	sandboxed: boolean;
	createdAt: number;
	trashedAt: number | null;
}

export interface BotView {
	id: string;
	name: string;
	role: string;
	color: number;
	systemPrompt: string;
	createdAt: number;
	modelProvider: string;
	modelId: string;
	reasoning: string;
	sandboxed: boolean;
	sandbox?: "running" | "idle" | "unknown";
	trashedAt?: number | null;
	expiresAt?: number;
}

export interface BotListResponse {
	bots: BotView[];
	trash: BotView[];
	limit: number;
	trashLimit: number;
	trashDays: number;
}

export interface ConversationMeta {
	id: string;
	title?: string;
	created?: number;
	updated: number;
	pinned?: boolean;
	renamed?: boolean;
	deleted?: boolean;
}

export interface GatewayCatalogModel {
	id: string;
	name: string;
	efforts: string[];
	fast: boolean;
}

export interface GatewayCatalogProvider {
	id: string;
	name: string;
	models: GatewayCatalogModel[];
}

export interface GatewayCatalogData {
	providers: GatewayCatalogProvider[];
}

export interface NormalizedMessagePart {
	type: "text" | "image_url";
	text?: string;
	image_url?: { url: string };
}

export interface NormalizedChatMessage {
	role: "user" | "assistant" | "system";
	content: string | NormalizedMessagePart[];
}
