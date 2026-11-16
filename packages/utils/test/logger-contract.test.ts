import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const fixtureDir = path.join(import.meta.dir, "fixtures");
const probePath = path.join(fixtureDir, "logger-contract-probe.ts");
const fatalProbePath = path.join(fixtureDir, "logger-fatal-flush-probe.ts");
const preloadPath = path.join(fixtureDir, "logger-fixed-date-preload.ts");
const fixedNow = "2026-01-02T03:04:05.006Z";
const fixedTimestamp = "2026-01-01T22:04:05.006-05:00";
const roots: string[] = [];

interface ScenarioResult {
	readonly pid: number;
	readonly root: string;
	readonly primaryDir: string;
	readonly secondaryDir: string;
	readonly resultPath: string;
	readonly stdout: string;
	readonly stderr: string;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function runScenario(
	scenario: string,
	options: { logLevel?: string; probe?: string; exitCode?: number; testRuntime?: boolean } = {},
): Promise<ScenarioResult> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-logger-contract-"));
	roots.push(root);
	const primaryDir = path.join(root, "primary");
	const secondaryDir = path.join(root, "secondary");
	const resultPath = path.join(root, "result.json");
	const stdoutPath = path.join(root, "stdout.log");
	const tmpDir = path.join(root, "tmp");
	await Promise.all([fs.mkdir(primaryDir), fs.mkdir(secondaryDir), fs.mkdir(tmpDir)]);
	const proc = Bun.spawn(
		[
			process.execPath,
			"--preload",
			preloadPath,
			options.probe ?? probePath,
			scenario,
			primaryDir,
			secondaryDir,
			resultPath,
		],
		{
			cwd: path.resolve(import.meta.dir, "../../.."),
			env: {
				...process.env,
				HOME: primaryDir,
				// os.homedir() on Windows reads USERPROFILE, not HOME: without
				// this the default-file scenario logs into the real profile.
				USERPROFILE: primaryDir,
				PI_CONFIG_DIR: ".omp",
				OMP_PROFILE: "",
				PI_PROFILE: "",
				XDG_DATA_HOME: "",
				XDG_STATE_HOME: "",
				XDG_CACHE_HOME: "",
				// Empty XDG_CACHE_HOME makes Bun's transpiler cache path relative,
				// spewing bun/@t@/*.pile into the repo root (the child's cwd) — disable it.
				BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
				// os.tmpdir() reads TMPDIR on POSIX and TMP/TEMP on Windows.
				TMPDIR: tmpDir,
				TMP: tmpDir,
				TEMP: tmpDir,
				PI_TEST_RUNTIME: options.testRuntime ? "1" : "",
				OMP_LOGGER_TEST_NOW: fixedNow,
				OMP_LOG_LEVEL: options.logLevel ?? "",
				TZ: "Etc/GMT+5",
			},
			stdout: Bun.file(stdoutPath),
			stderr: "pipe",
		},
	);
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	expect(exitCode, stderr).toBe(options.exitCode ?? 0);
	const stdout = await fs.readFile(stdoutPath, "utf8");
	return { pid: proc.pid, root, primaryDir, secondaryDir, resultPath, stdout, stderr };
}

async function logFileNames(directory: string): Promise<string[]> {
	return (await fs.readdir(directory)).filter(name => /^omp\.\d{4}-\d{2}-\d{2}\.log$/.test(name)).sort();
}

async function readSingleLog(directory: string): Promise<{ name: string; text: string }> {
	const names = await logFileNames(directory);
	expect(names).toHaveLength(1);
	const name = names[0];
	if (!name) throw new Error("expected one log file");
	return { name, text: await fs.readFile(path.join(directory, name), "utf8") };
}

interface LogEntry {
	readonly level: string;
	readonly message: string;
}

async function readLogEntries(directory: string): Promise<LogEntry[]> {
	const lines = (await readSingleLog(directory)).text.split(os.EOL).filter(line => line.length > 0);
	return lines.map(line => {
		const entry: LogEntry = JSON.parse(line);
		return entry;
	});
}

function expectedLine(
	pid: number,
	level: "fatal" | "error" | "warn" | "info" | "debug",
	message: string,
	context: Record<string, unknown> = {},
	timestamp = fixedTimestamp,
): string {
	return `${JSON.stringify({ timestamp, level, pid, message, ...context })}${os.EOL}`;
}

describe("central logger byte contract", () => {
	test("keeps fatal, error and warn only, and pins metadata normalization, key order, timestamp, errors, pid, and EOL", async () => {
		const result = await runScenario("matrix");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		const log = await readSingleLog(result.primaryDir);
		expect(log.name).toBe("omp.2026-01-01.log");
		const expected = [
			expectedLine(result.pid, "error", "level-error", { ordinal: 1 }),
			expectedLine(result.pid, "warn", "level-warn", { ordinal: 2 }),
			expectedLine(result.pid, "fatal", "level-fatal", { ordinal: 5 }),
			expectedLine(result.pid, "warn", "context-matrix", {
				stringValue: "text",
				numberValue: 7,
				booleanValue: false,
				nullValue: null,
				nested: { alpha: "a", values: [1, null, null, null] },
				infinity: null,
				nan: null,
			}),
			expectedLine(result.pid, "warn", "reserved-primary metadata-message", { before: "first", after: "last" }),
			expectedLine(result.pid, "warn", "reserved-falsy", { after: true }),
			expectedLine(result.pid, "error", "error-matrix", {
				error: {
					name: "CustomError",
					message: "upstream",
					stack: "OUTER_STACK",
					code: "E_FIXTURE",
					detail: { retry: false },
					cause: { name: "Error", message: "downstream", stack: "CAUSE_STACK" },
				},
			}),
			expectedLine(result.pid, "error", "tojson-error", {
				wrapped: { err: { name: "Error", message: "wrapped", stack: "WRAPPED_STACK" } },
			}),
		].join("");
		expect(log.text).toBe(expected);
		expect(log.text.endsWith(os.EOL)).toBe(true);
		expect((await fs.readdir(result.primaryDir)).filter(name => name.endsWith("-audit.json"))).toEqual([]);
	});

	test("treats Winston format tokens as a splat branch and omits context", async () => {
		const result = await runScenario("format-tokens");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		const tokenMessages = [
			"token-%s",
			"token-%c",
			"token-%d",
			"token-%j",
			"token-%i",
			"token-%f",
			"token-%o",
			"token-%O",
			"token-%%",
		];
		const expected = [
			...tokenMessages.map(message => expectedLine(result.pid, "warn", message)),
			expectedLine(result.pid, "warn", "non-token-%q", { value: 7 }),
			expectedLine(result.pid, "warn", "circular-%s"),
			expectedLine(result.pid, "warn", "bigint-%d"),
		].join("");
		expect((await readSingleLog(result.primaryDir)).text).toBe(expected);
	});

	test("stamps each record with its own async context, read live, which call fields override", async () => {
		const result = await runScenario("context");
		expect(result.stderr).toBe("");
		const expected = [
			expectedLine(result.pid, "warn", "parent-start", { sessionId: "parent" }),
			expectedLine(result.pid, "warn", "outside"),
			expectedLine(result.pid, "warn", "parent-after-timer", { sessionId: "parent-rekeyed" }),
			expectedLine(result.pid, "warn", "explicit-wins", { sessionId: "explicit" }),
			expectedLine(result.pid, "warn", "shared-service"),
			expectedLine(result.pid, "warn", "child-nested", { sessionId: "grandchild", ordinal: 1 }),
			expectedLine(result.pid, "warn", "reserved-kept", { sessionId: "reserved" }),
			expectedLine(result.pid, "warn", "to-sink", { sessionId: "sink", turn: 2 }),
			expectedLine(result.pid, "warn", "to-sink-outside"),
		].join("");
		expect((await readSingleLog(result.primaryDir)).text).toBe(expected);
		const payload = JSON.parse(await fs.readFile(result.resultPath, "utf8")) as { sinkContexts: unknown[] };
		// The throwing getter drops that record from the file; its sink still gets the call's own fields.
		expect(payload.sinkContexts).toEqual([{ sessionId: "sink", turn: 2 }, null, { kept: true }]);
	});

	test("drops native JSON failures locally but sends original contexts to sinks", async () => {
		const result = await runScenario("serialization-failures");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		// Nothing serialized, so the lazily created file never appears.
		expect(await logFileNames(result.primaryDir)).toEqual([]);
		const payload = JSON.parse(await fs.readFile(result.resultPath, "utf8")) as {
			events: Array<{ level: string; message: string; sameContext: boolean; timestamp: string }>;
		};
		expect(payload.events).toEqual([
			{ level: "info", message: "circular-drop", sameContext: true, timestamp: fixedNow },
			{ level: "error", message: "bigint-drop", sameContext: true, timestamp: fixedNow },
		]);
	});
});

describe("central logger file level and batching", () => {
	test("drops debug and info records: no file appears for them", async () => {
		const result = await runScenario("debug-only");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		expect(await logFileNames(result.primaryDir)).toEqual([]);
	});

	test("OMP_LOG_LEVEL=error narrows to error and fatal; debug never widens past warn", async () => {
		const narrowed = await runScenario("matrix", { logLevel: "ERROR" });
		expect((await readLogEntries(narrowed.primaryDir)).map(entry => entry.message)).toEqual([
			"level-error",
			"level-fatal",
			"error-matrix",
			"tojson-error",
		]);
		const widened = await runScenario("matrix", { logLevel: "debug" });
		expect((await readLogEntries(widened.primaryDir)).map(entry => entry.level)).not.toContain("debug");
	});

	test("the fatal record lands after the buffered records that preceded it", async () => {
		const result = await runScenario("uncaught", { probe: fatalProbePath, exitCode: 1 });
		expect((await readLogEntries(result.primaryDir)).map(entry => [entry.level, entry.message])).toEqual([
			["warn", "before-crash-warn"],
			["fatal", "Uncaught exception"],
		]);
	});

	test("a hard exit through exitProcess writes the buffered records", async () => {
		const result = await runScenario("exit-process", { probe: fatalProbePath, exitCode: 3 });
		expect((await readLogEntries(result.primaryDir)).map(entry => [entry.level, entry.message])).toEqual([
			["warn", "before-exit-warn"],
		]);
	});
});

describe("central logger transport lifecycle", () => {
	test("defaults to file-only without touching stdout or stderr", async () => {
		const result = await runScenario("default-file");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		const defaultLogsDir = path.join(result.primaryDir, ".omp", "logs");
		const log = await readSingleLog(defaultLogsDir);
		expect(log.text).toBe(expectedLine(result.pid, "warn", "mode-default", { mode: "default" }));
	});

	test("a test process writes its default-file records under the temp dir, never the real logs dir", async () => {
		const result = await runScenario("default-file", { testRuntime: true });
		expect(result.stderr).toBe("");
		// The child's HOME stays empty: no ~/.omp/logs was created.
		expect(await fs.readdir(result.primaryDir)).toEqual([]);
		// Named per user, so users of a shared /tmp never share it.
		const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().username;
		const testLogsDir = path.join(result.root, "tmp", `omp-test-logs-${uid}`);
		const log = await readSingleLog(testLogsDir);
		expect(log.text).toBe(expectedLine(result.pid, "warn", "mode-default", { mode: "default" }));
		// Log readers (report bundles, the stderr guard) resolve the same file.
		const { logPath } = JSON.parse(await fs.readFile(result.resultPath, "utf8"));
		expect(logPath).toBe(path.join(testLogsDir, log.name));
	});

	test("emits file-only, console-only, and dual modes exactly once", async () => {
		const fileOnly = await runScenario("file-only");
		const fileLine = expectedLine(fileOnly.pid, "warn", "mode-file", { mode: "file" });
		expect(fileOnly.stdout).toBe("");
		expect(fileOnly.stderr).toBe("");
		expect((await readSingleLog(fileOnly.primaryDir)).text).toBe(fileLine);

		const consoleOnly = await runScenario("console-only");
		const consoleLine = expectedLine(consoleOnly.pid, "warn", "mode-console", { mode: "console" });
		expect(consoleOnly.stdout).toBe(consoleLine);
		expect(consoleOnly.stderr).toBe("");
		expect(await logFileNames(consoleOnly.primaryDir)).toEqual([]);

		const both = await runScenario("both");
		const bothLine = expectedLine(both.pid, "warn", "mode-both", { mode: "both" });
		expect(both.stdout).toBe(bothLine);
		expect(both.stderr).toBe("");
		expect((await readSingleLog(both.primaryDir)).text).toBe(bothLine);
	});

	test("keeps disabled mode silent, sends sinks, preserves void returns, and re-enables", async () => {
		const result = await runScenario("disabled-reenable");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		expect((await readSingleLog(result.primaryDir)).text).toBe(
			expectedLine(result.pid, "warn", "mode-reenabled", { mode: "file" }),
		);
		const payload = JSON.parse(await fs.readFile(result.resultPath, "utf8")) as {
			disabledSinkSameContext: boolean;
			sinkCount: number;
			returnsUndefined: boolean;
		};
		expect(payload).toEqual({ disabledSinkSameContext: true, sinkCount: 2, returnsUndefined: true });
	});

	test("closes A before reconfiguring to B and never cross-writes", async () => {
		const result = await runScenario("reconfigure");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		expect((await readSingleLog(result.primaryDir)).text).toBe(
			expectedLine(result.pid, "warn", "directory-a", { destination: "a" }),
		);
		expect((await readSingleLog(result.secondaryDir)).text).toBe(
			expectedLine(result.pid, "warn", "directory-b", { destination: "b" }),
		);
	});

	test("invalidates closed transports when warm replacement construction fails", async () => {
		const result = await runScenario("reconfigure-failure");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		expect((await readSingleLog(result.primaryDir)).text).toBe(
			expectedLine(result.pid, "warn", "before-failed-reconfigure"),
		);
		expect(await logFileNames(result.secondaryDir)).toEqual([]);
		const payload = JSON.parse(await fs.readFile(result.resultPath, "utf8")) as {
			reconfigureThrew: boolean;
			sinkCount: number;
			sinkSameContext: boolean;
		};
		expect(payload).toEqual({ reconfigureThrew: true, sinkCount: 1, sinkSameContext: true });
	});

	// Two sequential probe children writing 1000 records each measure ~4.4 s
	// on an unloaded runner — bun's 5 s default test timeout SIGTERMed the
	// probe (exit 143) whenever CI runners shared cores. The contract is
	// order + drain, not latency; give it an explicit budget.
	test("preserves burst order and drains on close and natural child exit", async () => {
		for (const scenario of ["burst-close", "burst-natural"] as const) {
			const result = await runScenario(scenario);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			const text = (await readSingleLog(result.primaryDir)).text;
			expect(text.endsWith(os.EOL)).toBe(true);
			const lines = text.split(os.EOL);
			expect(lines.pop()).toBe("");
			expect(lines).toHaveLength(1_000);
			for (const [index, line] of lines.entries()) {
				const entry = JSON.parse(line) as { message: string; index: number };
				expect(entry).toMatchObject({ message: scenario, index });
			}
		}
	}, 30_000);

	test("runs local console output before sinks and isolates throwing or disposed sinks", async () => {
		const result = await runScenario("sink-order");
		const first = expectedLine(result.pid, "warn", "sink-first", { identity: "same" });
		const second = expectedLine(result.pid, "warn", "sink-disposed");
		expect(result.stdout).toBe(`${first}SINK:true\n${second}`);
		expect(result.stderr).toBe("");
	});
});

describe("daily file and retention contract", () => {
	test("writes one shared file per local day, named without a PID", async () => {
		const result = await runScenario("date-retention");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		// 03:04 UTC is 22:04 of the previous day in the probe's UTC-5 zone.
		const expectedNames = [1, 2, 3, 4, 5, 6].map(day => `omp.2026-01-0${day}.log`);
		expect(await logFileNames(result.primaryDir)).toEqual(expectedNames);
		for (const [offset, name] of expectedNames.entries()) {
			const day = offset + 1;
			const timestamp = `2026-01-0${day}T22:04:05.006-05:00`;
			expect(await fs.readFile(path.join(result.primaryDir, name), "utf8")).toBe(
				expectedLine(result.pid, "warn", `date-${offset + 1}`, {}, timestamp),
			);
		}
	});

	test("keeps five days and live processes' old files, removing older days and dead processes' files", async () => {
		const result = await runScenario("prune");
		expect(result.stderr).toBe("");
		expect((await fs.readdir(result.primaryDir)).sort()).toEqual(
			["notes.txt", "omp.2025-12-28.log", "omp.2026-01-01.log", `omp.2026-01-01.${result.pid}.log`].sort(),
		);
	});

	test("never rolls a day's file by size", async () => {
		const result = await runScenario("size-rotation");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		expect(await logFileNames(result.primaryDir)).toEqual(["omp.2026-01-01.log"]);
		const entries = await readLogEntries(result.primaryDir);
		expect(entries.map(entry => entry.message)).toEqual([
			"size-nine-mib",
			"size-half-mib",
			"size-crosses-ten-mib",
			"rotation-trigger",
		]);
	});
});
