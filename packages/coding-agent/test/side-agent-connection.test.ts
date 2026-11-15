import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type SideAgentHost,
	SideAgentAuthRequiredError,
	SideAgentConnection,
} from "@oh-my-pi/pi-coding-agent/side-agent/connection";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from "@oh-my-pi/pi-utils/acp";

// A real stdio agent process (fixtures/side-agent-fake.ts) on the other end: framing, the
// handshake and every client callback go over actual pipes.
const FAKE_AGENT = path.join(import.meta.dir, "fixtures", "side-agent-fake.ts");

class RecordingHost implements SideAgentHost {
	readonly updates: SessionNotification[] = [];
	readonly permissions: RequestPermissionRequest[] = [];
	closed: { error?: Error } | undefined;
	answer: RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "no" } };

	onSessionUpdate(notification: SessionNotification): void {
		this.updates.push(notification);
	}

	async requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		this.permissions.push(request);
		return this.answer;
	}

	onClosed(error?: Error): void {
		this.closed = { error };
	}

	/** Text of the agent's message chunks so far, joined. */
	get said(): string {
		return this.updates
			.map(n =>
				n.update.sessionUpdate === "agent_message_chunk" && n.update.content.type === "text"
					? n.update.content.text
					: "",
			)
			.join("");
	}
}

describe("SideAgentConnection", () => {
	let workspace: TempDir;
	let outside: TempDir;
	let host: RecordingHost;
	let agent: SideAgentConnection | undefined;

	beforeEach(async () => {
		workspace = TempDir.createSync("@npi-side-agent-ws-");
		outside = TempDir.createSync("@npi-side-agent-out-");
		host = new RecordingHost();
	});

	afterEach(async () => {
		await agent?.close();
		agent = undefined;
		await workspace.remove();
		await outside.remove();
	});

	async function start(env?: Record<string, string>): Promise<SideAgentConnection> {
		agent = await SideAgentConnection.start({ command: process.execPath, args: [FAKE_AGENT], env }, host, {
			cwd: workspace.path(),
		});
		return agent;
	}

	async function turn(text: string): Promise<{ said: string; stop: string }> {
		const before = host.said.length;
		const session = await agent!.newSession({ cwd: workspace.path() });
		const response = await agent!.prompt(session.sessionId, [{ type: "text", text }]);
		return { said: host.said.slice(before), stop: response.stopReason };
	}

	it("hands the agent's permission request to the host and returns the user's choice", async () => {
		await start();
		host.answer = { outcome: { outcome: "selected", optionId: "yes" } };
		const { said } = await turn("permission");
		expect(said).toBe("yes");
		expect(host.permissions[0]?.toolCall.title).toBe("Run tests");
		expect(host.permissions[0]?.options.map(o => o.optionId)).toEqual(["yes", "no"]);
	});

	it("serves reads and writes inside the workspace and refuses paths that escape it", async () => {
		await start();
		const inside = path.join(workspace.path(), "notes.txt");
		await Bun.write(inside, "inside");
		const secret = path.join(outside.path(), "secret.txt");
		await Bun.write(secret, "secret");
		await fs.symlink(outside.path(), path.join(workspace.path(), "link"));

		expect((await turn(`read ${inside}`)).said).toBe("inside");
		expect((await turn(`read ${secret}`)).said).toStartWith("error:");
		// a symlink inside the workspace does not open the folder it points to
		expect((await turn(`read ${path.join(workspace.path(), "link", "secret.txt")}`)).said).toStartWith("error:");

		const created = path.join(workspace.path(), "new.txt");
		expect((await turn(`write ${created}`)).said).toBe("ok");
		expect(await Bun.file(created).text()).toBe("written");
		const escaped = path.join(workspace.path(), "link", "dropped.txt");
		expect((await turn(`write ${escaped}`)).said).toStartWith("error:");
		expect(await Bun.file(path.join(outside.path(), "dropped.txt")).exists()).toBe(false);
	});

	it("runs a terminal for the agent and reports its output and exit code", async () => {
		await start();
		expect((await turn("terminal")).said).toBe("hello|0");
	});

	it("cancel ends the running turn as cancelled", async () => {
		await start();
		const session = await agent!.newSession({ cwd: workspace.path() });
		const running = agent!.prompt(session.sessionId, [{ type: "text", text: "wait" }]);
		await Bun.sleep(50);
		await agent!.cancel(session.sessionId);
		expect((await running).stopReason).toBe("cancelled");
	});

	it("reports sign-in methods when the agent refuses a session, and works once signed in", async () => {
		await start({ FAKE_REQUIRE_AUTH: "1" });
		const refused = await agent!.newSession({ cwd: workspace.path() }).catch(error => error);
		expect(refused).toBeInstanceOf(SideAgentAuthRequiredError);
		expect((refused as SideAgentAuthRequiredError).methods.map(m => m.id)).toEqual(["login"]);
		await agent!.authenticate("login");
		expect((await agent!.newSession({ cwd: workspace.path() })).sessionId).toBe("s1");
	});

	it("close shuts the agent down without reporting a failure", async () => {
		await start();
		await agent!.close();
		await Bun.sleep(20);
		expect(host.closed).toEqual({ error: undefined });
	});

	it("an agent that dies mid-turn fails the turn and reports the exit", async () => {
		await start();
		const session = await agent!.newSession({ cwd: workspace.path() });
		const failed = await agent!.prompt(session.sessionId, [{ type: "text", text: "exit" }]).catch(error => error);
		expect(failed).toBeInstanceOf(Error);
		await Bun.sleep(20);
		expect(host.closed?.error).toBeInstanceOf(Error);
	});

	it("an agent that exits before the handshake fails start instead of hanging", async () => {
		const doomed = await SideAgentConnection.start(
			{ command: process.execPath, args: ["-e", "process.exit(3)"] },
			new RecordingHost(),
			{ cwd: workspace.path() },
		).catch(error => error);
		expect(doomed).toBeInstanceOf(Error);
	});
});
