import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool, getEditStore } from "@oh-my-pi/pi-coding-agent/edit";
import type { ExtensionApprovalAnswer } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { requestApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { createHunkApproval, readApprovalText } from "@oh-my-pi/pi-coding-agent/tools/approval-hunks";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let cwd: string;
function session(): ToolSession {
	return {
		cwd, hasUI: false, enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		settings: Settings.isolated(),
	} as ToolSession;
}
beforeAll(async () => { await Settings.init({ inMemory: true }); });
beforeEach(async () => { cwd = await fs.mkdtemp(path.join(os.tmpdir(), "npi-hunk-approval-")); });
afterEach(async () => { await removeWithRetries(cwd); });

const before = "first\nmiddle\nlast\n";
const after = "FIRST\nmiddle\nLAST\n";

function proposal(file: string, original = before, proposed = after) {
	return createHunkApproval([{ path: file, before: original, after: proposed }], async (change, content) => {
		await Bun.write(change.path, content!);
	});
}

describe("frozen hunk approval", () => {
	it("writes exactly a selected subset and tells the model which changes were rejected", async () => {
		const file = path.join(cwd, "a.txt");
		await Bun.write(file, before);
		const pending = proposal(file);
		expect(pending.hunks.map(hunk => hunk.index)).toEqual([0, 1]);
		expect(pending.hunks[0]).toMatchObject({ path: file, header: "@@ -1,1 +1,1 @@", lines: ["-first", "+FIRST"] });
		const result = await pending.apply([1]);
		expect(await Bun.file(file).text()).toBe("first\nmiddle\nLAST\n");
		expect(result.details).toMatchObject({ appliedHunks: [1], rejectedHunks: [0] });
		const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
		expect(text).toContain("Applied hunks: 1");
		expect(text).toContain("Rejected hunks: 0");
		expect(text).toContain("Hunk 0 (rejected)");
		expect(text).toContain("+FIRST");
	});

	it("rejects a stale proposal before any file is written", async () => {
		const first = path.join(cwd, "a.txt");
		const second = path.join(cwd, "b.txt");
		await Bun.write(first, before);
		await Bun.write(second, before);
		const pending = createHunkApproval([
			{ path: first, before, after }, { path: second, before, after },
		], async (file, content) => { await Bun.write(file.path, content!); });
		await Bun.write(second, "user changes\n");
		await expect(pending.apply([0])).rejects.toThrow("changed since the approval diff was prepared");
		expect(await Bun.file(first).text()).toBe(before);
		expect(await Bun.file(second).text()).toBe("user changes\n");
	});

	it("handles all and none without leaking rejected changes", async () => {
		const file = path.join(cwd, "a.txt");
		await Bun.write(file, before);
		const pending = proposal(file);
		await expect(pending.apply([])).rejects.toThrow("no hunks selected");
		expect(await Bun.file(file).text()).toBe(before);
		await expect(pending.apply([0, 0])).rejects.toThrow("Invalid approval hunk selection");
		await expect(pending.apply([99])).rejects.toThrow("Invalid approval hunk selection");
		expect(await Bun.file(file).text()).toBe(before);
		await pending.apply([0, 1]);
		expect(await Bun.file(file).text()).toBe(after);
	});

	it("preserves BOM, CRLF and the missing final newline byte-for-byte", async () => {
		const file = path.join(cwd, "a.txt");
		const original = "\uFEFFfirst\r\nmiddle\r\nlast";
		await Bun.write(file, original);
		const pending = proposal(file, original, "\uFEFFFIRST\r\nmiddle\r\nLAST");
		await pending.apply([1]);
		expect(await fs.readFile(file)).toEqual(Buffer.from("\uFEFFfirst\r\nmiddle\r\nLAST"));
		expect(await readApprovalText(file)).toBe("\uFEFFfirst\r\nmiddle\r\nLAST");
	});

	it("applies insertion and deletion hunks without shifted offsets", async () => {
		const file = path.join(cwd, "a.txt");
		const original = "a\nb\nc\nd\ne\n";
		await Bun.write(file, original);
		const pending = proposal(file, original, "insert\na\nb\nc\ne\nappend");
		expect(pending.hunks).toHaveLength(3);
		await pending.apply([0, 2]);
		expect(await Bun.file(file).text()).toBe("insert\na\nb\nc\nd\ne\nappend");
	});
});

describe("file tool proposals and approval answers", () => {
	it("prepares write without changing disk and applies only the chosen write hunk", async () => {
		const file = path.join(cwd, "a.txt");
		await Bun.write(file, before);
		const pending = (await new WriteTool(session()).prepareHunkApproval({ path: file, content: after }))!;
		expect(await Bun.file(file).text()).toBe(before);
		await pending.apply([0]);
		expect(await Bun.file(file).text()).toBe("FIRST\nmiddle\nlast\n");
	});

	it("prepares native apply_patch in a private store, including rejected file creation", async () => {
		const file = path.join(cwd, "a.txt");
		await Bun.write(file, before);
		const owner = session();
		const store = getEditStore(owner);
		const tag = store.recordSnapshot(file, before, [1, 2, 3]);
		const pending = (await new EditTool(owner, "apply_patch").prepareHunkApproval({ input: [
			"*** Begin Patch", "*** Update File: a.txt", "@@", "-first", "+FIRST", " middle", "-last", "+LAST",
			"*** Add File: created.txt", "+not accepted", "*** End Patch",
		].join("\n") }))!;
		expect(await Bun.file(file).text()).toBe(before);
		expect(store.headHash(file)).toBe(tag);
		expect(await Bun.file(path.join(cwd, "created.txt")).exists()).toBe(false);
		expect(pending.hunks).toHaveLength(3);
		await pending.apply([1]);
		expect(await Bun.file(file).text()).toBe("first\nmiddle\nLAST\n");
		expect(await Bun.file(path.join(cwd, "created.txt")).exists()).toBe(false);
		expect(store.headText(file)).toBe("first\nmiddle\nLAST\n");
	});

	it("supports hashline and replace edit modes without executing the rejected hunk", async () => {
		for (const mode of ["hashline", "replace"] as const) {
			const file = path.join(cwd, `${mode}.txt`);
			await Bun.write(file, before);
			const owner = session();
			const tag = getEditStore(owner).recordSnapshot(file, before, [1, 2, 3]);
			const args = mode === "hashline"
				? { input: `[${file}#${tag}]\nPUT 1.=1:\n+FIRST\nPUT 3.=3:\n+LAST\n` }
				: { path: file, old_string: before, new_string: after };
			const pending = (await new EditTool(owner, mode).prepareHunkApproval(args))!;
			await pending.apply([0]);
			expect(await Bun.file(file).text()).toBe("FIRST\nmiddle\nlast\n");
		}
	});

	it("normalizes all/none to legacy answers and keeps old hosts' full approval", async () => {
		const file = path.join(cwd, "a.txt");
		await Bun.write(file, before);
		const tool = new WriteTool(session());
		const args = { path: file, content: after };
		const pending = (await tool.prepareHunkApproval(args))!;
		for (const [selectedHunks, expected] of [
			[[0], { selectedHunks: [0] }], [[0, 1], "once"], [[], "deny"],
		] as [number[], ExtensionApprovalAnswer][]) {
			const answer: ExtensionApprovalAnswer = { selectedHunks: [...selectedHunks] };
			expect(await requestApproval({ select: async () => "Approve", approve: async () => answer }, tool, args, { hunks: pending.hunks })).toEqual(expected);
		}
		expect(await requestApproval({ select: async () => "Approve" }, tool, args, { hunks: pending.hunks })).toBe("once");
		await tool.execute("legacy-full", args);
		expect(await Bun.file(file).text()).toBe(after);
	});
});
