/**
 * File checkpoints: what a project's files looked like just before a prompt, so a rewind can take
 * the files back with the conversation. Plain content-addressed copies under the agent directory:
 * no Git process and no touching the project's repository, so its index, commits and branches stay
 * as they are, and a folder without Git works the same. Files the project ignores, large files and
 * symlinks are not kept. A commit the agent made survives a restore; only file contents go back.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { getAgentDir, hashPath, logger } from "@oh-my-pi/pi-utils";

/** Custom session entry placed just before the prompt it belongs to. */
export const FILE_CHECKPOINT_CUSTOM_TYPE = "file-checkpoint";

/** A snapshot slower than this no longer holds up the prompt: it finishes in the background and only seeds the next one. */
const TAKE_LIMIT_MS = 2_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 100_000;
const MAX_STORE_BYTES = 2 * 1024 * 1024 * 1024;
const KEEP_MANIFESTS = 200;
const PRUNE_AT = KEEP_MANIFESTS + 50;
const IO_BATCH = 64;
/** Folders no project wants kept, ignored by it or not. */
const SKIPPED_DIRS = new Set([".git", "node_modules", "target", "dist", "build", ".venv", "venv", "__pycache__"]);

export interface FileCheckpointRef {
	root: string;
	id: string;
}

interface FileRecord {
	hash: string;
	size: number;
	mtimeMs: number;
	mode: number;
}

interface Manifest {
	root: string;
	files: Record<string, FileRecord>;
	/** Bytes the store held when this was written. */
	storeBytes: number;
}

export interface FileCheckpointChange {
	path: string;
	/** The file appeared after the snapshot, so restoring removes it. */
	removes: boolean;
}

const storeDir = (root: string) => path.join(getAgentDir(), "checkpoints", hashPath(root));
const manifestsDir = (root: string) => path.join(storeDir(root), "manifests");
const manifestPath = (ref: FileCheckpointRef) => path.join(manifestsDir(ref.root), `${ref.id}.json`);
const blobPath = (root: string, hash: string) => path.join(storeDir(root), "blobs", hash.slice(0, 2), hash.slice(2));

function sha256(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function listFiles(root: string): Promise<string[]> {
	const found = await natives.glob({
		pattern: "**/*",
		path: root,
		fileType: natives.FileType.File,
		hidden: true,
		gitignore: true,
		maxResults: MAX_FILES,
	});
	return found.matches
		.map(match => match.path)
		.filter(rel => !rel.split(path.sep).some(segment => SKIPPED_DIRS.has(segment)));
}

/** Runs `work` over `items`, a batch at a time. */
async function inBatches<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
	for (let at = 0; at < items.length; at += IO_BATCH) {
		await Promise.all(items.slice(at, at + IO_BATCH).map(work));
	}
}

function isMissing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/** The project as it is now. `known` spares re-reading files whose size and time did not move; `keep` receives contents that are new. */
async function scan(
	root: string,
	known: Record<string, FileRecord>,
	keep?: (hash: string, bytes: Uint8Array) => Promise<void>,
): Promise<Record<string, FileRecord>> {
	const files: Record<string, FileRecord> = {};
	await inBatches(await listFiles(root), async rel => {
		try {
			const abs = path.join(root, rel);
			const stat = await fs.lstat(abs);
			if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return;
			const same = known[rel];
			if (same && same.size === stat.size && same.mtimeMs === stat.mtimeMs) {
				files[rel] = same;
				return;
			}
			const bytes = await Bun.file(abs).bytes();
			const hash = sha256(bytes);
			await keep?.(hash, bytes);
			files[rel] = { hash, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode & 0o777 };
		} catch (error) {
			if (error instanceof StoreFull) throw error;
			// Deleted between the listing and here, or unreadable: not part of this snapshot.
			if (!isMissing(error)) logger.debug("file checkpoint skipped a file", { rel, error: String(error) });
		}
	});
	return files;
}

async function manifestIds(root: string): Promise<string[]> {
	try {
		const names = await fs.readdir(manifestsDir(root));
		return names
			.filter(name => name.endsWith(".json"))
			.map(name => name.slice(0, -5))
			.sort();
	} catch (error) {
		if (isMissing(error)) return [];
		throw error;
	}
}

async function readManifest(ref: FileCheckpointRef): Promise<Manifest | undefined> {
	try {
		return (await Bun.file(manifestPath(ref)).json()) as Manifest;
	} catch {
		return undefined;
	}
}

/** Forgets all but the newest manifests, then every blob none of them names. */
async function prune(root: string): Promise<void> {
	const ids = await manifestIds(root);
	if (ids.length < PRUNE_AT) return;
	const old = ids.slice(0, -KEEP_MANIFESTS);
	await inBatches(old, id => fs.rm(manifestPath({ root, id }), { force: true }));
	const live = new Set<string>();
	for (const id of ids.slice(-KEEP_MANIFESTS)) {
		const manifest = await readManifest({ root, id });
		for (const file of Object.values(manifest?.files ?? {})) live.add(file.hash);
	}
	const blobs = path.join(storeDir(root), "blobs");
	for (const prefix of await fs.readdir(blobs)) {
		for (const rest of await fs.readdir(path.join(blobs, prefix))) {
			if (!live.has(prefix + rest)) await fs.rm(path.join(blobs, prefix, rest), { force: true });
		}
	}
}

/** Thrown out of a scan that would take the store past its size: a home folder must not fill the disk. */
class StoreFull extends Error {}

async function snapshot(root: string, maxStoreBytes: number): Promise<FileCheckpointRef | undefined> {
	// A full store stays full: rescanning the folder on every prompt to find that out again is the waste it avoids.
	const full = path.join(storeDir(root), "full");
	if (await Bun.file(full).exists()) return undefined;
	const ids = await manifestIds(root);
	const previous = ids.length > 0 ? await readManifest({ root, id: ids[ids.length - 1] }) : undefined;
	let storeBytes = previous?.storeBytes ?? 0;
	const files = await scan(root, previous?.files ?? {}, async (hash, bytes) => {
		const blob = blobPath(root, hash);
		if (await Bun.file(blob).exists()) return;
		if (storeBytes + bytes.length > maxStoreBytes) throw new StoreFull();
		const partial = `${blob}.${process.pid}.tmp`;
		await Bun.write(partial, bytes);
		await fs.rename(partial, blob);
		storeBytes += bytes.length;
	});
	const ref = { root, id: `${Date.now().toString(36).padStart(10, "0")}-${process.pid}` };
	await Bun.write(manifestPath(ref), JSON.stringify({ root, files, storeBytes } satisfies Manifest));
	await prune(root);
	return ref;
}

const running = new Map<string, Promise<FileCheckpointRef | undefined>>();

/** Snapshots `root` for a prompt about to go out. `undefined` when that would make the prompt wait too long or the store is full. */
export async function takeFileCheckpoint(
	root: string,
	limitMs = TAKE_LIMIT_MS,
	maxStoreBytes = MAX_STORE_BYTES,
): Promise<FileCheckpointRef | undefined> {
	if (running.has(root)) return undefined;
	const work = snapshot(root, maxStoreBytes)
		.catch(async error => {
			if (error instanceof StoreFull) await Bun.write(path.join(storeDir(root), "full"), "");
			else logger.warn("file checkpoint failed", { error: String(error) });
			return undefined;
		})
		.finally(() => running.delete(root));
	running.set(root, work);
	const late = Bun.sleep(limitMs).then(() => undefined);
	return Promise.race([work, late]);
}

/** What restoring `ref` would change; `undefined` when the snapshot is gone. */
export async function planFileRestore(ref: FileCheckpointRef): Promise<FileCheckpointChange[] | undefined> {
	const manifest = await readManifest(ref);
	if (!manifest) return undefined;
	const current = await scan(ref.root, manifest.files);
	const changes: FileCheckpointChange[] = [];
	for (const [rel, file] of Object.entries(manifest.files)) {
		if (current[rel]?.hash !== file.hash) changes.push({ path: rel, removes: false });
	}
	for (const rel of Object.keys(current)) {
		if (!manifest.files[rel]) changes.push({ path: rel, removes: true });
	}
	return changes.sort((a, b) => a.path.localeCompare(b.path));
}

async function removeFile(root: string, rel: string): Promise<void> {
	const abs = path.join(root, rel);
	await fs.rm(abs, { force: true });
	// Folders the file left empty go too; a snapshot cannot hold them.
	let dir = path.dirname(abs);
	while (dir !== root && dir.startsWith(root)) {
		try {
			await fs.rmdir(dir);
		} catch {
			return;
		}
		dir = path.dirname(dir);
	}
}

/** Puts the files back as `ref` had them; returns how many changed. What it replaces is snapshotted first. */
export async function restoreFileCheckpoint(ref: FileCheckpointRef): Promise<number> {
	const manifest = await readManifest(ref);
	const changes = await planFileRestore(ref);
	if (!manifest || !changes) throw new Error("That file snapshot is gone.");
	await snapshot(ref.root, MAX_STORE_BYTES).catch(() => undefined);
	await inBatches(changes, async change => {
		if (change.removes) {
			await removeFile(ref.root, change.path);
			return;
		}
		const file = manifest.files[change.path];
		const abs = path.join(ref.root, change.path);
		await Bun.write(abs, Bun.file(blobPath(ref.root, file.hash)));
		await fs.chmod(abs, file.mode);
	});
	return changes.length;
}
