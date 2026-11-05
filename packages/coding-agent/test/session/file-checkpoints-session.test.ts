import { afterEach, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { FILE_CHECKPOINT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/file-checkpoints";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

async function createSession(overrides: { isSubagentSession?: boolean } = {}) {
	const tempDir = TempDir.createSync("@pi-file-checkpoints-");
	const root = path.join(tempDir.path(), "proj");
	await Bun.write(path.join(root, "a.txt"), "one\n");
	setAgentDir(path.join(tempDir.path(), "agent"));
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("mock", "test-key");
	const mock = createMockModel({ responses: [{ content: ["done"] }, { content: ["done again"] }] });
	const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "todo.enabled": false });
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock, systemPrompt: ["Test"], tools: [], messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.create(root, path.join(tempDir.path(), "sessions")),
		settings,
		modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		toolRegistry: new Map(),
		...overrides,
	});
	cleanups.push(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});
	return { session, root };
}

const userEntries = (session: AgentSession) =>
	session.sessionManager.getBranch().filter(e => e.type === "message" && e.message.role === "user");

it("a prompt can take the files back to how they were before it", async () => {
	const { session, root } = await createSession();
	await session.prompt("first");
	await Bun.write(path.join(root, "a.txt"), "two\n");
	await session.prompt("second");
	await Bun.write(path.join(root, "a.txt"), "three\n");
	await Bun.write(path.join(root, "b.txt"), "new\n");

	const second = userEntries(session)[1].id;
	expect(await session.planFileRestore(second)).toEqual([
		{ path: "a.txt", removes: false },
		{ path: "b.txt", removes: true },
	]);
	expect(await session.restoreFiles(second)).toBe(2);
	expect(await Bun.file(path.join(root, "a.txt")).text()).toBe("two\n");
	expect(await Bun.file(path.join(root, "b.txt")).exists()).toBe(false);
});

it("the snapshot stays with its prompt through a branch", async () => {
	const { session, root } = await createSession();
	await session.prompt("first");
	await Bun.write(path.join(root, "a.txt"), "two\n");
	await session.prompt("second");
	await Bun.write(path.join(root, "a.txt"), "three\n");

	const second = userEntries(session)[1].id;
	await session.branch(second);
	const first = userEntries(session)[0].id;
	expect(await session.planFileRestore(first)).toEqual([{ path: "a.txt", removes: false }]);
	await session.restoreFiles(first);
	expect(await Bun.file(path.join(root, "a.txt")).text()).toBe("one\n");
});

it("a subagent keeps no checkpoints of its own", async () => {
	const { session } = await createSession({ isSubagentSession: true });
	await session.prompt("first");
	const customs = session.sessionManager
		.getBranch()
		.filter(e => e.type === "custom" && e.customType === FILE_CHECKPOINT_CUSTOM_TYPE);
	expect(customs).toEqual([]);
});
