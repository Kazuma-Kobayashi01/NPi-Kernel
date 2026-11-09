#!/usr/bin/env bun
/**
 * Assemble `npi-<version>-linux-x64.run`, a self-extracting per-user installer
 * for the compiled Linux binary, its pinned Python runtime and a pinned Chrome
 * for Testing. The installer needs no root: it installs into `~/.local/opt/npi`
 * and links `~/.local/bin/npi`; user data in `~/.local/share/npi` and
 * `~/.cache/npi` is never touched.
 *
 * Usage: bun scripts/build-linux-run.ts [--out <dir>]
 *
 * Prerequisites (build them first):
 *   CROSS_TARGET=linux-x64 bun --cwd=packages/coding-agent run build
 *   bun scripts/build-linux-python-runtime.ts x64
 *
 * Layout inside the payload (`<prefix>`):
 *   bin/npi
 *   lib/npi/python-runtime-*.tar.gz, python-runtime-manifest.json   (Python host resources)
 *   lib/npi/chrome-linux64/chrome                                    (browser tool, see launch.ts)
 *   uninstall.sh, LICENSE
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";

const repoRoot = path.join(import.meta.dir, "..");
const binary = path.join(repoRoot, "packages", "coding-agent", "dist", "npi-linux-x64");
const runtimeDir = path.join(repoRoot, "dist", "linux-python-runtime");
const cacheDir = path.join(repoRoot, "dist", "linux-chrome");

/** Must equal puppeteer-core's `PUPPETEER_REVISIONS.chrome`, the build the browser tool is written against. */
const CHROME_BUILD = "150.0.7871.24";
const CHROME_SHA256 = "e0dd5721ae87fc74322b370e74f815c146357ebe42af176f8eee3f788b2ec01d";
const CHROME_URL = `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_BUILD}/linux64/chrome-linux64.zip`;

/** Shared libraries Chrome needs on a clean Ubuntu 22.04/24.04 (verified with ldd). */
const CHROME_APT_PACKAGES =
	"libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 libasound2 libgbm1 libcairo2 " +
	"libpango-1.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libatspi2.0-0";

const UNINSTALL = `#!/bin/sh
# Remove this npi installation. User data (~/.local/share/npi, ~/.cache/npi) is kept.
set -eu
PREFIX=$(cd "$(dirname "$0")" && pwd)
BIN_DIR="\${BIN_DIR:-$HOME/.local/bin}"
if [ -L "$BIN_DIR/npi" ] && [ "$(readlink "$BIN_DIR/npi")" = "$PREFIX/bin/npi" ]; then rm -f "$BIN_DIR/npi"; fi
rm -rf "$PREFIX"
echo "npi removed from $PREFIX. User data in ~/.local/share/npi and ~/.cache/npi was kept."
`;

const HEADER = `#!/bin/sh
# NPi __VERSION__ installer for Linux x64 (glibc >= 2.17). Installs for the current user; no root needed.
# Usage: sh npi-__VERSION__-linux-x64.run [--prefix DIR] [--bin-dir DIR] [--uninstall]
# Defaults: --prefix ~/.local/opt/npi  --bin-dir ~/.local/bin   (re-running upgrades in place)
set -eu
VERSION="__VERSION__"
PAYLOAD_SHA256="__SHA__"
SKIP=__SKIP__
PREFIX="$HOME/.local/opt/npi"
BIN_DIR="$HOME/.local/bin"
MODE=install
while [ $# -gt 0 ]; do
	case "$1" in
	--prefix) PREFIX=$2; shift 2 ;;
	--bin-dir) BIN_DIR=$2; shift 2 ;;
	--uninstall) MODE=uninstall; shift ;;
	-h | --help) sed -n '2,4p' "$0"; exit 0 ;;
	*) echo "unknown option: $1" >&2; exit 2 ;;
	esac
done
if [ "$MODE" = uninstall ]; then
	[ -f "$PREFIX/uninstall.sh" ] || { echo "no npi installation at $PREFIX" >&2; exit 1; }
	BIN_DIR="$BIN_DIR" sh "$PREFIX/uninstall.sh"
	exit 0
fi
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || { echo "This installer is for Linux x86_64 only." >&2; exit 1; }
for tool in tail xz tar sha256sum; do
	command -v "$tool" >/dev/null 2>&1 || { echo "missing required tool: $tool" >&2; exit 1; }
done
echo "Verifying installer..."
actual=$(tail -n +"$SKIP" "$0" | sha256sum | cut -d' ' -f1)
[ "$actual" = "$PAYLOAD_SHA256" ] || { echo "Checksum mismatch: the installer is corrupted or incomplete." >&2; exit 1; }
STAGE="$PREFIX.new.$$"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE"
echo "Extracting to $PREFIX ..."
tail -n +"$SKIP" "$0" | xz -dc | tar -x -C "$STAGE"
if [ -e "$PREFIX" ]; then mv "$PREFIX" "$PREFIX.old.$$"; fi
mv "$STAGE" "$PREFIX"
rm -rf "$PREFIX.old.$$"
mkdir -p "$BIN_DIR"
ln -sfn "$PREFIX/bin/npi" "$BIN_DIR/npi"
echo "Installed npi $VERSION: $BIN_DIR/npi -> $PREFIX/bin/npi"
missing=$(ldd "$PREFIX/lib/npi/chrome-linux64/chrome" 2>/dev/null | sed -n 's/^[[:space:]]*\\(.*\\) => not found/\\1/p' | tr '\\n' ' ')
if [ -n "$missing" ]; then
	echo
	echo "The browser tool needs system libraries that are not installed yet:"
	echo "  $missing"
	echo "On Ubuntu/Debian install them with:"
	echo "  sudo apt install __APT__"
	echo "(Ubuntu 24.04 names libasound2 as libasound2t64.) Everything else works without them."
fi
case ":$PATH:" in
*":$BIN_DIR:"*) ;;
*) echo; echo "Add $BIN_DIR to your PATH to run 'npi' directly." ;;
esac
exit 0
__PAYLOAD_BELOW__
`;

async function run(command: string[]): Promise<void> {
	const proc = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
	if ((await proc.exited) !== 0) throw new Error(`Command failed: ${command.join(" ")}`);
}

async function sha256(file: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(file).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

async function ensureChromeZip(): Promise<string> {
	const { PUPPETEER_REVISIONS } = await import("puppeteer-core/internal/revisions.js");
	if (PUPPETEER_REVISIONS.chrome !== CHROME_BUILD) {
		throw new Error(`puppeteer-core expects Chrome ${PUPPETEER_REVISIONS.chrome}; update CHROME_BUILD and CHROME_SHA256 here.`);
	}
	const zip = path.join(cacheDir, `chrome-linux64-${CHROME_BUILD}.zip`);
	if (!(await Bun.file(zip).exists()) || (await sha256(zip)) !== CHROME_SHA256) {
		await fs.mkdir(cacheDir, { recursive: true });
		const response = await fetch(CHROME_URL);
		if (!response.ok) throw new Error(`Download failed (${response.status}): ${CHROME_URL}`);
		await Bun.write(zip, response);
		const actual = await sha256(zip);
		if (actual !== CHROME_SHA256) throw new Error(`SHA-256 mismatch for ${CHROME_URL}: ${actual}`);
	}
	return zip;
}

async function main(): Promise<void> {
	const args = Bun.argv.slice(2);
	const outIndex = args.indexOf("--out");
	const outDir = path.resolve(outIndex >= 0 ? (args[outIndex + 1] ?? "") : path.join(repoRoot, "dist", "run"));
	const manifest = JSON.parse(await Bun.file(path.join(runtimeDir, "python-runtime-manifest.json")).text()) as {
		archiveName: string;
	};
	const chromeZip = await ensureChromeZip();

	const work = await fs.mkdtemp(path.join(os.tmpdir(), "npi-run-"));
	try {
		const stage = path.join(work, "stage");
		const lib = path.join(stage, "lib", "npi");
		await fs.mkdir(path.join(stage, "bin"), { recursive: true });
		await fs.mkdir(lib, { recursive: true });
		await fs.copyFile(binary, path.join(stage, "bin", "npi"));
		await fs.chmod(path.join(stage, "bin", "npi"), 0o755);
		for (const name of [manifest.archiveName, "python-runtime-manifest.json"]) {
			await fs.copyFile(path.join(runtimeDir, name), path.join(lib, name));
		}
		await run(["unzip", "-q", chromeZip, "-d", lib]);
		await fs.copyFile(path.join(repoRoot, "LICENSE"), path.join(stage, "LICENSE"));
		await Bun.write(path.join(stage, "uninstall.sh"), UNINSTALL);
		await fs.chmod(path.join(stage, "uninstall.sh"), 0o755);

		const payload = path.join(work, "payload.tar.xz");
		await run(["sh", "-c", `COPYFILE_DISABLE=1 tar -C "${stage}" -cf - . | xz -T0 -6 > "${payload}"`]);
		const header = HEADER.replace(/__VERSION__/g, VERSION)
			.replace("__SHA__", await sha256(payload))
			.replace("__APT__", CHROME_APT_PACKAGES);
		const skip = header.split("\n").length; // header ends with a newline, so payload starts on the next line
		const finalHeader = header.replace("__SKIP__", String(skip));
		const headerFile = path.join(work, "header.sh");
		await Bun.write(headerFile, finalHeader);

		await fs.mkdir(outDir, { recursive: true });
		const name = `npi-${VERSION}-linux-x64.run`;
		const out = path.join(outDir, name);
		await run(["sh", "-c", `cat "${headerFile}" "${payload}" > "${out}"`]);
		await fs.chmod(out, 0o755);
		const digest = await sha256(out);
		await Bun.write(`${out}.sha256`, `${digest}  ${name}\n`);
		process.stdout.write(`${out}\n${digest} ${(await fs.stat(out)).size}\n`);
	} finally {
		await fs.rm(work, { recursive: true, force: true });
	}
}

await main();
