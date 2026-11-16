/**
 * The line protocol between the plugin and the VM helper: one JSON object per line, requests on the helper's
 * stdin, messages on its stdout (stderr is its log). The helper owns the virtual machine and the shells inside
 * it; the plugin owns policy and talks to npi. Requests carry an `id` the helper echoes on everything it sends
 * back for that request.
 */

export type VmState = "stopped" | "starting" | "running" | "error";

export interface VmMount {
	/** Same absolute path on the host and in the guest, so paths in commands and output agree. */
	path: string;
	readOnly: boolean;
}

export interface VmConfig {
	memoryMiB: number;
	cpus: number;
	/** `off`: the guest has no network. `nat`: it reaches the network through the host. */
	network: "off" | "nat";
	/** Folder holding the guest image (`Image` and `rootfs.cpio.gz`) the helper boots. */
	image?: string;
	/** Unix socket the helper listens on for terminal clients (`attach`); omitted: no terminal access. */
	terminalSocket?: string;
	mounts: VmMount[];
}

export type HelperRequest =
	| { id: number; op: "start"; config: VmConfig }
	| { id: number; op: "stop" }
	| { id: number; op: "status" }
	| {
			id: number;
			op: "exec";
			/** Commands with one key share a shell in the guest; a key ending in `:async:<id>` is one job. */
			sessionKey?: string;
			command: string;
			cwd?: string;
			env: Record<string, string>;
			timeoutMs?: number;
	  }
	| { id: number; op: "cancel"; target: number }
	| { id: number; op: "release"; sessionKey: string };

export type HelperMessage =
	/** The machine changed state; not an answer to a request. */
	| { type: "state"; state: VmState; detail?: string }
	/** Ends a start/stop/status/cancel/release request. */
	| { id: number; type: "result"; state?: VmState; detail?: string }
	/** Output of an exec, stdout and stderr merged in order. */
	| { id: number; type: "chunk"; data: string }
	/** Ends an exec. */
	| { id: number; type: "exit"; exitCode?: number; cancelled?: boolean; timedOut?: boolean; workingDir?: string }
	/** Ends any request that failed. */
	| { id: number; type: "error"; message: string };

const VM_STATES: ReadonlySet<string> = new Set(["stopped", "starting", "running", "error"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate one decoded line from the helper; `undefined` for anything that is not a well-formed message. */
export function parseHelperMessage(value: unknown): HelperMessage | undefined {
	if (!isRecord(value) || typeof value.type !== "string") return undefined;
	const detail = typeof value.detail === "string" ? value.detail : undefined;
	const state = typeof value.state === "string" && VM_STATES.has(value.state) ? (value.state as VmState) : undefined;
	if (value.type === "state") {
		return state === undefined ? undefined : { type: "state", state, ...(detail === undefined ? {} : { detail }) };
	}
	if (typeof value.id !== "number") return undefined;
	const id = value.id;
	switch (value.type) {
		case "result":
			return {
				id,
				type: "result",
				...(state === undefined ? {} : { state }),
				...(detail === undefined ? {} : { detail }),
			};
		case "chunk":
			return typeof value.data === "string" ? { id, type: "chunk", data: value.data } : undefined;
		case "exit":
			return {
				id,
				type: "exit",
				...(typeof value.exitCode === "number" ? { exitCode: value.exitCode } : {}),
				...(value.cancelled === true ? { cancelled: true } : {}),
				...(value.timedOut === true ? { timedOut: true } : {}),
				...(typeof value.workingDir === "string" ? { workingDir: value.workingDir } : {}),
			};
		case "error":
			return { id, type: "error", message: typeof value.message === "string" ? value.message : "helper error" };
		default:
			return undefined;
	}
}
