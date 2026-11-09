#!/usr/bin/env bun
/**
 * Build the Python runtime archive and manifest the Linux deb ships next to the
 * npi binary (consumed by `packages/coding-agent/src/eval/py/linux-host.ts`).
 *
 * Usage: bun scripts/build-linux-python-runtime.ts [x64] [--out <dir>]
 *
 * Upstream artifacts are pinned by SHA-256; there is no unverified download
 * path. The archive has one top-level `python/` directory (CPython
 * install_only layout plus `bin/uv`), matching the desktop bundle contract.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const PBS_RELEASE = "20261026";
const PYTHON_VERSION = "3.12.16";
const UV_VERSION = "0.13.6";

interface Pins {
	platform: string;
	cpythonSha256: string;
	uvSha256: string;
}

const TARGETS: Record<string, Pins> = {
	x64: {
		platform: "x86_64-unknown-linux-gnu",
		cpythonSha256: "6a79e922e50006b601f29e688407659da1c2b86ebcd4e9c7254cf234be8b89de",
		uvSha256: "f29c3e94ffabd7e6f3ba521dba169a9b7ec12100bf3257087f0f24f6123f3645",
	},
};

async function run(command: string[], cwd?: string): Promise<void> {
	const proc = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
	if ((await proc.exited) !== 0) throw new Error(`Command failed: ${command.join(" ")}`);
}

async function sha256(file: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(file).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

async function download(url: string, dest: string, expected: string): Promise<void> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
	await Bun.write(dest, response);
	const actual = await sha256(dest);
	if (actual !== expected) throw new Error(`SHA-256 mismatch for ${url}: ${actual} != ${expected}`);
}

async function main(): Promise<void> {
	const args = Bun.argv.slice(2);
	const outIndex = args.indexOf("--out");
	const outDir = path.resolve(outIndex >= 0 ? (args[outIndex + 1] ?? "") : "dist/linux-python-runtime");
	const targetName = args.find((arg, i) => !arg.startsWith("--") && i !== outIndex + 1) ?? "x64";
	const pins = TARGETS[targetName];
	if (!pins) throw new Error(`Unknown target ${targetName}; supported: ${Object.keys(TARGETS).join(", ")}`);

	const work = await fs.mkdtemp(path.join(os.tmpdir(), "npi-pyrt-"));
	try {
		const cpythonName = `cpython-${PYTHON_VERSION}+${PBS_RELEASE}-${pins.platform}-install_only`;
		const cpythonUrl = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${cpythonName}.tar.gz`;
		const uvName = `uv-${pins.platform}`;
		const uvUrl = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${uvName}.tar.gz`;
		await download(cpythonUrl, path.join(work, "cpython.tar.gz"), pins.cpythonSha256);
		await download(uvUrl, path.join(work, "uv.tar.gz"), pins.uvSha256);

		const stage = path.join(work, "stage");
		await fs.mkdir(path.join(work, "uv"), { recursive: true });
		await fs.mkdir(stage);
		await run(["tar", "-xzf", path.join(work, "cpython.tar.gz"), "-C", stage]);
		await run(["tar", "-xzf", path.join(work, "uv.tar.gz"), "-C", path.join(work, "uv"), "--strip-components=1"]);
		const python = path.join(stage, "python");
		await fs.copyFile(path.join(work, "uv", "uv"), path.join(python, "bin", "uv"));
		await fs.chmod(path.join(python, "bin", "uv"), 0o755);
		await fs.mkdir(path.join(python, "licenses"), { recursive: true });
		await Bun.write(
			path.join(python, "licenses", "THIRD-PARTY-NOTICES.txt"),
			`CPython ${PYTHON_VERSION} (PSF-2.0), python-build-standalone ${PBS_RELEASE}: ${cpythonUrl}\n` +
				`uv ${UV_VERSION} (Apache-2.0 OR MIT): ${uvUrl}\n` +
				`CPython's own LICENSE text is in lib/python3.12/LICENSE.txt.\n`,
		);

		const archiveName = `python-runtime-${PYTHON_VERSION}-${pins.platform}.tar.gz`;
		await fs.mkdir(outDir, { recursive: true });
		const archive = path.join(outDir, archiveName);
		await run(["tar", "-czf", archive, "-C", stage, "python"]);
		const manifest = {
			runtimeVersion: PYTHON_VERSION,
			platform: pins.platform,
			archiveName,
			archiveSha256: await sha256(archive),
			archiveSize: (await fs.stat(archive)).size,
			uvVersion: UV_VERSION,
			cpythonBuild: cpythonName,
			components: ["cpython", "stdlib", "pip", "uv"],
			upstream: {
				cpython: { url: cpythonUrl, sha256: pins.cpythonSha256, license: "PSF-2.0" },
				uv: { version: UV_VERSION, url: uvUrl, sha256: pins.uvSha256, license: ["Apache-2.0", "MIT"] },
			},
		};
		await Bun.write(path.join(outDir, "python-runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
		process.stdout.write(`${archive}\n${manifest.archiveSha256} ${manifest.archiveSize}\n`);
	} finally {
		await fs.rm(work, { recursive: true, force: true });
	}
}

await main();
