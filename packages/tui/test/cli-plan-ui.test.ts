import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "../src/chat/assistant-message";
import { initTheme } from "../src/theme";
import { visibleWidth } from "../src/utils";
import { ListDialogFrame } from "../src/chrome/list-dialog";
import { createStartupStatusLine } from "../src/status-line/startup";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { CustomEditor } from "../src/prompt/custom-editor";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getEditorTheme } from "../src/theme/tui-adapters";
import { railComposerStyle } from "../src/components/composer/rail";

beforeAll(async () => {
	await initTheme();
});

const message: AssistantMessage = {
	role: "assistant",
	api: "openai-responses",
	provider: "test",
	model: "test-model",
	stopReason: "stop",
	timestamp: 1,
	content: [
		{ type: "thinking", thinking: "REASONING_BODY_SENTINEL" },
		{ type: "text", text: "Visible answer" },
	],
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};

describe("CLI plan presentation", () => {
	it("folds reasoning by default, expands without losing content, and folds again", () => {
		const component = new AssistantMessageComponent(message);
		const text = () => Bun.stripANSI(component.render(80).join("\n"));
		try {
			expect(text()).toContain("Thought");
			expect(text()).toContain("Visible answer");
			expect(text()).not.toContain("REASONING_BODY_SENTINEL");
			component.setExpandThinkingBlocks(true);
			expect(text()).toContain("REASONING_BODY_SENTINEL");
			component.setExpandThinkingBlocks(false);
			expect(text()).not.toContain("REASONING_BODY_SENTINEL");
			expect(message.content[0]).toMatchObject({ thinking: "REASONING_BODY_SENTINEL" });
		} finally {
			component.dispose();
		}
	});

	it("keeps streamed reasoning folded after later deltas and finalization", () => {
		const component = new AssistantMessageComponent();
		try {
			component.updateContent({ ...message, content: [message.content[0]!] }, { transient: true });
			expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("Thinking");
			component.updateContent(message);
			component.markTranscriptBlockFinalized();
			const rendered = Bun.stripANSI(component.render(80).join("\n"));
			expect(rendered).not.toContain("REASONING_BODY_SENTINEL");
			expect(rendered).toContain("Thought");
			expect(rendered).toContain("Visible answer");
			expect(component.renderTranscriptStableRows(100, 80).join("\n")).not.toContain("REASONING_BODY_SENTINEL");
		} finally {
			component.dispose();
		}
	});

	it("fits common dialog chrome around long titles and CJK content", () => {
		for (const width of [40, 80, 120]) {
			const frame = new ListDialogFrame(width, "设置与服务连接".repeat(10));
			frame.add("Search: 示例");
			frame.section("Services");
			frame.add("很长的搜索结果".repeat(30));
			for (const line of frame.finish()) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("updates the identity inside the rail when the mode changes and fits narrow widths", () => {
		const status = createStartupStatusLine({
			settings: {},
			model: buildModel({
				id: "fixture-model",
				name: "Fixture Model",
				provider: "fixture",
				api: "openai-responses",
				baseUrl: "https://example.invalid",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				maxTokens: 1024,
			}),
			thinkingLevel: ThinkingLevel.Low,
			gitEnabled: false,
			autoThinking: false,
			fastMode: false,
			usingSubscription: false,
			autoCompactEnabled: false,
			compactionBoundaries: null,
		});
		const editor = new CustomEditor(getEditorTheme());
		editor.setBorderStyle("rail");
		status.attachToEditor(editor, railComposerStyle);
		try {
			expect(Bun.stripANSI(editor.render(80).join("\n"))).toContain("Build · Fixture Model · fixture");
			status.setPlanModeStatus({ enabled: true, paused: false });
			expect(Bun.stripANSI(editor.render(80).join("\n"))).toContain("Plan · Fixture Model · fixture");
			for (const line of editor.render(40)) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		} finally {
			status.dispose();
		}
	});
});
