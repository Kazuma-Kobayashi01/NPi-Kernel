/**
 * Who is at which desk right now. One assignment per desk at a time, across every process working
 * on the repository: two sessions at the same worktree would overwrite each other.
 *
 * A claim is a file created exclusively in the repository's git directory. It names the process
 * holding it, so a claim left behind by a process that died is recognised and dropped.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { notifyOfficeChange, storePath } from "./store";
import type { Company } from "./workspace";

export interface DeskClaim {
	/** The desk's worktree. */
	desk: string;
	office: number;
	/** Member working at the desk. */
	member: string;
	role: "leader" | "worker";
	task: string;
	/** Process holding the claim. */
	pid: number;
	startedAt: string;
}

function claimsDir(company: Company): string {
	return storePath(company, "desks");
}

function claimPath(company: Company, desk: string): string {
	return path.join(claimsDir(company), `${Bun.hash(desk).toString(36)}.json`);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function readClaim(file: string): Promise<DeskClaim | null> {
	try {
		const claim: DeskClaim = await Bun.file(file).json();
		return typeof claim.pid === "number" && isAlive(claim.pid) ? claim : null;
	} catch {
		// Missing, half-written by a process that died, or not ours to parse: no live claim.
		return null;
	}
}

/**
 * Take the desk for one assignment. Returns the function that gives it back, or `null` when a
 * live process (this one included) already holds it.
 */
export async function claimDesk(
	company: Company,
	claim: Omit<DeskClaim, "pid" | "startedAt">,
): Promise<(() => Promise<void>) | null> {
	const file = claimPath(company, claim.desk);
	await fs.mkdir(path.dirname(file), { recursive: true });
	const body = JSON.stringify({ ...claim, pid: process.pid, startedAt: new Date().toISOString() } satisfies DeskClaim);
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await fs.writeFile(file, body, { flag: "wx" });
			notifyOfficeChange();
			return async () => {
				await fs.rm(file, { force: true });
				notifyOfficeChange();
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (await readClaim(file)) return null;
			// Left by a process that is gone: drop it and try once more.
			await fs.rm(file, { force: true });
		}
	}
	return null;
}

/** Every desk a live process is working at. */
export async function readClaims(company: Company): Promise<DeskClaim[]> {
	let names: string[];
	try {
		names = await fs.readdir(claimsDir(company));
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const claims = await Promise.all(names.sort().map(name => readClaim(path.join(claimsDir(company), name))));
	return claims.filter(claim => claim !== null);
}
