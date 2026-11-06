import { describe, expect, test } from "bun:test";
import { rosterTierOf } from "../src/config/model-roster";

describe("rosterTierOf", () => {
	test("names a tier only through a role selector, thinking suffix allowed", () => {
		expect(rosterTierOf("@economy")).toBe("economy");
		expect(rosterTierOf("@flagship:high")).toBe("flagship");
		expect(rosterTierOf("@smol")).toBeUndefined();
		expect(rosterTierOf("economy")).toBeUndefined();
		expect(rosterTierOf("anthropic/flagship")).toBeUndefined();
		expect(rosterTierOf(undefined)).toBeUndefined();
	});
});
