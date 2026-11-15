/**
 * `.npix` plugin packages: an npm-pack tarball (tar.gz whose entries live under `package/`) renamed, carrying
 * the plugin and every dependency it needs. Installing only unpacks and links it — nothing is downloaded —
 * so the same file installs the same plugin offline, like a VS Code `.vsix`.
 *
 * Installed copies live in `<plugins>/npix/<name>/<version>` and are linked into `<plugins>/node_modules`
 * through {@link PluginManager.link}, so list / enable / disable / features / uninstall work as for any
 * linked plugin.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getPluginsDir, isEnoent, pathIsWithin, TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { resolvePluginManifestEntries } from "./loader";
import { type PluginManager, validatePackageName } from "./manager";
import type { InstalledPlugin, PluginManifest } from "./types";

export const NPIX_EXTENSION = ".npix";
/** Who made the plugin, at the package root next to `package.json`. Required in every `.npix`. */
export const DEVELOPER_FILE = "developer.json";

/** Files and folders never packed: VCS state, OS litter, earlier packages, npm's command shims. */
const PACK_SKIP = new Set([".git", ".DS_Store", "node_modules/.bin"]);

/** `developer.json`: who made the plugin. Only `name` is required. */
export interface NpixDeveloper {
	name: string;
	email?: string;
	/** http(s) homepage of the developer or the plugin. */
	url?: string;
	organization?: string;
}

/** What a package declares, shown before installing it. */
export interface NpixInfo {
	name: string;
	version: string;
	description?: string;
	developer: NpixDeveloper;
	manifest: PluginManifest;
	/** Entry points per kind, as declared. */
	capabilities: { extensions: string[]; tools: string[]; hooks: string[]; commands: string[]; features: string[] };
	/** Bundled extras besides code. */
	bundles: { skills: boolean; mcp: boolean };
	files: number;
	bytes: number;
}

interface PackageJson {
	name?: unknown;
	version?: unknown;
	description?: unknown;
	omp?: PluginManifest;
	pi?: PluginManifest;
}

/** Longest value kept for a `developer.json` field. */
const DEVELOPER_FIELD_MAX = 200;

/** Validates `developer.json` content; throws with what to fix. */
export function parseDeveloper(value: unknown): NpixDeveloper {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${DEVELOPER_FILE} must be a JSON object`);
	}
	const record = value as Record<string, unknown>;
	const field = (key: string, required: boolean): string | undefined => {
		const raw = record[key];
		if (raw === undefined && !required) return undefined;
		if (typeof raw !== "string" || !raw.trim())
			throw new Error(`${DEVELOPER_FILE}: "${key}" must be a non-empty string`);
		if (raw.length > DEVELOPER_FIELD_MAX || /[\u0000-\u001f]/.test(raw)) {
			throw new Error(`${DEVELOPER_FILE}: "${key}" is too long or contains control characters`);
		}
		return raw.trim();
	};
	const developer: NpixDeveloper = { name: field("name", true) as string };
	const email = field("email", false);
	if (email !== undefined) {
		if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error(`${DEVELOPER_FILE}: "email" is not an email address`);
		developer.email = email;
	}
	const url = field("url", false);
	if (url !== undefined) {
		if (!/^https?:\/\//i.test(url) || !URL.canParse(url))
			throw new Error(`${DEVELOPER_FILE}: "url" must be an http(s) URL`);
		developer.url = url;
	}
	const organization = field("organization", false);
	if (organization !== undefined) developer.organization = organization;
	return developer;
}

/** The plugin folder's `developer.json`, or `undefined` when it has none (plugins not installed from `.npix`). */
async function readDeveloper(dir: string): Promise<NpixDeveloper | undefined> {
	let raw: unknown;
	try {
		raw = await Bun.file(path.join(dir, DEVELOPER_FILE)).json();
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw new Error(`${DEVELOPER_FILE} is not valid JSON`);
	}
	return parseDeveloper(raw);
}

function asList(value: string | string[] | undefined): string[] {
	if (!value) return [];
	return Array.isArray(value) ? value : [value];
}

/**
 * Validates an unpacked plugin folder (`package.json` with an `omp` / `pi` manifest whose entries exist) and
 * describes it. Throws with the reason a user can act on.
 */
export async function describePluginFolder(dir: string): Promise<NpixInfo> {
	let pkg: PackageJson;
	try {
		pkg = (await Bun.file(path.join(dir, "package.json")).json()) as PackageJson;
	} catch {
		throw new Error("package.json is missing or not valid JSON");
	}
	if (typeof pkg.name !== "string" || !pkg.name) throw new Error("package.json has no name");
	validatePackageName(pkg.name);
	if (typeof pkg.version !== "string" || !pkg.version) throw new Error("package.json has no version");
	const developer = await readDeveloper(dir);
	if (!developer) throw new Error(`${DEVELOPER_FILE} is missing (who made the plugin: { "name": "…" })`);
	const manifest = pkg.omp ?? pkg.pi;
	if (!manifest || typeof manifest !== "object") {
		throw new Error('package.json has no "omp" manifest (e.g. "omp": { "extensions": ["./index.ts"] })');
	}
	const features = Object.keys(manifest.features ?? {});
	const capabilities = {
		extensions: asList(manifest.extensions),
		tools: asList(manifest.tools),
		hooks: asList(manifest.hooks),
		commands: asList(manifest.commands),
		features,
	};
	if (Object.values(capabilities).every(list => list.length === 0)) {
		throw new Error('The "omp" manifest declares no extensions, tools, hooks, commands or features');
	}
	const plugin: InstalledPlugin = {
		name: pkg.name,
		version: pkg.version,
		path: dir,
		manifest: { ...manifest, version: pkg.version },
		enabledFeatures: null,
		enabled: true,
	};
	for (const key of ["extensions", "tools", "hooks", "commands"] as const) {
		const missing = resolvePluginManifestEntries(plugin, key).filter(entry => entry.resolvedPath === null);
		if (missing.length > 0) {
			throw new Error(`${key} entry not found in the package: ${missing.map(m => m.entry).join(", ")}`);
		}
	}
	let files = 0;
	let bytes = 0;
	for await (const file of new Bun.Glob("**/*").scan({ cwd: dir, dot: true, onlyFiles: true })) {
		files++;
		bytes += Bun.file(path.join(dir, file)).size;
	}
	const exists = (rel: string) =>
		fs.stat(path.join(dir, rel)).then(
			() => true,
			() => false,
		);
	return {
		name: pkg.name,
		version: pkg.version,
		description: typeof pkg.description === "string" ? pkg.description : undefined,
		developer,
		manifest: plugin.manifest,
		capabilities,
		bundles: { skills: await exists("skills"), mcp: await exists(".mcp.json") },
		files,
		bytes,
	};
}

/** Unpacks `file` into `into`/package after checking every entry stays inside it; returns that folder. */
async function unpack(file: string, into: string): Promise<string> {
	const listing = await $`tar -tzf ${file}`.quiet().nothrow();
	if (listing.exitCode !== 0) throw new Error(`${path.basename(file)} is not a tar.gz archive`);
	const entries = listing.text().split("\n").filter(Boolean);
	if (entries.length === 0) throw new Error(`${path.basename(file)} is empty`);
	for (const entry of entries) {
		const segments = entry.split("/");
		if (path.isAbsolute(entry) || segments.includes("..") || (segments[0] !== "package" && entry !== "package")) {
			throw new Error(`Refusing ${path.basename(file)}: entry "${entry}" is outside package/`);
		}
	}
	const extracted = await $`tar -xzf ${file} -C ${into}`.quiet().nothrow();
	if (extracted.exitCode !== 0)
		throw new Error(`Couldn't unpack ${path.basename(file)}: ${extracted.stderr.toString()}`);
	const root = path.join(into, "package");
	for await (const entry of new Bun.Glob("**/*").scan({
		cwd: root,
		dot: true,
		onlyFiles: false,
		followSymlinks: false,
	})) {
		if ((await fs.lstat(path.join(root, entry))).isSymbolicLink()) {
			throw new Error(`Refusing ${path.basename(file)}: it contains a symlink (${entry})`);
		}
	}
	return root;
}

function assertNpix(file: string): void {
	if (!file.endsWith(NPIX_EXTENSION)) throw new Error(`Not a ${NPIX_EXTENSION} file: ${file}`);
}

/** Describes `file` without installing anything. */
export async function inspectNpix(file: string): Promise<NpixInfo> {
	assertNpix(file);
	await using temp = await TempDir.create("@npi-npix-inspect-");
	// `await` before returning: the temp folder is removed as soon as this function returns.
	return await describePluginFolder(await unpack(path.resolve(file), temp.path()));
}

/** Folder holding every installed version of `name`. */
function installRoot(name: string): string {
	return path.join(getPluginsDir(), "npix", name.replace("/", "__"));
}

/** Installs `file` (replacing an installed copy of the same version) and links it as a plugin. */
export async function installNpix(manager: PluginManager, file: string): Promise<InstalledPlugin> {
	assertNpix(file);
	await using temp = await TempDir.create("@npi-npix-install-");
	const unpacked = await unpack(path.resolve(file), temp.path());
	const info = await describePluginFolder(unpacked);
	const root = installRoot(info.name);
	const dest = path.join(root, info.version);
	// Earlier versions go: only the linked one is ever loaded.
	await fs.rm(root, { recursive: true, force: true });
	await fs.mkdir(root, { recursive: true });
	await fs.rename(unpacked, dest);
	return manager.link(dest);
}

/**
 * Where an installed plugin came from, for `plugin list --json`: `npix` when its folder is an unpacked
 * `.npix` copy, plus the `developer.json` it carries (any source may ship one; an invalid one is left out).
 */
export async function installedDetails(plugin: InstalledPlugin): Promise<{ npix: boolean; developer?: NpixDeveloper }> {
	let real = plugin.path;
	try {
		real = await fs.realpath(plugin.path);
	} catch {}
	const npixRoot = path.join(getPluginsDir(), "npix");
	let developer: NpixDeveloper | undefined;
	try {
		developer = await readDeveloper(real);
	} catch {}
	return { npix: pathIsWithin(npixRoot, real), ...(developer ? { developer } : {}) };
}

/** Removes the unpacked copies of `name` after `uninstall`; nothing happens for plugins not from `.npix`. */
export async function removeNpixInstall(name: string): Promise<void> {
	await fs.rm(installRoot(name), { recursive: true, force: true });
}

/** Packs plugin folder `dir` into `<name>-<version>.npix` (or `out`), after validating it. */
export async function packNpix(dir: string, out?: string): Promise<{ file: string; info: NpixInfo }> {
	const source = path.resolve(dir);
	const info = await describePluginFolder(source);
	const file = path.resolve(
		out ?? path.join(source, `${info.name.replace("@", "").replace("/", "-")}-${info.version}${NPIX_EXTENSION}`),
	);
	await using temp = await TempDir.create("@npi-npix-pack-");
	const staged = path.join(temp.path(), "package");
	await fs.cp(source, staged, {
		recursive: true,
		dereference: true,
		filter: from => {
			const rel = path.relative(source, from).split(path.sep).join("/");
			return !PACK_SKIP.has(rel) && !rel.endsWith(NPIX_EXTENSION) && path.basename(rel) !== ".DS_Store";
		},
	});
	const packed = await $`tar -czf ${file} -C ${temp.path()} package`.quiet().nothrow();
	if (packed.exitCode !== 0) throw new Error(`Couldn't write ${file}: ${packed.stderr.toString()}`);
	return { file, info };
}
