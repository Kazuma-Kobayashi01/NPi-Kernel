import { describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { UiPresentTool, uiContinuationMessage, type UiSubmitDetails } from "../src/modes/rpc/generative-ui";
import type { AgentSession } from "../src/session/agent-session";
import { createGenerativeUiDemoSession, demoSchema } from "./fixtures/generative-ui-rpc-agent";

const values = { concurrency: 8, reasoning: "high" };
async function show(session: AgentSession, batch = false) {
	await session.refreshRpcHostTools([new UiPresentTool(session.generativeUi)]);
	await session.prompt(batch ? "show-ui batch" : "show-ui");
	const card = session.generativeUi.pendingUi;
	if (!card) throw new Error("Missing waiting interaction");
	return card;
}
function resume(session: AgentSession, submission: UiSubmitDetails) {
	return session.generativeUi.continueSubmission(submission, () => session.promptCustomMessage({ ...uiContinuationMessage, details: submission }));
}
function wake(session: AgentSession) {
	return session.promptCustomMessage({ customType: "test.background", content: "background wake", display: false, attribution: "agent" });
}

describe("Generative UI task lifecycle", () => {
	it("yields successfully before a later same-batch side effect, gates wakes, and resumes once with targeted values", async () => {
		using root = TempDir.createSync("omp-ui-wait-");
		const { session, authStorage, metrics } = await createGenerativeUiDemoSession(root.path());
		try {
			const card = await show(session, true);
			expect(card).toMatchObject({ status: "waiting_input", rendered: false, task_id: "ui-call-1" });
			expect(card.message_id).toBeTruthy();
			expect(metrics).toEqual({ requests: 1, sideEffects: 0 });
			expect(await Bun.file(`${root.path()}/side-effect.txt`).exists()).toBe(false);
			await wake(session);
			expect(metrics.requests).toBe(1);
			await session.generativeUi.rendered(card.ui_id, session.sessionId);
			await session.generativeUi.rendered(card.ui_id, session.sessionId);
			expect(session.generativeUi.pendingUi?.rendered).toBe(true);
			const submission = await session.generativeUi.recordSubmission(card.ui_id, session.sessionId, values);
			await resume(session, submission);
			expect(metrics).toEqual({ requests: 2, sideEffects: 0 });
			expect(session.generativeUi.getState(card.ui_id)).toMatchObject({ status: "submitted", continuation: "admitted" });
			expect(JSON.stringify(session.messages)).toContain("Received submitted parameters");
			await expect(session.generativeUi.recordSubmission(card.ui_id, session.sessionId, values)).rejects.toThrow(/already/);
		} finally { await session.dispose(); authStorage.close(); }
	});

	it("restores waiting input and recovers interrupted admission without duplicating received values", async () => {
		using root = TempDir.createSync("omp-ui-recover-");
		let active = await createGenerativeUiDemoSession(root.path());
		let file: string;
		let ui_id: string;
		let session_id: string;
		try {
			const card = await show(active.session);
			({ ui_id, session_id } = card);
			file = active.session.sessionManager.getSessionFile()!;
		} finally { await active.session.dispose(); active.authStorage.close(); }
		active = await createGenerativeUiDemoSession(root.path(), file!);
		try {
			expect(active.session.generativeUi.pendingUi?.ui_id).toBe(ui_id!);
			expect(active.metrics.requests).toBe(0);
			const submission = await active.session.generativeUi.recordSubmission(ui_id!, session_id!, values);
			await expect(active.session.generativeUi.continueSubmission(submission, async () => { throw new Error("interrupted admission"); })).rejects.toThrow("interrupted admission");
			expect(active.session.generativeUi.getState(ui_id!).continuation).toBe("pending");
		} finally { await active.session.dispose(); active.authStorage.close(); }
		active = await createGenerativeUiDemoSession(root.path(), file!);
		try {
			const submission = await active.session.generativeUi.recordSubmission(ui_id!, session_id!, values);
			await expect(active.session.generativeUi.recordSubmission(ui_id!, session_id!, { ...values, concurrency: 9 })).rejects.toThrow(/already/);
			await resume(active.session, submission);
			expect(active.metrics.requests).toBe(1);
			expect(active.session.sessionManager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === "ui.submit")).toHaveLength(1);
			await expect(active.session.generativeUi.recordSubmission(ui_id!, session_id!, values)).rejects.toThrow(/already/);
		} finally { await active.session.dispose(); active.authStorage.close(); }
	});

	it("settles submit/cancel races once, validates ownership and cancels without invoking the model", async () => {
		using root = TempDir.createSync("omp-ui-cancel-");
		const { session, authStorage, metrics } = await createGenerativeUiDemoSession(root.path());
		try {
			const card = await show(session);
			await expect(session.generativeUi.recordSubmission(card.ui_id, "another-session", values)).rejects.toThrow(/different session/);
			await expect(session.generativeUi.recordSubmission(card.ui_id, session.sessionId, { ...values, concurrency: 99 })).rejects.toThrow();
			const race = await Promise.allSettled([
				session.generativeUi.cancel(card.ui_id, session.sessionId),
				session.generativeUi.recordSubmission(card.ui_id, session.sessionId, values),
			]);
			expect(race.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
			expect(session.generativeUi.getState(card.ui_id).status).toBe("cancelled");
			await wake(session);
			expect(metrics.requests).toBe(1);
			await expect(session.generativeUi.recordSubmission(card.ui_id, session.sessionId, values)).rejects.toThrow(/already/);
			await session.prompt("a new explicit task");
			expect(metrics.requests).toBe(2);
		} finally { await session.dispose(); authStorage.close(); }
	});

	it("expires pending continuation on a new task and cannot resurrect it by historical navigation", async () => {
		using root = TempDir.createSync("omp-ui-expire-");
		const { session, authStorage } = await createGenerativeUiDemoSession(root.path());
		try {
			const card = await show(session);
			const result = session.sessionManager.getBranchView().findLast(entry => entry.type === "message" && entry.message.role === "toolResult")!;
			const submission = await session.generativeUi.recordSubmission(card.ui_id, session.sessionId, values);
			await session.prompt("a new explicit task");
			expect(session.generativeUi.getState(card.ui_id)).toMatchObject({ status: "expired", reason: "new_user_task" });
			await expect(resume(session, submission)).rejects.toThrow(/already/);
			await session.navigateTree(result.id);
			expect(session.generativeUi.pendingUi).toBeNull();
			expect(session.generativeUi.getState(card.ui_id).status).toBe("expired");
		} finally { await session.dispose(); authStorage.close(); }
	});

	it("keeps legacy unbound and inherited fork presentations historical", async () => {
		using root = TempDir.createSync("omp-ui-fork-");
		const { session, authStorage } = await createGenerativeUiDemoSession(root.path());
		try {
			await session.recordCustomMessage({ customType: "ui.present", content: "legacy", display: true, details: { ui_id: "legacy", session_id: session.sessionId, schema: demoSchema } });
			expect(session.generativeUi.pendingUi).toBeNull();
			expect(session.generativeUi.getState("legacy").status).toBe("expired");
			await expect(session.generativeUi.recordSubmission("legacy", session.sessionId, values)).rejects.toThrow(/expired/);
			const card = await show(session);
			await session.fork();
			expect(session.sessionId).not.toBe(card.session_id);
			expect(session.generativeUi.pendingUi).toBeNull();
			expect(session.generativeUi.getState(card.ui_id).status).toBe("expired");
			await expect(session.generativeUi.recordSubmission(card.ui_id, session.sessionId, values)).rejects.toThrow();
		} finally { await session.dispose(); authStorage.close(); }
	});

	it("ignores malformed historical UI for admission while preserving raw isolated error cards", async () => {
		using root = TempDir.createSync("omp-ui-bad-history-");
		const { session, authStorage, metrics } = await createGenerativeUiDemoSession(root.path());
		try {
			await session.recordCustomMessage({ customType: "ui.present", content: "bad identity", display: true, details: { ui_id: 12 } });
			await session.recordCustomMessage({ customType: "ui.present", content: "unsupported schema", display: true, details: { ui_id: "bad-schema", session_id: session.sessionId, schema: { version: 99, components: [] } } });
			expect(session.generativeUi.pendingUi).toBeNull();
			await session.prompt("an ordinary prose task");
			expect(metrics.requests).toBe(1);
			const historical = session.sessionManager.getBranchView().filter(entry => entry.type === "custom_message" && entry.customType === "ui.present");
			expect(historical).toHaveLength(2);
			expect(session.generativeUi.historyStates()).toEqual([]);
		} finally { await session.dispose(); authStorage.close(); }
	});
});
