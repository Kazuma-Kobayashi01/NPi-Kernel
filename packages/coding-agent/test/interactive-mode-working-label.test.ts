/**
 * The working row keeps the kaomoji loading label while tools run (a tool's
 * intent stays on its card), and a live (function) label — the background-job
 * wait row — is re-read on every tick and kept to one terminal row.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
const COLUMNS = 40;

describe("InteractiveMode live working label", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-working-label-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		Object.defineProperty(mode.ui.terminal, "columns", { get: () => COLUMNS, configurable: true });
	});

	afterAll(async () => {
		mode.stop();
		await session.dispose();
		authStorage.close();
		resetSettingsForTest();
		await tempDir.remove();
	});

	it("keeps the animated working label when tools start and preserves the tool card", async () => {
		mode.ensureLoadingAnimation();
		mode.setWorkingMessage();
		const label = () =>
			mode.statusContainer
				.render(120)
				.map(line => Bun.stripANSI(line))
				.join("\n");
		const before = label();
		await mode.eventController.handleEvent({
			type: "tool_execution_start",
			toolCallId: "loading-intent",
			toolName: "read",
			args: { path: "sample.ts" },
			intent: "分析某个文件",
		});
		expect(label()).toBe(before);
		expect(label()).not.toContain("分析某个文件");
		expect(
			mode.chatContainer
				.render(120)
				.map(line => Bun.stripANSI(line))
				.join("\n"),
		).toContain("sample.ts");
	});

	it("keeps a long live label on one row", () => {
		const jobs = ["bg_1", "bg_2", "bg_3", "bg_4", "bg_5", "bg_6"];
		mode.ensureLoadingAnimation();
		mode.setWorkingMessage(() => `Waiting for ${jobs.length} background jobs: ${jobs.join(", ")}`);

		const rows = mode.statusContainer
			.render(COLUMNS)
			.map(line => Bun.stripANSI(line).trimEnd())
			.filter(line => line.length > 0);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("Waiting for 6 background jobs");
		expect(Bun.stringWidth(rows[0] ?? "")).toBeLessThanOrEqual(COLUMNS);
	});
});
