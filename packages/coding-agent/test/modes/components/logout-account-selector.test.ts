import { beforeAll, describe, expect, it } from "bun:test";
import { LogoutAccountSelectorComponent } from "@oh-my-pi/pi-tui/overlays/logout-account-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { StoredAuthCredential } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { toLogoutAccounts } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/logout";

beforeAll(async () => {
	await initTheme();
});

describe("LogoutAccountSelectorComponent", () => {
	it("starts on the active stored account and selects that credential", () => {
		const rows: StoredAuthCredential[] = [
			{
				id: 11,
				provider: "anthropic",
				disabledCause: null,
				credential: {
					type: "oauth",
					access: "access-a",
					refresh: "refresh-a",
					expires: Date.now() + 60_000,
					email: "a@example.com",
					accountId: "acct-a",
				},
			},
			{
				id: 12,
				provider: "anthropic",
				disabledCause: null,
				credential: {
					type: "oauth",
					access: "access-b",
					refresh: "refresh-b",
					expires: Date.now() + 60_000,
					email: "b@example.com",
					accountId: "acct-b",
				},
			},
		];
		const accounts = toLogoutAccounts("anthropic", rows, { activeIdentity: { accountId: "acct-b" } });
		const selected: number[] = [];
		const component = new LogoutAccountSelectorComponent(
			"Anthropic",
			accounts,
			account => selected.push(account.credentialId),
			() => {},
		);

		const rendered = component
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("b@example.com (active)");
		expect(rendered.indexOf("b@example.com")).toBeLessThan(rendered.indexOf("a@example.com"));

		component.handleInput("\n");

		expect(selected).toEqual([12]);
	});

	function oauth(id: number, provider: string, email: string, label?: string): StoredAuthCredential {
		return {
			id,
			provider,
			disabledCause: null,
			credential: {
				type: "oauth",
				access: `access-${id}`,
				refresh: `refresh-${id}`,
				expires: Date.now() + 60_000,
				email,
				...(label ? { label } : {}),
			},
		};
	}

	it("labels an account by the name the user gave it, the email moving to the detail", () => {
		const [named] = toLogoutAccounts("openai-codex", [oauth(1, "openai-codex", "k@example.com", "GPT-Plus-Kazuma")]);
		expect(named?.label).toBe("GPT-Plus-Kazuma");
		expect(named?.detail).toContain("k@example.com");
	});

	it("lists every provider's accounts in one picker and logs out the chosen provider's row", () => {
		// The same credential id under two providers must stay two rows.
		const accounts = [
			...toLogoutAccounts("anthropic", [oauth(7, "anthropic", "a@example.com")]),
			...toLogoutAccounts("openai-codex", [oauth(7, "openai-codex", "k@example.com", "GPT-Plus-Kazuma")]),
		];
		const selected: string[] = [];
		const component = new LogoutAccountSelectorComponent(
			undefined,
			accounts,
			account => selected.push(`${account.provider}:${account.credentialId}`),
			() => {},
			{ providerName: provider => (provider === "anthropic" ? "Anthropic" : "Openai Codex") },
		);
		const rendered = component
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("Anthropic · a@example.com");
		expect(rendered).toContain("Openai Codex · GPT-Plus-Kazuma");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		expect(selected).toEqual(["openai-codex:7"]);
	});
});
