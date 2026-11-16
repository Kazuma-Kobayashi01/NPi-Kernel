import { logger, readJsonl } from "@oh-my-pi/pi-utils";
import { type HelperMessage, type HelperRequest, parseHelperMessage, type VmConfig, type VmState } from "./protocol";

export interface ExecRequest {
	sessionKey?: string;
	command: string;
	cwd?: string;
	env: Record<string, string>;
	timeoutMs?: number;
}

export interface ExecOutcome {
	exitCode?: number;
	cancelled?: boolean;
	timedOut?: boolean;
	workingDir?: string;
}

interface Pending {
	/** An exec streams chunks; the other requests have none. */
	onChunk?: (data: string) => void;
	resolve: (message: HelperMessage) => void;
	reject: (error: Error) => void;
}

/** What the helper answered a start/stop/status request with. */
export interface VmStatus {
	state: VmState;
	detail?: string;
}

/**
 * One running VM helper process, spoken to over the line protocol ({@link ./protocol}). Requests are
 * multiplexed by id, so several commands can run at once. A helper that exits fails everything in
 * flight; the next request starts a new one.
 */
export class HelperClient {
	readonly #command: readonly string[];
	#child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
	#nextId = 1;
	readonly #pending = new Map<number, Pending>();
	readonly #stateListeners = new Set<(status: VmStatus) => void>();
	#status: VmStatus = { state: "stopped" };

	constructor(command: readonly string[]) {
		this.#command = command;
	}

	get status(): VmStatus {
		return this.#status;
	}

	/** Observe state changes the helper reports; returns the unsubscribe function. */
	onState(listener: (status: VmStatus) => void): () => void {
		this.#stateListeners.add(listener);
		return () => this.#stateListeners.delete(listener);
	}

	#setStatus(status: VmStatus): void {
		if (this.#status.state === status.state && this.#status.detail === status.detail) return;
		this.#status = status;
		for (const listener of this.#stateListeners) listener(status);
	}

	#spawn(): Bun.Subprocess<"pipe", "pipe", "pipe"> {
		if (this.#child) return this.#child;
		const child = Bun.spawn([...this.#command], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		this.#child = child;
		void this.#readMessages(child);
		void this.#logStderr(child);
		void child.exited.then(code => this.#onExit(child, code));
		return child;
	}

	async #readMessages(child: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
		try {
			for await (const value of readJsonl<unknown>(child.stdout)) {
				const message = parseHelperMessage(value);
				if (message) this.#dispatch(message);
				else logger.warn("VM helper sent an unreadable message");
			}
		} catch (error) {
			logger.warn("VM helper output failed", { error: String(error) });
		}
	}

	async #logStderr(child: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
		try {
			const text = await new Response(child.stderr).text();
			if (text.trim()) logger.debug("VM helper stderr", { text: text.slice(-2000) });
		} catch {
			// The helper is gone; nothing to log.
		}
	}

	#onExit(child: Bun.Subprocess<"pipe", "pipe", "pipe">, code: number): void {
		if (this.#child !== child) return;
		this.#child = undefined;
		this.#setStatus({ state: "stopped", detail: `helper exited (${code})` });
		const error = new Error(`VM helper exited with code ${code}`);
		const pending = [...this.#pending.values()];
		this.#pending.clear();
		for (const entry of pending) entry.reject(error);
	}

	#dispatch(message: HelperMessage): void {
		if (message.type === "state") {
			this.#setStatus({ state: message.state, ...(message.detail === undefined ? {} : { detail: message.detail }) });
			return;
		}
		const entry = this.#pending.get(message.id);
		if (!entry) return;
		if (message.type === "chunk") {
			entry.onChunk?.(message.data);
			return;
		}
		this.#pending.delete(message.id);
		if (message.type === "error") entry.reject(new Error(message.message));
		else entry.resolve(message);
	}

	/** Send `request` (built from a fresh id) and resolve with the message that ends it. */
	#send(
		build: (id: number) => HelperRequest,
		onChunk?: (data: string) => void,
	): { id: number; done: Promise<HelperMessage> } {
		const id = this.#nextId++;
		const { promise, resolve, reject } = Promise.withResolvers<HelperMessage>();
		this.#pending.set(id, { onChunk, resolve, reject });
		try {
			const child = this.#spawn();
			child.stdin.write(`${JSON.stringify(build(id))}\n`);
			child.stdin.flush();
		} catch (error) {
			this.#pending.delete(id);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
		return { id, done: promise };
	}

	async #statusOf(done: Promise<HelperMessage>): Promise<VmStatus> {
		const message = await done;
		if (message.type !== "result") throw new Error("VM helper answered with the wrong message");
		const status: VmStatus = {
			state: message.state ?? this.#status.state,
			...(message.detail === undefined ? {} : { detail: message.detail }),
		};
		this.#setStatus(status);
		return status;
	}

	start(config: VmConfig): Promise<VmStatus> {
		return this.#statusOf(this.#send(id => ({ id, op: "start", config })).done);
	}

	stop(): Promise<VmStatus> {
		if (!this.#child) return Promise.resolve(this.#status);
		return this.#statusOf(this.#send(id => ({ id, op: "stop" })).done);
	}

	queryStatus(): Promise<VmStatus> {
		if (!this.#child) return Promise.resolve(this.#status);
		return this.#statusOf(this.#send(id => ({ id, op: "status" })).done);
	}

	release(sessionKey: string): Promise<void> {
		if (!this.#child) return Promise.resolve();
		return this.#send(id => ({ id, op: "release", sessionKey })).done.then(() => undefined);
	}

	/** Run a command in the guest; `onChunk` gets its output as it arrives. Aborting `signal` cancels it. */
	async exec(request: ExecRequest, onChunk: (data: string) => void, signal: AbortSignal): Promise<ExecOutcome> {
		const { id, done } = this.#send(requestId => ({ id: requestId, op: "exec", ...request }), onChunk);
		const cancel = () => {
			this.#send(cancelId => ({ id: cancelId, op: "cancel", target: id })).done.catch(() => undefined);
		};
		if (signal.aborted) cancel();
		else signal.addEventListener("abort", cancel, { once: true });
		try {
			const message = await done;
			if (message.type !== "exit") throw new Error("VM helper answered with the wrong message");
			return {
				...(message.exitCode === undefined ? {} : { exitCode: message.exitCode }),
				...(message.cancelled ? { cancelled: true } : {}),
				...(message.timedOut ? { timedOut: true } : {}),
				...(message.workingDir === undefined ? {} : { workingDir: message.workingDir }),
			};
		} finally {
			signal.removeEventListener("abort", cancel);
		}
	}

	/** Stop the helper process itself (not a graceful VM shutdown: call {@link stop} first for that). */
	close(): void {
		// The exit handler fails what is in flight and forgets the process.
		this.#child?.kill();
	}
}
