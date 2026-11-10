/**
 * The office's records on disk: small JSON files in the repository's git directory, so they are
 * shared by every worktree of the project, survive branch switches, and never show up as changes.
 */
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { Company } from "./workspace";

/** `<git common dir>/npi-office/<name>`. */
export function storePath(company: Company, name: string): string {
	return path.join(vcs.requireGit(company.checkout).info().commonDir, "npi-office", name);
}

export async function readStore<T>(file: string, empty: () => T): Promise<T> {
	try {
		return await Bun.file(file).json();
	} catch (error) {
		if (isEnoent(error)) return empty();
		throw error;
	}
}

const listeners = new Set<() => void>();

/**
 * Call `listener` whenever this process changes something a client draws: a pull request, an
 * office's memory, the usage ledger, or who is at a desk. Returns the unsubscribe function.
 */
export function onOfficeChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Tell {@link onOfficeChange} listeners the company changed. */
export function notifyOfficeChange(): void {
	for (const listener of listeners) listener();
}

// One writer at a time per file: every desk of a company runs in this process.
const writes = new Map<string, Promise<unknown>>();

/** Read `file`, let `change` edit the value in place, write it back; serialized per file. */
export async function updateStore<T, R>(
	file: string,
	empty: () => T,
	change: (value: T) => R,
	{ notify = true }: { notify?: boolean } = {},
): Promise<R> {
	const prior = writes.get(file) ?? Promise.resolve();
	const run = prior
		.catch(() => {})
		.then(async () => {
			const value = await readStore(file, empty);
			const result = change(value);
			await Bun.write(file, JSON.stringify(value, null, "\t"));
			if (notify) notifyOfficeChange();
			return result;
		});
	writes.set(file, run);
	try {
		return await run;
	} finally {
		if (writes.get(file) === run) writes.delete(file);
	}
}
