import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as logger from "../src/logger";
import { type RotatingFileBatchOptions, RotatingFileSink } from "../src/logger/rotating-file";

const FLUSH_BYTES = 64 * 1024;

let dir: string;
let writeSpy: Mock<typeof fs.writeSync>;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-logger-batching-"));
	writeSpy = spyOn(fs, "writeSync");
});

afterEach(() => {
	vi.useRealTimers();
	writeSpy.mockRestore();
	logger.setTransports({ console: false, file: false });
	fs.rmSync(dir, { recursive: true, force: true });
});

function readLines(directory: string): string[] {
	const names = fs.readdirSync(directory).sort();
	return names.flatMap(name =>
		fs
			.readFileSync(path.join(directory, name), "utf8")
			.split(os.EOL)
			.filter(line => line.length > 0),
	);
}

function messages(directory: string): string[] {
	return readLines(directory).map(line => {
		const entry: { message: string } = JSON.parse(line);
		return entry.message;
	});
}

describe("logger file writes", () => {
	test("warn, error and fatal records reach disk at once, one write each; info and debug never do", () => {
		logger.setTransports({ console: false, file: dir });
		logger.debug("debug-1");
		logger.info("info-2");
		expect(writeSpy).not.toHaveBeenCalled();
		expect(fs.readdirSync(dir)).toEqual([]);

		logger.warn("warn-3");
		expect(writeSpy).toHaveBeenCalledTimes(1);
		logger.error("error-4");
		logger.fatal("fatal-5");
		expect(writeSpy).toHaveBeenCalledTimes(3);
		expect(messages(dir)).toEqual(["warn-3", "error-4", "fatal-5"]);
	});
});

describe("RotatingFileSink batching", () => {
	function makeSink(directory: string, batch?: RotatingFileBatchOptions): RotatingFileSink {
		return new RotatingFileSink({
			directory,
			filenamePrefix: "omp",
			filenameSuffix: "1234",
			maxBytes: 1_000,
			maxFiles: 5,
			batch,
		});
	}

	test("rotation honors maxBytes exactly as an unbatched sink does", () => {
		const unbatchedDir = path.join(dir, "unbatched");
		const batchedDir = path.join(dir, "batched");
		fs.mkdirSync(unbatchedDir);
		fs.mkdirSync(batchedDir);
		const unbatched = makeSink(unbatchedDir);
		const batched = makeSink(batchedDir, { intervalMs: 60_000, maxBytes: FLUSH_BYTES });
		const records = Array.from({ length: 10 }, (_, index) => `${index}`.padEnd(300, "x"));

		for (const record of records) unbatched.write(record);
		unbatched.close();
		const unbatchedWrites = writeSpy.mock.calls.length;
		writeSpy.mockClear();
		for (const record of records) batched.write(record);
		batched.close();

		const names = fs.readdirSync(batchedDir).sort();
		expect(names).toEqual(fs.readdirSync(unbatchedDir).sort());
		expect(names).toHaveLength(3);
		for (const name of names) {
			expect(fs.readFileSync(path.join(batchedDir, name), "utf8")).toBe(
				fs.readFileSync(path.join(unbatchedDir, name), "utf8"),
			);
		}
		expect(unbatchedWrites).toBe(records.length);
		// One write per rotated file instead of one per record.
		expect(writeSpy).toHaveBeenCalledTimes(names.length);
	});
});
