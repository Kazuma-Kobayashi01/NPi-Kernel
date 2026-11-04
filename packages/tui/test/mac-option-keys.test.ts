import { afterEach, describe, expect, it } from "bun:test";
import { matchesKey, parseKey, setMacOptionAsAlt } from "../src/keys";

const darwin = process.platform === "darwin";

describe("macOS Option as Alt", () => {
	afterEach(() => setMacOptionAsAlt(undefined));

	it.skipIf(!darwin)("reads the Option-layer characters as Alt+letter when enabled", () => {
		setMacOptionAsAlt(true);
		expect(matchesKey("å", "alt+a")).toBe(true);
		expect(matchesKey("ø", "alt+o")).toBe(true);
		expect(parseKey("Å")).toBe("alt+shift+a");
		expect(parseKey("")).toBe("alt+shift+k");
		expect(matchesKey("\x1ba", "alt+a")).toBe(true);
	});

	it.skipIf(!darwin)("leaves those characters as text when disabled", () => {
		setMacOptionAsAlt(false);
		expect(matchesKey("å", "alt+a")).toBe(false);
		expect(parseKey("å")).not.toBe("alt+a");
	});
});
