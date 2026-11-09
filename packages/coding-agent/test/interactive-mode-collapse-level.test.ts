/**
 * Appearance → Collapse sets what each turn starts folded: Off shows everything,
 * Thinking folds thinking, Thinking + Tools also folds tool output, All folds file
 * changes too. Switching the level re-applies to cards already in the transcript.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgDisplayCollapse } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const FILE_BODY = Array.from({ length: 60 }, (_, index) => `row-${index + 1}`).join("\n");

describe("InteractiveMode collapse level", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-collapse-level-");
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
		const composer = new Composer({ terminal: new VirtualTerminal(120, 32) });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
		// The live settings listener is attached by init().
		await mode.init({ suppressWelcomeIntro: true });
	});

	afterAll(async () => {
		mode.stop();
		await session.dispose();
		authStorage.close();
		resetSettingsForTest();
		await tempDir.remove();
	});

	it("folds thinking, then tool output, then file changes as the level rises", async () => {
		const fileCard = new ToolExecutionComponent(
			"write",
			{ path: "notes.txt", content: FILE_BODY },
			{ fileChangesExpanded: () => mode.fileChangesExpanded },
			undefined,
			mode.ui,
			tempDir.path(),
			"write-1",
		);
		fileCard.updateResult({ content: [{ type: "text", text: "Wrote notes.txt" }], isError: false }, false, "write-1");
		fileCard.setExpanded(mode.toolOutputExpanded);
		mode.chatContainer.addChild(fileCard);
		const fileShown = () => fileCard.render(120).some(line => Bun.stripANSI(line).includes("row-60"));
		// The live settings listener coalesces changes into one microtask.
		const stateAt = async (level: "off" | "thinking" | "tools" | "all") => {
			cfgDisplayCollapse.set(session.settings, level);
			await Promise.resolve();
			return { thinking: mode.expandThinkingBlocks, tools: mode.toolOutputExpanded, fileChanges: fileShown() };
		};

		// Default is All: everything folded, as before the setting existed.
		expect({ thinking: mode.expandThinkingBlocks, tools: mode.toolOutputExpanded, fileChanges: fileShown() }).toEqual(
			{
				thinking: false,
				tools: false,
				fileChanges: false,
			},
		);
		expect(await stateAt("tools")).toEqual({ thinking: false, tools: false, fileChanges: true });
		expect(await stateAt("thinking")).toEqual({ thinking: false, tools: true, fileChanges: true });
		expect(await stateAt("off")).toEqual({ thinking: true, tools: true, fileChanges: true });
		expect(await stateAt("all")).toEqual({ thinking: false, tools: false, fileChanges: false });
	});
});
