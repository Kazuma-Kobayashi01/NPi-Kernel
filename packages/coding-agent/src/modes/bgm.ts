import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which, isEnoent, logger } from "@oh-my-pi/pi-utils";

/**
 * Background music for the interactive TUI: loops the `.mp3` files under
 * `<agentDir>/bgm/` (user-supplied, never part of the repo) through the
 * platform's command-line player. Armed only by the interactive entrypoint, so
 * RPC, print and render hosts stay silent even when they share settings.
 */

/** Folder under the agent dir that holds the tracks. */
export const BGM_DIR_NAME = "bgm";

interface Player {
	bin: string;
	args: (file: string) => string[];
}

interface BgmState {
	dir: string;
	enabled: boolean;
	child: Bun.Subprocess | undefined;
	generation: number;
}

let state: BgmState | undefined;
let exitHookInstalled = false;

function resolvePlayer(): Player | undefined {
	if (process.platform === "darwin") {
		const bin = $which("afplay");
		return bin ? { bin, args: file => [file] } : undefined;
	}
	const ffplay = $which("ffplay");
	if (ffplay) return { bin: ffplay, args: file => ["-nodisp", "-autoexit", "-loglevel", "quiet", file] };
	const mpg123 = $which("mpg123");
	if (mpg123) return { bin: mpg123, args: file => ["-q", file] };
	return undefined;
}

/** `.mp3` files in `dir`, sorted by name; `[]` when the folder is missing. */
export async function listBgmTracks(dir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		return entries
			.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".mp3"))
			.map(entry => path.join(dir, entry.name))
			.sort((left, right) => left.localeCompare(right));
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}

function killChild(): void {
	const child = state?.child;
	if (!child) return;
	state!.child = undefined;
	try {
		child.kill();
	} catch {
		// Already gone.
	}
}

async function playLoop(generation: number): Promise<void> {
	const current = state;
	if (!current) return;
	const player = resolvePlayer();
	if (!player) {
		logger.debug("BGM: no command-line audio player found");
		return;
	}
	const tracks = await listBgmTracks(current.dir);
	if (tracks.length === 0) {
		logger.debug("BGM: no .mp3 tracks", { dir: current.dir });
		return;
	}
	for (let index = 0; state?.enabled && state.generation === generation; index = (index + 1) % tracks.length) {
		const track = tracks[index]!;
		const startedAt = performance.now();
		const child = Bun.spawn([player.bin, ...player.args(track)], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		child.unref();
		state.child = child;
		const code = await child.exited;
		if (state?.child === child) state.child = undefined;
		// A player that dies at once (bad file, no audio device) would spin; stop instead.
		if (code !== 0 && performance.now() - startedAt < 1000) {
			logger.debug("BGM: player exited early", { track, code });
			return;
		}
	}
}

/**
 * Arm BGM for this process and start playing when `enabled`. Call once from
 * the interactive entrypoint, after the welcome is on screen.
 */
export function startBgm(agentDir: string, enabled: boolean): void {
	state ??= { dir: path.join(agentDir, BGM_DIR_NAME), enabled: false, child: undefined, generation: 0 };
	if (!exitHookInstalled) {
		exitHookInstalled = true;
		process.once("exit", killChild);
	}
	setBgmEnabled(enabled);
}

/** Follow the settings toggle live. A no-op until {@link startBgm} armed BGM. */
export function setBgmEnabled(enabled: boolean): void {
	if (!state || state.enabled === enabled) return;
	state.enabled = enabled;
	state.generation++;
	killChild();
	if (enabled) {
		playLoop(state.generation).catch(error => logger.warn("BGM playback failed", { error: String(error) }));
	}
}

/** Stop playback and disarm; used on shutdown. */
export function stopBgm(): void {
	if (!state) return;
	state.enabled = false;
	state.generation++;
	killChild();
}
