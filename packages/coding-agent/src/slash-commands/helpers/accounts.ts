import type { AccountRow } from "@oh-my-pi/pi-tui/overlays/account-manager";
import type { AuthStorage } from "../../session/auth-storage";

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * Every signed-in OAuth account for `/account`, grouped by provider (providers in name order, each
 * provider's accounts in store order). A provider with an activated account marks it `active` and the
 * rest `idle`; without one its accounts are `rotating`. Reloads the store to see other processes.
 */
export async function listAccountRows(
	authStorage: AuthStorage,
	sessionId: string,
	providerName: (provider: string) => string,
): Promise<AccountRow[]> {
	await authStorage.credentials.reload();
	const providers = [
		...new Set(
			authStorage.credentials
				.list()
				.filter(row => row.credential.type === "oauth")
				.map(row => row.provider),
		),
	].sort((left, right) => providerName(left).localeCompare(providerName(right)));
	return providers.flatMap(provider => {
		const accounts = authStorage.oauth.accounts(provider, sessionId);
		const anyActivated = accounts.some(account => account.activated);
		return accounts.map(account => {
			const name =
				nonEmpty(account.label) ??
				nonEmpty(account.email) ??
				nonEmpty(account.accountId) ??
				nonEmpty(account.projectId) ??
				`account #${account.credentialId}`;
			const detail: string[] = [];
			const email = nonEmpty(account.email);
			if (email && email !== name) detail.push(email);
			const org = nonEmpty(account.orgName) ?? nonEmpty(account.orgId);
			if (org && org !== name) detail.push(org);
			detail.push(`#${account.credentialId}`);
			return {
				provider,
				providerName: providerName(provider),
				credentialId: account.credentialId,
				name,
				detail: detail.join(" · "),
				state: anyActivated ? (account.activated ? "active" : "idle") : "rotating",
				inUse: account.active,
			} satisfies AccountRow;
		});
	});
}

/** The `/account` list as text, grouped by provider, for hosts without the panel. */
export function formatAccountRows(rows: readonly AccountRow[]): string {
	if (rows.length === 0) return "No OAuth accounts are signed in. Use /login to add one.";
	const lines: string[] = [];
	let provider: string | undefined;
	for (const row of rows) {
		if (row.provider !== provider) {
			provider = row.provider;
			lines.push(
				row.state === "rotating" ? `${row.providerName} (no active account; accounts rotate)` : row.providerName,
			);
		}
		lines.push(`  ${row.name}  ${row.state}${row.inUse ? " · in use" : ""}  ${row.detail}`);
	}
	return lines.join("\n");
}
