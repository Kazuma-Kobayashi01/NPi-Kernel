import { describe, expect, it } from "bun:test";
import { validateToolArguments } from "@oh-my-pi/pi-ai";
import { normalizeUiSchema, uiPresentParameters, validateUiValues } from "../src/modes/rpc/generative-ui-schema";
import { demoSchema } from "./fixtures/generative-ui-rpc-agent";

const allControls = {
	version: 1,
	components: [
		{ type: "text", id: "intro", text: "Choose parameters", label: "Information" },
		{ type: "input", id: "name", label: "Name", required: true, minLength: 2, maxLength: 10 },
		{ type: "slider", id: "count", label: "Count", min: 1, max: 32, default: 4 },
		{ type: "select", id: "mode", label: "Mode", options: [{ label: "A", value: "a" }] },
		{
			type: "radio",
			id: "level",
			label: "Level",
			options: [{ label: "Low", value: "low" }],
			required: false,
			default: "",
		},
		{ type: "button", id: "submit", label: "Submit" },
	],
};
describe("Generative UI schema", () => {
	it("uses the existing argument pipeline to remove strict-provider optional nulls recursively", () => {
		const tool = { name: "ui.present", description: "", parameters: uiPresentParameters };
		const argumentsWithNulls = {
			schema: {
				...allControls,
				title: null,
				layout: null,
				components: allControls.components.map(component => {
					switch (component.type) {
						case "text":
							return { ...component, label: null };
						case "input":
							return { ...component, default: null, required: null, minLength: null, maxLength: null };
						case "slider":
							return { ...component, step: null };
						case "select":
						case "radio":
							return { ...component, default: null, required: null };
						default:
							return component;
					}
				}),
			},
		};
		const normalized = validateToolArguments(
			tool,
			{ type: "toolCall", id: "nullable-ui", name: "ui.present", arguments: argumentsWithNulls },
			{ keepUnknownRootKeys: true },
		);
		const schema = normalizeUiSchema(normalized.schema);
		expect(schema.layout).toBe("stack");
		expect(schema.title).toBeUndefined();
		expect(schema.components[0]).not.toHaveProperty("label");
		expect(schema.components[1]).toMatchObject({ default: "", required: false, minLength: 0, maxLength: 1024 });
		expect(schema.components[2]).toMatchObject({ step: 1 });
		expect(schema.components[3]).toMatchObject({ default: "a", required: false });
		expect(schema.components[4]).toMatchObject({ default: "low", required: false });
		// Direct unnormalized host data remains strict: no second null-handling convention.
		expect(() => normalizeUiSchema(argumentsWithNulls.schema)).toThrow();
	});
	it("normalizes all six component kinds and validates string/number submission", () => {
		const schema = normalizeUiSchema(allControls);
		expect(schema.layout).toBe("stack");
		expect(schema.components[1]).toMatchObject({ default: "", minLength: 2, maxLength: 10 });
		expect(schema.components[2]).toMatchObject({ step: 1 });
		expect(schema.components[3]).toMatchObject({ default: "a", required: false });
		expect(validateUiValues(schema, { name: "Ada", count: 8, mode: "a", level: "" })).toEqual({
			name: "Ada",
			count: 8,
			mode: "a",
			level: "",
		});
		for (const values of [
			{ name: "", count: 4, mode: "a", level: "" },
			{ name: "A", count: 4, mode: "a", level: "" },
			{ name: "Ada", count: 1.5, mode: "a", level: "" },
			{ name: "Ada", count: 4, mode: "unknown", level: "" },
			{ name: "Ada", count: 4, mode: "a" },
			{ name: "Ada", count: 4, mode: "a", level: "", submit: "bad" },
		]) {
			expect(() => validateUiValues(schema, values)).toThrow();
		}
	});
	it("rejects unsupported versions, code/actions, unsafe and duplicate IDs, size and numeric boundaries", () => {
		const button = { type: "button", id: "submit", label: "Submit" };
		const invalid = [
			{ ...demoSchema, version: 2 },
			{ ...demoSchema, command: "run" },
			{ ...demoSchema, layout: null },
			{ version: 1, components: [] },
			{ version: 1, components: [button, button] },
			{ version: 1, components: [{ ...button, action: "eval" }] },
			...["__proto__", "constructor", "prototype", "bad.id", ""].map(id => ({
				version: 1,
				components: [{ ...button, id }],
			})),
			{ version: 1, components: [{ type: "text", id: "text", text: "x".repeat(4097) }, button] },
			{ version: 1, title: "x".repeat(161), components: [button] },
			{
				version: 1,
				components: [...Array.from({ length: 25 }, (_, i) => ({ type: "text", id: `t${i}`, text: "x" })), button],
			},
			...[NaN, Infinity, -Infinity, 1e7].map(defaultValue => ({
				version: 1,
				components: [{ type: "slider", id: "s", label: "S", min: 0, max: 32, default: defaultValue }, button],
			})),
			...[0, -1].map(step => ({
				version: 1,
				components: [{ type: "slider", id: "s", label: "S", min: 0, max: 32, default: 4, step }, button],
			})),
			{ version: 1, components: [{ type: "input", id: "i", label: "I", maxLength: 4097 }, button] },
			{
				version: 1,
				components: [
					{
						type: "select",
						id: "s",
						label: "S",
						options: [
							{ label: "A", value: "a" },
							{ label: "B", value: "a" },
						],
					},
					button,
				],
			},
			{
				version: 1,
				components: [
					{
						type: "radio",
						id: "s",
						label: "S",
						options: [{ label: "A", value: "a" }],
						required: true,
						default: "",
					},
					button,
				],
			},
			{ version: 1, components: [{ type: "iframe", id: "s", label: "S" }, button] },
		];
		for (const schema of invalid) expect(() => normalizeUiSchema(schema)).toThrow();
	});
});

