import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { formatAccountRows, listAccountRows } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/accounts";
import { AccountManagerComponent, type AccountRow } from "@oh-my-pi/pi-tui/overlays/account-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { removeWithRetries } from "../../../../utils/src/temp";

beforeAll(async () => {
	await initTheme();
});

const oauth = (accountId: string, access: string, label?: string) => ({
	type: "oauth" as const,
	access,
	refresh: `refresh-${access}`,
	expires: Date.now() + 60 * 60_000,
	accountId,
	email: `${accountId}@example.com`,
	...(label ? { label } : {}),
});

const names: Record<string, string> = { "unit-claude": "Claude", "unit-codex": "Codex" };
const providerName = (provider: string): string => names[provider] ?? provider;

describe("/account rows", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let storage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-account-rows-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store);
		await storage.credentials.set("unit-codex", [oauth("kazuma", "k", "GPT-Plus-Kazuma")]);
		await storage.credentials.set("unit-claude", [
			oauth("cynthia", "c", "Claude-Pro-Cynthia"),
			oauth("hanyu", "h", "Claude-Pro-Hanyu"),
		]);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		storage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	it("groups accounts by provider: rotating until one is activated, then active and idle", async () => {
		let rows = await listAccountRows(storage!, "s1", providerName);
		expect(rows.map(row => `${row.providerName}/${row.name}/${row.state}`)).toEqual([
			"Claude/Claude-Pro-Cynthia/rotating",
			"Claude/Claude-Pro-Hanyu/rotating",
			"Codex/GPT-Plus-Kazuma/rotating",
		]);
		const hanyu = rows.find(row => row.name === "Claude-Pro-Hanyu")!;
		storage!.oauth.activate(hanyu.provider, hanyu.credentialId);
		rows = await listAccountRows(storage!, "s1", providerName);
		expect(rows.map(row => `${row.name}/${row.state}`)).toEqual([
			"Claude-Pro-Cynthia/idle",
			"Claude-Pro-Hanyu/active",
			"GPT-Plus-Kazuma/rotating",
		]);
		expect(rows[0]?.detail).toContain("cynthia@example.com");
		const text = formatAccountRows(rows);
		expect(text).toContain("Claude\n  Claude-Pro-Cynthia  idle");
		expect(text).toContain("Codex (no active account; accounts rotate)");
	});
});

describe("AccountManagerComponent", () => {
	const rows: AccountRow[] = [
		{
			provider: "c",
			providerName: "Claude",
			credentialId: 1,
			name: "Claude-Pro-Cynthia",
			detail: "#1",
			state: "active",
			inUse: true,
		},
		{
			provider: "c",
			providerName: "Claude",
			credentialId: 2,
			name: "Claude-Pro-Hanyu",
			detail: "#2",
			state: "idle",
			inUse: false,
		},
		{
			provider: "x",
			providerName: "Codex",
			credentialId: 2,
			name: "GPT-Plus-Kazuma",
			detail: "#2",
			state: "rotating",
			inUse: false,
		},
	];

	it("shows a header per provider and each account's state", () => {
		const panel = new AccountManagerComponent(rows, { onActivate() {}, onRename() {}, onCancel() {} });
		const text = panel
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(text).toMatch(/Claude\s*\n.*Claude-Pro-Cynthia\s+active · in use by this session/);
		expect(text).toMatch(/Claude-Pro-Hanyu\s+idle/);
		expect(text).toMatch(/Codex\s+no active account · accounts rotate/);
		expect(text).toContain("activate");
		expect(text).toContain("r rename");
	});

	it("activates with Enter and renames with r, on the selected account", () => {
		const activated: string[] = [];
		const renamed: string[] = [];
		const panel = new AccountManagerComponent(rows, {
			onActivate: row => activated.push(`${row.provider}:${row.credentialId}`),
			onRename: row => renamed.push(`${row.provider}:${row.credentialId}`),
			onCancel() {},
		});
		panel.handleInput("\x1b[B");
		panel.handleInput("\n");
		panel.handleInput("\x1b[B");
		panel.handleInput("r");
		expect(activated).toEqual(["c:2"]);
		expect(renamed).toEqual(["x:2"]);
	});
});
