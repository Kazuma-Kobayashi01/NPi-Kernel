import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";

/**
 * How NPi Desktop's terminal panel finds this VM. The panel runs `<helper> attach <socket>` for a tab whose
 * commands run in the VM; it learns the helper and the socket from `<tmp>/npi-vm-routes/<omp pid>.json`, keyed by
 * the pid of the omp process it started for the tab, so the webview never names a program or a path. The folder is
 * owner-only, the file is too, and Desktop checks both before it trusts the file.
 */
export interface TerminalRoute {
	/** The VM helper executable (its `attach` mode is the client). */
	helper: string;
	/** The helper's terminal socket. */
	socket: string;
}

/** A unix socket path must stay under about 104 bytes on macOS, which is why this lives in the short temp folder. */
export function routeDir(): string {
	return path.join(os.tmpdir(), "npi-vm-routes");
}

export function routePaths(pid: number = process.pid): { dir: string; file: string; socket: string } {
	const dir = routeDir();
	return { dir, file: path.join(dir, `${pid}.json`), socket: path.join(dir, `${pid}.sock`) };
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but is not ours to signal.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Delete the route and socket files of processes that no longer exist (a killed omp cannot withdraw its own). */
export async function pruneRoutes(): Promise<void> {
	let names: string[];
	try {
		names = await fs.readdir(routeDir());
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
	for (const name of names) {
		const match = /^(\d+)\.(?:json|sock)$/u.exec(name);
		if (!match || alive(Number(match[1]))) continue;
		await fs.rm(path.join(routeDir(), name), { force: true });
	}
}

/** Publish the route of this process; the folder is created owner-only (and tightened if it already exists). */
export async function writeRoute(helper: string, pid: number = process.pid): Promise<TerminalRoute> {
	const { dir, file, socket } = routePaths(pid);
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	await fs.chmod(dir, 0o700);
	await pruneRoutes().catch(() => undefined);
	const route: TerminalRoute = { helper, socket };
	const temp = `${file}.${process.pid}.tmp`;
	await Bun.write(temp, `${JSON.stringify(route)}\n`);
	await fs.chmod(temp, 0o600);
	await fs.rename(temp, file);
	return route;
}

/** Withdraw the route and the socket file the helper left. */
export async function removeRoute(pid: number = process.pid): Promise<void> {
	const { file, socket } = routePaths(pid);
	for (const target of [file, socket]) {
		try {
			await fs.rm(target, { force: true });
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
}
