/**
 * The general manager's standing brief: the part of the main session's system prompt that turns
 * it from a hands-on coding agent into the head of the company.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import type { ScopeLike } from "../config/registry";
import managerRole from "../prompts/office/manager.md" with { type: "text" };
import { staffedOffices } from "./company";
import { leaderOf, workersOf } from "./model";
import { readOfficeMemories } from "./memory";
import { cfgOfficeEnabled } from "./settings";
import { type Company, OfficeWorkspaceError, openCompany } from "./workspace";

/** Merged office pull requests per office the general manager is reminded of. */
const MANAGER_RECENT_WORK = 3;

/**
 * The brief for a main session in `cwd`, or `undefined` when Virtual Office is off or there is no
 * branch to work from (the `office` tool is absent then too, so the session works as usual).
 */
export async function renderManagerBrief(settings: ScopeLike, cwd: string): Promise<string | undefined> {
	if (!cfgOfficeEnabled.get(settings)) return undefined;
	let company: Company;
	try {
		company = await openCompany(cwd);
	} catch (error) {
		if (error instanceof OfficeWorkspaceError) return undefined;
		throw error;
	}
	const offices = staffedOffices(settings);
	const memories = await readOfficeMemories(
		company,
		offices.map(office => office.number),
	);
	return prompt.render(managerRole, {
		baseBranch: company.baseBranch,
		offices: offices.map((office, index) => ({
			number: office.number,
			leader: leaderOf(office),
			workers: workersOf(office),
			// The office pull requests that reached a base branch, newest first.
			recent: memories[index].log
				.filter(entry => entry.kind === "office")
				.slice(-MANAGER_RECENT_WORK)
				.reverse(),
			lessons: memories[index].notes.length,
		})),
	});
}
