import * as fs from "node:fs";
import * as path from "node:path";
import { getLogPath } from "../../src/dirs";
import * as logger from "../../src/logger";

const scenario = process.argv[2];
const primaryDir = process.argv[3];
const secondaryDir = process.argv[4];
const resultPath = process.argv[5];

if (!scenario || !primaryDir || !secondaryDir || !resultPath) {
	throw new Error("expected scenario, primary directory, secondary directory, and result path");
}

function disableTransports(): void {
	logger.setTransports({ console: false, file: false });
}

function writeResult(value: unknown): void {
	fs.writeFileSync(resultPath, JSON.stringify(value));
}

switch (scenario) {
	case "matrix": {
		logger.setTransports({ console: false, file: primaryDir });
		logger.error("level-error", { ordinal: 1 });
		logger.warn("level-warn", { ordinal: 2 });
		logger.info("level-info", { ordinal: 3 });
		logger.debug("level-debug", { ordinal: 4 });
		logger.fatal("level-fatal", { ordinal: 5 });

		const hidden = Symbol("hidden");
		const context: Record<string, unknown> & { [hidden]?: unknown } = {
			stringValue: "text",
			numberValue: 7,
			booleanValue: false,
			nullValue: null,
			nested: { alpha: "a", values: [1, undefined, () => "omitted", Number.NaN] },
			undefinedValue: undefined,
			functionValue: () => "omitted",
			infinity: Number.POSITIVE_INFINITY,
			nan: Number.NaN,
		};
		context[hidden] = "omitted";
		logger.warn("context-matrix", context);
		logger.warn("reserved-primary", {
			before: "first",
			message: "metadata-message",
			level: "context-level",
			timestamp: "context-timestamp",
			after: "last",
		});
		logger.warn("reserved-falsy", { message: "", after: true });

		const cause = new Error("downstream");
		cause.stack = "CAUSE_STACK";
		const error = new Error("upstream", { cause }) as Error & { code: string; detail: { retry: boolean } };
		error.name = "CustomError";
		error.stack = "OUTER_STACK";
		error.code = "E_FIXTURE";
		error.detail = { retry: false };
		logger.error("error-matrix", { error });
		const wrappedError = new Error("wrapped");
		wrappedError.stack = "WRAPPED_STACK";
		logger.error("tojson-error", { wrapped: { toJSON: () => ({ err: wrappedError }) } });
		disableTransports();
		break;
	}
	case "format-tokens": {
		logger.setTransports({ console: false, file: primaryDir });
		for (const token of ["s", "c", "d", "j", "i", "f", "o", "O", "%"]) {
			logger.warn(`token-%${token}`, { value: 7 });
		}
		logger.warn("non-token-%q", { value: 7 });
		interface TokenCircularContext extends Record<string, unknown> {
			self?: TokenCircularContext;
		}
		const circular: TokenCircularContext = { kind: "circular" };
		circular.self = circular;
		logger.warn("circular-%s", circular);
		logger.warn("bigint-%d", { value: 1n });
		disableTransports();
		break;
	}
	case "context": {
		logger.setTransports({ console: false, file: primaryDir });
		const { promise: parentLogged, resolve: parentDone } = Promise.withResolvers<void>();
		// Two sessions interleave on one event loop: each record keeps its own
		// session's fields across awaits and timers.
		let parentId = "parent";
		const parent = logger.withContext(
			{
				get sessionId() {
					return parentId;
				},
			},
			async () => {
				logger.warn("parent-start");
				await Bun.sleep(5);
				// A getter is read per record, so a re-keyed session is current at once.
				parentId = "parent-rekeyed";
				logger.warn("parent-after-timer");
				logger.warn("explicit-wins", { sessionId: "explicit" });
				logger.withoutContext(() => logger.warn("shared-service"));
				parentDone();
			},
		);
		const child = logger.withContext({ sessionId: "child" }, async () => {
			await parentLogged;
			logger.withContext({ sessionId: "grandchild" }, () => logger.warn("child-nested", { ordinal: 1 }));
		});
		logger.warn("outside");
		await Promise.all([parent, child]);
		// Context fields named like the record's own keep the record's level and message.
		logger.withContext({ sessionId: "reserved", level: "error", message: "scoped", timestamp: "scoped" }, () =>
			logger.warn("reserved-kept"),
		);
		// Sinks see the context's fields under the call's own.
		const sinkContexts: unknown[] = [];
		const unregister = logger.registerLogSink(event => sinkContexts.push(event.context));
		logger.withContext({ sessionId: "sink", turn: 1 }, () => logger.warn("to-sink", { turn: 2 }));
		logger.warn("to-sink-outside");
		// A context getter that throws costs the record, never the caller.
		const throwing = {
			get sessionId(): string {
				throw new Error("getter failed");
			},
		};
		logger.withContext(throwing, () => logger.warn("throwing-getter", { kept: true }));
		unregister();
		writeResult({ sinkContexts });
		disableTransports();
		break;
	}
	case "serialization-failures": {
		logger.setTransports({ console: false, file: primaryDir });
		interface CircularContext extends Record<string, unknown> {
			self?: CircularContext;
		}
		const circular: CircularContext = { kind: "circular" };
		circular.self = circular;
		const bigintContext: Record<string, unknown> = { value: 1n };
		const expectedContexts: Record<string, unknown>[] = [circular, bigintContext];
		const events: Array<{ level: logger.LogLevel; message: string; sameContext: boolean; timestamp: string }> = [];
		const dispose = logger.registerLogSink(event => {
			const expected = expectedContexts[events.length];
			events.push({
				level: event.level,
				message: event.message,
				sameContext: event.context === expected,
				timestamp: event.timestamp.toISOString(),
			});
		});
		logger.info("circular-drop", circular);
		logger.error("bigint-drop", bigintContext);
		dispose();
		disableTransports();
		writeResult({ events });
		break;
	}
	case "debug-only":
		logger.setTransports({ console: false, file: primaryDir });
		logger.debug("debug-only-first", { ordinal: 1 });
		logger.debug("debug-only-second", { ordinal: 2 });
		disableTransports();
		break;
	case "default-file":
		logger.warn("mode-default", { mode: "default" });
		disableTransports();
		writeResult({ logPath: getLogPath() });
		break;
	case "file-only":
		logger.setTransports({ console: false, file: primaryDir });
		logger.warn("mode-file", { mode: "file" });
		disableTransports();
		break;
	case "console-only":
		logger.setTransports({ console: true, file: false });
		logger.warn("mode-console", { mode: "console" });
		disableTransports();
		break;
	case "both":
		logger.setTransports({ console: true, file: primaryDir });
		logger.warn("mode-both", { mode: "both" });
		disableTransports();
		break;
	case "disabled-reenable": {
		const contexts: Record<string, unknown>[] = [];
		const disabledContext = { mode: "disabled" };
		const dispose = logger.registerLogSink(event => {
			if (event.context) contexts.push(event.context);
		});
		const setReturn = logger.setTransports({ console: false, file: false });
		const logReturn = logger.warn("mode-disabled", disabledContext);
		logger.setTransports({ console: false, file: primaryDir });
		logger.warn("mode-reenabled", { mode: "file" });
		const disposeReturn = dispose();
		disableTransports();
		writeResult({
			disabledSinkSameContext: contexts[0] === disabledContext,
			sinkCount: contexts.length,
			returnsUndefined: setReturn === undefined && logReturn === undefined && disposeReturn === undefined,
		});
		break;
	}
	case "reconfigure":
		logger.setTransports({ console: false, file: primaryDir });
		logger.warn("directory-a", { destination: "a" });
		logger.setTransports({ console: false, file: secondaryDir });
		logger.warn("directory-b", { destination: "b" });
		disableTransports();
		break;
	case "reconfigure-failure": {
		logger.setTransports({ console: false, file: primaryDir });
		logger.warn("before-failed-reconfigure");
		const blockerPath = path.join(secondaryDir, "not-a-directory");
		fs.writeFileSync(blockerPath, "blocked");
		let reconfigureThrew = false;
		try {
			logger.setTransports({ console: false, file: path.join(blockerPath, "child") });
		} catch {
			reconfigureThrew = true;
		}
		const sinkContext = { after: "failure" };
		let sinkSameContext = false;
		let sinkCount = 0;
		const dispose = logger.registerLogSink(event => {
			sinkCount++;
			sinkSameContext = event.context === sinkContext;
		});
		logger.warn("after-failed-reconfigure", sinkContext);
		dispose();
		await Bun.sleep(20);
		writeResult({ reconfigureThrew, sinkCount, sinkSameContext });
		break;
	}
	case "burst-close":
		logger.setTransports({ console: false, file: primaryDir });
		for (let index = 0; index < 1_000; index++) logger.warn("burst-close", { index });
		disableTransports();
		break;
	case "burst-natural":
		logger.setTransports({ console: false, file: primaryDir });
		for (let index = 0; index < 1_000; index++) logger.warn("burst-natural", { index });
		break;
	case "sink-order": {
		logger.setTransports({ console: true, file: false });
		const sinkContext = { identity: "same" };
		const dispose = logger.registerLogSink(event => {
			process.stdout.write(`SINK:${event.context === sinkContext}\n`);
			throw new Error("sink failure must be isolated");
		});
		logger.warn("sink-first", sinkContext);
		dispose();
		logger.warn("sink-disposed");
		disableTransports();
		break;
	}
	case "date-retention": {
		const dates = [
			"2026-01-02T03:04:05.006Z",
			"2026-01-03T03:04:05.006Z",
			"2026-01-04T03:04:05.006Z",
			"2026-01-05T03:04:05.006Z",
			"2026-01-06T03:04:05.006Z",
			"2026-01-07T03:04:05.006Z",
		];
		process.env.OMP_LOGGER_TEST_NOW = dates[0];
		logger.setTransports({ console: false, file: primaryDir });
		for (const [index, date] of dates.entries()) {
			process.env.OMP_LOGGER_TEST_NOW = date;
			logger.warn(`date-${index + 1}`);
			await Bun.sleep(10);
		}
		disableTransports();
		break;
	}
	case "prune": {
		// Shared retention runs once the transport is built: older days and dead processes' files go.
		const live = process.pid;
		for (const name of [
			"omp.2025-12-27.log",
			"omp.2025-12-28.log",
			"omp.2025-12-31.999999.log",
			`omp.2026-01-01.${live}.log`,
			".omp.999999-audit.json",
			"notes.txt",
		]) {
			fs.writeFileSync(path.join(primaryDir, name), "old\n");
		}
		logger.setTransports({ console: false, file: primaryDir });
		logger.warn("after-prune");
		await Bun.sleep(50);
		disableTransports();
		break;
	}
	case "size-rotation":
		logger.setTransports({ console: false, file: primaryDir });
		logger.warn("size-nine-mib", { payload: "x".repeat(9 * 1024 * 1024) });
		logger.warn("size-half-mib", { payload: "y".repeat(512 * 1024) });
		logger.warn("size-crosses-ten-mib", { payload: "z".repeat(1024 * 1024) });
		logger.warn("rotation-trigger");
		disableTransports();
		break;
	default:
		throw new Error(`unknown scenario: ${scenario}`);
}
