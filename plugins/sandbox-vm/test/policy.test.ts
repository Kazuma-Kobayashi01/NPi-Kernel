import { describe, expect, it } from "bun:test";
import { applyHostCodePolicy } from "../src/policy";

const ALL = ["read", "bash", "eval", "python", "debug", "grep"];

describe("host code tool policy", () => {
	it("switches off the tools that run code on the host while the VM is the backend", () => {
		const result = applyHostCodePolicy(ALL, [], true);
		expect(result.active).toEqual(["read", "bash", "grep"]);
		expect(result.removed).toEqual(["eval", "python", "debug"]);
	});

	it("gives back only what it took, never a tool the user had turned off", () => {
		// The user had already switched `python` off before the VM became the backend.
		const withoutPython = ALL.filter(name => name !== "python");
		const on = applyHostCodePolicy(withoutPython, [], true);
		expect(on.removed).toEqual(["eval", "debug"]);

		const off = applyHostCodePolicy(on.active, on.removed, false);
		expect(off.active).toEqual(["read", "bash", "grep", "eval", "debug"]);
		expect(off.removed).toEqual([]);
	});

	it("is stable when applied twice", () => {
		const once = applyHostCodePolicy(ALL, [], true);
		const twice = applyHostCodePolicy(once.active, once.removed, true);
		expect(twice.active).toEqual(once.active);
		expect(twice.removed).toEqual(once.removed);
	});
});
