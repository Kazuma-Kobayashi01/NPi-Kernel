/**
 * Python runtime resolution utilities.
 *
 * Centralizes environment filtering, venv detection, and Python executable resolution
 * for both the shared gateway and local kernel spawning.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	$env,
	$whichAll,
	getNpiEnvDir,
	getNpiManagedPythonEnvDir,
	getPythonEnvDir,
	isEnoent,
	isRecord,
} from "@oh-my-pi/pi-utils";

const DEFAULT_ENV_ALLOWLIST = new Set([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
	"TERM",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"TMPDIR",
	"TEMP",
	"TMP",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_RUNTIME_DIR",
	"SSH_AUTH_SOCK",
	"SSH_AGENT_PID",
	"CONDA_PREFIX",
	"CONDA_DEFAULT_ENV",
	"VIRTUAL_ENV",
	"PYTHONPATH",
	"LD_LIBRARY_PATH",
]);

const WINDOWS_ENV_ALLOWLIST = new Set([
	"APPDATA",
	"COMPUTERNAME",
	"COMSPEC",
	"HOMEDRIVE",
	"HOMEPATH",
	"LOCALAPPDATA",
	"NUMBER_OF_PROCESSORS",
	"OS",
	"PATH",
	"PATHEXT",
	"PROCESSOR_ARCHITECTURE",
	"PROCESSOR_IDENTIFIER",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PROGRAMW6432",
	"SESSIONNAME",
	"SYSTEMDRIVE",
	"SYSTEMROOT",
	"TEMP",
	"TMP",
	"USERDOMAIN",
	"USERDOMAIN_ROAMINGPROFILE",
	"USERPROFILE",
	"USERNAME",
	"WINDIR",
]);

const DEFAULT_ENV_DENYLIST = new Set([
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"GOOGLE_API_KEY",
	"GEMINI_API_KEY",
	"OPENROUTER_API_KEY",
	"PERPLEXITY_API_KEY",
	"PERPLEXITY_COOKIES",
	"EXA_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"MISTRAL_API_KEY",
]);

const DEFAULT_ENV_ALLOW_PREFIXES = ["LC_", "XDG_"];

const CASE_INSENSITIVE_ENV = process.platform === "win32";
const BASE_ENV_ALLOWLIST = new Set([...DEFAULT_ENV_ALLOWLIST, ...WINDOWS_ENV_ALLOWLIST]);

const NORMALIZED_ALLOWLIST = new Set(
	Array.from(BASE_ENV_ALLOWLIST, key => (CASE_INSENSITIVE_ENV ? key.toUpperCase() : key)),
);
const NORMALIZED_DENYLIST = new Set(
	Array.from(DEFAULT_ENV_DENYLIST, key => (CASE_INSENSITIVE_ENV ? key.toUpperCase() : key)),
);
const NORMALIZED_ALLOW_PREFIXES = CASE_INSENSITIVE_ENV
	? DEFAULT_ENV_ALLOW_PREFIXES.map(prefix => prefix.toUpperCase())
	: DEFAULT_ENV_ALLOW_PREFIXES;

function normalizeEnvKey(key: string): string {
	return CASE_INSENSITIVE_ENV ? key.toUpperCase() : key;
}

function resolvePathKey(env: Record<string, string | undefined>): string {
	if (!CASE_INSENSITIVE_ENV) return "PATH";
	const match = Object.keys(env).find(candidate => candidate.toLowerCase() === "path");
	return match ?? "PATH";
}

function resolveManagedPythonEnv(): string {
	return getPythonEnvDir();
}

function resolveManagedPythonCandidate(): { venvPath: string; pythonPath: string } {
	const venvPath = resolveManagedPythonEnv();
	const binDir = process.platform === "win32" ? path.join(venvPath, "Scripts") : path.join(venvPath, "bin");
	const pythonPath = path.join(binDir, process.platform === "win32" ? "python.exe" : "python");
	return { venvPath, pythonPath };
}

export interface PythonRuntime {
	/** Path to python executable */
	pythonPath: string;
	/** Filtered environment variables */
	env: Record<string, string | undefined>;
	/** Path to virtual environment, if detected */
	venvPath?: string;
}

/** One unpacked immutable base runtime under `<NPI_ENV_DIR>/runtimes/python`. */
export interface NpiPythonRuntime {
	/** `<NPI_ENV_DIR>/runtimes/python/<version>-<platform>` */
	runtimePath: string;
	/** Interpreter shipped by the runtime (`bin/python3` or `bin/python`). */
	pythonPath: string;
}

/**
 * Whether the desktop app supplied its runtime host executable. In that mode
 * the Rust host is the sole runtime/environment manager: omp never unpacks an
 * archive, creates a virtualenv, or falls back to a system interpreter.
 */
export function isNpiPythonHostConfigured(): boolean {
	return Boolean(process.env.NPI_PYTHON_HOST?.trim());
}

/** Model-facing hint for a host that is configured but has not provisioned yet. */
export const NPI_PYTHON_HOST_UNAVAILABLE_HINT =
	"The NPi managed Python runtime is not provisioned yet. The desktop app installs it on the first python action; " +
	"from a source checkout set NPI_PYTHON_HOST to the app executable and NPI_PYTHON_RESOURCE_DIR to the directory " +
	"holding python-runtime-manifest.json.";

/** `<NPI_ENV_DIR>/environments/default/bin/python` (or `Scripts/python.exe` on Windows). */
export function npiManagedPythonPath(): string {
	const binDir = process.platform === "win32" ? "Scripts" : "bin";
	return path.join(getNpiManagedPythonEnvDir(), binDir, process.platform === "win32" ? "python.exe" : "python");
}

/** `<NPI_ENV_DIR>/cache/uv`, the shared uv cache for managed package installs. */
export function getNpiPythonCacheDir(): string {
	return path.join(getNpiEnvDir(), "cache", "uv");
}

/**
 * Accept both runtime layouts a python-build-standalone archive can leave
 * behind: the archive's `python/` prefix stripped, and an installer that keeps
 * `<runtime>/python/bin/python3`.
 */
function runtimePython(runtimePath: string): string | undefined {
	const binName = process.platform === "win32" ? "Scripts" : "bin";
	const names = process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"];
	for (const root of [runtimePath, path.join(runtimePath, "python")]) {
		const binDir = path.join(root, binName);
		for (const name of names) {
			const candidate = path.join(binDir, name);
			if (fs.existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

function runtimeVersionKey(name: string): [number, number, number] {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(name);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
}

/** Newest unpacked NPi runtime, when one exists. Cheap enough for synchronous resolution. */
export function findNpiPythonRuntime(): NpiPythonRuntime | undefined {
	const runtimesRoot = path.join(getNpiEnvDir(), "runtimes", "python");
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(runtimesRoot, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	const candidates = entries
		.filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
		.map(entry => path.join(runtimesRoot, entry.name))
		.sort((left, right) => {
			const [la, lb, lc] = runtimeVersionKey(path.basename(left));
			const [ra, rb, rc] = runtimeVersionKey(path.basename(right));
			return ra - la || rb - lb || rc - lc || left.localeCompare(right);
		});
	for (const runtimePath of candidates) {
		const pythonPath = runtimePython(runtimePath);
		if (pythonPath) return { runtimePath, pythonPath };
	}
	return undefined;
}

/**
 * Filter environment variables to a safe allowlist for Python subprocesses.
 * Removes sensitive API keys and limits to known-safe variables.
 */
export function filterEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
	const filtered: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		const normalizedKey = normalizeEnvKey(key);
		if (NORMALIZED_DENYLIST.has(normalizedKey)) continue;
		if (NORMALIZED_ALLOWLIST.has(normalizedKey)) {
			const destKey = normalizedKey === "PATH" ? "PATH" : key;
			filtered[destKey] = value;
			continue;
		}
		if (NORMALIZED_ALLOW_PREFIXES.some(prefix => normalizedKey.startsWith(prefix))) {
			filtered[key] = value;
		}
	}
	return filtered;
}

/**
 * Detect virtual environment path from VIRTUAL_ENV or common locations.
 */
export function resolveVenvPath(cwd: string): string | undefined {
	if ($env.VIRTUAL_ENV) return $env.VIRTUAL_ENV;
	if ($env.CONDA_PREFIX) return $env.CONDA_PREFIX;
	const candidates = [path.join(cwd, ".venv"), path.join(cwd, "venv")];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * Apply a venv-style PATH/VIRTUAL_ENV layout onto a fresh copy of `baseEnv` for
 * the interpreter living in `binDir`.
 */
function applyVenvEnv(
	baseEnv: Record<string, string | undefined>,
	venvPath: string,
	binDir: string,
): Record<string, string | undefined> {
	const env = { ...baseEnv };
	env.VIRTUAL_ENV = venvPath;
	const pathKey = resolvePathKey(env);
	const currentPath = env[pathKey];
	env[pathKey] = currentPath ? `${binDir}${path.delimiter}${currentPath}` : binDir;
	return env;
}

function venvBinDir(venvPath: string): string {
	return process.platform === "win32" ? path.join(venvPath, "Scripts") : path.join(venvPath, "bin");
}

function detectExplicitVenv(pythonPath: string): { venvPath: string; binDir: string } | undefined {
	const binDir = path.dirname(pythonPath);
	const venvPath = path.dirname(binDir);
	if (fs.existsSync(path.join(venvPath, "pyvenv.cfg"))) {
		return { venvPath, binDir };
	}
	return undefined;
}

/**
 * Resolve an explicitly configured interpreter (`python.interpreter`) into a
 * runtime, bypassing discovery. Does not probe or validate the executable —
 * callers must check it actually runs. `~` expands to the home directory and
 * relative paths resolve against `cwd`. When the interpreter sits inside a
 * virtualenv (a `pyvenv.cfg` above its bin dir), the venv activation env is
 * applied so subprocesses and `pip` resolve consistently.
 */
export function resolveExplicitPythonRuntime(
	interpreter: string,
	cwd: string,
	baseEnv: Record<string, string | undefined>,
): PythonRuntime {
	const expanded =
		interpreter === "~"
			? os.homedir()
			: interpreter.startsWith("~/")
				? path.join(os.homedir(), interpreter.slice(2))
				: interpreter;
	// Join (rather than resolve) onto an absolute cwd so the result stays anchored to
	// exactly the cwd given — `path.resolve` would graft the process drive onto a
	// rooted-but-driveless Windows cwd such as `\work`.
	const pythonPath = path.isAbsolute(expanded)
		? expanded
		: path.isAbsolute(cwd)
			? path.join(cwd, expanded)
			: path.resolve(cwd, expanded);
	const venv = detectExplicitVenv(pythonPath);
	if (venv) {
		return { pythonPath, env: applyVenvEnv(baseEnv, venv.venvPath, venv.binDir), venvPath: venv.venvPath };
	}
	return { pythonPath, env: { ...baseEnv } };
}

/**
 * The managed interpreter the Rust host most recently reported. The Rust
 * manager versions its environments (`environments/default/versions/...`), so
 * this is the only trustworthy source; never derive it from a fixed layout.
 */
export function cachedNpiManagedPythonPath(): string | undefined {
	const cached = npiPythonInterpreterCache;
	if (!cached || cached.envDir !== getNpiEnvDir()) return undefined;
	return fs.existsSync(cached.pythonPath) ? cached.pythonPath : undefined;
}

/**
 * The managed runtime for desktop-managed mode, or `undefined` before the
 * environment has been provisioned. Never falls back to a project venv or a
 * system interpreter while the host is configured.
 */
export function resolveNpiManagedPythonRuntime(
	cwd: string,
	baseEnv: Record<string, string | undefined>,
): PythonRuntime | undefined {
	const managed = isNpiPythonHostConfigured();
	const pythonPath = cachedNpiManagedPythonPath() ?? (managed ? undefined : npiManagedPythonPath());
	if (!pythonPath || !fs.existsSync(pythonPath)) return undefined;
	return resolveExplicitPythonRuntime(pythonPath, cwd, baseEnv);
}

/**
 * Enumerate candidate Python runtimes in priority order: an active/project venv,
 * the managed `~/.omp/python-env`, then every `python` and `python3` on PATH. Every
 * candidate that physically exists is returned so callers can probe each in turn
 * rather than committing to the first — a managed env left behind by a removed
 * `uv` install, or a version-manager shim with no version selected for the cwd,
 * no longer shadows a working system Python.
 *
 * With the desktop runtime host configured, the managed interpreter is the only
 * candidate: silently running user code against a system Python would bypass the
 * environment the app installs and manages.
 */
export function enumeratePythonRuntimes(cwd: string, baseEnv: Record<string, string | undefined>): PythonRuntime[] {
	const runtimes: PythonRuntime[] = [];
	const seen = new Set<string>();
	const push = (runtime: PythonRuntime): void => {
		if (seen.has(runtime.pythonPath)) return;
		seen.add(runtime.pythonPath);
		runtimes.push(runtime);
	};

	if (isNpiPythonHostConfigured()) {
		const managed = resolveNpiManagedPythonRuntime(cwd, baseEnv);
		if (managed) push(managed);
		return runtimes;
	}

	const venvPath = baseEnv.VIRTUAL_ENV ?? resolveVenvPath(cwd);
	if (venvPath) {
		const binDir = venvBinDir(venvPath);
		const pythonCandidate = path.join(binDir, process.platform === "win32" ? "python.exe" : "python");
		if (fs.existsSync(pythonCandidate)) {
			push({ pythonPath: pythonCandidate, env: applyVenvEnv(baseEnv, venvPath, binDir), venvPath });
		}
	}

	const npiEnvPath = getNpiManagedPythonEnvDir();
	const npiEnvPython = npiManagedPythonPath();
	if (fs.existsSync(npiEnvPython)) {
		push({
			pythonPath: npiEnvPython,
			env: applyVenvEnv(baseEnv, npiEnvPath, venvBinDir(npiEnvPath)),
			venvPath: npiEnvPath,
		});
	}
	const npiRuntime = findNpiPythonRuntime();
	if (npiRuntime) {
		push({ pythonPath: npiRuntime.pythonPath, env: { ...baseEnv } });
	}

	const managed = resolveManagedPythonCandidate();
	if (fs.existsSync(managed.pythonPath)) {
		const managedBin = path.dirname(managed.pythonPath);
		push({
			pythonPath: managed.pythonPath,
			env: applyVenvEnv(baseEnv, managed.venvPath, managedBin),
			venvPath: managed.venvPath,
		});
	}

	for (const systemPath of [...$whichAll("python"), ...$whichAll("python3")]) {
		push({ pythonPath: systemPath, env: { ...baseEnv } });
	}

	return runtimes;
}

/**
 * Resolve the highest-priority Python runtime. Prefer {@link enumeratePythonRuntimes}
 * when you can probe candidates; this returns only the first one and throws when
 * no interpreter exists.
 */
export function resolvePythonRuntime(cwd: string, baseEnv: Record<string, string | undefined>): PythonRuntime {
	const [runtime] = enumeratePythonRuntimes(cwd, baseEnv);
	if (!runtime) {
		throw new Error("Python executable not found on PATH");
	}
	return runtime;
}

// =============================================================================
// NPi runtime host (the desktop app's Rust runtime/environment manager)
// =============================================================================

/** One `EnvironmentHealth` reported by the desktop runtime host. */
export interface NpiPythonEnvironmentHealth {
	ok: boolean;
	pythonVersion: string;
	uvVersion: string;
	pythonPath: string;
	envPath: string;
	runtimePath: string;
	message: string | null;
}

/** One installed distribution reported by the desktop runtime host. */
export interface NpiPythonPackage {
	name: string;
	version: string;
}

/** One structured progress line from the host (`npi-python-progress {json}`). */
export interface NpiPythonProgress {
	stage: string;
	message?: string;
}

/** Options for one host request. */
export interface NpiPythonHostOptions {
	signal?: AbortSignal;
	/** Wall-clock ceiling for one request; the first `ensure` unpacks the runtime. */
	timeoutMs?: number;
	/** Structured install/build progress; never user-facing chat text. */
	onProgress?: (progress: NpiPythonProgress) => void;
}

/** Options for {@link ensureNpiPythonEnv}. */
export type EnsureNpiPythonEnvOptions = NpiPythonHostOptions;

/** The host's request envelope (`deny_unknown_fields`: send only these keys). */
interface NpiPythonHostRequest {
	action: "ensure" | "environment" | "packages";
	operation?: "list" | "install";
	packages?: string[];
	resourceDir?: string;
}

const NPI_PYTHON_HOST_TIMEOUT_MS = 300_000;
const NPI_PYTHON_HOST_OUTPUT_LIMIT = 8 * 1024 * 1024;

/** `<NPI_ENV_DIR>/workspaces/<sanitized-session-id>` for one execution session. */
export function getNpiPythonWorkspaceDir(sessionId: string): string {
	const sanitized = sessionId.replace(/[^A-Za-z0-9_-]/g, "_") || "_";
	return path.join(getNpiEnvDir(), "workspaces", sanitized);
}

/** Last interpreter the host reported, keyed by the base directory it belongs to. */
let npiPythonInterpreterCache: { envDir: string; pythonPath: string } | undefined;
const npiPythonEnsurePending = new Map<string, Promise<string>>();

function npiPythonHostPath(): string {
	const host = process.env.NPI_PYTHON_HOST?.trim();
	if (!host) throw new Error(NPI_PYTHON_HOST_UNAVAILABLE_HINT);
	if (!path.isAbsolute(host)) throw new Error(`NPI_PYTHON_HOST must be an absolute path, got: ${host}`);
	return host;
}

/** Only safe variables reach the host; agent credentials never do. */
function npiPythonHostEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {
		...filterEnv(Bun.env as Record<string, string | undefined>),
		NPI_ENV_DIR: getNpiEnvDir(),
	};
	const resourceDir = process.env.NPI_PYTHON_RESOURCE_DIR?.trim();
	if (resourceDir) env.NPI_PYTHON_RESOURCE_DIR = resourceDir;
	return env;
}

function npiPythonHostError(stderr: string, exitCode: number | null): string {
	const lines = stderr
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0 && !line.startsWith("npi-python-progress"));
	const reported = lines.find(line => line.startsWith("npi-python-error:"));
	const message = (reported ?? lines.at(-1) ?? "").replace(/^npi-python-error:\s*/, "");
	return message || `The NPi Python runtime host exited with ${exitCode ?? "no status"}.`;
}

/**
 * Send one JSON request to `<NPI_PYTHON_HOST> --npi-python-host` and parse its
 * one JSON answer. `npi-python-progress {json}` lines are forwarded to the
 * caller's `onProgress`; failures surface the host's `npi-python-error:
 * <message>` line.
 */
async function runNpiPythonHost<T>(request: NpiPythonHostRequest, options: NpiPythonHostOptions = {}): Promise<T> {
	options.signal?.throwIfAborted();
	const host = npiPythonHostPath();
	const child = Bun.spawn([host, "--npi-python-host"], {
		env: npiPythonHostEnv(),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		detached: process.platform !== "win32",
		windowsHide: true,
	});
	const terminate = (): void => {
		if (child.exitCode !== null) return;
		if (process.platform === "win32") {
			child.kill("SIGKILL");
			return;
		}
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	};
	const timeoutMs = options.timeoutMs ?? NPI_PYTHON_HOST_TIMEOUT_MS;
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		terminate();
	}, timeoutMs);
	timer.unref?.();
	const onAbort = () => terminate();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		child.stdin?.write(`${JSON.stringify(request)}\n`);
		child.stdin?.end();
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout as ReadableStream<Uint8Array>).text(),
			readNpiPythonHostStderr(child.stderr as ReadableStream<Uint8Array>, options.onProgress),
			child.exited,
		]);
		options.signal?.throwIfAborted();
		if (timedOut) throw new Error(`The NPi Python runtime host did not answer within ${timeoutMs}ms.`);
		if (exitCode !== 0) throw new Error(npiPythonHostError(stderr, exitCode));
		if (stdout.length > NPI_PYTHON_HOST_OUTPUT_LIMIT) {
			throw new Error(`The NPi Python runtime host returned more than ${NPI_PYTHON_HOST_OUTPUT_LIMIT} bytes.`);
		}
		const payload = stdout.trim();
		if (!payload) throw new Error("The NPi Python runtime host returned no JSON.");
		try {
			return JSON.parse(payload) as T;
		} catch {
			throw new Error(`The NPi Python runtime host returned invalid JSON: ${payload.slice(0, 200)}`);
		}
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
		if (child.exitCode === null) terminate();
	}
}

/** Read the host's stderr, forwarding structured progress and keeping error text. */
async function readNpiPythonHostStderr(
	stream: ReadableStream<Uint8Array>,
	onProgress: NpiPythonHostOptions["onProgress"],
): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let errors = "";
	let buffered = "";
	const handleLine = (raw: string): void => {
		const line = raw.trim();
		if (!line) return;
		if (!line.startsWith("npi-python-progress")) {
			errors += `${line}\n`;
			if (errors.length > 262_144) errors = errors.slice(-131_072);
			return;
		}
		if (!onProgress) return;
		try {
			const value: unknown = JSON.parse(line.slice("npi-python-progress".length).trim());
			if (!isRecord(value) || typeof value.stage !== "string") return;
			onProgress({
				stage: value.stage,
				...(typeof value.message === "string" ? { message: value.message } : {}),
			});
		} catch {
			// A malformed progress line is not a failure; the result still governs.
		}
	};
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffered += decoder.decode(value, { stream: true });
		const lines = buffered.split("\n");
		buffered = lines.pop() ?? "";
		for (const line of lines) handleLine(line);
	}
	buffered += decoder.decode();
	handleLine(buffered);
	return errors;
}

function parseNpiPythonHealth(value: unknown): NpiPythonEnvironmentHealth {
	if (!isRecord(value)) throw new Error("The NPi Python runtime host returned a malformed environment health.");
	const { ok, pythonVersion, uvVersion, pythonPath, envPath, runtimePath, message } = value;
	if (
		typeof ok !== "boolean" ||
		typeof pythonVersion !== "string" ||
		typeof uvVersion !== "string" ||
		typeof pythonPath !== "string" ||
		typeof envPath !== "string" ||
		typeof runtimePath !== "string" ||
		(message !== null && typeof message !== "string")
	) {
		throw new Error("The NPi Python runtime host returned a malformed environment health.");
	}
	if (ok) {
		if (!path.isAbsolute(pythonPath) || !fs.existsSync(pythonPath)) {
			throw new Error(`The NPi Python runtime host reported a missing interpreter: ${pythonPath || "(empty)"}`);
		}
		npiPythonInterpreterCache = { envDir: getNpiEnvDir(), pythonPath };
	}
	return { ok, pythonVersion, uvVersion, pythonPath, envPath, runtimePath, message };
}

function parseNpiPythonPackages(value: unknown): NpiPythonPackage[] {
	if (!Array.isArray(value)) throw new Error("The NPi Python runtime host returned a malformed package list.");
	return value.map(item => {
		if (!isRecord(item) || typeof item.name !== "string" || typeof item.version !== "string") {
			throw new Error("The NPi Python runtime host returned a malformed package list.");
		}
		return { name: item.name, version: item.version };
	});
}

/** Read the managed environment's health without installing or building it. */
export async function readNpiPythonEnvironment(
	options: NpiPythonHostOptions = {},
): Promise<NpiPythonEnvironmentHealth> {
	return parseNpiPythonHealth(await runNpiPythonHost({ action: "environment" }, options));
}

/** List the managed environment's installed distributions. */
export async function listNpiPythonPackages(options: NpiPythonHostOptions = {}): Promise<NpiPythonPackage[]> {
	const value = await runNpiPythonHost({ action: "packages", operation: "list" }, options);
	return parseNpiPythonPackages(value);
}

/** Install distribution requirements into the managed environment. */
export async function installNpiPythonPackages(
	packages: readonly string[],
	options: NpiPythonHostOptions = {},
): Promise<NpiPythonPackage[]> {
	const value = await runNpiPythonHost({ action: "packages", operation: "install", packages: [...packages] }, options);
	return parseNpiPythonPackages(value);
}

/**
 * Ensure the desktop-managed runtime and environment exist, returning the
 * absolute interpreter the Rust host reported.
 *
 * The host is the only installer: omp never extracts an archive or creates a
 * virtualenv. Returns `undefined` when no host is configured (source CLI), and
 * throws when a configured host cannot provision the runtime — silently
 * continuing would run user code against an unknown interpreter.
 */
export async function ensureNpiPythonEnv(options: EnsureNpiPythonEnvOptions = {}): Promise<string | undefined> {
	options.signal?.throwIfAborted();
	if (!isNpiPythonHostConfigured()) return undefined;
	const cached = cachedNpiManagedPythonPath();
	if (cached) return cached;
	const key = [
		process.env.NPI_PYTHON_HOST?.trim() ?? "",
		getNpiEnvDir(),
		process.env.NPI_PYTHON_RESOURCE_DIR?.trim() ?? "",
	].join("\0");
	const pending = npiPythonEnsurePending.get(key);
	if (pending) return await pending;
	const request: NpiPythonHostRequest = { action: "ensure" };
	const resourceDir = process.env.NPI_PYTHON_RESOURCE_DIR?.trim();
	if (resourceDir) request.resourceDir = path.resolve(resourceDir);
	const work = (async () => {
		const health = parseNpiPythonHealth(await runNpiPythonHost<unknown>(request, options));
		if (!health.ok) throw new Error(health.message ?? NPI_PYTHON_HOST_UNAVAILABLE_HINT);
		return health.pythonPath;
	})();
	npiPythonEnsurePending.set(key, work);
	try {
		return await work;
	} finally {
		if (npiPythonEnsurePending.get(key) === work) npiPythonEnsurePending.delete(key);
	}
}
