import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ExtensionUIDialogOptions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { requestApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { TempDir } from "@oh-my-pi/pi-utils";

const sourceDir = path.join(import.meta.dir, "..", "src");

describe("Kernel Remote Connect patches", () => {
	test("set_approval_mode updates get_state.approvalMode, --no-computer-use locks /computer on, and --no-voice blocks voice", async () => {
		using temp = TempDir.createSync("@omp-rpc-patches-");
		const fixturePath = temp.join("fixture.ts");
		await Bun.write(
			fixturePath,
			`
import { createAgentSession, Settings } from ${JSON.stringify(path.join(sourceDir, "sdk.ts"))};
import { runRpcMode } from ${JSON.stringify(path.join(sourceDir, "modes/rpc/rpc-mode.ts"))};

const { session, setToolUIContext } = await createAgentSession({
	cwd: ${JSON.stringify(temp.path())},
	agentDir: ${JSON.stringify(temp.join("agent"))},
	enableMCP: false,
	enableLsp: false,
	disableExtensionDiscovery: true,
	disableComputerUse: true,
	settings: Settings.isolated({ "compaction.enabled": false, "computer.enabled": true }),
});
await runRpcMode(session, {
	setToolUIContext,
	disableVoice: true,
});
`,
		);

		const client = new RpcClient({
			command: [process.execPath, fixturePath],
			cwd: temp.path(),
			env: {
				HOME: temp.join("home"),
				PI_CODING_AGENT_DIR: temp.join("agent"),
				XDG_CONFIG_HOME: temp.join("config"),
				XDG_DATA_HOME: temp.join("data"),
				XDG_CACHE_HOME: temp.join("cache"),
				PI_NO_TITLE: "1",
			},
		});

		await client.start();
		try {
			const modeAfterWrite = await client.setApprovalMode("write");
			expect(modeAfterWrite).toBe("write");
			expect((await client.getState()).approvalMode).toBe("write");

			const modeAfterAsk = await client.setApprovalMode("always-ask");
			expect(modeAfterAsk).toBe("always-ask");
			expect((await client.getState()).approvalMode).toBe("always-ask");

			const invalidResp = await client.sendCommand({
				type: "set_approval_mode",
				mode: "invalid-mode" as never,
			});
			expect(invalidResp.success).toBe(false);

			// Computer use remains hard-locked off even when RPC or /computer on tries to enable it
			const setCompResp = await client.sendCommand({ type: "set_computer_use", enabled: true });
			expect(setCompResp.success).toBe(false);
			const getCompResp = await client.sendCommand({ type: "get_computer_use" });
			expect(getCompResp.success).toBe(true);
			if (getCompResp.success && getCompResp.command === "get_computer_use") {
				expect(getCompResp.data.enabled).toBe(false);
			}

			await client.promptAndWait("/computer on");
			const getCompAfterSlash = await client.sendCommand({ type: "get_computer_use" });
			expect(getCompAfterSlash.success).toBe(true);
			if (getCompAfterSlash.success && getCompAfterSlash.command === "get_computer_use") {
				expect(getCompAfterSlash.data.enabled).toBe(false);
			}

			// Voice commands rejected when disableVoice is true
			const liveResp = await client.sendCommand({ type: "live_start" });
			expect(liveResp.success).toBe(false);
			const dictResp = await client.sendCommand({ type: "dictation_start", captureId: "c1" });
			expect(dictResp.success).toBe(false);
		} finally {
			await client.stop();
		}
	}, 30_000);

	test("requestApproval forwards toolCallId, toolName, and tier through RpcExtensionUIContext select", async () => {
		using temp = TempDir.createSync("@omp-approval-meta-");
		const fixturePath = temp.join("approval-fixture.ts");
		await Bun.write(
			fixturePath,
			`
import { createAgentSession, Settings } from ${JSON.stringify(path.join(sourceDir, "sdk.ts"))};
import { runRpcMode } from ${JSON.stringify(path.join(sourceDir, "modes/rpc/rpc-mode.ts"))};
import { requestApproval } from ${JSON.stringify(path.join(sourceDir, "tools/approval.ts"))};

const { session, setToolUIContext } = await createAgentSession({
	cwd: ${JSON.stringify(temp.path())},
	agentDir: ${JSON.stringify(temp.join("agent"))},
	enableMCP: false,
	enableLsp: false,
	disableExtensionDiscovery: true,
	settings: Settings.isolated({ "compaction.enabled": false }),
});
void runRpcMode(session, {
	setToolUIContext(ui, hasUI) {
		setToolUIContext(ui, hasUI);
		void requestApproval(
			ui,
			{ name: "bash", approval: { tier: "exec" } },
			{ command: "echo hi" },
			{ toolCallId: "tc-remote-1", tier: "exec", reason: "Shell command" },
		).then(answer => {
			ui.notify("approval-answer:" + JSON.stringify(answer));
		});
	},
});
`,
		);

		const client = new RpcClient({
			command: [process.execPath, fixturePath],
			cwd: temp.path(),
			env: {
				HOME: temp.join("home"),
				PI_CODING_AGENT_DIR: temp.join("agent"),
				PI_NO_TITLE: "1",
			},
		});

		let seenSelect: { toolCallId?: string; toolName?: string; tier?: string } | undefined;
		let notifyText: string | undefined;
		const done = Promise.withResolvers<void>();

		client.onExtensionUIRequest(req => {
			if (req.method === "select") {
				seenSelect = {
					toolCallId: req.toolCallId,
					toolName: req.toolName,
					tier: req.tier,
				};
				client.sendExtensionUIResponse({
					type: "extension_ui_response",
					id: req.id,
					value: "Approve",
				});
			} else if (req.method === "notify" && req.message.startsWith("approval-answer:")) {
				notifyText = req.message;
				done.resolve();
			}
		});

		await client.start();
		try {
			await done.promise;
			expect(seenSelect?.toolCallId).toBe("tc-remote-1");
			expect(seenSelect?.toolName).toBe("bash");
			expect(seenSelect?.tier).toBe("exec");
			expect(notifyText).toBe('approval-answer:"once"');
		} finally {
			await client.stop();
		}
	}, 30_000);

	test("requestApproval passes metadata directly to ExtensionUIContext.select", async () => {
		let capturedOptions: ExtensionUIDialogOptions | undefined;
		const fakeTool: Pick<AgentTool, "name" | "approval"> = {
			name: "edit",
			approval: { tier: "write" },
		};
		const answer = await requestApproval(
			{
				select: async (_title, _options, dialogOptions) => {
					capturedOptions = dialogOptions;
					return "Approve";
				},
			},
			fakeTool,
			{ path: "foo.ts" },
			{ toolCallId: "tc-42", tier: "write" },
		);
		expect(answer).toBe("once");
		expect(capturedOptions).toEqual({
			toolName: "edit",
			toolCallId: "tc-42",
			tier: "write",
		});
	});
});
