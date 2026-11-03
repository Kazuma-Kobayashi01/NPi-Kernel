import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { postProcessToolResult, wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { cfgReadDefaultLimit } from "@oh-my-pi/pi-coding-agent/tools/settings";

function getTextOutput(result: AgentToolResult): string {
	const texts: string[] = [];
	for (const block of result.content) if (block.type === "text") texts.push(block.text);
	return texts.join("\n");
}

describe("read tool artifacts without an artifacts directory", () => {
	let testDir: string;
	let manager: SessionManager;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-artifact-memory-"));
		manager = SessionManager.inMemory(testDir);
	});

	afterEach(async () => {
		resetRegisteredArtifactDirsForTests();
		await manager.close();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	function makeSession(): ToolSession {
		return {
			cwd: testDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => manager.getArtifactsDir(),
			sessionManager: manager,
			settings: Settings.isolated(),
		};
	}

	async function makeToolContext(): Promise<AgentToolContext> {
		return {
			sessionManager: manager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(await AuthStorage.create(":memory:"), path.join(testDir, "models.yml")),
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};
	}

	it("reads the artifact a spill footer advertises back from the in-memory store", async () => {
		const fullOutput = Array.from({ length: 8_000 }, (_, index) => `spill line ${index + 1} ${"x".repeat(80)}`).join(
			"\n",
		);
		const spilled = await postProcessToolResult(
			{ content: [{ type: "text", text: fullOutput }], details: {} },
			"bash",
			await makeToolContext(),
		);
		const advertised = getTextOutput(spilled).match(/artifact:\/\/(\d+)/);
		expect(advertised).not.toBeNull();
		expect(manager.getArtifactsDir()).toBeNull();

		const tool = new ReadTool(makeSession());
		const head = getTextOutput(await tool.execute("call-head", { path: `artifact://${advertised![1]}` }));
		const tail = getTextOutput(
			await tool.execute("call-tail", { path: `artifact://${advertised![1]}:raw:8000-8000` }),
		);

		expect(head).toContain("spill line 1 ");
		expect(tail).toContain("spill line 8000 ");
	});

	it("spills a medium result under the smaller defaults, preserves recovery, and respects an explicit larger budget", async () => {
		const lines = Array.from(
			{ length: 300 },
			(_, index) => `row-${String(index + 1).padStart(4, "0")} ${"x".repeat(80)}`,
		);
		const fullOutput = lines.join("\n");
		const context = await makeToolContext();
		const result = await postProcessToolResult(
			{ content: [{ type: "text", text: fullOutput }], details: {} },
			"bash",
			context,
		);
		const inline = getTextOutput(result);
		expect(Buffer.byteLength(inline)).toBeLessThan(10 * 1024);
		expect(inline).toContain("row-0001");
		expect(inline).toContain("row-0300");
		expect(inline).not.toContain("row-0150");
		const artifact = inline.match(/artifact:\/\/(\d+)/);
		expect(artifact).not.toBeNull();
		const recovered = await new ReadTool(makeSession()).execute("recover-middle", {
			path: `artifact://${artifact![1]}:raw:150-150`,
		});
		expect(getTextOutput(recovered)).toContain(lines[149]!);
		context.settings = Settings.isolated({ "tools.artifactSpillThreshold": 50 });
		const expanded = await postProcessToolResult(
			{ content: [{ type: "text", text: fullOutput }], details: {} },
			"bash",
			context,
		);
		expect(getTextOutput(expanded)).toBe(fullOutput);
	});

	it("returns a smaller default file page with continuation while allowing explicit ranges and configured limits", async () => {
		const file = path.join(testDir, "paged.txt");
		await Bun.write(
			file,
			Array.from({ length: 200 }, (_, index) => `record-${String(index + 1).padStart(4, "0")}`).join("\n"),
		);
		const session = makeSession();
		session.settings = Settings.isolated({ "read.summarize.enabled": false });
		const tool = wrapToolWithMetaNotice(new ReadTool(session));
		const first = getTextOutput(await tool.execute("first", { path: file }));
		expect(first).toContain("record-0120");
		expect(first).not.toContain("record-0121");
		expect(first).toContain(":121");
		const next = getTextOutput(await tool.execute("next", { path: `${file}:raw:121-200` }));
		expect(next).toContain("record-0121");
		expect(next).toContain("record-0200");
		cfgReadDefaultLimit.set(session.settings, 180);
		const configured = getTextOutput(await tool.execute("configured", { path: file }));
		expect(configured).toContain("record-0180");
		expect(configured).not.toContain("record-0181");
	});

	it("pages an in-memory artifact with a line selector", async () => {
		const lines = Array.from({ length: 50 }, (_, index) => `line-${index + 1}`);
		const id = await manager.saveArtifact(lines.join("\n"), "bash");
		if (id === undefined) throw new Error("expected an artifact id");

		const result = await new ReadTool(makeSession()).execute("call-range", { path: `artifact://${id}:raw:10-12` });
		const output = getTextOutput(result);

		expect(output).toContain("line-10");
		expect(output).toContain("line-12");
		expect(output).not.toContain("line-9");
		expect(output).not.toContain("line-13");
	});

	it("prefers the caller's in-memory artifact over another session's file with the same id", async () => {
		const id = await manager.saveArtifact("LOCAL SESSION OUTPUT", "bash");
		if (id === undefined) throw new Error("expected an artifact id");
		const foreignDir = path.join(testDir, "foreign-artifacts");
		await fs.mkdir(foreignDir);
		await Bun.write(path.join(foreignDir, `${id}.bash.log`), "FOREIGN SESSION OUTPUT");
		registerArtifactsDir(foreignDir);

		const output = getTextOutput(
			await new ReadTool(makeSession()).execute("call-own", { path: `artifact://${id}:raw` }),
		);

		expect(output).toContain("LOCAL SESSION OUTPUT");
		expect(output).not.toContain("FOREIGN");
	});

	it("pages an in-memory artifact larger than the inline resolution cap", async () => {
		const line = "y".repeat(1023);
		const lines = Array.from({ length: 8_200 }, (_, index) => `big-${index + 1} ${line}`);
		const content = lines.join("\n");
		expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(8 * 1024 * 1024);
		const id = await manager.saveArtifact(content, "bash");
		if (id === undefined) throw new Error("expected an artifact id");

		const output = getTextOutput(
			await new ReadTool(makeSession()).execute("call-big", { path: `artifact://${id}:raw:2-2` }),
		);

		expect(output).toContain("big-2 ");
		expect(output).not.toContain("big-3 ");
	});
});
