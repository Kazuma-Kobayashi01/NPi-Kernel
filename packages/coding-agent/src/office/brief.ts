/**
 * The general manager's standing brief: the part of the main session's system prompt that tells it
 * it has offices to investigate questions for it.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import type { ScopeLike } from "../config/registry";
import managerRole from "../prompts/office/manager.md" with { type: "text" };
import { staffedOffices } from "./company";
import { leaderOf, MANAGER, workersOf } from "./model";
import { readOfficeMemories } from "./memory";
import { readRuns } from "./usage";
import { cfgOfficeEnabled } from "./settings";
import { type Company, OfficeWorkspaceError, openCompany } from "./workspace";

/** Recent office reports per office the general manager is reminded of. */
const MANAGER_RECENT_WORK = 3;

/**
 * The brief for a main session in `cwd`, or `undefined` when Virtual Office is off or there is no
 * repository (the `office` tool is absent then too, so the session works as usual).
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
	const runs = await readRuns(company);
	return prompt.render(managerRole, {
		offices: offices.map((office, index) => ({
			number: office.number,
			leader: leaderOf(office),
			workers: workersOf(office),
			// The office's own reports (its leader's runs for the general manager), newest first.
			recent: runs
				.filter(run => run.office === office.number && run.by === MANAGER && run.report)
				.slice(-MANAGER_RECENT_WORK)
				.reverse()
				.map(run => ({ id: run.id, title: run.report })),
			lessons: memories[index].notes.length,
		})),
	});
}
