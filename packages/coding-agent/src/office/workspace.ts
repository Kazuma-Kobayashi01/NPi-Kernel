/**
 * Which project a Virtual Office works for. The offices only investigate and report, so a company
 * is just the repository: its checkout is where every member reads, and its git directory holds
 * the office's records (`store.ts`). Nothing here creates branches, worktrees or commits.
 */
import * as vcs from "@oh-my-pi/pi-natives/vcs";

/** The repository a company works for. */
export interface Company {
	/** The owner's checkout: where members read and the general manager makes changes. */
	checkout: string;
}

/** Thrown when there is no repository to work for; shown to the user as is. */
export class OfficeWorkspaceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OfficeWorkspaceError";
	}
}

/**
 * The company for the checkout containing `cwd`.
 *
 * @throws OfficeWorkspaceError outside a git repository.
 */
export async function openCompany(cwd: string): Promise<Company> {
	const repo = vcs.git(cwd);
	if (!repo) throw new OfficeWorkspaceError("Virtual Office needs a git repository; this directory is not in one.");
	return { checkout: repo.info().repoRoot };
}
