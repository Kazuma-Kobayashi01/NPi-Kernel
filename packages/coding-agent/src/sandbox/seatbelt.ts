/**
 * macOS process sandbox: relaunch `npi` under a Seatbelt profile.
 *
 * Seatbelt rules are inherited by every child, so confining the agent process
 * itself confines the embedded shell's external programs, eval kernels, file
 * tools and MCP servers without touching any spawn path. The profile allows
 * everything except file writes outside a list of writable roots: the project
 * (its git repository, including a worktree's shared git directory), npi's own
 * data, cache and runtime folders, the temporary folders, `/dev`, and
 * `sandbox.writableRoots`. Reads and network stay open — the agent needs the
 * model API, and the point is containing writes.
 *
 * Paths are passed as `-D` parameters rather than spliced into the profile
 * text, so a folder name never needs Seatbelt string escaping. Every root is
 * resolved through `realpath`: Seatbelt matches the real path (`/tmp` is
 * `/private/tmp`, `/var` is `/private/var`).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	GLOBAL_CACHE_DIR_NAME,
	getAgentDir,
	getBaseConfigRoot,
	getConfigRootDir,
	getGlobalDaemonRuntimeRoot,
	getLogsDir,
	getNpiEnvDir,
	logger,
} from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { cfgSandboxMode, cfgSandboxWritableRoots, type SandboxMode } from "./settings";

/** Set in the relaunched child; names the active mode and stops a second relaunch. */
export const SANDBOX_ACTIVE_ENV = "NPI_SANDBOX_ACTIVE";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** The mode the current process already runs under, if it was relaunched into one. */
export function activeSandboxMode(): SandboxMode | undefined {
	const value = process.env[SANDBOX_ACTIVE_ENV];
	return value === "workspace-write" || value === "read-only" ? value : undefined;
}

/** `value` as a sandbox mode, or `undefined` when it names none. */
export function parseSandboxMode(value: string | undefined): SandboxMode | undefined {
	return value === "off" || value === "workspace-write" || value === "read-only" ? value : undefined;
}

/** Whether this platform can run the Seatbelt sandbox. */
export function sandboxSupported(): boolean {
	return process.platform === "darwin" && fs.existsSync(SANDBOX_EXEC);
}

/** The profile text and the `sandbox-exec` parameters that fill it. */
export interface SeatbeltProfile {
	profile: string;
	/** `-D` arguments, one `["-D", "W<n>=<path>"]` pair per writable root. */
	params: string[];
}

/** A profile that denies file writes outside `writableRoots` (real paths). */
export function buildSeatbeltProfile(writableRoots: readonly string[]): SeatbeltProfile {
	const params: string[] = [];
	const allowed = writableRoots.map((root, index) => {
		params.push("-D", `W${index}=${root}`);
		return `(require-not (subpath (param "W${index}")))`;
	});
	const profile = [
		"(version 1)",
		"(allow default)",
		allowed.length === 0 ? "(deny file-write*)" : `(deny file-write* (require-all ${allowed.join(" ")}))`,
	].join("\n");
	return { profile, params };
}

/** `~/x` → `<home>/x`; anything else unchanged. */
function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

/** The real path of an existing directory, or `undefined`. */
function realDir(candidate: string): string | undefined {
	try {
		const real = fs.realpathSync(candidate);
		return fs.statSync(real).isDirectory() ? real : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The git checkout containing `cwd`: its top level plus the git directories a
 * commit writes. A linked worktree's `.git` is a file naming its private git
 * directory, whose `commondir` names the main repository's `.git`.
 */
export function gitWriteRoots(cwd: string): string[] {
	for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
		const dotGit = path.join(dir, ".git");
		let stat: fs.Stats | undefined;
		try {
			stat = fs.statSync(dotGit);
		} catch {}
		if (stat?.isDirectory()) return [dir];
		if (stat?.isFile()) {
			const roots = [dir];
			const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"))?.[1]?.trim();
			if (pointer) {
				const gitDir = path.resolve(dir, pointer);
				roots.push(gitDir);
				try {
					const common = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
					if (common) roots.push(path.resolve(gitDir, common));
				} catch {}
			}
			return roots;
		}
		if (path.dirname(dir) === dir) return [];
	}
}

/** Folders npi itself writes: config/data, agent dir, logs, caches, runtime, managed Python. */
function npiWriteRoots(): string[] {
	const roots = [
		getBaseConfigRoot(),
		getConfigRootDir(),
		getAgentDir(),
		getLogsDir(),
		getNpiEnvDir(),
		getGlobalDaemonRuntimeRoot(),
		path.join(os.homedir(), GLOBAL_CACHE_DIR_NAME),
	];
	for (const variable of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
		const value = process.env[variable]?.trim();
		if (value) roots.push(path.join(value, "npi"), path.join(value, "omp"));
	}
	return roots;
}

/** Temporary folders and devices every process needs to write. */
function systemWriteRoots(): string[] {
	const roots = ["/private/tmp", "/private/var/folders", "/dev"];
	const tmpdir = process.env.TMPDIR?.trim();
	if (tmpdir) roots.push(tmpdir);
	roots.push(os.tmpdir());
	return roots;
}

/**
 * Every folder `mode` lets the sandboxed process tree write, as existing real
 * paths without duplicates. A root that does not exist yet is created first
 * when it is one of npi's own folders, so a fresh install can write its state.
 */
export function sandboxWritableRoots(
	mode: Exclude<SandboxMode, "off">,
	cwd: string,
	extra: readonly string[],
): string[] {
	const npiRoots = npiWriteRoots();
	for (const root of npiRoots) {
		try {
			fs.mkdirSync(root, { recursive: true });
		} catch {}
	}
	const candidates = [...npiRoots, ...systemWriteRoots(), ...extra.map(expandHome)];
	if (mode === "workspace-write") {
		candidates.push(cwd, ...gitWriteRoots(cwd));
	}
	const seen = new Set<string>();
	const roots: string[] = [];
	for (const candidate of candidates) {
		if (!path.isAbsolute(candidate)) continue;
		const real = realDir(candidate);
		if (real && !seen.has(real)) {
			seen.add(real);
			roots.push(real);
		}
	}
	return roots;
}

/**
 * The argv that starts this same program again: a compiled binary is its own
 * entry (`process.argv[1]` is its virtual `$bunfs` path), a source run passes
 * the script to the Bun runtime.
 */
function selfArgv(): string[] {
	const compiled = process.argv[1]?.includes("$bunfs") === true;
	return [process.execPath, ...process.argv.slice(compiled ? 2 : 1)];
}

/**
 * Run this process's command again under the Seatbelt profile for `mode`,
 * wait for it, and exit with its status. The parent stays alive only to relay
 * the exit: the child inherits the terminal, and a terminal Ctrl-C reaches it
 * directly through the shared process group.
 */
export async function relaunchInSandbox(
	mode: Exclude<SandboxMode, "off">,
	cwd: string,
	extraWritableRoots: readonly string[],
): Promise<never> {
	const { profile, params } = buildSeatbeltProfile(sandboxWritableRoots(mode, cwd, extraWritableRoots));
	// stdin is inherited untouched: the caller relaunches before anything in
	// this process reads it (RPC's input claim pulls a frame at once), so the
	// child receives every byte, and a terminal stays a terminal for raw mode.
	const child = Bun.spawn([SANDBOX_EXEC, ...params, "-p", profile, ...selfArgv()], {
		cwd,
		env: { ...process.env, [SANDBOX_ACTIVE_ENV]: mode },
		stdio: ["inherit", "inherit", "inherit"],
	});
	// The terminal sends SIGINT to the whole foreground group; the child
	// handles it. Signals aimed at this process alone are passed on.
	process.on("SIGINT", () => {});
	for (const signal of ["SIGTERM", "SIGHUP"] as const) {
		process.on(signal, () => child.kill(signal));
	}
	const code = await child.exited;
	process.exit(child.signalCode ? 128 + (os.constants.signals[child.signalCode] ?? 0) : code);
}

/** What {@link enterSandboxIfConfigured} needs from the launch. */
export interface SandboxStartup {
	/** `--sandbox <mode>`, which wins over `sandbox.mode`. */
	flag: SandboxMode | undefined;
	cwd: string;
	/** The effective settings; a failure leaves the decision to the flag alone. */
	loadSettings: () => Promise<Settings>;
	/** Stop anything that already drew to the terminal before the child takes it. */
	beforeRelaunch: () => void;
}

/**
 * Relaunch into the sandbox when `--sandbox` or `sandbox.mode` asks for one
 * and this process is not already the sandboxed child; otherwise return.
 * An explicit flag on a platform without Seatbelt fails closed; a setting
 * there is logged and skipped, since config files travel between machines.
 */
export async function enterSandboxIfConfigured(startup: SandboxStartup): Promise<void> {
	if (activeSandboxMode()) return;
	let settings: Settings | undefined;
	try {
		settings = await startup.loadSettings();
	} catch {}
	const mode = startup.flag ?? (settings ? cfgSandboxMode.get(settings) : "off");
	if (mode === "off") return;
	if (!sandboxSupported()) {
		if (startup.flag) {
			process.stderr.write(`Error: --sandbox ${mode} needs macOS (${SANDBOX_EXEC}); refusing to run unsandboxed.\n`);
			process.exit(1);
		}
		logger.warn("sandbox.mode is set but this platform has no Seatbelt sandbox; running unsandboxed", { mode });
		return;
	}
	startup.beforeRelaunch();
	await relaunchInSandbox(mode, startup.cwd, settings ? cfgSandboxWritableRoots.get(settings) : []);
}
