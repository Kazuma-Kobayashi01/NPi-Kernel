/**
 * Build edition. A China-region build hides catalogue providers whose only bundled
 * endpoint is a mainland-China vendor's international site; the same vendors stay
 * reachable through their China-region provider ids (`alibaba-cn`, `siliconflow-cn`,
 * `zhipu-coding-plan`, `minimax-cn`, `minimax-code-cn`, `xiaomi-token-plan-cn`).
 *
 * The catalogue keeps every entry — this gates selection, it never deletes.
 */

/** Edition compiled into this binary (`NPI_EDITION=cn` at build time). */
export type Edition = "global" | "cn";

export const EDITION: Edition = process.env.PI_EDITION === "cn" ? "cn" : "global";

/** Providers hidden by the edition, independent of the user's `disabledProviders`. */
export const EDITION_HIDDEN_PROVIDERS: string[] =
	EDITION === "cn"
		? [
				// dashscope-intl.aliyuncs.com (Singapore); China-region access is `alibaba-cn`.
				"alibaba",
				// portal.qwen.ai (Singapore); China-region Qwen access is `alibaba-cn`.
				"qwen-portal",
				// api.siliconflow.com (US); China-region access is `siliconflow-cn`.
				"siliconflow",
				// api.z.ai; China-region access is `zhipu-coding-plan`.
				"zai",
				// api.minimax.io; China-region access is `minimax-cn`.
				"minimax",
				// api.minimax.io; China-region access is `minimax-code-cn`.
				"minimax-code",
				// token-plan-sgp.xiaomimimo.com; China-region access is `xiaomi-token-plan-cn`.
				"xiaomi-token-plan-sgp",
				// token-plan-ams.xiaomimimo.com; China-region access is `xiaomi-token-plan-cn`.
				"xiaomi-token-plan-ams",
			]
		: [];

/** Union of a configured provider list with the edition block; the block always wins. */
export function withEditionHiddenProviders(ids: readonly string[] | undefined): string[] {
	if (EDITION_HIDDEN_PROVIDERS.length === 0) return [...(ids ?? [])];
	return [...new Set([...(ids ?? []), ...EDITION_HIDDEN_PROVIDERS])];
}
