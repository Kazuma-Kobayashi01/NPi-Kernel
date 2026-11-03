import type { AgentToolContext, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { judgeQuestions, type Model } from "@oh-my-pi/pi-ai";
import { resolveThinkingLevelForModel } from "@oh-my-pi/pi-tui/thinking";
import { formatModelStringWithRouting, resolveModelOverride } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { journalJudgmentUsage, resolveJudge } from "../judgment";
import modelQuestions from "../prompts/judge/subagent-model.json" with { type: "json" };
import { cfgRetryModelFallback, cfgRetryUsageAwareFallback } from "../session/settings";
import type { ToolSession } from "../tools";
import { AskTool } from "../tools/ask";
import { EventBus } from "../utils/event-bus";
import { getSubagentConcurrencyLimit, readSubagentPreferences, type SubagentPreferences } from "./delegation-preferences";
import { Semaphore } from "./parallel";
import { cfgTaskDelegationAppetite, cfgTaskSubagentModelMode, SUBAGENT_THINKING_LEVELS } from "./settings";

export interface DelegationSelection {
	model: string;
	thinking: SubagentPreferences["thinking"];
}

interface RootDelegationContext {
	session: ToolSession;
	semaphore: Semaphore;
	ask: Semaphore;
	active: Map<string, number>;
	waiting: AbortController;
	selections: Map<string, DelegationSelection>;
}
const roots = new WeakMap<object, RootDelegationContext>();
const sessions = new WeakMap<object, ToolSession>();

function context(session: ToolSession): RootDelegationContext {
	const key = session.subagentEventBus ??= new EventBus();
	let root = roots.get(key);
	if (!root) {
		root = { session, semaphore: new Semaphore(0), ask: new Semaphore(1), active: new Map(), waiting: new AbortController(), selections: new Map() };
		roots.set(key, root);
		const captured = root;
		session.settings.onEffectiveChange([cfgTaskDelegationAppetite, cfgTaskSubagentModelMode], () => {
			resize(captured);
			if (readSubagentPreferences(session)?.appetite === "off") {
				captured.waiting.abort(new Error("Subagent delegation is off."));
				captured.waiting = new AbortController();
			}
		});
	}
	return root;
}

/** Install the root before constructing any child; descendants retain live owner settings and selectors. */
export function registerDelegationContext(session: ToolSession): void {
	context(session);
}

export function bindDelegationSession(owner: object, session: ToolSession): void {
	sessions.set(owner, session);
}

export function delegationOwner(session: ToolSession): ToolSession {
	return context(session).session;
}

export function delegationPreferences(session: ToolSession): SubagentPreferences | undefined {
	return readSubagentPreferences(delegationOwner(session));
}

export function rememberDelegationSelection(session: ToolSession, id: string, selection: DelegationSelection | undefined): void {
	if (selection) context(session).selections.set(id, selection);
}

export interface DelegationModelSession {
	settings: Settings;
	disarmPrewalk(): void;
	model: Model | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	setModelTemporary(model: Model, thinkingLevel?: SubagentPreferences["thinking"]): Promise<void>;
	setThinkingLevel(level: SubagentPreferences["thinking"]): void;
}

/** Applied before each resumed/wake turn; Sync reads the root, never a parent's stale snapshot. */
export async function applyDelegationModel(owner: DelegationModelSession): Promise<void> {
	const session = sessions.get(owner);
	if (!session || (session.taskDepth ?? 0) === 0) return;
	const preferences = delegationPreferences(session);
	if (!preferences) return;
	const selection = preferences.mode === "auto"
		? context(session).selections.get(session.getAgentId!()!)
		: fixedSelection(delegationOwner(session), preferences);
	if (!selection) throw new Error("No confirmed Auto model selection for this subagent.");
	const model = validateDelegationSelection(session, selection);
	if (!owner.model || formatModelStringWithRouting(owner.model) !== selection.model) await owner.setModelTemporary(model, selection.thinking);
	cfgRetryModelFallback.override(owner.settings, false);
	cfgRetryUsageAwareFallback.override(owner.settings, false);
	owner.disarmPrewalk();
	owner.setThinkingLevel(selection.thinking);
}

function resize(root: RootDelegationContext): boolean {
	const enabled = readSubagentPreferences(root.session) !== undefined;
	root.semaphore.resize(enabled ? getSubagentConcurrencyLimit(root.session) : 0, enabled);
	return enabled;
}

function retain(root: RootDelegationContext, id: string): () => void {
	root.active.set(id, (root.active.get(id) ?? 0) + 1);
	return () => {
		const count = root.active.get(id)! - 1;
		if (count > 0) root.active.set(id, count);
		else {
			root.active.delete(id);
			resize(root);
			root.semaphore.release();
		}
	};
}

/** Root launches queue; nested launches reject saturation instead of waiting on their own parent. */
export async function acquireDelegationSlot(session: ToolSession, id: string, signal?: AbortSignal): Promise<() => void> {
	const root = context(session);
	resize(root);
	if (readSubagentPreferences(root.session)?.appetite === "off") throw new Error("Subagent delegation is off.");
	if (root.active.has(id)) return retain(root, id);
	if ((session.taskDepth ?? 0) > 0) {
		if (!root.semaphore.tryAcquire()) throw new Error("Subagent concurrency limit reached; nested delegation cannot wait for its parent.");
	} else {
		await root.semaphore.acquire(signal ? AbortSignal.any([signal, root.waiting.signal]) : root.waiting.signal);
	}
	return retain(root, id);
}

/** All autonomous and resumed turns share the same root slots as fresh structured spawns. */
export function beginDelegationTurn(owner: object): (() => void) | undefined {
	const session = sessions.get(owner);
	if (!session || (session.taskDepth ?? 0) === 0) return undefined;
	const root = context(session);
	resize(root);
	if (readSubagentPreferences(root.session)?.appetite === "off") throw new Error("Subagent delegation is off; resume was not started.");
	const id = session.getAgentId!()!;
	if (root.active.has(id)) return retain(root, id);
	if (!root.semaphore.tryAcquire()) throw new Error("Subagent concurrency limit reached or delegation is off; resume was not started.");
	return retain(root, id);
}

const thinkingLevels = SUBAGENT_THINKING_LEVELS;

export function validateDelegationSelection(session: ToolSession, selection: DelegationSelection): Model {
	const owner = delegationOwner(session);
	const resolved = resolveModelOverride([selection.model], owner.modelRegistry!, owner.settings).model;
	if (!resolved || formatModelStringWithRouting(resolved) !== selection.model || !owner.modelRegistry!.hasConfiguredAuth(resolved)) {
		throw new Error(`Subagent model is unavailable: ${selection.model || "(empty Custom model)"}`);
	}
	if (!thinkingLevels.includes(selection.thinking)) throw new Error(`Invalid subagent thinking level: ${selection.thinking}`);
	const supported = resolveThinkingLevelForModel(resolved, selection.thinking) ?? "off";
	if (supported !== selection.thinking) throw new Error(`Thinking level ${selection.thinking} is not supported by ${selection.model}.`);
	return resolved;
}

function fixedSelection(owner: ToolSession, preferences: SubagentPreferences): DelegationSelection {
	if (preferences.mode === "custom") return { model: preferences.model, thinking: preferences.thinking };
	const model = owner.getActiveModel?.();
	const thinking = owner.getActiveThinkingLevel?.() ?? "off";
	if (!thinkingLevels.includes(thinking as SubagentPreferences["thinking"])) throw new Error(`Invalid root thinking level: ${thinking}`);
	return { model: model ? formatModelStringWithRouting(model) : "", thinking: thinking as SubagentPreferences["thinking"] };
}

const selectionQuestions = judgeQuestions(modelQuestions);

/** Only free-text Auto answers need semantic interpretation; persisted selectors stay exact. */
async function resolveTypedModel(
	owner: ToolSession,
	request: string,
	signal: AbortSignal | undefined,
	toolContext: AgentToolContext | undefined,
): Promise<string> {
	const registry = owner.modelRegistry!;
	const available = registry.getAvailable().filter(model => registry.hasConfiguredAuth(model));
	const remaining = new Map(available.map((model, index) => [`M${index}`, model]));
	const matches: Model[] = [];
	const judge = resolveJudge({
		settings: owner.settings,
		registry,
		sessionModel: owner.getActiveModel?.(),
		sessionId: owner.getSessionId?.() ?? undefined,
		purpose: "subagent-model-selection",
		onUsage: journalJudgmentUsage(owner.sessionManager),
		costGate: owner.costGate,
	});
	while (remaining.size > 0) {
		signal?.throwIfAborted();
		const criteria: Record<string, string | null> = { NONE: null };
		const candidates = Array.from(remaining, ([key, model]) => {
			criteria[key] = null;
			return { key, selector: formatModelStringWithRouting(model), name: model.name, provider: model.provider };
		});
		const { answers } = await judge.judge({
			state: { request, candidates },
			questions: {
				model: { ...selectionQuestions.model, criteria },
				multiple: selectionQuestions.multiple,
			},
		}, { signal });
		const key = answers.model.choice;
		if (key === "NONE") break;
		const model = remaining.get(key);
		if (!model) throw new Error(`Model judgment returned an unknown candidate: ${key}`);
		matches.push(model);
		remaining.delete(key);
		if (answers.multiple.noul < 0.5) break;
	}
	signal?.throwIfAborted();
	if (matches.length === 0) throw new Error(`No available subagent model matches: ${request}`);
	if (matches.length === 1) return formatModelStringWithRouting(matches[0]!);
	const selectors = matches.map(formatModelStringWithRouting);
	const result = await new AskTool(owner, { disableTimeout: true }).execute("subagent-model-confirm", {
		questions: [{
			id: "model",
			question: `Multiple available models match “${request}”. Which provider/model should this batch use?`,
			options: matches.map((model, index) => ({ label: selectors[index]!, description: model.name })),
		}],
	}, signal, undefined, toolContext ?? owner.getToolContext?.());
	const answer = result.details;
	const selector = answer?.customInput ?? answer?.selectedOptions?.[0];
	if (answer?.timedOut || !selector || !selectors.includes(selector)) {
		throw new Error("Choose an explicit model candidate; no agents were started.");
	}
	return selector;
}

/** No UI work occurs during preflight; a caller explicitly resolves one selection per dispatch batch. */
export async function selectDelegationModel(
	session: ToolSession,
	signal?: AbortSignal,
	toolContext?: AgentToolContext,
): Promise<DelegationSelection | undefined> {
	const preferences = delegationPreferences(session);
	if (!preferences) return undefined;
	if (preferences.appetite === "off") throw new Error("Subagent delegation is off.");
	const owner = delegationOwner(session);
	let selection: DelegationSelection;
	if (preferences.mode !== "auto") {
		selection = fixedSelection(owner, preferences);
	} else {
		const available = owner.modelRegistry!.getAvailable();
		const current = owner.getActiveModel?.();
		const candidates = current ? [current, ...available.filter(model => formatModelStringWithRouting(model) !== formatModelStringWithRouting(current))] : available;
		// Every configured model, the current one first and recommended: a long list is a dropdown in the Desktop form.
		const models = candidates.filter(model => owner.modelRegistry!.hasConfiguredAuth(model));
		if (models.length === 0) throw new Error("No available subagent models.");
		const ask = context(session).ask;
		await ask.acquire(signal);
		try {
		const result = await new AskTool(owner, { disableTimeout: true }).execute("subagent-preferences", {
			questions: [
				{ id: "model", question: "Which model should this subagent batch use?", options: models.map(model => ({ label: formatModelStringWithRouting(model) })), recommended: 0 },
				{ id: "thinking", question: "Which thinking level should this subagent batch use?", options: thinkingLevels.map(label => ({ label })), recommended: Math.max(0, thinkingLevels.indexOf((owner.getActiveThinkingLevel?.() ?? "off") as SubagentPreferences["thinking"])) },
			],
		}, signal, undefined, toolContext ?? owner.getToolContext?.());
		const answers = result.details?.results;
		const model = answers?.find(answer => answer.id === "model");
		const thinking = answers?.find(answer => answer.id === "thinking");
		const modelValue = model?.customInput ?? model?.selectedOptions[0];
		const thinkingValue = thinking?.customInput ?? thinking?.selectedOptions[0];
		if (!modelValue || !thinkingValue || model?.timedOut || thinking?.timedOut) throw new Error("Subagent selection was cancelled; no agents were started.");
		if (!thinkingLevels.includes(thinkingValue as SubagentPreferences["thinking"])) throw new Error(`Invalid subagent thinking level: ${thinkingValue}`);
		selection = {
			model: model?.customInput
				? await resolveTypedModel(owner, modelValue.trim(), signal, toolContext)
				: modelValue.trim(),
			thinking: thinkingValue as SubagentPreferences["thinking"],
		};
		} finally {
			ask.release();
		}
	}
	validateDelegationSelection(session, selection);
	return selection;
}
