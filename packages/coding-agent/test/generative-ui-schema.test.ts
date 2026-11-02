import { describe, expect, it } from "bun:test";
import { normalizeUiSchema, uiPresentParameters, validateUiValues } from "../src/modes/rpc/generative-ui-schema";
import { validateToolArguments } from "@oh-my-pi/pi-ai";

const options = [{ label: "A", value: "a" }, { label: "B", value: "b" }, { label: "C", value: "c" }];
const schema = () => ({ version: 1, layout: "grid" as const, components: [
	{ type: "textarea", id: "text", label: "Text", minLength: 2, maxLength: 8, rows: 3 },
	{ type: "date", id: "date", label: "Date", min: "2026-01-01", max: "2026-12-31", default: "2026-11-02" },
	{ type: "number", id: "number", label: "Number", min: -1, max: 1, step: 0.25, default: 0 },
	{ type: "checkbox", id: "check", label: "Check" },
	{ type: "switch", id: "switch", label: "Switch", default: true },
	{ type: "multiselect", id: "multi", label: "Multi", options, minItems: 1, maxItems: 2, default: ["a"] },
	{ type: "input", id: "conditional", label: "Conditional", required: true, minLength: 3, visibleWhen: { id: "check", equals: true } },
	{ type: "button", id: "send", label: "Send" },
] });
describe("Generative UI additive controls", () => {
	it("normalizes additive controls, grid layout, visibleWhen, and clones array defaults and submission values", () => {
		const raw = schema(), host = normalizeUiSchema(raw);
		expect(host.layout).toBe("grid");
		expect(host.components[0]).toMatchObject({ rows: 3, default: "", required: false });
		expect(host.components[1]).toMatchObject({ default: "2026-11-02", min: "2026-01-01", max: "2026-12-31" });
		expect(host.components[3]).toMatchObject({ default: false });
		const multi = host.components[5];
		if (multi.type !== "multiselect") throw new Error("Expected multiselect");
		multi.default.push("b");
		expect(raw.components[5]).toMatchObject({ default: ["a"] });
		const submitted = validateUiValues(host, { text: "okay", date: "2026-12-01", number: -0.75, check: false, switch: true, multi: ["a", "b"], conditional: "" });
		expect(submitted.conditional).toBe("");
		(submitted.multi as string[]).push("c");
		expect(multi.default).toEqual(["a", "b"]);
	});
	it("keeps provider optional-null normalization on all new controls in the argument pipeline", () => {
		const raw = schema();
		const nullable = { schema: { ...raw, components: raw.components.map(c => {
			if (c.type === "textarea") return { ...c, default: null, required: null, rows: null };
			if (c.type === "checkbox" || c.type === "switch") return { ...c, default: null };
			if (c.type === "multiselect") return { ...c, default: null, minItems: null, maxItems: null };
			return c;
		}) } };
		const args = validateToolArguments({ name: "ui.present", description: "", parameters: uiPresentParameters }, { type: "toolCall", id: "controls", name: "ui.present", arguments: nullable });
		expect(normalizeUiSchema(args.schema).components[0]).toMatchObject({ default: "", required: false, rows: 4 });
		expect(() => normalizeUiSchema(nullable.schema)).toThrow();
	});
	it("enforces submission bounds, booleans, finite steps, membership and cardinality", () => {
		const host = normalizeUiSchema(schema());
		const valid = { text: "okay", date: "2026-06-15", number: 0.25, check: true, switch: false, multi: ["a"], conditional: "yes" };
		for (const changes of [{}, { text: "", date: "" }, { check: false, conditional: "" }, { text: "12345678", date: "2026-12-31", number: -1, multi: ["b", "c"] }]) {
			expect(validateUiValues(host, { ...valid, ...changes })).toEqual({ ...valid, ...changes });
		}
		for (const changes of [
			{ text: "x" }, { text: "123456789" }, { text: null },
			{ date: "2026-02-30" }, { date: "2025-12-31" }, { date: "2027-01-01" },
			{ check: true, conditional: "" }, { check: true, conditional: "no" },
			{ number: NaN }, { number: Infinity }, { number: -Infinity }, { number: 1000001 }, { number: 0.1 }, { number: 1.25 },
			{ check: "false" }, { check: 0 }, { switch: undefined },
			{ multi: [] }, { multi: ["a", "a"] }, { multi: ["a", "b", "c"] }, { multi: ["unknown"] }, { multi: [1] }, { multi: "a" },
		]) {
			expect(() => validateUiValues(host, { ...valid, ...changes })).toThrow();
		}
	});
	it("rejects malformed schema bounds, including finite quotient overflow", () => {
		const button = { type: "button", id: "send", label: "Send" };
		const controls = [
			{ type: "textarea", id: "x", label: "X", rows: 0 },
			{ type: "textarea", id: "x", label: "X", rows: 21 },
			{ type: "textarea", id: "x", label: "X", rows: 1.5 },
			{ type: "textarea", id: "x", label: "X", maxLength: 4097 },
			{ type: "checkbox", id: "x", label: "X", default: "true" },
			{ type: "switch", id: "x", label: "X", default: 1 },
			{ type: "number", id: "x", label: "X", min: 0, max: 1, step: Number.MIN_VALUE, default: 0 },
			{ type: "slider", id: "x", label: "X", min: -1000001, max: 1, default: 0 },
			{ type: "multiselect", id: "x", label: "X", options, maxItems: 4 },
			{ type: "multiselect", id: "x", label: "X", options, minItems: 2, maxItems: 1 },
			{ type: "multiselect", id: "x", label: "X", options, default: ["a", "a"] },
			{ type: "multiselect", id: "x", label: "X", options, default: ["unknown"] },
			{ type: "select", id: "x", label: "X", options: [{ label: "Empty", value: "" }] },
			{ type: "date", id: "x", label: "X", default: "2026-02-30" },
			{ type: "date", id: "x", label: "X", min: "2026-12-01", max: "2026-01-01" },
			{ type: "input", id: "x", label: "X", visibleWhen: { id: "missing", equals: true } },
			{ type: "input", id: "x", label: "X", visibleWhen: { id: "x", equals: true } },
		];
		for (const control of controls) {
			const raw = { version: 1, components: [control, button] };
			expect(() => normalizeUiSchema(raw)).toThrow();
		}
		const zero = { version: 1, components: [{ type: "input", id: "x", label: "X", minLength: 0 }, button] };
		expect(normalizeUiSchema(zero).components[0]).toMatchObject({ minLength: 0 });
	});
});
