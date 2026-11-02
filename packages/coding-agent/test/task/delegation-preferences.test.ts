import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "../../src/config/settings";
import { ModelRegistry } from "../../src/config/model-registry";
import type { ExtensionAskDialogQuestion, ExtensionAskDialogResult } from "../../src/extensibility/extensions";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AuthStorage } from "../../src/session/auth-storage";
import { AsyncJobManager } from "../../src/async/job-manager";
import { runEvalAgent } from "../../src/eval/agent-bridge";
import { runEvalWorkpool } from "../../src/eval/workpool-bridge";
import { WorkPoolRegistry } from "../../src/task/workpool";
import { TaskTool } from "../../src/task";
import * as discovery from "../../src/task/discovery";
import {
	acquireDelegationSlot,
	registerDelegationContext,
	selectDelegationModel,
} from "../../src/task/delegation-runtime";
import { runSubagentFollowUpTurn } from "../../src/task/executor";
import { resolveEffectiveSubagentPolicy, runStructuredSubagent } from "../../src/task/structured-subagent";
import {
	cfgTaskDelegationAppetite,
	cfgTaskSubagentModelMode,
	cfgTaskSubagentCustomModel,
	cfgTaskSubagentCustomThinking,
} from "../../src/task/settings";
import type { AgentDefinition } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import { EventBus } from "../../src/utils/event-bus";

const resources: Array<{ root: string; auth: AuthStorage; source: string }> = [];
const managers = new Set<AsyncJobManager>();

afterEach(async () => {
	for (const manager of managers) await manager.dispose();
	managers.clear();
	WorkPoolRegistry.resetForTests();
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	vi.restoreAllMocks();
	for (const resource of resources.splice(0)) {
		unregisterCustomApis(resource.source);
		resource.auth.close();
		await fs.rm(resource.root, { recursive: true, force: true });
	}
});
beforeAll(async () => {
	await initTheme(false);
});

async function fixture(mode: "auto" | "sync" | "custom" = "custom") {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "npi-delegation-policy-"));
	const auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("mock", "local-only");
	const source = `delegation-${root}`;
	registerMockApi(source);
	resources.push({ root, auth, source });
	const models = ["first", "second", "third"].map(id => createMockModel({ id, handler: () => ({ content: [`done ${id}`] }) }));
	const registry = new ModelRegistry(auth, path.join(root, "models.yml"));
	const find = registry.find.bind(registry);
	vi.spyOn(registry, "find").mockImplementation((provider, id) => models.find(model => provider === "mock" && model.id === id) ?? find(provider, id));
	vi.spyOn(registry, "getAvailable").mockImplementation(() => models);
	const settings = Settings.isolated({
		"async.enabled": false,
		"task.batch": true,
		"task.structured": false,
		"task.enableEffort": true,
		"task.maxRecursionDepth": 4,
		"task.agentIdleTtlMs": 0,
		"task.isolation.enabled": false,
		"compaction.enabled": false,
		"todo.enabled": false,
		"retry.enabled": false,
		"ask.timeout": 1,
	});
	cfgTaskDelegationAppetite.override(settings, "conservative");
	cfgTaskSubagentModelMode.override(settings, mode);
	cfgTaskSubagentCustomModel.override(settings, "mock/first");
	cfgTaskSubagentCustomThinking.override(settings, "off");
	let active: MockModel = models[0]!;
	let thinking: ThinkingLevel | undefined = "off";
	const agent: AgentDefinition = { name: "worker", source: "bundled", description: "Test worker", systemPrompt: "Complete the assigned work.", tools: ["read"], model: ["mock/third"], thinkingLevel: "auto" };
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
	const session: ToolSession = {
		cwd: root,
		hasUI: false,
		canPromptUser: true,
		settings,
		authStorage: auth,
		modelRegistry: registry,
		subagentEventBus: new EventBus(),
		getSessionFile: () => path.join(root, "root.jsonl"),
		getArtifactsDir: () => path.join(root, "root"),
		getSessionSpawns: () => "*",
		getAgentId: () => "Main",
		getActiveModel: () => active,
		getActiveModelString: () => `mock/${active.id}`,
		getActiveThinkingLevel: () => thinking,
		enableMCP: false,
		enableLsp: false,
		enableIrc: false,
		restrictToolNames: true,
		suppressSpawnAdvisory: true,
	};
	registerDelegationContext(session);
	return { session, settings, models, agent, setActive(model: MockModel, level: ThinkingLevel = "off") { active = model; thinking = level; } };
}

function interactive(answer: (questions: ExtensionAskDialogQuestion[], options?: { timeout?: number }) => Promise<ExtensionAskDialogResult | undefined>): AgentToolContext {
	return { hasUI: true, abort() {}, ui: { askDialog: answer } } as unknown as AgentToolContext;
}

function submit(questions: ExtensionAskDialogQuestion[], model = "mock/second", thinking = "off"): ExtensionAskDialogResult {
	return {
		kind: "submit",
		results: questions.map(question => ({
			id: question.id,
			question: question.question,
			options: question.options.map(option => option.label),
			multi: false,
			selectedOptions: [question.id === "model" ? model : thinking],
		})),
	};
}

function run(session: ToolSession, id: string, keepAlive = false) {
	return runStructuredSubagent({ session, invocationKind: "task", assignment: "Return a short answer.", agent: "worker", identity: { id }, structured: false, keepAlive, enableIrc: false, enableLsp: false });
}

describe("Desktop delegation consumers", () => {
	it("asks exactly two questions once for a real task batch, with no timeout or per-task model escape", async () => {
		const { session, models } = await fixture("auto");
		let dialogs = 0;
		const context = interactive(async (questions, options) => {
			dialogs++;
			expect(questions.map(question => question.id)).toEqual(["model", "thinking"]);
			expect(questions[0]!.options).toHaveLength(3);
			expect(options?.timeout).toBeUndefined();
			return submit(questions);
		});
		session.getToolContext = () => context;
		session.emitBeforeSubagentSpawn = async () => ({ model: "mock/third" });
		const tool = await TaskTool.create(session);
		const result = await tool.execute("auto-batch", { context: "Shared context", tasks: [{ agent: "worker", task: "First item", model: "mock/third", effort: "hi" }, { agent: "worker", task: "Second item", model: "mock/first" }] }, undefined, undefined, context);
		if (result.isError) throw new Error("TEST 1 ERROR: " + JSON.stringify(result));
		expect(result.isError).not.toBe(true);
		expect(dialogs).toBe(1);
		expect(models.map(model => model.calls.length)).toEqual([0, 2, 0]);
	});

	it("keeps preflight non-interactive; cancelling Auto or running without UI never reaches the executor", async () => {
		const { session, models } = await fixture("auto");
		let dialogs = 0;
		session.getToolContext = () => interactive(async () => { dialogs++; return undefined; });
		await resolveEffectiveSubagentPolicy({ session, invocationKind: "task", assignment: "Inspect", agent: "worker" });
		expect(dialogs).toBe(0);
		await expect(run(session, "Cancelled")).rejects.toThrow();
		expect(dialogs).toBe(1);
		session.getToolContext = () => undefined;
		await expect(run(session, "Headless")).rejects.toThrow("interactive mode");
		expect(models.every(model => model.calls.length === 0)).toBe(true);
		expect(AgentRegistry.global().get("Cancelled")).toBeUndefined();
		expect(AgentRegistry.global().get("Headless")).toBeUndefined();
	});

	it("rejects an unsupported Auto thinking choice instead of silently clamping it", async () => {
		const { session, models } = await fixture("auto");
		session.getToolContext = () => interactive(async questions => submit(questions, "mock/first", "max"));
		await expect(run(session, "Unsupported")).rejects.toThrow("not supported");
		expect(models[0]!.calls).toHaveLength(0);
	});

	it("pins Custom through the actual executor despite agent defaults, task parameters and routing hooks", async () => {
		const { session, models } = await fixture();
		session.emitBeforeSubagentSpawn = async () => ({ model: "mock/third" });
		const result = await runStructuredSubagent({ session, invocationKind: "task", assignment: "Answer", agent: "worker", identity: { id: "Custom" }, model: ["mock/third", "mock/second"], effort: "hi", structured: false, keepAlive: false });
		expect(result.result.exitCode).toBe(0);
		expect(models.map(model => model.calls.length)).toEqual([1, 0, 0]);
		expect(result.policy.delegationSelection).toEqual({ model: "mock/first", thinking: "off" });
	});

	it("reports empty and unavailable Custom selectors before any child exists", async () => {
		const { session, settings, models } = await fixture();
		for (const model of ["", "mock/missing"]) {
			cfgTaskSubagentCustomModel.override(settings, model);
			await expect(run(session, "Invalid")).rejects.toThrow("unavailable");
		}
		expect(models.every(model => model.calls.length === 0)).toBe(true);
	});

	it("Sync descendants read root selectors live, not their parent's model snapshot", async () => {
		const { session, models, setActive } = await fixture("sync");
		Object.assign(models[1]!, { reasoning: true, thinking: { efforts: ["low", "high"], mode: "anthropic-adaptive" } });
		const nested: ToolSession = { ...session, settings: session.settings.overlay({}), taskDepth: 1, getAgentId: () => "Parent", getActiveModel: () => models[2], getActiveThinkingLevel: () => "max" };
		await run(nested, "SyncOne");
		setActive(models[1]!, "high");
		await run(nested, "SyncTwo");
		expect(models.map(model => model.calls.length)).toEqual([1, 1, 0]);
		expect(models[1]!.calls[0]!.options?.reasoning).toBe("high");
	});

	it("shares admission across mixed frontends, isolates roots, and rejects saturated nesting without waiting", async () => {
		const { session } = await fixture();
		const releaseTask = await acquireDelegationSlot(session, "Task");
		const releaseEval = await acquireDelegationSlot(session, "Eval");
		let started = false;
		const pendingPool = acquireDelegationSlot(session, "Pool").then(release => { started = true; return release; });
		await Promise.resolve();
		expect(started).toBe(false);
		await expect(acquireDelegationSlot({ ...session, taskDepth: 1 }, "Nested")).rejects.toThrow("nested delegation");
		const independent: ToolSession = { ...session, subagentEventBus: new EventBus() };
		const releaseIndependent = await acquireDelegationSlot(independent, "OtherConversation");
		releaseIndependent();
		releaseTask();
		const releasePool = await pendingPool;
		expect(started).toBe(true);
		releasePool();
		releaseEval();
	});

	it("lets existing holders drain after a lower cap and cancels queued starts when switched Off", async () => {
		const { session, settings } = await fixture();
		cfgTaskDelegationAppetite.override(settings, "moderate");
		const releases = await Promise.all(["One", "Two", "Three"].map(id => acquireDelegationSlot(session, id)));
		cfgTaskDelegationAppetite.override(settings, "conservative");
		let started = false;
		const pending = acquireDelegationSlot(session, "Queued").then(release => { started = true; return release; });
		releases[0]!();
		await Promise.resolve();
		expect(started).toBe(false);
		releases[1]!();
		const release = await pending;
		release();
		const waiting = acquireDelegationSlot(session, "Waiting");
		const occupied = await waiting;
		const blocked = acquireDelegationSlot(session, "OffQueue");
		cfgTaskDelegationAppetite.override(settings, "off");
		await expect(blocked).rejects.toThrow("off");
		await expect(acquireDelegationSlot(session, "Off")).rejects.toThrow("off");
		occupied();
		releases[2]!();
	});

	it("counts idle/parked agents only when they resume, and reapplies live Sync on a real parked follow-up", async () => {
		const { session, models, agent, setActive } = await fixture("sync");
		await run(session, "Resumable", true);
		await AgentLifecycleManager.global().park("Resumable");
		const releaseOne = await acquireDelegationSlot(session, "One");
		const releaseTwo = await acquireDelegationSlot(session, "Two");
		const resumed = await AgentLifecycleManager.global().ensureLive("Resumable");
		await expect(resumed.prompt("No slot is available.")).rejects.toThrow("limit reached");
		releaseOne();
		releaseTwo();
		setActive(models[1]!);
		const result = await runSubagentFollowUpTurn({ id: "Resumable", agent, message: "Continue with a short answer.", structured: false });
		expect(result.exitCode).toBe(0);
		expect(models.map(model => model.calls.length)).toEqual([1, 1, 0]);
	});

	it("reuses one actual Auto Ask result for a workpool push and asks separately for eval agent()", async () => {
		const { session, models } = await fixture("auto");
		const manager = new AsyncJobManager({ retentionMs: 0 });
		managers.add(manager);
		session.asyncJobManager = manager;
		let dialogs = 0;
		session.getToolContext = () => interactive(async questions => {
			dialogs++;
			return submit(questions);
		});
		models[1]!.fallback = context => {
			const hasYield = context.messages?.some(m => m.role === "toolResult");
			if (hasYield) return { content: ["all done"] };
			return {
				content: [{
					type: "toolCall",
					name: "yield",
					arguments: JSON.stringify(context.messages).includes("<workpool")
						? { key: 1, data: "done" }
						: { data: "done" },
				}],
			};
		};
		await runEvalWorkpool({ op: "create", name: "AutoPool", agent: "worker" }, { session });
		expect(dialogs).toBe(0);
		await runEvalWorkpool({ op: "push", name: "AutoPool", items: ["First", "Second"] }, { session });
		expect(dialogs).toBe(1);
		await runEvalAgent({ agent: "worker", prompt: "Separate eval invocation" }, { session });
		expect(dialogs).toBe(2);
		await manager.waitForAll();
		expect(models.map(model => model.calls.length)).toEqual([0, 5, 0]);
		await runEvalWorkpool({ op: "close", name: "AutoPool" }, { session });
	}, 30_000);

	it("bounds actual task, eval and two workpool executors by one root cap", async () => {
		const { session, models } = await fixture();
		const manager = new AsyncJobManager({ retentionMs: 0 });
		managers.add(manager);
		session.asyncJobManager = manager;
		const gates: PromiseWithResolvers<void>[] = [];
		const started = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
		let running = 0;
		let peak = 0;
		models[0]!.fallback = async context => {
			const gate = Promise.withResolvers<void>();
			gates.push(gate);
			peak = Math.max(peak, ++running);
			started[gates.length - 1]?.resolve();
			await gate.promise;
			running--;
			const pooled = JSON.stringify(context.messages).includes("<workpool");
			return context.tools?.some(tool => tool.name === "yield")
				? { content: [{ type: "toolCall", name: "yield", arguments: pooled ? { key: 1, data: "done" } : { data: "done" } }] }
				: { content: ["done"] };
		};
		const tool = await TaskTool.create(session);
		const task = tool.execute("mixed-task", { context: "Shared context", tasks: [{ agent: "worker", task: "Task item" }] });
		await started[0]!.promise;
		await runEvalAgent({ agent: "worker", prompt: "Eval item" }, { session });
		await started[1]!.promise;
		for (const name of ["PoolOne", "PoolTwo"]) {
			await runEvalWorkpool({ op: "create", name, agent: "worker" }, { session });
			await runEvalWorkpool({ op: "push", name, items: ["Pool item"] }, { session });
		}
		expect(gates).toHaveLength(2);
		gates[0]!.resolve();
		gates[1]!.resolve();
		await started[3]!.promise;
		expect(peak).toBe(2);
		gates[2]!.resolve();
		gates[3]!.resolve();
		const [taskResult] = await Promise.all([task, manager.waitForAll()]);
		expect(taskResult.isError).not.toBe(true);
		expect(models[0]!.calls).toHaveLength(6);
		for (const name of ["PoolOne", "PoolTwo"]) await runEvalWorkpool({ op: "close", name }, { session });
	}, 30_000);

	it("leaves unconfigured CLI selection and concurrency behavior unchanged", async () => {
		const { session, settings } = await fixture();
		cfgTaskSubagentModelMode.override(settings, "default");
		expect(await selectDelegationModel(session)).toBeUndefined();
		const releases = await Promise.all(Array.from({ length: 5 }, (_, index) => acquireDelegationSlot(session, `Cli${index}`)));
		for (const release of releases) release();
	});
});
