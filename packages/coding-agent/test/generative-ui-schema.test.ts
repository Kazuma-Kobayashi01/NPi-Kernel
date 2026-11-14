import { describe, expect, it } from "bun:test";
import { normalizeUiSchema, uiPresentParameters, validateUiValues, type UiComponent } from "../src/modes/rpc/generative-ui-schema";
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
describe("Generative UI image references", () => {
	const remote = {
		type: "image", id: "shot", src: "https://cdn.example.com/shot.png", thumbnail: "https://cdn.example.com/thumb.png",
		alt: "Screenshot of the build", title: "Build", sourceUrl: "https://example.com/build", attribution: "Example",
	} satisfies UiComponent;
	const local = { type: "image", id: "logo", src: "assets/logo.png", alt: "Logo" } satisfies UiComponent;
	const image = (src: unknown, extra: Record<string, unknown> = {}) => ({ version: 1, components: [{ type: "image", id: "x", src, ...extra }] });

	it("keeps an image's description (the side-by-side card) and bounds it", () => {
		const described = normalizeUiSchema(image("https://cdn.example.com/a.png", { title: "Autumn", description: "Maples at Nikko." }));
		expect(described.components[0]).toMatchObject({ type: "image", description: "Maples at Nikko." });
		expect(() => normalizeUiSchema(image("https://cdn.example.com/a.png", { description: "x".repeat(1201) }))).toThrow(/image\.description/);
	});

	it("normalizes remote and project-relative references as a display component that never waits for a submit", () => {
		const host = normalizeUiSchema({ version: 1, components: [remote, local] });
		expect(host.mode).toBe("display");
		expect(host.components).toEqual([remote, local]);
		expect(normalizeUiSchema({ version: 1, mode: "display", components: [local] }).components[0]).toEqual(local);
		const interactive = normalizeUiSchema({ version: 1, mode: "interactive", components: [local, { type: "input", id: "note", label: "Note" }, { type: "button", id: "send", label: "Send" }] });
		expect(interactive.mode).toBe("interactive");
		expect(() => normalizeUiSchema({ version: 1, mode: "display", components: [local, { type: "button", id: "send", label: "Send" }] })).toThrow();
	});
	it("rejects dangerous schemes, credentials, local hosts, non-project paths and unknown image fields", () => {
		for (const src of [
			"data:image/png;base64,AAAA", "javascript:alert(1)", "blob:https://example.com/x", "file:///etc/passwd",
			"http://example.com/x.png", "//example.com/x.png", "/etc/passwd", "../secret.png", "a//b.png", "assets/./x.png", "~/x.png",
			"https://user:pw@example.com/x.png", "https://localhost/x.png", "https://127.0.0.1/x.png", "https://10.0.0.1/x.png",
			"https://172.16.0.1/x.png", "https://192.168.1.1/x.png", "https://169.254.1.1/x.png", "https://[::1]/x.png", "https://[fd00::1]/x.png",
			"https://example.com/a b.png", "",
		]) {
			expect(() => normalizeUiSchema(image(src))).toThrow();
		}
		for (const field of ["thumbnail", "sourceUrl"]) {
			expect(() => normalizeUiSchema(image("assets/x.png", { [field]: "http://example.com/x.png" }))).toThrow();
			expect(() => normalizeUiSchema(image("assets/x.png", { [field]: "https://localhost/x.png" }))).toThrow();
		}
		expect(() => normalizeUiSchema(image("assets/x.png", { caption: "Unknown" }))).toThrow();
		expect(() => normalizeUiSchema(image("assets/x.png", { alt: "a".repeat(301) }))).toThrow();
	});
	it("accepts the 2048-character reference bound and stays stable when a persisted schema is re-normalized", () => {
		const bounded = `https://example.com/${"a".repeat(2048 - "https://example.com/".length)}`;
		expect(bounded).toHaveLength(2048);
		const host = normalizeUiSchema(image(bounded, { alt: "a".repeat(300) }));
		expect(host.components[0]).toMatchObject({ src: bounded });
		expect(() => normalizeUiSchema(image(`${bounded}a`))).toThrow();
		const once = normalizeUiSchema({ version: 1, title: "Media", components: [remote, local] });
		expect(normalizeUiSchema(JSON.parse(JSON.stringify(once)))).toEqual(once);
	});
	it("canonicalizes remote URLs, preserves spaced project paths, normalizes separators and counts references in the text budget", () => {
		expect(normalizeUiSchema(image("HTTPS://cdn.example.com/Shot.png")).components[0]).toMatchObject({ src: "https://cdn.example.com/Shot.png" });
		expect(normalizeUiSchema(image("assets\\images\\my image.png")).components[0]).toMatchObject({ src: "assets/images/my image.png" });
		const bounded = `https://example.com/${"a".repeat(2048 - "https://example.com/".length)}`;
		const many = { version: 1, components: Array.from({ length: 17 }, (_, index) => ({ type: "image", id: `i${index}`, src: bounded })) };
		expect(() => normalizeUiSchema(many)).toThrow();
		// Raw 250 characters, but percent-encoding each CJK character triples it past the canonical bound.
		const unicode = `https://example.com/${"图".repeat(230)}`;
		expect(unicode.length).toBeLessThanOrEqual(2048);
		expect(() => normalizeUiSchema(image(unicode))).toThrow();
	});
});

describe("Generative UI suggestions, ranking, paths and wizard steps", () => {
	const button = { type: "button", id: "send", label: "Send" };
	const form = (control: Record<string, unknown>) => ({ version: 1, mode: "interactive", components: [control, button] });
	const ranking = { type: "ranking", id: "rank", label: "Priority", options };
	const picker = { type: "path-picker", id: "paths", label: "Files" };
	const suggestions = { type: "suggestions", id: "next", items: [{ id: "explain", label: "Explain", prompt: "Explain the result", description: "More detail" }] };

	it("normalizes bounded display suggestions and rejects interactive suggestions and unsafe/duplicate item ids", () => {
		const display = (component: Record<string, unknown>) => ({ version: 1, mode: "display", components: [component] });
		expect(normalizeUiSchema(display(suggestions)).components[0]).toMatchObject({ style: "chips", items: suggestions.items });
		expect(normalizeUiSchema(display({ ...suggestions, style: "cards", label: "x".repeat(120), items: Array.from({ length: 6 }, (_, i) => ({ id: `i${i}`, label: "x".repeat(80), prompt: "x".repeat(500), description: "x".repeat(200) })) })).mode).toBe("display");
		for (const component of [
			{ ...suggestions, items: [] }, { ...suggestions, items: Array.from({ length: 7 }, (_, i) => ({ id: `i${i}`, label: "Next" })) },
			{ ...suggestions, items: [suggestions.items[0], suggestions.items[0]] },
			{ ...suggestions, style: "other" }, { ...suggestions, label: "x".repeat(121) },
			...["__proto__", "constructor", "prototype", "", "bad.id"].map(id => ({ ...suggestions, items: [{ id, label: "Next" }] })),
			...[{ label: "x".repeat(81) }, { prompt: "x".repeat(501) }, { description: "x".repeat(201) }, { action: "run" }].map(extra => ({ ...suggestions, items: [{ ...suggestions.items[0], ...extra }] })),
		]) expect(() => normalizeUiSchema(display(component))).toThrow();
		expect(() => normalizeUiSchema(form(suggestions))).toThrow(/display-only/);
	});

	it("requires ranking defaults and submissions to be full permutations of 2–12 unique options", () => {
		const host = normalizeUiSchema(form(ranking));
		expect(host.components[0]).toMatchObject({ default: ["a", "b", "c"] });
		expect(validateUiValues(host, { rank: ["c", "a", "b"] })).toEqual({ rank: ["c", "a", "b"] });
		const rawDefault = ["c", "b", "a"];
		const normalized = normalizeUiSchema(form({ ...ranking, default: rawDefault }));
		rawDefault.push("a");
		expect(normalized.components[0]).toMatchObject({ default: ["c", "b", "a"] });
		for (const value of [[], ["a"], ["a", "b", "b"], ["a", "b", "unknown"], ["a", "b", "c", "a"], "a", [1, 2, 3]]) {
			expect(() => normalizeUiSchema(form({ ...ranking, default: value }))).toThrow();
			expect(() => validateUiValues(host, { rank: value })).toThrow();
		}
		for (const invalidOptions of [[], [options[0]], [options[0], options[0]], Array.from({ length: 13 }, (_, i) => ({ label: "Option", value: `${i}` })), [{ label: "A", value: "" }, options[1]]]) {
			expect(() => normalizeUiSchema(form({ ...ranking, options: invalidOptions }))).toThrow();
		}
		const twelve = Array.from({ length: 12 }, (_, i) => ({ label: "x".repeat(120), value: `${i}`, description: "x".repeat(200) }));
		expect(normalizeUiSchema(form({ ...ranking, options: twelve })).components[0]).toMatchObject({ default: twelve.map(o => o.value) });
		expect(() => normalizeUiSchema({ version: 1, mode: "display", components: [ranking] })).toThrow();
	});

	it("normalizes project-relative picker paths and enforces required, multiple, maxItems and path format", () => {
		const host = normalizeUiSchema(form(picker));
		expect(host.components[0]).toMatchObject({ kind: "file", multiple: false, default: [], required: false, maxItems: 1 });
		expect(validateUiValues(host, { paths: [] })).toEqual({ paths: [] });
		expect(validateUiValues(host, { paths: ["src\\my file.ts"] })).toEqual({ paths: ["src/my file.ts"] });
		const many = normalizeUiSchema(form({ ...picker, multiple: true, required: true, maxItems: 50, kind: "any" }));
		expect(many.components[0]).toMatchObject({ default: [], maxItems: 50 });
		const fifty = Array.from({ length: 50 }, (_, i) => `src/file${i}.ts`);
		expect(validateUiValues(many, { paths: fifty }).paths).toEqual(fifty);
		expect(() => validateUiValues(many, { paths: [] })).toThrow();
		expect(() => validateUiValues(many, { paths: [...fifty, "extra"] })).toThrow();
		expect(normalizeUiSchema(form({ ...picker, multiple: true })).components[0]).toMatchObject({ maxItems: 20 });
		for (const path of ["", "/absolute", "\\absolute", "~/file", "../file", "a/../file", "a/./file", "a//file", "C:\\file", "https://example.com/file", "a\0b", "x".repeat(1025)]) {
			expect(() => normalizeUiSchema(form({ ...picker, default: [path] }))).toThrow();
			expect(() => validateUiValues(host, { paths: [path] })).toThrow();
		}
		expect(validateUiValues(host, { paths: ["x".repeat(1024)] }).paths).toEqual(["x".repeat(1024)]);
		for (const values of [["a", "b"], ["a", "a"], "a", [1]]) expect(() => validateUiValues(host, { paths: values })).toThrow();
		expect(() => validateUiValues(many, { paths: ["src/a", "src\\a"] })).toThrow(/Duplicate/);
		for (const extra of [{ maxItems: 0 }, { maxItems: 51 }, { maxItems: 1.5 }, { kind: "socket" }, { multiple: "yes" }, { required: "yes" }, { placeholder: "x".repeat(121) }, { default: ["a", "b"] }]) expect(() => normalizeUiSchema(form({ ...picker, ...extra }))).toThrow();
		const singleLargeMax = normalizeUiSchema(form({ ...picker, maxItems: 50 }));
		expect(() => validateUiValues(singleLargeMax, { paths: ["a", "b"] })).toThrow();
	});

	it("validates every non-button wizard component belongs to exactly one of 2–6 steps", () => {
		const raw = { version: 1, mode: "interactive", components: [{ type: "text", id: "intro", text: "Rank and select" }, ranking, picker, button], steps: [{ id: "priorities", title: "Priorities", components: ["intro", "rank"] }, { id: "files", title: "Files", components: ["paths"] }] };
		const host = normalizeUiSchema(raw);
		expect(host.steps).toEqual(raw.steps);
		expect(validateUiValues(host, { rank: ["b", "a", "c"], paths: ["src/a.ts"] })).toEqual({ rank: ["b", "a", "c"], paths: ["src/a.ts"] });
		expect(normalizeUiSchema(JSON.parse(JSON.stringify(host)))).toEqual(host);
		for (const steps of [
			[], [raw.steps[0]], Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, title: "Step", components: [] })),
			[{ ...raw.steps[0], id: "bad.id" }, raw.steps[1]],
			[{ ...raw.steps[0], title: "x".repeat(81) }, raw.steps[1]],
			[raw.steps[0], { ...raw.steps[1], id: raw.steps[0].id }],
			[raw.steps[0], { ...raw.steps[1], components: [] }],
			[raw.steps[0], { ...raw.steps[1], components: ["paths", "intro"] }],
			[raw.steps[0], { ...raw.steps[1], components: ["paths", "send"] }],
			[raw.steps[0], { ...raw.steps[1], components: ["missing"] }],
			[raw.steps[0], { ...raw.steps[1], components: ["paths", "paths"] }],
		]) expect(() => normalizeUiSchema({ ...raw, steps })).toThrow();
		expect(() => normalizeUiSchema({ version: 1, mode: "display", components: [{ type: "text", id: "intro", text: "Hi" }], steps: raw.steps })).toThrow(/interactive-only/);
		expect(normalizeUiSchema({ ...raw, steps: [...raw.steps, ...Array.from({ length: 4 }, (_, i) => ({ id: `empty${i}`, title: "x".repeat(80), components: [] }))] }).steps).toHaveLength(6);
	});

	it("routes new arguments through strict tool validation and retains hidden array defaults", () => {
		const schema = { version: 1, mode: "interactive", components: [{ type: "checkbox", id: "enabled", label: "Enabled" }, { ...ranking, visibleWhen: { id: "enabled", equals: true } }, { ...picker, required: true, default: ["src\\a.ts"], visibleWhen: { id: "enabled", equals: true } }, button], steps: [{ id: "enable", title: "Enable", components: ["enabled"] }, { id: "configure", title: "Configure", components: ["rank", "paths"] }] };
		const args = validateToolArguments({ name: "ui.present", description: "", parameters: uiPresentParameters }, { type: "toolCall", id: "wizard", name: "ui.present", arguments: { schema, ui_id: null } });
		expect(args.ui_id).toBeUndefined();
		const host = normalizeUiSchema(args.schema);
		expect(validateUiValues(host, { enabled: false })).toEqual({ enabled: false, rank: ["a", "b", "c"], paths: ["src/a.ts"] });
		const displayArgs = validateToolArguments({ name: "ui.present", description: "", parameters: uiPresentParameters }, { type: "toolCall", id: "suggestions", name: "ui.present", arguments: { ui_id: "display-id", schema: { version: 1, mode: "display", components: [suggestions] } } });
		expect(displayArgs.ui_id).toBe("display-id");
		expect(normalizeUiSchema(displayArgs.schema).components[0]).toMatchObject({ type: "suggestions" });
	});
});
