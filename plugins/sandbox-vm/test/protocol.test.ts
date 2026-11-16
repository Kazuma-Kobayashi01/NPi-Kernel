import { describe, expect, it } from "bun:test";
import { parseHelperMessage } from "../src/protocol";

describe("helper messages", () => {
	it("reads well-formed messages and drops everything else", () => {
		expect(parseHelperMessage({ type: "state", state: "running", detail: "up" })).toEqual({
			type: "state",
			state: "running",
			detail: "up",
		});
		expect(parseHelperMessage({ id: 4, type: "exit", exitCode: 2, workingDir: "/p" })).toEqual({
			id: 4,
			type: "exit",
			exitCode: 2,
			workingDir: "/p",
		});
		expect(parseHelperMessage({ id: 4, type: "chunk", data: "x" })).toEqual({ id: 4, type: "chunk", data: "x" });
		// What would otherwise reach a pending request with the wrong shape.
		expect(parseHelperMessage({ type: "state", state: "melting" })).toBeUndefined();
		expect(parseHelperMessage({ type: "chunk", data: "no id" })).toBeUndefined();
		expect(parseHelperMessage({ id: 1, type: "chunk", data: 5 })).toBeUndefined();
		expect(parseHelperMessage({ id: 1, type: "unknown" })).toBeUndefined();
		expect(parseHelperMessage("exit")).toBeUndefined();
	});
});
