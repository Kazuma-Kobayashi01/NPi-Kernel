/**
 * Managed Python environment tool.
 *
 * Reports the NPi managed interpreter's health and lists or installs its
 * packages. Running code belongs to `eval`, whose Python backend already uses
 * the managed interpreter. The desktop app's (or the Linux binary's) runtime
 * host owns installation and package changes; this tool never unpacks a
 * runtime or creates a virtualenv. Discoverable: mounted under `xd://python`.
 */
import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import {
	ensureNpiPythonEnv,
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
} from "../eval/py/runtime";
import { normalizePackageRequirements } from "../eval/package-requirements";
import pythonDescription from "../prompts/tools/python.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

const pythonSchema = type({
	action: '"environment" | "packages"',
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
	sessionId?: string;
	pythonPath?: string;
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

/** Describes the NPi managed Python environment and manages its packages. */
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
		if (action === "packages" && params.operation === "install" && Array.isArray(params.packages)) {
			return [`Packages: ${params.packages.filter((item): item is string => typeof item === "string").join(", ")}`];
		}
		return [`Action: ${action}`];
	};
	readonly label = "Python";
	readonly summary = "Inspect the NPi managed Python runtime's health; list or install its packages";
	readonly description = prompt.render(pythonDescription);
	readonly parameters = pythonSchema;
	readonly strict = true;
	readonly concurrency = "exclusive";
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: PythonParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<PythonToolDetails>,
	): Promise<AgentToolResult<PythonToolDetails>> {
		throwIfAborted(signal);
		switch (params.action) {
			case "environment":
				return await this.#environment(signal);
			case "packages":
				return await this.#packages(params, signal, onUpdate);
			default:
				throw new ToolError(`Unsupported python action: ${String(params.action)}`);
		}
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
					: "No NPi managed Python runtime is configured: NPI_PYTHON_HOST is unset.",
			);
		}
		return managed;
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
