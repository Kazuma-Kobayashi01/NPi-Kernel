import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";

/** The files `scripts/build-image.sh` writes into the image folder; reclaiming removes these and nothing else. */
export const IMAGE_FILES = ["Image", "rootfs.cpio.gz", "manifest.json"] as const;

export interface ImageInfo {
	/** Bytes the image files take on disk (0 when there is no image). */
	bytes: number;
	/** The image files present. */
	files: string[];
}

async function sizeOf(file: string): Promise<number | undefined> {
	try {
		return (await fs.stat(file)).size;
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

/** What the guest image in `dir` occupies. */
export async function imageInfo(dir: string): Promise<ImageInfo> {
	const info: ImageInfo = { bytes: 0, files: [] };
	for (const name of IMAGE_FILES) {
		const size = await sizeOf(path.join(dir, name));
		if (size === undefined) continue;
		info.bytes += size;
		info.files.push(name);
	}
	return info;
}

/**
 * Delete the guest image: only the files `build-image.sh` writes, so a folder the user pointed `image` at that
 * holds anything else keeps it. The folder itself goes when it ends up empty, and `parent` (the plugin's
 * `sandbox-vm` data folder) too when the image folder was its last entry. Returns what was freed.
 */
export async function reclaimImage(dir: string, parent?: string): Promise<ImageInfo> {
	const freed = await imageInfo(dir);
	for (const name of freed.files) await fs.rm(path.join(dir, name), { force: true });
	await removeIfEmpty(dir);
	if (parent) await removeIfEmpty(parent);
	return freed;
}

async function removeIfEmpty(dir: string): Promise<void> {
	try {
		await fs.rmdir(dir);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
	}
}

/** `68.1 MB`-style size for messages. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
}
