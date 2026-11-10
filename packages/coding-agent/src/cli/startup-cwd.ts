import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { directoryExists, getProjectDir, normalizePathForComparison, setProjectDir } from "@oh-my-pi/pi-utils";
import type { Args } from "./args";

/** Where a CLI started in the home folder works: `~/Documents/NPi/Code`. */
export function defaultWorkspaceDir(home: string): string {
	return path.join(home, "Documents", "NPi", "Code");
}

async function maybeAutoChdir(parsed: Args): Promise<void> {
	if (parsed.allowHome || parsed.cwd) {
		return;
	}

	const home = os.homedir();
	if (!home) {
		return;
	}

	const normalizePath = normalizePathForComparison;

	const cwd = normalizePath(getProjectDir());
	const normalizedHome = normalizePath(home);
	if (cwd !== normalizedHome) {
		return;
	}

	// The NPi workspace comes first, created on first use, so a session opened from the home
	// folder lands in a real project directory instead of a scratch one shared by every such
	// session (whose memory and history would otherwise pile up under `/tmp`).
	const workspace = defaultWorkspaceDir(home);
	try {
		await fs.mkdir(workspace, { recursive: true });
		setProjectDir(workspace);
		return;
	} catch {
		// No access to Documents (macOS privacy prompt declined, read-only home): use a temp dir.
	}

	const candidates =
		process.platform === "win32" ? [path.join(home, "tmp")] : [path.join(home, "tmp"), "/tmp", "/var/tmp"];
	for (const candidate of candidates) {
		try {
			if (!(await directoryExists(candidate))) {
				continue;
			}
			setProjectDir(candidate);
			return;
		} catch {
			// Try next candidate.
		}
	}

	try {
		const fallback = os.tmpdir();
		if (fallback && normalizePath(fallback) !== cwd && (await directoryExists(fallback))) {
			setProjectDir(fallback);
		}
	} catch {
		// Ignore fallback errors.
	}
}

export async function applyStartupCwd(parsed: Args): Promise<void> {
	if (parsed.cwd) {
		try {
			setProjectDir(parsed.cwd);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			// Permission denials are the macOS TCC case; a plain ENOENT typo
			// should not be told to grant Full Disk Access.
			const code = (error as NodeJS.ErrnoException | null)?.code;
			const hint =
				code === "EACCES" || code === "EPERM"
					? " On macOS, grant npi Files & Folders or Full Disk Access permission for the target directory."
					: "";
			throw new Error(`Cannot change working directory to ${parsed.cwd}: ${reason}.${hint}`);
		}
		// setProjectDir resolves the (possibly relative) target against the launch
		// cwd and chdirs into it. Re-sync parsed.cwd to the resolved absolute path
		// so downstream consumers (buildSessionOptions, settings/discovery, session
		// persistence) don't re-resolve a relative string against the new cwd.
		parsed.cwd = getProjectDir();
		return;
	}
	await maybeAutoChdir(parsed);
}
