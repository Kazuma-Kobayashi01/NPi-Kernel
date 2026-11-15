/**
 * Terminals a side agent runs through NPi (`terminal/*` ACP requests).
 *
 * Output from stdout and stderr is interleaved into one buffer. When it grows past the
 * request's `outputByteLimit` the oldest bytes are dropped (ACP: keep the most recent
 * output, report `truncated`), cutting only at a character boundary.
 */
import { type ChildProcess, ptree } from "@oh-my-pi/pi-utils";
import {
	type CreateTerminalRequest,
	RequestError,
	type TerminalOutputResponse,
	type WaitForTerminalExitResponse,
} from "@oh-my-pi/pi-utils/acp";

/** Output kept when the agent sets no limit. */
const DEFAULT_OUTPUT_BYTES = 1024 * 1024;
/** Grace before a killed terminal's process tree gets SIGKILL. */
const KILL_GRACE_MS = 2000;

interface Terminal {
	child: ChildProcess<"ignore">;
	output: string;
	outputBytes: number;
	limit: number;
	truncated: boolean;
	drained: Promise<void>;
	exit?: { exitCode: number | null; signal: string | null };
}

export class SideAgentTerminals {
	#terminals = new Map<string, Terminal>();
	#next = 0;

	/** Starts `command args` in `cwd` (already checked against the session roots by the caller). */
	create(request: CreateTerminalRequest, cwd: string): string {
		const env: Record<string, string | undefined> = { ...Bun.env };
		for (const entry of request.env ?? []) env[entry.name] = entry.value;
		const child = ptree.spawn([request.command, ...(request.args ?? [])], { cwd, env, stderr: "full" });
		const terminal: Terminal = {
			child,
			output: "",
			outputBytes: 0,
			limit: request.outputByteLimit && request.outputByteLimit > 0 ? request.outputByteLimit : DEFAULT_OUTPUT_BYTES,
			truncated: false,
			drained: Promise.resolve(),
		};
		terminal.drained = Promise.all([
			this.#drain(terminal, child.stdout),
			child.stderr ? this.#drain(terminal, child.stderr) : Promise.resolve(),
		]).then(() => {});
		void child.exited
			.catch(() => null)
			.then(() => {
				const signal = child.proc.signalCode;
				terminal.exit = { exitCode: signal ? null : child.proc.exitCode, signal: signal ?? null };
			});
		const id = `term_${++this.#next}`;
		this.#terminals.set(id, terminal);
		return id;
	}

	output(terminalId: string): TerminalOutputResponse {
		const terminal = this.#get(terminalId);
		return {
			output: terminal.output,
			truncated: terminal.truncated,
			...(terminal.exit ? { exitStatus: terminal.exit } : {}),
		};
	}

	async waitForExit(terminalId: string): Promise<WaitForTerminalExitResponse> {
		const terminal = this.#get(terminalId);
		await terminal.child.exited.catch(() => null);
		await terminal.drained;
		const signal = terminal.child.proc.signalCode;
		return { exitCode: signal ? null : terminal.child.proc.exitCode, signal: signal ?? null };
	}

	/** Stops the command; the terminal stays readable until released. */
	kill(terminalId: string): void {
		const terminal = this.#get(terminalId);
		if (terminal.child.proc.exitCode === null) terminal.child.kill(undefined, KILL_GRACE_MS);
	}

	release(terminalId: string): void {
		const terminal = this.#terminals.get(terminalId);
		if (!terminal) return;
		this.#terminals.delete(terminalId);
		if (terminal.child.proc.exitCode === null) terminal.child.kill(undefined, KILL_GRACE_MS);
	}

	/** Kills everything still running; called when the side agent goes away. */
	disposeAll(): void {
		for (const id of this.#terminals.keys()) this.release(id);
	}

	#get(terminalId: string): Terminal {
		const terminal = this.#terminals.get(terminalId);
		if (!terminal) throw RequestError.invalidParams({ terminalId }, "Unknown terminal");
		return terminal;
	}

	async #drain(terminal: Terminal, stream: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		try {
			for await (const chunk of stream) this.#append(terminal, decoder.decode(chunk, { stream: true }));
			this.#append(terminal, decoder.decode());
		} catch {
			// The process was killed mid-read: what arrived is kept.
		}
	}

	#append(terminal: Terminal, text: string): void {
		if (!text) return;
		terminal.output += text;
		terminal.outputBytes += Buffer.byteLength(text);
		if (terminal.outputBytes <= terminal.limit) return;
		// Drop from the front in UTF-8, moving the cut past continuation bytes so no character is split.
		const excess = terminal.outputBytes - terminal.limit;
		const encoded = Buffer.from(terminal.output);
		let start = excess;
		while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) start++;
		terminal.output = encoded.subarray(start).toString();
		terminal.outputBytes = encoded.length - start;
		terminal.truncated = true;
	}
}
