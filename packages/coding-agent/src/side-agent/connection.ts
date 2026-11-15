/**
 * SideAgent: NPi as an ACP *client* driving another coding agent (Antigravity's `agy acp`,
 * Claude Agent, Codex, …) over stdio.
 *
 * The agent signs in and talks to its own service with its own credentials; NPi never sees
 * them. NPi supplies what an ACP client offers — permission prompts, file reads and writes,
 * terminals — and every file or terminal request is confined to the session's roots.
 * Anything the agent does with its own tools is outside NPi's policy; only its permission
 * requests reach the user.
 */
import * as path from "node:path";
import { type ChildProcess, logger, pathIsWithin, ptree, VERSION } from "@oh-my-pi/pi-utils";
import {
	type AuthMethod,
	type Client,
	ClientSideConnection,
	type ContentBlock,
	type CreateElicitationRequest,
	type CreateElicitationResponse,
	type InitializeResponse,
	type ListSessionsResponse,
	type LoadSessionResponse,
	type NewSessionResponse,
	ndJsonStream,
	PROTOCOL_VERSION,
	type PromptResponse,
	type ReadTextFileRequest,
	type ReadTextFileResponse,
	RequestError,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionConfigOption,
	type SessionNotification,
	type WriteTextFileRequest,
} from "@oh-my-pi/pi-utils/acp";
import { realpathIfExists } from "../discovery/contained-path";
import { SideAgentTerminals } from "./terminals";

/** Error code an agent answers with until the user has signed in. */
const AUTH_REQUIRED = -32000;
/** Grace between closing stdin and killing the agent's process tree. */
const SHUTDOWN_GRACE_MS = 3000;

/** How to start an agent: an executable and its arguments (`agy acp`, `npx -y pkg`, …). */
export interface SideAgentLaunch {
	command: string;
	args: string[];
	env?: Record<string, string>;
}

/** What the embedding mode supplies: where updates go and who answers the agent's questions. */
export interface SideAgentHost {
	/** Every `session/update` the agent sends (message chunks, tool calls, plans, usage, …). */
	onSessionUpdate(notification: SessionNotification): void;
	/**
	 * Asks the user to allow one of the agent's tool calls. `signal` aborts when the agent withdraws
	 * the request (cancelled turn); answer `{ outcome: { outcome: "cancelled" } }` then.
	 */
	requestPermission(request: RequestPermissionRequest, signal?: AbortSignal): Promise<RequestPermissionResponse>;
	/** Form questions from the agent. Without it NPi does not advertise elicitation support. */
	elicit?(request: CreateElicitationRequest): Promise<CreateElicitationResponse>;
	/** The agent process went away (crash, exit, or {@link SideAgentConnection.close}). */
	onClosed?(error?: Error): void;
}

/** The agent refused a session until the user signs in with one of {@link methods}. */
export class SideAgentAuthRequiredError extends Error {
	constructor(
		message: string,
		readonly methods: AuthMethod[],
	) {
		super(message);
		this.name = "SideAgentAuthRequiredError";
	}
}

/** Optional features the agent announced at `initialize`. */
export interface SideAgentCapabilities {
	loadSession: boolean;
	listSessions: boolean;
	resumeSession: boolean;
	closeSession: boolean;
	image: boolean;
	embeddedContext: boolean;
}

export interface SideAgentStartOptions {
	/** Working directory of the agent process. */
	cwd: string;
	signal?: AbortSignal;
}

export interface SideAgentSessionOptions {
	cwd: string;
	/** Extra workspace roots the agent may read and write besides `cwd`. */
	additionalDirectories?: string[];
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function parseCapabilities(response: InitializeResponse): SideAgentCapabilities {
	const agent = record(response.agentCapabilities);
	const prompt = record(agent.promptCapabilities);
	const session = record(agent.sessionCapabilities);
	return {
		loadSession: agent.loadSession === true,
		listSessions: session.list !== undefined && session.list !== null,
		resumeSession: session.resume !== undefined && session.resume !== null,
		closeSession: session.close !== undefined && session.close !== null,
		image: prompt.image === true,
		embeddedContext: prompt.embeddedContext === true,
	};
}

/** Wraps Bun's stdin sink as the web stream {@link ndJsonStream} writes to. */
function stdinWritable(child: ChildProcess<"pipe">): WritableStream<Uint8Array> {
	const sink = child.stdin;
	return new WritableStream<Uint8Array>({
		async write(chunk) {
			sink.write(chunk);
			await sink.flush();
		},
		async close() {
			await sink.end();
		},
		async abort() {
			await sink.end();
		},
	});
}

export class SideAgentConnection {
	#child: ChildProcess<"pipe">;
	#connection: ClientSideConnection;
	#host: SideAgentHost;
	#terminals = new SideAgentTerminals();
	/** Filesystem-resolved roots per session; file and terminal requests must stay inside them. */
	#roots = new Map<string, string[]>();
	#closing = false;
	#init: InitializeResponse | undefined;
	#capabilities: SideAgentCapabilities | undefined;

	/** Use {@link SideAgentConnection.start}; this only wires the transport to an already spawned agent. */
	constructor(child: ChildProcess<"pipe">, host: SideAgentHost) {
		this.#child = child;
		this.#host = host;
		const stream = ndJsonStream(stdinWritable(child), child.stdout);
		this.#connection = new ClientSideConnection(() => this.#client(), stream);
		void this.#connection.closed.then(() => this.#onTransportClosed());
	}

	/** Spawns the agent and completes the ACP `initialize` handshake. */
	static async start(
		launch: SideAgentLaunch,
		host: SideAgentHost,
		options: SideAgentStartOptions,
	): Promise<SideAgentConnection> {
		const child = ptree.spawn<"pipe">([launch.command, ...launch.args], {
			cwd: options.cwd,
			env: { ...Bun.env, ...launch.env },
			stdin: "pipe",
			signal: options.signal,
		});
		const connection = new SideAgentConnection(child, host);
		try {
			const init = await connection.#connection.initialize({
				protocolVersion: PROTOCOL_VERSION,
				clientCapabilities: {
					fs: { readTextFile: true, writeTextFile: true },
					terminal: true,
					auth: { terminal: true },
					...(host.elicit ? { elicitation: { form: {} } } : {}),
				},
				clientInfo: { name: "npi", title: "NPi", version: VERSION },
			});
			if (init.protocolVersion !== PROTOCOL_VERSION) {
				throw new Error(`Agent speaks ACP v${init.protocolVersion}; NPi speaks v${PROTOCOL_VERSION}`);
			}
			connection.#init = init;
			connection.#capabilities = parseCapabilities(init);
			return connection;
		} catch (error) {
			await connection.close();
			const stderr = child.peekStderr().trim();
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(stderr ? `${reason}\n${stderr}` : reason);
		}
	}

	/** Name and version the agent reported, e.g. `{ name: "agy", version: "1.5.9" }`. */
	get agentInfo(): { name: string; title?: string; version: string } | undefined {
		return this.#init?.agentInfo ?? undefined;
	}

	get authMethods(): AuthMethod[] {
		return this.#init?.authMethods ?? [];
	}

	get capabilities(): SideAgentCapabilities {
		if (!this.#capabilities) throw new Error("Side agent is not initialized");
		return this.#capabilities;
	}

	/** Recent stderr of the agent process, for error reports. */
	get stderrTail(): string {
		return this.#child.peekStderr();
	}

	authenticate(methodId: string): Promise<unknown> {
		return this.#connection.authenticate({ methodId });
	}

	async newSession(options: SideAgentSessionOptions): Promise<NewSessionResponse> {
		const roots = await this.#resolveRoots(options);
		const response = await this.#authAware(() =>
			this.#connection.newSession({
				cwd: options.cwd,
				mcpServers: [],
				...(options.additionalDirectories?.length ? { additionalDirectories: options.additionalDirectories } : {}),
			}),
		);
		this.#roots.set(response.sessionId, roots);
		return response;
	}

	/** Reopens a stored session. Uses `session/resume` (no history replay) when `replay` is false and supported. */
	async loadSession(
		sessionId: string,
		options: SideAgentSessionOptions & { replay: boolean },
	): Promise<LoadSessionResponse> {
		const capabilities = this.capabilities;
		const roots = await this.#resolveRoots(options);
		const request = { sessionId, cwd: options.cwd, mcpServers: [] };
		this.#roots.set(sessionId, roots);
		if (!options.replay && capabilities.resumeSession) {
			return this.#authAware(() => this.#connection.resumeSession(request));
		}
		if (!capabilities.loadSession) throw new Error("This agent cannot reopen sessions");
		return this.#authAware(async () => (await this.#connection.loadSession(request)) ?? {});
	}

	listSessions(cwd?: string): Promise<ListSessionsResponse> {
		if (!this.capabilities.listSessions) return Promise.resolve({ sessions: [] });
		return this.#authAware(() => this.#connection.listSessions(cwd ? { cwd } : {}));
	}

	/** Runs one turn; resolves when the agent stops (`end_turn`, `cancelled`, …). */
	prompt(sessionId: string, prompt: ContentBlock[]): Promise<PromptResponse> {
		return this.#authAware(() => this.#connection.prompt({ sessionId, prompt }));
	}

	/** Stops the running turn; the pending {@link prompt} then resolves with `cancelled`. */
	cancel(sessionId: string): Promise<void> {
		return this.#connection.cancel({ sessionId });
	}

	async setMode(sessionId: string, modeId: string): Promise<void> {
		await this.#connection.setSessionMode({ sessionId, modeId });
	}

	async setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<SessionConfigOption[]> {
		return (await this.#connection.setSessionConfigOption({ sessionId, configId, value })).configOptions;
	}

	/** Closes the agent's sessions (where supported) and shuts the process down. Idempotent. */
	async close(): Promise<void> {
		if (this.#closing) return;
		this.#closing = true;
		if (this.#capabilities?.closeSession && !this.#connection.signal.aborted) {
			await Promise.allSettled(
				[...this.#roots.keys()].map(sessionId => this.#connection.closeSession({ sessionId })),
			);
		}
		this.#terminals.disposeAll();
		try {
			await this.#child.stdin.end();
		} catch {
			// Already closed.
		}
		const exited = await Promise.race([
			this.#child.exited.then(
				() => true,
				() => true,
			),
			Bun.sleep(SHUTDOWN_GRACE_MS).then(() => false),
		]);
		if (!exited) this.#child.kill(undefined, SHUTDOWN_GRACE_MS);
	}

	#onTransportClosed(): void {
		this.#terminals.disposeAll();
		const error = this.#closing
			? undefined
			: new Error(`Side agent exited${this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : ""}`);
		if (error) logger.warn("Side agent connection closed", { error: error.message });
		this.#host.onClosed?.(error);
	}

	/** Turns the agent's "sign in first" reply into {@link SideAgentAuthRequiredError}. */
	async #authAware<T>(call: () => Promise<T>): Promise<T> {
		try {
			return await call();
		} catch (error) {
			if (error instanceof RequestError && error.code === AUTH_REQUIRED) {
				throw new SideAgentAuthRequiredError(error.message, this.authMethods);
			}
			throw error;
		}
	}

	async #resolveRoots(options: SideAgentSessionOptions): Promise<string[]> {
		const roots: string[] = [];
		for (const dir of [options.cwd, ...(options.additionalDirectories ?? [])]) {
			const real = await realpathIfExists(path.resolve(dir));
			if (real) roots.push(real);
		}
		if (roots.length === 0) throw new Error(`Workspace folder does not exist: ${options.cwd}`);
		return roots;
	}

	/**
	 * Resolves `target` to a real path inside one of the session's roots, or throws an ACP error the agent
	 * understands. Symlinks are resolved before the check, so a link inside the workspace cannot reach out;
	 * a file that does not exist yet (a write) is judged by its real parent folder.
	 */
	async #contained(sessionId: string, target: string, mustExist: boolean): Promise<string> {
		const roots = this.#roots.get(sessionId);
		if (!roots) throw RequestError.invalidParams({ sessionId }, "Unknown session");
		if (!path.isAbsolute(target)) throw RequestError.invalidParams({ path: target }, "Path must be absolute");
		const resolved = path.resolve(target);
		let real = await realpathIfExists(resolved);
		if (real === null && !mustExist) {
			const parent = await realpathIfExists(path.dirname(resolved));
			if (parent !== null) real = path.join(parent, path.basename(resolved));
		}
		if (real === null) throw RequestError.invalidParams({ path: target }, "No such file or folder");
		if (roots.some(root => pathIsWithin(root, real))) return real;
		throw RequestError.invalidParams({ path: target }, "Path is outside the workspace NPi shares with this agent");
	}

	async #readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
		const file = await this.#contained(params.sessionId, params.path, true);
		const text = await Bun.file(file).text();
		if (!params.line && !params.limit) return { content: text };
		const lines = text.split("\n");
		const start = Math.max(0, (params.line ?? 1) - 1);
		const end = params.limit ? start + params.limit : lines.length;
		return { content: lines.slice(start, end).join("\n") };
	}

	async #writeTextFile(params: WriteTextFileRequest): Promise<void> {
		const file = await this.#contained(params.sessionId, params.path, false);
		await Bun.write(file, params.content);
	}

	#client(): Client {
		const elicit = this.#host.elicit;
		return {
			sessionUpdate: notification => this.#host.onSessionUpdate(notification),
			requestPermission: (params, options) => this.#host.requestPermission(params, options?.signal),
			readTextFile: params => this.#readTextFile(params),
			writeTextFile: params => this.#writeTextFile(params),
			createTerminal: async params => {
				const cwd = params.cwd
					? await this.#contained(params.sessionId, params.cwd, true)
					: this.#roots.get(params.sessionId)?.[0];
				if (!cwd) throw RequestError.invalidParams({ sessionId: params.sessionId }, "Unknown session");
				return { terminalId: this.#terminals.create(params, cwd) };
			},
			terminalOutput: params => this.#terminals.output(params.terminalId),
			waitForTerminalExit: params => this.#terminals.waitForExit(params.terminalId),
			killTerminal: params => this.#terminals.kill(params.terminalId),
			releaseTerminal: params => this.#terminals.release(params.terminalId),
			...(elicit ? { unstable_createElicitation: (params: CreateElicitationRequest) => elicit(params) } : {}),
		};
	}
}
