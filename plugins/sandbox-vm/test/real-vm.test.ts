/**
 * Against a real VM: the Swift helper, the guest image and the command agent. Skipped unless both the helper
 * (`helper/build.sh`) and the image (`scripts/build-image.sh`, or NPI_VM_IMAGE_DIR) are there.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecBackendResult } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { Shell } from "@oh-my-pi/pi-natives";
import { defaultImageDir, DEFAULT_CONFIG } from "../src/config";
import { BACKEND_NAME, VmController } from "../src/vm-controller";

const HELPER = path.join(import.meta.dir, "..", "bin", "npi-vm-helper");
const IMAGE = process.env.NPI_VM_IMAGE_DIR ?? defaultImageDir();
const ready =
	fs.existsSync(HELPER) &&
	fs.existsSync(path.join(IMAGE, "Image")) &&
	fs.existsSync(path.join(IMAGE, "rootfs.cpio.gz"));

const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-vm-project-")));
const readOnlyDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-vm-ro-")));

const controller = new VmController({
	loadConfig: async () => ({ ...DEFAULT_CONFIG, image: IMAGE, readOnlyMounts: [readOnlyDir] }),
	helperCommand: async () => [HELPER],
});
controller.setProjectDir(project);

interface Outcome {
	output: string;
	result: ExecBackendResult;
}

async function run(
	command: string,
	options: { sessionKey?: string; signal?: AbortSignal; timeoutMs?: number; cwd?: string } = {},
): Promise<Outcome> {
	let output = "";
	const result = await controller.backend.run(command, {
		cwd: options.cwd ?? project,
		env: {},
		timeoutMs: options.timeoutMs,
		signal: options.signal ?? new AbortController().signal,
		sessionKey: options.sessionKey,
		onChunk: chunk => {
			output += chunk;
		},
	});
	return { output, result };
}

describe.skipIf(!ready)("sandbox VM (real guest)", () => {
	beforeAll(async () => {
		const started = performance.now();
		await controller.start();
		console.log(`VM up in ${Math.round(performance.now() - started)} ms`);
	}, 120_000);

	afterAll(async () => {
		await controller.stop();
		fs.rmSync(project, { recursive: true, force: true });
		fs.rmSync(readOnlyDir, { recursive: true, force: true });
	}, 60_000);

	it("runs commands in an aarch64 Linux guest and reports their exit status", async () => {
		const { output, result } = await run("uname -sm; echo to-stderr >&2; exit 4");
		expect(output).toContain("Linux aarch64");
		expect(output).toContain("to-stderr");
		expect(result).toMatchObject({ exitCode: 4 });
	});

	it("sees the project at the same path, read-write, and extra folders read-only", async () => {
		fs.writeFileSync(path.join(project, "from-host.txt"), "host says hi\n");
		fs.writeFileSync(path.join(readOnlyDir, "ro.txt"), "read only\n");

		const here = await run("pwd; cat from-host.txt; echo guest-wrote > from-guest.txt");
		expect(here.output).toBe(`${project}\nhost says hi\n`);
		expect(fs.readFileSync(path.join(project, "from-guest.txt"), "utf8")).toBe("guest-wrote\n");

		const readOnly = await run(`cat ${readOnlyDir}/ro.txt; echo nope > ${readOnlyDir}/new.txt`);
		expect(readOnly.output).toContain("read only");
		expect(readOnly.result.exitCode).not.toBe(0);
		expect(fs.existsSync(path.join(readOnlyDir, "new.txt"))).toBe(false);
	});

	it("keeps exported variables and functions between commands of one session, and only of that session", async () => {
		await run('export GREETING=hello; shout() { echo "$GREETING $1"; }', { sessionKey: "s1" });
		const same = await run("shout world", { sessionKey: "s1" });
		const other = await run("echo [$GREETING]", { sessionKey: "s2" });

		expect(same.output).toBe("hello world\n");
		expect(other.output).toBe("[]\n");
	});

	it("has no network device unless asked for one", async () => {
		const { output } = await run("ls /sys/class/net");
		expect(output.trim()).toBe("lo");
	});

	it("has the developer tools the image promises", async () => {
		const { output, result } = await run(
			"git init -q . && git status --short | head -1; python3 -c 'print(6*7)'; bash --version | head -1; rg --version | head -1; curl --version | head -1",
		);
		expect(result).toMatchObject({ exitCode: 0 });
		expect(output).toContain("42");
		expect(output).toMatch(/GNU bash/);
		expect(output).toMatch(/ripgrep/);
		expect(output).toMatch(/curl/);
	});

	it("stops a running command when the call is aborted, and the process is gone", async () => {
		const abort = new AbortController();
		const pending = run("sleep 120", { signal: abort.signal });
		await Bun.sleep(300);
		const started = performance.now();
		abort.abort();
		const { result } = await pending;
		expect(result.cancelled).toBe(true);
		expect(performance.now() - started).toBeLessThan(5_000);

		const left = await run("ps | grep -c '[s]leep 120'; true");
		expect(left.output.trim()).toBe("0");
	});

	it("ends a command that outlives its timeout", async () => {
		const { result } = await run("sleep 120", { timeoutMs: 1_000 });
		expect(result.timedOut).toBe(true);
	});

	it("runs several commands at once", async () => {
		const [a, b] = await Promise.all([run("sleep 1; echo a"), run("echo b")]);
		expect(a.output).toBe("a\n");
		expect(b.output).toBe("b\n");
	});

	it("serves the bash tool: the command runs in the guest, never in the host shell", async () => {
		const hostRun = spyOn(Shell.prototype, "run");
		const session = {
			cwd: project,
			hasUI: false,
			skills: [],
			getSessionFile: () => null,
			settings: Settings.isolated({
				"exec.backend": BACKEND_NAME,
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
				"astGrep.enabled": false,
				"astEdit.enabled": false,
				"grep.enabled": false,
				"glob.enabled": false,
			}),
			getClientBridge: () => undefined,
			getExecBackend: (name: string) => (name === BACKEND_NAME ? { ...controller.backend, name } : undefined),
		} as unknown as ToolSession;

		const result = await new BashTool(session).execute("call-vm", {
			command: "uname -m && pwd && echo made-by-the-tool > tool.txt",
		});

		const text = result.content.find(block => block.type === "text")?.text ?? "";
		expect(text).toContain("aarch64");
		expect(text).toContain(project);
		expect(fs.readFileSync(path.join(project, "tool.txt"), "utf8")).toBe("made-by-the-tool\n");
		expect(hostRun).not.toHaveBeenCalled();
	});
});
