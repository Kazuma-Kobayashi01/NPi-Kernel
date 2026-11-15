/**
 * Exec backends: somewhere other than the host shell for the `bash` tool's commands to run (a VM, a
 * container, a remote machine), offered by an extension (`pi.registerExecBackend`) and chosen by the
 * `exec.backend` setting. The tool keeps everything around the process: approvals, streaming and
 * truncation, artifacts, background jobs and the card. A backend replaces only where it runs.
 *
 * A backend that was asked for and is not there is an error, never the host shell: choosing one is how a
 * user keeps agent commands off the host, so a plugin that failed to load must not undo it.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import type { ExecBackendResult, RegisteredExecBackend } from "../extensibility/extensions/types";
import type { BashExecutorOptions, BashResult } from "./bash-executor";
import { buildNonInteractiveEnv } from "./non-interactive-env";
import { createOutputCapture, type OutputCaptureSummary } from "./output-capture";

/** How long a backend gets to return after its command was cancelled or timed out before the call gives up on it. */
const ABORT_GRACE_MS = 5_000;
/** The deadline of a command that names none, as for the embedded shell. */
const DEFAULT_TIMEOUT_MS = 300_000;

export type ExecBackendSelection =
	| { kind: "host" }
	| { kind: "backend"; backend: RegisteredExecBackend }
	| { kind: "missing"; name: string };

/** Resolve the `exec.backend` setting: empty means the host shell, a name nobody serves means `missing`. */
export function selectExecBackend(
	setting: string,
	lookup: (name: string) => RegisteredExecBackend | undefined,
): ExecBackendSelection {
	const name = setting.trim();
	if (name === "") return { kind: "host" };
	const backend = lookup(name);
	return backend ? { kind: "backend", backend } : { kind: "missing", name };
}

/** Backends each agent session ran commands on, so ending the session can release what they keep for it. */
const backendsBySession = new Map<string, Set<RegisteredExecBackend>>();

/** The agent session a `sessionKey` belongs to: background jobs append `:async:<id>`. */
function agentSessionKey(sessionKey: string): string {
	const at = sessionKey.indexOf(":async:");
	return at < 0 ? sessionKey : sessionKey.slice(0, at);
}

/** Tell the backends that ran commands for `agentSession` that it ended (see `RegisteredExecBackend.release`). */
export function releaseExecBackendSessions(agentSession: string | undefined): void {
	if (!agentSession) return;
	const backends = backendsBySession.get(agentSession);
	if (!backends) return;
	backendsBySession.delete(agentSession);
	for (const backend of backends) {
		void Promise.resolve()
			.then(() => backend.release?.(agentSession))
			.catch((error: unknown) => {
				logger.warn("Exec backend release failed", { backend: backend.name, error: String(error) });
			});
	}
}

/** Run `command` on `backend` with the same result shape as the embedded shell. */
export async function executeOnBackend(
	backend: RegisteredExecBackend,
	command: string,
	options: BashExecutorOptions | undefined,
): Promise<BashResult> {
	const settings = await Settings.init();
	const capture = createOutputCapture(settings, {
		onChunk: options?.onChunk,
		onPreview: options?.onPreview,
		chunkThrottleMs: options?.chunkThrottleMs,
		artifactPath: options?.artifactPath,
		artifactId: options?.artifactId,
	});
	const { dump } = capture;
	try {
		if (options?.signal?.aborted) {
			return { exitCode: undefined, cancelled: true, ...(await dump("Command cancelled")) };
		}

		const requestedMs = options?.timeout;
		const deadlineMs = requestedMs === 0 ? undefined : Math.max(1_000, requestedMs ?? DEFAULT_TIMEOUT_MS);
		const runAbort = new AbortController();
		let timedOut = false;
		const timer =
			deadlineMs === undefined
				? undefined
				: setTimeout(() => {
						timedOut = true;
						runAbort.abort();
					}, deadlineMs);
		const userSignal = options?.signal;
		const onUserAbort = () => runAbort.abort();
		userSignal?.addEventListener("abort", onUserAbort, { once: true });

		const sessionKey = options?.sessionKey;
		if (sessionKey) {
			const owner = agentSessionKey(sessionKey);
			const used = backendsBySession.get(owner) ?? new Set<RegisteredExecBackend>();
			used.add(backend);
			backendsBySession.set(owner, used);
		}

		let abandonTimer: NodeJS.Timeout | undefined;
		try {
			const finished = backend
				.run(command, {
					cwd: options?.cwd,
					env: buildNonInteractiveEnv(options?.env),
					timeoutMs: deadlineMs,
					signal: runAbort.signal,
					sessionKey,
					onChunk: capture.enqueueChunk,
				})
				.then(
					(result): { kind: "result"; result: ExecBackendResult } => ({ kind: "result", result }),
					(error: unknown): { kind: "failed"; error: unknown } => ({ kind: "failed", error }),
				);
			const abandoned = Promise.withResolvers<{ kind: "abandoned" }>();
			runAbort.signal.addEventListener(
				"abort",
				() => {
					abandonTimer = setTimeout(() => abandoned.resolve({ kind: "abandoned" }), ABORT_GRACE_MS);
				},
				{ once: true },
			);
			const outcome = await Promise.race([finished, abandoned.promise]);

			if (outcome.kind === "abandoned") {
				// The backend ignored the abort: stop listening to it and report the cancel.
				capture.stopAccepting();
				return cancelledResult(await dump(timedOut ? timeoutNotice(deadlineMs) : "Command cancelled"), timedOut);
			}
			if (outcome.kind === "failed") {
				capture.stopAccepting();
				const reason = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
				throw new Error(`Exec backend ${backend.name} failed: ${reason}`);
			}
			const { result } = outcome;
			if (timedOut || result.timedOut) {
				return cancelledResult(await dump(timeoutNotice(deadlineMs)), true);
			}
			if (result.cancelled || runAbort.signal.aborted) {
				return cancelledResult(await dump("Command cancelled"), false);
			}
			if (result.exitCode === undefined) {
				throw new Error(`Exec backend ${backend.name} ended the command without an exit status`);
			}
			return {
				exitCode: result.exitCode,
				cancelled: false,
				...(result.workingDir === undefined ? {} : { workingDir: result.workingDir }),
				...(await dump()),
			};
		} finally {
			if (timer) clearTimeout(timer);
			if (abandonTimer) clearTimeout(abandonTimer);
			userSignal?.removeEventListener("abort", onUserAbort);
		}
	} finally {
		await capture.sink.dispose();
	}
}

function timeoutNotice(deadlineMs: number | undefined): string {
	return deadlineMs === undefined
		? "Command timed out"
		: `Command timed out after ${Math.round(deadlineMs / 1000)} seconds`;
}

function cancelledResult(summary: OutputCaptureSummary, timedOut: boolean): BashResult {
	return { exitCode: undefined, cancelled: true, ...(timedOut ? { timedOut: true } : {}), ...summary };
}
