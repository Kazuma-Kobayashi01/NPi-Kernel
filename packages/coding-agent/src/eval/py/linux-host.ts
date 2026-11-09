/**
 * Standalone NPi Python runtime host for Linux.
 *
 * Speaks the same one-shot `--npi-python-host` protocol as the desktop app's
 * Rust host (`desktop/docs/architecture/python-runtime.md`): one JSON request
 * on stdin, one JSON value on stdout, `npi-python-error: <message>` plus exit 1
 * on failure, `npi-python-progress {json}` lines on stderr. The `.run` installer ships a
 * pinned python-build-standalone archive (with uv) and its manifest; this host
 * unpacks it into the content-addressed runtime directory and builds the
 * versioned default environment. It never falls back to a system interpreter.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getNpiEnvDir, isEnoent, isRecord } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";

export const LINUX_HOST_ARG = "--npi-python-host";

interface Manifest {
	runtimeVersion: string;
	platform: string;
	archiveName: string;
	archiveSha256: string;
	archiveSize: number;
	uvVersion: string;
}

interface Health {
	ok: boolean;
	pythonVersion: string;
	uvVersion: string;
	pythonPath: string;
	envPath: string;
	runtimePath: string;
	message: string | null;
}

interface Request {
	action: "ensure" | "environment" | "packages";
	resourceDir?: string;
	operation?: "list" | "install";
	packages?: string[];
}

interface ToolOutput {
	exitCode: number;
	stdout: string;
	stderr: string;
}

const TOOL_TIMEOUT_MS = 280_000;
const MANIFEST_NAME = "python-runtime-manifest.json";

/** `x86_64-unknown-linux-gnu` / `aarch64-unknown-linux-gnu`, the platform string the manifest must carry. */
function hostPlatform(): string {
	const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : undefined;
	if (process.platform !== "linux" || !arch) {
		throw new Error(`The standalone Python host supports Linux x64/arm64 only, not ${process.platform}-${process.arch}.`);
	}
	return `${arch}-unknown-linux-gnu`;
}

export function reportProgress(stage: string, message: string): void {
	process.stderr.write(`npi-python-progress ${JSON.stringify({ stage, message })}\n`);
}

function parseRequest(raw: string): Request {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		throw new Error(`invalid request: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(value)) throw new Error("invalid request: expected a JSON object");
	for (const key of Object.keys(value)) {
		if (key !== "action" && key !== "resourceDir" && key !== "operation" && key !== "packages") {
			throw new Error(`invalid request: unknown field ${key}`);
		}
	}
	const { action, resourceDir, operation, packages } = value;
	if (action !== "ensure" && action !== "environment" && action !== "packages") {
		throw new Error(`invalid request: unknown action ${String(action)}`);
	}
	if (resourceDir !== undefined && typeof resourceDir !== "string") {
		throw new Error("invalid request: resourceDir must be a string");
	}
	if (operation !== undefined && operation !== "list" && operation !== "install") {
		throw new Error(`invalid request: unknown operation ${String(operation)}`);
	}
	if (packages !== undefined && (!Array.isArray(packages) || packages.some(item => typeof item !== "string"))) {
		throw new Error("invalid request: packages must be an array of strings");
	}
	return { action, resourceDir, operation, packages: packages as string[] | undefined };
}

/** Explicit `resourceDir`, then `NPI_PYTHON_RESOURCE_DIR`, then `<exe dir>/../lib/npi` (the installer layout, `<prefix>/lib/npi`). */
function resolveResourceDir(explicit: string | undefined): string {
	const candidates: string[] = [];
	if (explicit !== undefined) {
		if (!path.isAbsolute(explicit) || !fs.statSync(explicit, { throwIfNoEntry: false })?.isDirectory()) {
			throw new Error(`resourceDir must be an absolute existing directory: ${explicit}`);
		}
		candidates.push(explicit);
	} else {
		const env = process.env.NPI_PYTHON_RESOURCE_DIR?.trim();
		if (env) candidates.push(path.resolve(env));
		candidates.push(path.resolve(path.dirname(fs.realpathSync(process.execPath)), "..", "lib", "npi"));
	}
	for (const dir of candidates) {
		for (const root of [dir, path.join(dir, "resources")]) {
			if (fs.existsSync(path.join(root, MANIFEST_NAME))) return root;
		}
	}
	throw new Error(`${MANIFEST_NAME} not found in: ${candidates.join(", ")}`);
}

function readManifest(resourceDir: string): Manifest {
	const value: unknown = JSON.parse(fs.readFileSync(path.join(resourceDir, MANIFEST_NAME), "utf8"));
	if (!isRecord(value)) throw new Error(`${MANIFEST_NAME} is not an object`);
	const { runtimeVersion, platform, archiveName, archiveSha256, archiveSize, uvVersion } = value;
	if (
		typeof runtimeVersion !== "string" ||
		typeof platform !== "string" ||
		typeof archiveName !== "string" ||
		typeof archiveSha256 !== "string" ||
		typeof archiveSize !== "number" ||
		typeof uvVersion !== "string"
	) {
		throw new Error(`${MANIFEST_NAME} is missing required fields`);
	}
	if (archiveName !== path.basename(archiveName)) throw new Error("archiveName must be a bare file name");
	const expected = hostPlatform();
	if (platform !== expected) {
		throw new Error(`The bundled Python runtime targets ${platform}, this host is ${expected}.`);
	}
	return { runtimeVersion, platform, archiveName, archiveSha256, archiveSize, uvVersion };
}

async function runTool(command: string[], cwd?: string): Promise<ToolOutput> {
	const proc = Bun.spawn(command, {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGKILL");
	}, TOOL_TIMEOUT_MS);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
			new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
			proc.exited,
		]);
		if (timedOut) throw new Error(`${path.basename(command[0])} did not finish within ${TOOL_TIMEOUT_MS}ms`);
		return { exitCode, stdout, stderr };
	} finally {
		clearTimeout(timer);
	}
}

async function runChecked(command: string[]): Promise<string> {
	const result = await runTool(command);
	if (result.exitCode !== 0) {
		const detail = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-3).join(" ");
		throw new Error(`${path.basename(command[0])} ${command[1] ?? ""} failed (${result.exitCode}): ${detail}`);
	}
	return result.stdout;
}

async function sha256File(file: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(file).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

class Layout {
	readonly base = getNpiEnvDir();
	readonly envDir = path.join(this.base, "environments", "default");
	readonly currentFile = path.join(this.envDir, "current");
	readonly lockPath = path.join(this.base, "state", "install");
	readonly uvCache = path.join(this.base, "cache", "uv");

	runtimeDir(manifest: Manifest): string {
		return path.join(
			this.base,
			"runtimes",
			"python",
			`${manifest.runtimeVersion}-${manifest.platform}-${manifest.archiveSha256.slice(0, 12)}`,
		);
	}

	envVersionDir(manifest: Manifest): string {
		return path.join(this.envDir, "versions", `py${manifest.runtimeVersion}-${manifest.archiveSha256.slice(0, 12)}`);
	}
}

const layout = new Layout();

function pythonIn(root: string): string {
	return path.join(root, "bin", "python3");
}

function uvIn(root: string): string {
	return path.join(root, "bin", "uv");
}

function readCurrent(): string | undefined {
	try {
		const id = fs.readFileSync(layout.currentFile, "utf8").trim();
		return id ? path.join(layout.envDir, "versions", id) : undefined;
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

async function probeVersions(runtimeDir: string): Promise<{ python: string; uv: string }> {
	const python = (await runChecked([pythonIn(runtimeDir), "-I", "-B", "--version"])).trim().replace(/^Python\s+/, "");
	const uv = (await runChecked([uvIn(runtimeDir), "--version"])).trim().split(/\s+/)[1] ?? "";
	return { python, uv };
}

async function installRuntime(resourceDir: string, manifest: Manifest, runtimeDir: string): Promise<void> {
	if (fs.existsSync(path.join(runtimeDir, ".npi-installed.json"))) return;
	const archive = path.join(resourceDir, manifest.archiveName);
	const size = fs.statSync(archive, { throwIfNoEntry: false })?.size;
	if (size === undefined) throw new Error(`Python runtime archive is missing: ${archive}`);
	if (size !== manifest.archiveSize) {
		throw new Error(`Python runtime archive size ${size} does not match the manifest (${manifest.archiveSize}).`);
	}
	reportProgress("verifying", manifest.archiveName);
	const digest = await sha256File(archive);
	if (digest !== manifest.archiveSha256) throw new Error("Python runtime archive digest does not match the manifest.");

	const parent = path.dirname(runtimeDir);
	fs.mkdirSync(parent, { recursive: true });
	const staging = path.join(parent, `.staging-${process.pid}-${Date.now()}`);
	fs.rmSync(runtimeDir, { recursive: true, force: true });
	fs.mkdirSync(staging);
	try {
		reportProgress("extracting", manifest.archiveName);
		await runChecked(["tar", "-xzf", archive, "-C", staging, "--strip-components=1"]);
		const versions = await probeVersions(staging);
		if (versions.python !== manifest.runtimeVersion || versions.uv !== manifest.uvVersion) {
			throw new Error(
				`Packaged runtime reports python ${versions.python} / uv ${versions.uv}, manifest says ` +
					`${manifest.runtimeVersion} / ${manifest.uvVersion}.`,
			);
		}
		fs.writeFileSync(path.join(staging, ".npi-installed.json"), JSON.stringify({ archiveSha256: digest }));
		fs.renameSync(staging, runtimeDir);
	} catch (error) {
		fs.rmSync(staging, { recursive: true, force: true });
		throw error;
	}
}

async function buildEnvironment(manifest: Manifest, runtimeDir: string): Promise<void> {
	const versionDir = layout.envVersionDir(manifest);
	const versionId = path.basename(versionDir);
	if (!fs.existsSync(path.join(versionDir, "bin", "python"))) {
		reportProgress("environment", "creating virtual environment");
		fs.rmSync(versionDir, { recursive: true, force: true });
		fs.mkdirSync(path.dirname(versionDir), { recursive: true });
		const building = `${versionDir}.building-${process.pid}`;
		fs.rmSync(building, { recursive: true, force: true });
		try {
			await runChecked([pythonIn(runtimeDir), "-I", "-B", "-m", "venv", "--without-pip", building]);
			await runChecked([path.join(building, "bin", "python"), "-I", "-B", "-m", "ensurepip", "--upgrade", "--default-pip"]);
			fs.renameSync(building, versionDir);
		} catch (error) {
			fs.rmSync(building, { recursive: true, force: true });
			throw error;
		}
	}
	const pointer = `${layout.currentFile}.${process.pid}.tmp`;
	fs.mkdirSync(layout.envDir, { recursive: true });
	fs.writeFileSync(pointer, `${versionId}\n`);
	fs.renameSync(pointer, layout.currentFile);
}

/** Every field is a string so the omp client's strict health parser accepts an unprovisioned environment. */
function unhealthy(message: string): Health {
	return {
		ok: false,
		pythonVersion: "",
		uvVersion: "",
		pythonPath: "",
		envPath: layout.envDir,
		runtimePath: "",
		message,
	};
}

/** Read-only: report what is installed without touching resources or the network. */
async function readHealth(): Promise<Health> {
	const versionDir = readCurrent();
	if (!versionDir) return unhealthy("The managed Python environment has not been created yet.");
	const pythonPath = path.join(versionDir, "bin", "python");
	if (!fs.existsSync(pythonPath)) return unhealthy(`The managed interpreter is missing: ${pythonPath}`);
	const runtimeDir = path.dirname(path.dirname(fs.realpathSync(pythonPath)));
	const versions = await probeVersions(runtimeDir);
	return {
		ok: true,
		pythonVersion: versions.python,
		uvVersion: versions.uv,
		pythonPath,
		envPath: layout.envDir,
		runtimePath: runtimeDir,
		message: null,
	};
}

async function ensure(resourceDir: string | undefined): Promise<Health> {
	const dir = resolveResourceDir(resourceDir);
	const manifest = readManifest(dir);
	fs.mkdirSync(path.dirname(layout.lockPath), { recursive: true });
	await withFileLock(
		layout.lockPath,
		async () => {
			const runtimeDir = layout.runtimeDir(manifest);
			await installRuntime(dir, manifest, runtimeDir);
			await buildEnvironment(manifest, runtimeDir);
		},
		{ retries: 2800, retryDelayMs: 100 },
	);
	return await readHealth();
}

async function managedTools(): Promise<{ python: string; uv: string }> {
	const health = await readHealth();
	if (!health.ok) throw new Error(health.message ?? "The managed Python environment is not ready.");
	return { python: health.pythonPath, uv: uvIn(health.runtimePath) };
}

async function listPackages(): Promise<Array<{ name: string; version: string }>> {
	const { python, uv } = await managedTools();
	const out = await runChecked([uv, "pip", "list", "--format", "json", "--python", python, "--cache-dir", layout.uvCache]);
	const parsed: unknown = JSON.parse(out);
	if (!Array.isArray(parsed)) throw new Error("uv pip list returned a non-array result");
	const items = parsed.map(item => {
		if (!isRecord(item) || typeof item.name !== "string" || typeof item.version !== "string") {
			throw new Error("uv pip list returned a malformed package");
		}
		return { name: item.name, version: item.version };
	});
	return items.sort((a, b) => a.name.localeCompare(b.name));
}

async function installPackages(packages: string[]): Promise<Array<{ name: string; version: string }>> {
	const { python, uv } = await managedTools();
	reportProgress("installing", packages.join(" "));
	fs.mkdirSync(layout.uvCache, { recursive: true });
	await withFileLock(
		layout.lockPath,
		() => runChecked([uv, "pip", "install", "--python", python, "--cache-dir", layout.uvCache, ...packages]),
		{ retries: 2800, retryDelayMs: 100 },
	);
	return await listPackages();
}

async function handle(request: Request): Promise<unknown> {
	switch (request.action) {
		case "ensure":
			return await ensure(request.resourceDir);
		case "environment":
			return await readHealth();
		case "packages":
			if ((request.operation ?? "list") === "list") return await listPackages();
			if (!request.packages || request.packages.length === 0) {
				throw new Error("invalid request: install requires a non-empty packages array");
			}
			return await installPackages(request.packages);
	}
}

/** The `--npi-python-host` entry: one request on stdin, one JSON answer on stdout. */
export async function runLinuxPythonHost(): Promise<void> {
	try {
		const request = parseRequest(await Bun.stdin.text());
		process.stdout.write(`${JSON.stringify(await handle(request))}\n`);
	} catch (error) {
		const message = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ");
		process.stderr.write(`npi-python-error: ${message}\n`);
		process.exitCode = 1;
	}
}
