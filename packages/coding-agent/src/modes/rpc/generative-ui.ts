import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isRecord, Snowflake } from "@oh-my-pi/pi-utils";
import { customMessageEntryMessage } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import type { AgentSession } from "../../session/agent-session";
import type { CustomMessage } from "../../session/messages";
import type { SessionEntry } from "../../session/session-entries";
import description from "../../prompts/tools/ui-present.md" with { type: "text" };
import continuation from "../../prompts/tools/ui-continue.md" with { type: "text" };
import { normalizeUiSchema, uiPresentParameters, validateUiValues, type UiSchema, type UiValue } from "./generative-ui-schema";

export type UiStatus = "waiting_input" | "submitted" | "cancelled" | "expired" | "rendered";
export interface UiStateDetails {
	ui_id: string;
	session_id: string;
	task_id?: string;
	message_id?: string;
	status: UiStatus;
	rendered: boolean;
	reason?: string;
	continuation?: "pending" | "admitted";
}
export interface UiPresentDetails extends UiStateDetails {
	schema: UiSchema;
}
export interface UiSubmitDetails extends UiStateDetails {
	values: Record<string, UiValue>;
}
export interface PendingUi extends UiStateDetails {
	task_id: string;
	message_id: string;
	status: "waiting_input";
}
export type GenerativeUiSession = Pick<AgentSession, "sessionId" | "sessionManager" | "isCompacting" | "recordCustomMessage" | "waitForMessagePersistence" | "messages">;
interface Interaction {
	presentation: UiPresentDetails;
	state: UiStateDetails;
	submission?: UiSubmitDetails;
}

export class UiContinuationAdmissionError extends Error {}

export class GenerativeUiController {
	#session: GenerativeUiSession;
	#available: () => boolean;
	#settling = new Set<string>();
	#continuing = new Set<string>();
	#userTurnSinceCancel = false;
	constructor(session: GenerativeUiSession, available: () => boolean = () => true) {
		this.#session = session;
		this.#available = available;
	}
	setAvailable(available: () => boolean): void {
		this.#available = available;
	}
	clearAdmissionReservations(): void {
		this.#continuing.clear();
		this.#userTurnSinceCancel = false;
	}
	#assertAvailable(): void {
		if (!this.#available() || this.#session.isCompacting)
			throw new Error("Generative UI is unavailable while disabled, compacting, or changing sessions");
	}
	canPresent(params: unknown): boolean {
		if (!this.#available() || this.#session.isCompacting) return false;
		if (!isRecord(params) || Object.keys(params).some(key => key !== "schema") || !("schema" in params)) return false;
		try {
			const schema = normalizeUiSchema(params.schema);
			if (schema.mode === "interactive" && this.pendingUi) return false;
			return true;
		} catch {
			return false;
		}
	}
	/** Presentations are branch-local; settlements are session-wide tombstones, even after tree navigation. */
	#interactions(): Map<string, Interaction> {
		const interactions = new Map<string, Interaction>();
		const branch = this.#session.sessionManager.getBranchView();
		for (const entry of branch) {
			if (entry.type !== "custom_message" || entry.customType !== "ui.present") continue;
			const details = entry.details;
			if (!isRecord(details) || typeof details.ui_id !== "string" || typeof details.session_id !== "string") continue;
			let schema: UiSchema;
			try {
				schema = normalizeUiSchema(details.schema);
			} catch {
				// Untrusted historical schemas remain raw error cards, never admission state.
				continue;
			}
			const task_id = typeof details.task_id === "string" ? details.task_id : undefined;
			const message_id = typeof details.message_id === "string" ? details.message_id : undefined;
			const bound = details.session_id === this.#session.sessionId && task_id !== undefined && message_id !== undefined &&
				branch.some(origin => origin.id === message_id && origin.type === "message" && origin.message.role === "assistant" &&
					origin.message.content.some(block => block.type === "toolCall" && block.id === task_id && block.name === "ui.present"));
			const initialStatus: UiStatus = schema.mode === "display"
				? "rendered"
				: (bound ? "waiting_input" : "expired");
			const state: UiStateDetails = {
				ui_id: details.ui_id, session_id: details.session_id, task_id, message_id,
				status: initialStatus, rendered: schema.mode === "display" || details.rendered === true,
				...(!bound && schema.mode === "interactive" ? { reason: "historical_form" } : {}),
			};
			interactions.set(details.ui_id, { presentation: { ...state, schema }, state });
		}
		for (const entry of this.#session.sessionManager.getEntries()) {
			if (entry.type !== "custom_message" || (entry.customType !== "ui.state" && entry.customType !== "ui.submit")) continue;
			const details = entry.details;
			if (!isRecord(details) || typeof details.ui_id !== "string") continue;
			const interaction = interactions.get(details.ui_id);
			if (!interaction || details.session_id !== interaction.presentation.session_id) continue;
			if (entry.customType === "ui.submit") {
				const submission = details as unknown as UiSubmitDetails;
				interaction.submission = { ...submission, status: "submitted", rendered: submission.rendered ?? false, continuation: submission.continuation ?? "admitted" };
				interaction.state = {
					ui_id: submission.ui_id, session_id: submission.session_id,
					task_id: submission.task_id, message_id: submission.message_id,
					status: "submitted", rendered: submission.rendered ?? false,
					continuation: submission.continuation ?? "admitted",
				};
			} else if (interaction.state.status === "waiting_input" || details.status !== "waiting_input") {
				interaction.state = details as unknown as UiStateDetails;
			}
		}
		for (const interaction of interactions.values()) {
			if (interaction.presentation.status === "expired") {
				interaction.state = { ...interaction.state, status: "expired", reason: "historical_form" };
			}
		}
		return interactions;
	}
	get pendingUi(): PendingUi | null {
		for (const { state } of this.#interactions().values()) {
			if (state.status === "waiting_input") return state as PendingUi;
		}
		return null;
	}
	/** Construction-time model gate also covers maintenance, retries, goals and background wakes. */
	async beforeModelCall(): Promise<{ stop: true } | undefined> {
		const interactions = this.#interactions();
		if ([...interactions.values()].some(({ state }) => state.status === "waiting_input")) return { stop: true };
		for (const { state } of interactions.values()) {
			if (state.status === "submitted" && state.continuation === "pending") {
				if (!this.#continuing.has(state.ui_id)) return { stop: true };
				await this.#recordState({ ...state, continuation: "admitted" });
				this.#continuing.delete(state.ui_id);
			}
		}
		const branch = this.#session.sessionManager.getBranchView();
		const lastCancelled = branch.findLastIndex(entry => entry.type === "custom_message" && entry.customType === "ui.state" &&
			isRecord(entry.details) && entry.details.status === "cancelled");
		if (lastCancelled >= 0 && !this.#userTurnSinceCancel && !branch.slice(lastCancelled + 1).some(entry => entry.type === "message" &&
			entry.message.role === "user" && entry.message.attribution !== "agent")) return { stop: true };
		return undefined;
	}
	async #persist(message: Pick<CustomMessage, "customType" | "content" | "display" | "details" | "attribution">): Promise<void> {
		await this.#session.recordCustomMessage(message);
		await this.#session.sessionManager.ensureOnDisk();
		await this.#session.sessionManager.flush();
	}
	async #recordState(details: UiStateDetails): Promise<UiStateDetails> {
		await this.#persist({ customType: "ui.state", content: JSON.stringify(details), details, display: true, attribution: "agent" });
		return details;
	}
	async present(params: unknown, toolCallId?: string): Promise<UiStateDetails> {
		this.#assertAvailable();
		if (!isRecord(params) || Object.keys(params).some(key => key !== "schema") || !("schema" in params))
			throw new Error("ui.present requires only schema");
		const schema = normalizeUiSchema(params.schema);
		await this.#session.waitForMessagePersistence();
		const origin = this.#session.sessionManager.getBranchView().findLast(entry => entry.type === "message" && entry.message.role === "assistant" &&
			entry.message.content.some(block => block.type === "toolCall" && block.id === toolCallId && block.name === "ui.present"));
		if (!toolCallId || !origin) throw new Error("ui.present requires an assistant tool call in the current branch");
		const existing = [...this.#interactions().values()].find(({ presentation }) =>
			presentation.task_id === toolCallId && presentation.message_id === origin.id);
		if (existing) return existing.state;
		if (schema.mode === "interactive" && this.pendingUi) throw new Error("A UI interaction is already waiting for input");
		const initialStatus: UiStatus = schema.mode === "display" ? "rendered" : "waiting_input";
		const details: UiPresentDetails = {
			ui_id: Snowflake.next() as string, session_id: this.#session.sessionId,
			task_id: toolCallId, message_id: origin.id, status: initialStatus,
			rendered: schema.mode === "display", schema,
		};
		const msgContent = schema.mode === "display" ? "Display UI presentation." : "Interactive form waiting for user input.";
		await this.#persist({ customType: "ui.present", content: msgContent, display: true, details, attribution: "agent" });
		return {
			ui_id: details.ui_id, session_id: details.session_id, task_id: toolCallId,
			message_id: origin.id, status: initialStatus, rendered: schema.mode === "display",
		};
	}
	#lookup(ui_id: unknown, session_id: unknown): Interaction {
		if (typeof ui_id !== "string" || session_id !== this.#session.sessionId)
			throw new Error("UI interaction belongs to a different session");
		const interaction = this.#interactions().get(ui_id);
		if (!interaction || interaction.presentation.session_id !== session_id)
			throw new Error("UI is not on the current session branch");
		return interaction;
	}
	async rendered(ui_id: unknown, session_id: unknown): Promise<UiStateDetails> {
		const { state } = this.#lookup(ui_id, session_id);
		if (state.rendered || state.status !== "waiting_input") return state;
		return this.#recordState({ ...state, rendered: true });
	}
	async cancel(ui_id: unknown, session_id: unknown): Promise<UiStateDetails> {
		const { state } = this.#lookup(ui_id, session_id);
		if (state.status !== "waiting_input" || this.#settling.has(state.ui_id)) throw new Error(`UI is already ${state.status}`);
		this.#settling.add(state.ui_id);
		this.#userTurnSinceCancel = false;
		try { return await this.#recordState({ ...state, status: "cancelled" }); }
		finally { this.#settling.delete(state.ui_id); }
	}
	async expirePending(reason: string): Promise<void> {
		if (reason === "new_user_task") this.#userTurnSinceCancel = true;
		for (const { state } of this.#interactions().values()) {
			if (state.status === "waiting_input" || (state.status === "submitted" && state.continuation === "pending")) {
				await this.#recordState({ ...state, status: "expired", reason });
				this.#continuing.delete(state.ui_id);
			}
		}
	}
	/** Reserve before the first await; submitted pending receipts may retry admission, never values. */
	async recordSubmission(ui_id: unknown, session_id: unknown, values: unknown): Promise<UiSubmitDetails> {
		const interaction = this.#lookup(ui_id, session_id);
		if (this.#continuing.has(interaction.state.ui_id)) throw new Error("UI continuation is already being admitted");
		const { state, presentation } = interaction;
		if (this.#settling.has(state.ui_id)) throw new Error("UI has already been submitted or cancelled");
		const validated = validateUiValues(presentation.schema, values);
		if (state.status === "submitted" && state.continuation === "pending" && interaction.submission) {
			if (JSON.stringify(validated) !== JSON.stringify(interaction.submission.values)) throw new Error("UI values have already been submitted");
			return { ...interaction.submission, ...state, values: interaction.submission.values };
		}
		if (state.status !== "waiting_input") throw new Error(`UI has already been ${state.status}`);
		const details: UiSubmitDetails = { ...state, status: "submitted", continuation: "pending", values: validated };
		this.#settling.add(state.ui_id);
		try {
			await this.#persist({ customType: "ui.submit", content: JSON.stringify({ ui_id, values: details.values }), details, display: true, attribution: "user" });
			return details;
		} finally { this.#settling.delete(state.ui_id); }
	}
	async continueSubmission(details: UiSubmitDetails, start: () => Promise<boolean>): Promise<boolean> {
		if (this.#continuing.has(details.ui_id)) throw new UiContinuationAdmissionError("UI continuation is already being admitted");
		const current = this.#lookup(details.ui_id, details.session_id).state;
		if (current.status !== "submitted" || current.continuation !== "pending") throw new UiContinuationAdmissionError("UI continuation was already admitted");
		this.#continuing.add(details.ui_id);
		try {
			const started = await start();
			if (!started) this.#continuing.delete(details.ui_id);
			return started;
		} catch (error) {
			this.#continuing.delete(details.ui_id);
			throw error;
		}
	}
	getState(ui_id: string): UiStateDetails {
		const interaction = this.#interactions().get(ui_id);
		if (!interaction) throw new Error("UI is not on the current session branch");
		return interaction.state;
	}
	/** Project session-wide tombstones and inert inherited/legacy forms into ordinary history. */
	historyStates(): CustomMessage[] {
		return [...this.#interactions().values()].map(({ state }) => ({
			role: "custom", customType: "ui.state", content: JSON.stringify(state), details: state,
			display: true, attribution: "agent", timestamp: Date.now(),
		}));
	}
}
export class UiPresentTool implements AgentTool<typeof uiPresentParameters> {
	readonly name = "ui.present";
	readonly approval = "read" as const;
	readonly label = "Interactive UI";
	readonly description = description;
	readonly parameters = uiPresentParameters;
	readonly strict = true;
	readonly lenientArgValidation = true;
	readonly concurrency = "exclusive";
	readonly loadMode = "essential";
	constructor(private readonly controller: GenerativeUiController) {}
	async execute(id: string, params: unknown): Promise<AgentToolResult<unknown>> {
		try {
			const details = await this.controller.present(params, id);
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		} catch (error) {
			return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: {}, isError: true };
		}
	}
}
export const uiContinuationMessage: Pick<CustomMessage, "customType" | "content" | "display" | "attribution"> = {
	customType: "ui.continue", content: continuation, display: false, attribution: "user",
};
export function generativeUiHistoryMessage(entry: SessionEntry): CustomMessage | undefined {
	if (entry.type !== "custom_message" || !["ui.present", "ui.submit", "ui.state"].includes(entry.customType)) return undefined;
	return customMessageEntryMessage(entry);
}
