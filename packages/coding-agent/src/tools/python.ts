/**
 * Managed Python tool.
 *
 * Runs Python through the existing eval Python subprocess backend against the
 * desktop-managed interpreter, and exposes that environment's health and
 * package set. The desktop app's Rust runtime host owns installation and
 * package changes; this tool never unpacks a runtime or creates a virtualenv.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { isRecord, prompt, Snowflake } from "@oh-my-pi/pi-utils";
import { executePython } from "../eval/py/executor";
import {
	ensureNpiPythonEnv,
	filterEnv,
	getNpiPythonCacheDir,
	getNpiPythonWorkspaceDir,
	installNpiPythonPackages,
	isNpiPythonHostConfigured,
	listNpiPythonPackages,
	NPI_PYTHON_HOST_UNAVAILABLE_HINT,
	type NpiPythonPackage,
	type NpiPythonEnvironmentHealth,
	type NpiPythonProgress,
	readNpiPythonEnvironment,
	resolveExplicitPythonRuntime,
} from "../eval/py/runtime";
import { normalizePackageRequirements } from "../eval/package-requirements";
import { cfgPythonInterpreter } from "../eval/settings";
import pythonDescription from "../prompts/tools/python.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { truncateForPrompt } from "./approval";
import { resolveToCwd } from "./path-utils";
import { cfgToolsMaxTimeout } from "./settings";
import { clampTimeout } from "./tool-timeouts";
import { ToolAbortError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

const pythonSchema = type({
	action: '"execute" | "environment" | "packages"',
	"code?": type("string").describe("Python source for execute"),
	"interpreter?": type("string").describe(
		"Explicit interpreter for execute; only when python.interpreter is configured for the session",
	),
	"cwd?": type("string").describe("working directory; defaults to the session workspace"),
	"timeout?": type("number").describe("seconds; 0 disables the deadline"),
	"executionId?": type("string").describe("caller-supplied execution id; generated when omitted"),
	"operation?": type('"list" | "install"').describe("packages operation"),
	"packages?": type("string").array().describe("distribution requirements for packages install"),
});

type PythonParams = typeof pythonSchema.infer;

/** Details rendered for every action; absent fields do not apply to that action. */
interface PythonToolDetails {
	action: PythonParams["action"];
	/** One of "ready", "not-installed", or "broken". */
	status?: "ready" | "not-installed" | "broken";
	healthy?: boolean;
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	timedOut?: boolean;
	durationMs?: number;
	truncated?: boolean;
	sessionId?: string;
	executionId?: string;
	pythonPath?: string;
	cwd?: string;
	pythonVersion?: string;
	uvVersion?: string;
	runtimePath?: string;
	envPath?: string;
	cachePath?: string;
	workspacePath?: string;
	operation?: "list" | "install";
	packages?: NpiPythonPackage[];
	error?: string;
	meta?: OutputMeta;
}

/** Runs Python in the NPi managed environment and describes that environment. */
export class PythonTool implements AgentTool<typeof pythonSchema, PythonToolDetails> {
	readonly name = "python";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const params: Record<string, unknown> = isRecord(args) ? args : {};
		if (params.action === "environment") return "read";
		if (params.action === "packages") {
			return params.operation === "install"
				? {
						tier: "exec",
						reason: "Install Python packages into the NPi managed environment",
					}
				: "read";
		}
		return "exec";
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params: Record<string, unknown> = isRecord(args) ? args : {};
		const action = typeof params.action === "string" ? params.action : "(missing)";
		const target = typeof params.interpreter === "string" ? params.interpreter : "NPi managed environment";
		if (action === "packages" && params.operation === "install" && Array.isArray(params.packages)) {
			return [`Packages: ${params.packages.filter((item): item is string => typeof item === "string").join(", ")}`];
		}
		if (action === "execute") {
			return [
				`Interpreter: ${target}`,
				`Code:\n${truncateForPrompt(typeof params.code === "string" ? params.code : "")}`,
			];
		}
		return [`Action: ${action}`];
	};
	readonly label = "Python";
	readonly summary = "Run Python in the NPi managed environment; inspect packages and runtime health";
	readonly description = prompt.render(pythonDescription);
	readonly parameters = pythonSchema;
	readonly strict = true;
	readonly concurrency = "exclusive";
	readonly loadMode = "essential";

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: PythonParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<PythonToolDetails>,
	): Promise<AgentToolResult<PythonToolDetails>> {
		throwIfAborted(signal);
		switch (params.action) {
			case "execute":
				return await this.#execute(params, signal, onUpdate);
			case "environment":
				return await this.#environment(signal);
			case "packages":
				return await this.#packages(params, signal, onUpdate);
			default:
				throw new ToolError(`Unsupported python action: ${String(params.action)}`);
		}
	}

	#baseEnv(): Record<string, string | undefined> {
		return filterEnv(this.session.settings.getShellConfig().env);
	}

	#sessionId(): string {
		return this.session.getSessionId?.() ?? "default";
	}

	async #managedPython(signal?: AbortSignal, onProgress?: (progress: NpiPythonProgress) => void): Promise<string> {
		const managed = await ensureNpiPythonEnv({ signal, onProgress });
		if (!managed) {
			throw new ToolError(
				isNpiPythonHostConfigured()
					? NPI_PYTHON_HOST_UNAVAILABLE_HINT
					: "No NPi managed Python runtime is configured: NPI_PYTHON_HOST is unset. Run Python from a source " +
							"checkout by setting python.interpreter to an explicit interpreter.",
			);
		}
		return managed;
	}

	/**
	 * `interpreter` is only honored when the session's `python.interpreter`
	 * setting names the same executable: an explicit project interpreter must be
	 * configured, never guessed, and no project virtualenv is created.
	 */
	async #resolveInterpreter(
		params: PythonParams,
		cwd: string,
		signal?: AbortSignal,
		onProgress?: (progress: NpiPythonProgress) => void,
	): Promise<string> {
		const requested = params.interpreter?.trim();
		if (!requested) return await this.#managedPython(signal, onProgress);
		const mode = process.env.NPI_APP_MODE?.trim();
		if (mode !== undefined && mode !== "code") {
			throw new ToolError("interpreter is only allowed in Code mode; other modes use the NPi managed environment.");
		}
		const configured = cfgPythonInterpreter.get(this.session.settings)?.trim();
		if (!configured) {
			throw new ToolError(
				"interpreter is only allowed when python.interpreter is configured for this session; " +
					"the NPi managed environment never creates a project virtualenv.",
			);
		}
		const baseEnv = this.#baseEnv();
		const expected = resolveExplicitPythonRuntime(configured, cwd, baseEnv).pythonPath;
		const actual = resolveExplicitPythonRuntime(requested, cwd, baseEnv).pythonPath;
		if (path.resolve(expected) !== path.resolve(actual)) {
			throw new ToolError(`interpreter must match the session's python.interpreter setting (${expected}).`);
		}
		return expected;
	}

	async #execute(
		params: PythonParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<PythonToolDetails>,
	): Promise<AgentToolResult<PythonToolDetails>> {
		if (typeof params.code !== "string" || params.code.trim().length === 0) {
			throw new ToolError("code is required for execute");
		}
		const sessionId = this.#sessionId();
		const executionId = params.executionId?.trim() || Snowflake.next();
		const workspace = getNpiPythonWorkspaceDir(sessionId);
		const cwd = params.cwd ? resolveToCwd(params.cwd, this.session.cwd) : workspace;
		await fs.mkdir(cwd, { recursive: true });
		const reportProgress = (progress: NpiPythonProgress): void => {
			onUpdate?.({
				content: [
					{
						type: "text",
						text: `NPi Python: ${progress.stage}${progress.message ? ` — ${progress.message}` : ""}`,
					},
				],
				details: { action: "execute" },
			});
		};
		const interpreter = await this.#resolveInterpreter(params, cwd, signal, reportProgress);
		throwIfAborted(signal);

		const timeoutMs =
			params.timeout === 0
				? 0
				: clampTimeout("python", params.timeout, cfgToolsMaxTimeout.get(this.session.settings)) * 1000;
		const startedAt = performance.now();
		const execution = await executePython(params.code, {
			cwd,
			sessionId: `${sessionId}:${executionId}`,
			interpreter,
			kernelMode: "per-call",
			timeoutMs: timeoutMs || undefined,
			signal,
		});
		if (signal?.aborted) throw new ToolAbortError("Python execution aborted");
		const durationMs = Math.round(performance.now() - startedAt);
		const timedOut = execution.cancelled && timeoutMs > 0;

		const details: PythonToolDetails = {
			action: "execute",
			stdout: execution.output,
			exitCode: execution.exitCode,
			timedOut,
			durationMs,
			truncated: execution.truncated,
			sessionId,
			executionId,
			pythonPath: interpreter,
			cwd,
			workspacePath: workspace,
		};
		const sections: string[] = [];
		if (execution.output.trim().length > 0) sections.push(execution.output.trimEnd());
		if (timedOut) sections.push(`[timed out after ${Math.round(timeoutMs / 1000)}s]`);
		if (execution.truncated) sections.push("[output truncated]");
		sections.push(
			`[exit ${execution.exitCode ?? "killed"} · ${durationMs}ms · session ${sessionId} · execution ${executionId}]`,
		);
		const content = toolResult(details).text(sections.join("\n"));
		if (timedOut || (execution.exitCode !== undefined && execution.exitCode !== 0)) {
			return content.error(true).done();
		}
		return content.done();
	}

	async #environment(signal?: AbortSignal): Promise<AgentToolResult<PythonToolDetails>> {
		let health: NpiPythonEnvironmentHealth | undefined;
		let failure: string | undefined;
		const hostConfigured = isNpiPythonHostConfigured();
		if (hostConfigured) {
			try {
				health = await readNpiPythonEnvironment({ signal });
			} catch (error) {
				throwIfAborted(signal);
				failure = error instanceof Error ? error.message : String(error);
			}
		} else {
			failure = NPI_PYTHON_HOST_UNAVAILABLE_HINT;
		}
		const sessionId = this.#sessionId();
		const healthy = health?.ok ?? false;
		const details: PythonToolDetails = {
			action: "environment",
			status: healthy ? "ready" : failure !== undefined && hostConfigured ? "broken" : "not-installed",
			healthy,
			pythonPath: health?.pythonPath || undefined,
			pythonVersion: health?.pythonVersion || undefined,
			uvVersion: health?.uvVersion || undefined,
			runtimePath: health?.runtimePath || undefined,
			envPath: health?.envPath || undefined,
			cachePath: getNpiPythonCacheDir(),
			workspacePath: getNpiPythonWorkspaceDir(sessionId),
			sessionId,
			error: failure ?? health?.message ?? undefined,
		};
		const lines = [
			`Status: ${details.status}${healthy ? "" : " (health check failed)"}`,
			`Python: ${details.pythonVersion ?? "unknown"}`,
			`uv: ${details.uvVersion ?? "unknown"}`,
			`Interpreter: ${details.pythonPath ?? "not provisioned"}`,
			`Runtime: ${details.runtimePath ?? "not provisioned"}`,
			`Environment: ${details.envPath ?? "not provisioned"}`,
			`Package cache: ${details.cachePath}`,
			`Workspace: ${details.workspacePath}`,
		];
		if (details.error) lines.push(details.error);
		return toolResult(details).text(lines.join("\n")).error(!healthy).done();
	}

	async #packages(
		params: PythonParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<PythonToolDetails>,
	): Promise<AgentToolResult<PythonToolDetails>> {
		const operation = params.operation;
		if (operation !== "list" && operation !== "install") {
			throw new ToolError('operation is required for packages: "list" or "install"');
		}
		const requirements = operation === "install" ? normalizePackageRequirements(params.packages ?? []) : [];
		if (operation === "install" && requirements.length === 0) {
			throw new ToolError("packages is required for packages install");
		}
		const report = (progress: NpiPythonProgress): void => {
			onUpdate?.({
				content: [
					{
						type: "text",
						text: `NPi Python: ${progress.stage}${progress.message ? ` — ${progress.message}` : ""}`,
					},
				],
				details: { action: "packages", operation },
			});
		};
		const pythonPath = await this.#managedPython(signal, report);
		const packages =
			operation === "install"
				? await installNpiPythonPackages(requirements, { signal, onProgress: report })
				: await listNpiPythonPackages({ signal });
		throwIfAborted(signal);
		const sorted = [...packages].sort((left, right) => left.name.localeCompare(right.name));
		const details: PythonToolDetails = {
			action: "packages",
			operation,
			packages: sorted,
			pythonPath,
			cachePath: getNpiPythonCacheDir(),
			sessionId: this.#sessionId(),
		};
		const lines =
			operation === "install"
				? [`Installed ${requirements.join(", ")}.`, `Environment: ${pythonPath}`, `Packages: ${sorted.length}`]
				: sorted.length === 0
					? ["No packages installed in the NPi managed environment."]
					: sorted.map(item => `${item.name} ${item.version}`);
		return toolResult(details).text(lines.join("\n")).done();
	}
}
