import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { matchesAuthAccountSelector } from "@oh-my-pi/pi-ai/auth/policy";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "unit-oauth-label";

const oauth = (accountId: string, access: string, label?: string) => ({
	type: "oauth" as const,
	access,
	refresh: `refresh-${access}`,
	expires: Date.now() + 60 * 60_000,
	accountId,
	email: `${accountId}@example.com`,
	...(label ? { label } : {}),
});

describe("AuthStorage.oauth.setLabel", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-label-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
		await authStorage.credentials.set(PROVIDER, [oauth("kazuma", "a"), oauth("hanyu", "b")]);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("names two accounts of one provider, refuses a taken name, and clears a name", () => {
		const storage = authStorage!;
		const [first, second] = storage.oauth.accounts(PROVIDER);
		expect(storage.oauth.setLabel(PROVIDER, first!.credentialId, " GPT-Plus-Kazuma ").label).toBe("GPT-Plus-Kazuma");
		storage.oauth.setLabel(PROVIDER, second!.credentialId, "GPT-Plus-Hanyu");
		expect(storage.oauth.accounts(PROVIDER).map(account => account.label)).toEqual([
			"GPT-Plus-Kazuma",
			"GPT-Plus-Hanyu",
		]);
		// Names are unique per provider, ignoring case.
		expect(() => storage.oauth.setLabel(PROVIDER, second!.credentialId, "gpt-plus-kazuma")).toThrow(/already named/);
		expect(storage.oauth.accounts(PROVIDER)[1]?.label).toBe("GPT-Plus-Hanyu");
		expect(storage.oauth.setLabel(PROVIDER, second!.credentialId, undefined).label).toBeUndefined();
		// The tokens are untouched.
		expect(storage.credentials.all()[PROVIDER]).toContainEqual(expect.objectContaining({ access: "b" }));
	});

	test("keeps the name when the same account logs in again with fresh tokens", async () => {
		const storage = authStorage!;
		const [first] = storage.oauth.accounts(PROVIDER);
		storage.oauth.setLabel(PROVIDER, first!.credentialId, "GPT-Plus-Kazuma");
		await store!.upsertAuthCredential(PROVIDER, oauth("kazuma", "a2"));
		const rows = store!.listAuthCredentials(PROVIDER);
		const kazuma = rows.find(row => row.credential.type === "oauth" && row.credential.accountId === "kazuma");
		expect(kazuma?.credential).toMatchObject({ access: "a2", label: "GPT-Plus-Kazuma" });
		expect(rows).toHaveLength(2);
	});

	test("an account policy can select an account by its name", () => {
		expect(matchesAuthAccountSelector({ label: "gpt-plus-hanyu" }, { label: "GPT-Plus-Hanyu" })).toBe(true);
		expect(matchesAuthAccountSelector({ label: "GPT-Plus-Hanyu" }, { label: "GPT-Plus-Kazuma" })).toBe(false);
		expect(matchesAuthAccountSelector({ label: "GPT-Plus-Hanyu" }, { email: "hanyu@example.com" })).toBe(false);
	});
});
