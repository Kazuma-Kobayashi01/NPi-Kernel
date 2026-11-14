import { describe, expect, it } from "bun:test";
import { validateToolArguments } from "@oh-my-pi/pi-ai";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { GenerativeUiController, generativeUiHistoryMessage } from "../src/modes/rpc/generative-ui";
import type { AgentSession } from "../src/session/agent-session";
import { normalizeUiSchema, uiPresentParameters, validateUiValues } from "../src/modes/rpc/generative-ui-schema";
import { createGenerativeUiDemoSession, demoSchema } from "./fixtures/generative-ui-rpc-agent";

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


function appendUiCall(session: AgentSession, id: string, schema: unknown, ui_id?: string): string {
	return session.sessionManager.appendMessage({
		role: "assistant", content: [{ type: "toolCall", id, name: "ui.present", arguments: { schema, ...(ui_id === undefined ? {} : { ui_id }) } }],
		api: "openai-completions", provider: "openai", model: "offline-test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse", timestamp: Date.now(),
	});
}

describe("Generative UI display updates and submitted paths", () => {
	const display = (value: number) => ({ version: 1, mode: "display", components: [{ type: "progress", id: "progress", label: "Work", value }] });

	it("persists in-place updates with their own call identities, replays revisions after reopen and keeps updates branch-local", async () => {
		using root = TempDir.createSync("omp-ui-update-");
		let active = await createGenerativeUiDemoSession(root.path());
		let sessionFile: string;
		let ui_id: string;
		let originalEntry: string;
		try {
			const { session } = active;
			appendUiCall(session, "initial", display(10));
			const initial = await session.generativeUi.present({ schema: display(10) }, "initial");
			ui_id = initial.ui_id;
			originalEntry = session.sessionManager.getLeafId()!;
			const updateOrigin = appendUiCall(session, "update-1", display(50), ui_id);
			expect(session.generativeUi.canPresent({ schema: display(50), ui_id })).toBe(true);
			expect(await session.generativeUi.present({ schema: display(50), ui_id }, "update-1")).toEqual({ ui_id, session_id: session.sessionId, status: "rendered", rendered: true, revision: 1 });
			expect(await session.generativeUi.present({ schema: display(50), ui_id }, "update-1")).toMatchObject({ revision: 1 });
			const updateEntry = session.sessionManager.getBranchView().find(entry => entry.type === "custom_message" && entry.customType === "ui.update")!;
			expect(updateEntry).toMatchObject({ customType: "ui.update", display: true, attribution: "agent", details: { ui_id, task_id: "update-1", message_id: updateOrigin, status: "rendered", rendered: true, revision: 1, schema: { components: [{ value: 50 }] } } });
			expect(generativeUiHistoryMessage(updateEntry)).toMatchObject({ role: "custom", customType: "ui.update", details: { revision: 1 } });
			appendUiCall(session, "update-2", display(100), ui_id);
			expect(await session.generativeUi.present({ schema: display(100), ui_id }, "update-2")).toMatchObject({ revision: 2 });
			expect(session.sessionManager.getBranchView().filter(entry => entry.type === "custom_message" && entry.customType === "ui.present")).toHaveLength(1);
			expect(session.sessionManager.getBranchView().filter(entry => entry.type === "custom_message" && entry.customType === "ui.update")).toHaveLength(2);
			expect(new GenerativeUiController(session).getState(ui_id)).toMatchObject({ status: "rendered", revision: 2 });
			expect(session.generativeUi.pendingUi).toBeNull();
			expect(await session.generativeUi.beforeModelCall()).toBeUndefined();
			sessionFile = session.sessionManager.getSessionFile()!;
		} finally { await active.session.dispose(); active.authStorage.close(); }
		active = await createGenerativeUiDemoSession(root.path(), sessionFile!);
		try {
			const { session } = active;
			expect(session.generativeUi.getState(ui_id!)).toMatchObject({ status: "rendered", revision: 2 });
			appendUiCall(session, "update-3", display(75), ui_id!);
			expect(await session.generativeUi.present({ schema: display(75), ui_id: ui_id! }, "update-3")).toMatchObject({ revision: 3 });
			session.sessionManager.branch(originalEntry!);
			expect(session.generativeUi.getState(ui_id!)).not.toHaveProperty("revision");
			appendUiCall(session, "branch-update", display(20), ui_id!);
			expect(await session.generativeUi.present({ schema: display(20), ui_id: ui_id! }, "branch-update")).toMatchObject({ revision: 1 });
			expect(session.sessionManager.getBranchView().filter(entry => entry.type === "custom_message" && entry.customType === "ui.update")).toHaveLength(1);
		} finally { await active.session.dispose(); active.authStorage.close(); }
	});

	it("rejects interactive, unknown and off-branch update targets without changing the pending form invariant", async () => {
		using root = TempDir.createSync("omp-ui-update-errors-");
		const { session, authStorage } = await createGenerativeUiDemoSession(root.path());
		try {
			const origin = appendUiCall(session, "initial-display", display(0));
			const card = await session.generativeUi.present({ schema: display(0) }, "initial-display");
			appendUiCall(session, "form", demoSchema);
			const form = await session.generativeUi.present({ schema: demoSchema }, "form");
			for (const [id, params] of [
				["unknown", { schema: display(20), ui_id: "unknown" }],
				["interactive-target", { schema: display(20), ui_id: form.ui_id }],
				["interactive-schema", { schema: demoSchema, ui_id: card.ui_id }],
				["invalid-id", { schema: display(20), ui_id: 123 }],
			] as const) {
				appendUiCall(session, id, params.schema, typeof params.ui_id === "string" ? params.ui_id : undefined);
				expect(session.generativeUi.canPresent(params)).toBe(false);
				await expect(session.generativeUi.present(params, id)).rejects.toThrow();
			}
			expect(session.generativeUi.pendingUi?.ui_id).toBe(form.ui_id);
			appendUiCall(session, "display-while-pending", display(80), card.ui_id);
			expect(session.generativeUi.canPresent({ schema: display(80), ui_id: card.ui_id })).toBe(true);
			await session.generativeUi.present({ schema: display(80), ui_id: card.ui_id }, "display-while-pending");
			expect(session.generativeUi.pendingUi?.ui_id).toBe(form.ui_id);
			session.sessionManager.branch(origin);
			appendUiCall(session, "off-branch", display(30), card.ui_id);
			expect(session.generativeUi.canPresent({ schema: display(30), ui_id: card.ui_id })).toBe(false);
			await expect(session.generativeUi.present({ schema: display(30), ui_id: card.ui_id }, "off-branch")).rejects.toThrow(/current session branch/);
		} finally { await session.dispose(); authStorage.close(); }
	});

	it("validates submitted picker existence, kind and real project containment before persisting values", async () => {
		using root = TempDir.createSync("omp-ui-paths-");
		using outside = TempDir.createSync("omp-ui-paths-outside-");
		await Bun.write(path.join(root.path(), "src", "a.ts"), "export {};");
		await Bun.write(path.join(outside.path(), "secret.txt"), "outside");
		await fs.symlink(outside.absolute(), path.join(root.path(), "escape"), process.platform === "win32" ? "junction" : "dir");
		const { session, authStorage } = await createGenerativeUiDemoSession(root.path());
		const pathSchema = (kind: string, multiple = false) => ({ version: 1, mode: "interactive", components: [{ type: "path-picker", id: "paths", label: "Project paths", kind, required: true, multiple }, { type: "button", id: "send", label: "Send" }] });
		try {
			appendUiCall(session, "file", pathSchema("file"));
			const file = await session.generativeUi.present({ schema: pathSchema("file") }, "file");
			for (const [selected, error] of [
				[["missing.ts"], /does not exist/],
				[["src"], /expected file/],
				[["escape/secret.txt"], /outside the session project/],
				[[], /cardinality/],
			] as const) {
				await expect(session.generativeUi.recordSubmission(file.ui_id, session.sessionId, { paths: [...selected] })).rejects.toThrow(error);
				expect(session.generativeUi.pendingUi?.ui_id).toBe(file.ui_id);
			}
			expect(session.sessionManager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === "ui.submit")).toHaveLength(0);
			const submitted = await session.generativeUi.recordSubmission(file.ui_id, session.sessionId, { paths: ["src\\a.ts"] });
			expect(submitted.values).toEqual({ paths: ["src/a.ts"] });
			expect(await session.generativeUi.recordSubmission(file.ui_id, session.sessionId, { paths: ["src/a.ts"] })).toEqual(submitted);
			appendUiCall(session, "directory", pathSchema("directory"));
			const directory = await session.generativeUi.present({ schema: pathSchema("directory") }, "directory");
			await expect(session.generativeUi.recordSubmission(directory.ui_id, session.sessionId, { paths: ["src/a.ts"] })).rejects.toThrow(/expected directory/);
			expect((await session.generativeUi.recordSubmission(directory.ui_id, session.sessionId, { paths: ["src"] })).values).toEqual({ paths: ["src"] });
			appendUiCall(session, "any", pathSchema("any", true));
			const anyKind = await session.generativeUi.present({ schema: pathSchema("any", true) }, "any");
			expect((await session.generativeUi.recordSubmission(anyKind.ui_id, session.sessionId, { paths: ["src", "src/a.ts"] })).values).toEqual({ paths: ["src", "src/a.ts"] });
		} finally { await session.dispose(); authStorage.close(); }
	});
});
