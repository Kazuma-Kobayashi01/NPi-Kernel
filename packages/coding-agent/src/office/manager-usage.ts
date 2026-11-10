/** Books the general manager's own model usage: the main session's, while Virtual Office is on. */
import type { ScopeLike } from "../config/registry";
import type { AgentSessionEvent } from "../session/agent-session";
import { MANAGER } from "./pulls";
import { cfgOfficeEnabled } from "./settings";
import { recordUsage } from "./usage";
import { openCompany } from "./workspace";

export function bookManagerUsage(settings: ScopeLike, cwd: string, event: AgentSessionEvent): void {
	if (event.type !== "message_end" || event.message.role !== "assistant") return;
	if (!cfgOfficeEnabled.get(settings)) return;
	const usage = event.message.usage;
	if (!usage) return;
	const amount = {
		tokens: usage.input + usage.output + usage.cacheWrite,
		cost: usage.cost.total,
		requests: 1,
	};
	// No company here (not a repository, detached HEAD): nothing to book against.
	void openCompany(cwd).then(
		company => recordUsage(company, MANAGER, amount),
		() => {},
	);
}
