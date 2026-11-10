import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type {
	UsageSessionTokens,
	UsageStatsPeriod,
	UsageTokenFigures,
	UsageTokenModel,
	UsageTokensData,
} from "@oh-my-pi/pi-tui/overlays/usage-panel-model";
import type { SessionStats } from "../../session/agent-session-types";
import { loadTokenRanks, PERIOD_LABEL, RANK_PERIODS, type TokenRankData } from "./token-rank";

export interface UsageTokensSession {
	getSessionStats(): SessionStats;
	agent: {
		state: {
			messages: AgentMessage[];
		};
	};
}

interface AccumulatedModel {
	name: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	requests: number;
}

/** Pure: per-session figures. Totals MUST equal what `getSessionStats()` reports for tokens/cost. */
export function buildSessionTokens(session: UsageTokensSession): UsageSessionTokens {
	const stats = session.getSessionStats();
	const modelMap = new Map<string, AccumulatedModel>();

	for (const message of session.agent.state.messages) {
		if (message.role !== "assistant") continue;
		const assistant = message as AssistantMessage;
		const usage = assistant.usage;
		if (!usage) continue;

		const key = `${assistant.provider}/${assistant.model}`;
		let entry = modelMap.get(key);
		if (!entry) {
			entry = {
				name: key,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				requests: 0,
			};
			modelMap.set(key, entry);
		}

		entry.input += usage.input;
		entry.output += usage.output;
		entry.cacheRead += usage.cacheRead;
		entry.cacheWrite += usage.cacheWrite;
		entry.cost += usage.cost.total;
		entry.requests += 1;
	}

	const models: UsageTokenModel[] = Array.from(modelMap.values()).sort((left, right) => {
		const totalLeft = left.input + left.output + left.cacheRead + left.cacheWrite;
		const totalRight = right.input + right.output + right.cacheRead + right.cacheWrite;
		return totalRight - totalLeft;
	});

	const totals: UsageTokenFigures = {
		input: stats.tokens.input,
		output: stats.tokens.output,
		cacheRead: stats.tokens.cacheRead,
		cacheWrite: stats.tokens.cacheWrite,
		cost: stats.cost,
		requests: stats.assistantMessages,
	};

	return {
		totals,
		...(stats.tokens.reasoning > 0 ? { reasoning: stats.tokens.reasoning } : undefined),
		models,
	};
}

/** Pure: map the stats-DB ranking to the panel's periods (same order as RANK_PERIODS, labels from PERIOD_LABEL). */
export function buildStatsPeriods(data: TokenRankData): UsageStatsPeriod[] {
	const periodMap = new Map(data.periods.map(period => [period.period, period]));
	return RANK_PERIODS.map(id => {
		const period = periodMap.get(id);
		const models: UsageTokenModel[] = period
			? period.models.map(model => ({
					name: model.name,
					input: model.input,
					output: model.output,
					cacheRead: model.cacheRead,
					cacheWrite: model.cacheWrite,
					cost: model.cost,
					requests: model.requests,
				}))
			: [];
		return {
			id,
			label: PERIOD_LABEL[id],
			models,
		};
	});
}

/** Session figures + synced local stats (calls loadTokenRanks, which syncs session files into the stats DB). */
export async function loadUsageTokensData(session: UsageTokensSession): Promise<UsageTokensData> {
	const sessionTokens = buildSessionTokens(session);
	const rankData = await loadTokenRanks();
	return {
		session: sessionTokens,
		periods: buildStatsPeriods(rankData),
	};
}
