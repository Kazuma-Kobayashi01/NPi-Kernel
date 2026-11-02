import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode";
import { createAgentSession, type CustomTool } from "../../src/sdk";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import type { AgentSession } from "../../src/session/agent-session";

export const demoSchema = {
	version: 1,
	title: "Run parameters",
	components: [
		{ type: "slider", id: "concurrency", label: "Concurrent workers", min: 1, max: 32, default: 4 },
		{
			type: "select",
			id: "reasoning",
			label: "Reasoning",
			options: ["off", "low", "medium", "high"].map(value => ({ label: value, value })),
			default: "medium",
		},
		{ type: "button", id: "submit", label: "Submit choices" },
	],
};

/** Real SDK session and persistence; only the provider is deterministic and entirely local. */
export async function createGenerativeUiDemoSession(
	root: string,
	sessionFile?: string,
): Promise<{ session: AgentSession; authStorage: AuthStorage; metrics: { requests: number; sideEffects: number } }> {
	const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
	authStorage.keys.setRuntime("anthropic", "offline-fixture-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	const sessionManager = sessionFile
		? await SessionManager.open(sessionFile, path.join(root, "sessions"), undefined, { throwIfMissing: true })
		: SessionManager.create(root, path.join(root, "sessions"));
	const metrics = { requests: 0, sideEffects: 0 };
	const dependent: CustomTool = {
		name: "dependent_side_effect",
		label: "Dependent side effect",
		description: "Deterministic dependent side effect for lifecycle coverage.",
		parameters: type({}),
		async execute() {
			metrics.sideEffects++;
			await Bun.write(path.join(root, "side-effect.txt"), "unexpected dependent execution");
			return { content: [{ type: "text", text: "side effect executed" }] };
		},
	};
	const { session } = await createAgentSession({
		cwd: root,
		agentDir: path.join(root, "agent"),
		authStorage,
		modelRegistry,
		sessionManager,
		model: getBundledModel("anthropic", "claude-sonnet-4-5"),
		settings: Settings.isolated({ "compaction.enabled": false }),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		toolNames: ["dependent_side_effect"],
		customTools: [dependent],
		allowRestrictedCustomTools: true,
		restrictToolNames: true,
	});
	const mock = createMockModel({
		handler: context => {
			metrics.requests++;
			const requests = metrics.requests;
			session.emitNotice("info", `offline-model-request:${requests}`, "generative-ui-demo");
			const last = context.messages.at(-1)!;
			const lastText = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
			if (last.role === "user" && lastText.includes("invalid-ui")) {
				const schema = lastText.includes("unknown")
					? { version: 1, components: [{ type: "iframe", id: "bad", label: "Unsupported" }, { type: "button", id: "submit", label: "Submit" }] }
					: { ...demoSchema, components: demoSchema.components.map(component => component.type === "slider" ? { ...component, default: 99 } : component) };
				return { content: [{ type: "toolCall", id: `invalid-ui-${requests}`, name: "ui.present", arguments: { schema } }] };
			}
			if (last.role === "user" && lastText.includes("show-ui")) {
				return {
					content: [
						...(lastText.includes("batch") ? [{
							type: "toolCall" as const,
							id: `pre-dependent-call-${requests}`,
							name: "dependent_side_effect",
							arguments: {},
						}] : []),
						{
							type: "toolCall",
							id: `ui-call-${requests}`,
							name: "ui.present",
							arguments: { schema: demoSchema },
						},
						...(lastText.includes("batch") ? [{
							type: "toolCall" as const,
							id: `dependent-call-${requests}`,
							name: "dependent_side_effect",
							arguments: {},
						}] : []),
					],
				};
			}
			// The hidden continuation is only a scheduling reminder. The values must be in an earlier content block.
			const submitted = context.messages.findLast(
				message =>
					JSON.stringify(message.content).includes('\\"ui_id\\"') &&
					JSON.stringify(message.content).includes('\\"values\\"'),
			);
			if (submitted)
				return {
					content: [
						`Received submitted parameters: ${typeof submitted.content === "string" ? submitted.content : JSON.stringify(submitted.content)}`,
					],
				};
			return { content: ["Form presented; adjust the controls locally and submit when ready."] };
		},
	});
	// Public SDK injection seam; no network provider or credentials are consulted by this stream.
	session.agent.streamFn = mock.stream;
	return { session, authStorage, metrics };
}

if (import.meta.main) {
	const root = process.argv[2];
	if (!root || root.startsWith("-")) throw new Error("Expected a temporary root directory");
	process.chdir(root);
	const { session } = await createGenerativeUiDemoSession(root, process.argv[3]);
	await runRpcMode(session);
}
