/**
 * Where a Virtual Office works: the branch hierarchy and the desks (git worktrees) on it.
 *
 *   <base branch>                      the owner's checkout — the general manager's seat
 *   └─ office/<base>/o<N>/main         one per office — the leader's desk
 *      └─ office/<base>/o<N>/<name>    one per worker — that worker's desk
 *
 * Work only moves up this tree through {@link mergePull}: one squashed commit per pull request,
 * applied to the level above. Nothing here pushes or talks to a remote.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getWorktreesDir, isEnoent } from "@oh-my-pi/pi-utils";
import type { ScopeLike } from "../config/registry";
import { cfgIsolationBackend, cfgWorktreeClone } from "../task/settings";
import { parseIsolationBackend } from "../task/worktree";
import { withRepoLock } from "../utils/repo-lock";

/** The repository and branch a company works for. */
export interface Company {
	/** The owner's checkout: where the base branch is checked out and the final merge lands. */
	checkout: string;
	/** The branch the offices branch from and merge back into. */
	baseBranch: string;
	/** Directory holding every desk of this company. */
	dir: string;
}

/** Thrown when the repository is not in a state the office can work with; shown to the user as is. */
export class OfficeWorkspaceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OfficeWorkspaceError";
	}
}

const COMPANY_FILE = "company.json";

function desksRoot(): string {
	return path.join(getWorktreesDir(), "office");
}

function slug(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/**
 * The company for the checkout containing `cwd`: its current branch is the base branch.
 *
 * @throws OfficeWorkspaceError outside a git repository or on a detached HEAD.
 */
export async function openCompany(cwd: string): Promise<Company> {
	const repo = vcs.git(cwd);
	if (!repo) throw new OfficeWorkspaceError("Virtual Office needs a git repository; this directory is not in one.");
	const baseBranch = await repo.currentBranch();
	if (!baseBranch) {
		throw new OfficeWorkspaceError("Virtual Office needs a branch to work from; check one out (HEAD is detached).");
	}
	const checkout = repo.info().repoRoot;
	const primary = repo.primaryRoot();
	const repoKey = `${slug(path.basename(primary))}-${Bun.hash(primary).toString(16).slice(0, 8)}`;
	const company: Company = { checkout, baseBranch, dir: path.join(desksRoot(), repoKey, slug(baseBranch)) };
	await Bun.write(path.join(company.dir, COMPANY_FILE), JSON.stringify({ checkout, baseBranch }, null, "\t"));
	return company;
}

/** A desk's place in its company, read back from the desk's own path. */
export interface DeskLocation {
	company: Company;
	office: number;
	/** `null` at the office's own desk (the leader's); otherwise the worker's name. */
	member: string | null;
}

/** Which desk `cwd` is, or `null` when it is not inside one. */
export async function locateDesk(cwd: string): Promise<DeskLocation | null> {
	const [root, here] = await Promise.all([
		fs.realpath(desksRoot()).catch(() => desksRoot()),
		fs.realpath(cwd).catch(() => cwd),
	]);
	const relative = path.relative(root, here);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
	const [repoKey, branchSlug, officeDir, desk] = relative.split(path.sep);
	const office = /^o(\d+)$/.exec(officeDir ?? "");
	if (!repoKey || !branchSlug || !office || !desk) return null;
	const dir = path.join(desksRoot(), repoKey, branchSlug);
	try {
		const saved: { checkout: string; baseBranch: string } = await Bun.file(path.join(dir, COMPANY_FILE)).json();
		return {
			company: { checkout: saved.checkout, baseBranch: saved.baseBranch, dir },
			office: Number(office[1]),
			member: desk === "main" ? null : desk,
		};
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

/** Branch of office `office`: the leader's desk and the target of its workers' pull requests. */
export function officeBranch(company: Company, office: number): string {
	return `office/${company.baseBranch}/o${office}/main`;
}

export function memberBranch(company: Company, office: number, member: string): string {
	return `office/${company.baseBranch}/o${office}/${member}`;
}

export function officeDesk(company: Company, office: number): string {
	return path.join(company.dir, `o${office}`, "main");
}

export function memberDesk(company: Company, office: number, member: string): string {
	return path.join(company.dir, `o${office}`, member);
}

async function samePath(a: string, b: string): Promise<boolean> {
	if (path.resolve(a) === path.resolve(b)) return true;
	const [left, right] = await Promise.all([fs.realpath(a).catch(() => a), fs.realpath(b).catch(() => b)]);
	return left === right;
}

/**
 * Make sure the desk at `dir` exists on `branch`, creating the branch from `upstream` on first
 * use. A desk with nothing of its own (see {@link ownChanges}, clean tree) is moved up to
 * `upstream`, so new work starts from the latest merged state; a desk with unmerged work is left
 * exactly as it is.
 */
export async function prepareDesk(
	company: Company,
	desk: { dir: string; branch: string; upstream: string },
	settings: ScopeLike,
): Promise<void> {
	await withRepoLock(company.checkout, async () => {
		const repo = vcs.requireGit(company.checkout);
		if (!(await repo.refExists(`refs/heads/${desk.branch}`))) {
			await repo.createBranch(desk.branch, desk.upstream, false);
		}
		let registered = false;
		for (const entry of await repo.worktrees()) {
			if (await samePath(entry.path, desk.dir)) registered = true;
		}
		if (!registered) {
			await repo.worktreePrune();
			await fs.mkdir(path.dirname(desk.dir), { recursive: true });
			await repo.worktreeAdd(desk.dir, desk.branch, {
				detach: false,
				clone: cfgWorktreeClone.get(settings),
				backend: parseIsolationBackend(cfgIsolationBackend.get(settings)),
			});
		}
		const here = vcs.requireGit(desk.dir);
		if (!(await here.isDirty()) && (await ownChanges(here, desk.upstream, desk.branch)).length === 0) {
			await here.reset("hard", desk.upstream);
		}
	});
}

/**
 * Files `branch` changed whose content `upstream` does not have yet.
 *
 * Commit ancestry cannot answer this: every merge lands as a new squashed commit, so a desk whose
 * work was merged two levels up still has commits its upstream lacks, though not one line of
 * content. Comparing the content of the files it touched can.
 */
async function ownChanges(repo: VcsGitRepo, upstream: string, branch: string): Promise<string[]> {
	if ((await repo.revListRange(upstream, branch)).length === 0) return [];
	const base = (await repo.mergeBase(upstream, branch)) ?? upstream;
	const touched = await repo.changedFiles({ base, head: branch });
	if (touched.length === 0) return [];
	return repo.changedFiles({ base: upstream, head: branch, files: touched });
}

/**
 * Commit whatever is uncommitted at the desk, then report how much the desk's branch holds that
 * `upstream` does not.
 */
export async function commitDesk(
	company: Company,
	desk: { dir: string; branch: string; upstream: string },
	message: string,
): Promise<{ commits: number; files: string[] }> {
	return withRepoLock(company.checkout, async () => {
		const here = vcs.requireGit(desk.dir);
		if (await here.isDirty()) {
			await here.stageFiles([]);
			if (await here.hasDiff({ cached: true })) await here.commitCreate(message, {});
		}
		const commits = await here.revListRange(desk.upstream, desk.branch);
		return { commits: commits.length, files: await ownChanges(here, desk.upstream, desk.branch) };
	});
}

/** Files `source` changes relative to where it branched from `target`. */
export async function changedFilesOf(company: Company, source: string, target: string): Promise<string[]> {
	const repo = vcs.requireGit(company.checkout);
	const base = (await repo.mergeBase(target, source)) ?? target;
	return repo.changedFiles({ base, head: source });
}

/** What a pull request would change: per-file line counts and the patch, cut at `maxBytes`. */
export async function describeChange(
	company: Company,
	source: string,
	target: string,
	maxBytes: number,
): Promise<{ files: Array<{ path: string; added: number; removed: number }>; patch: string }> {
	const repo = vcs.requireGit(company.checkout);
	const base = (await repo.mergeBase(target, source)) ?? target;
	const [numstat, patch] = await Promise.all([
		repo.numstat({ base, head: source }),
		repo.diffText({ base, head: source, maxBytes }),
	]);
	return {
		files: numstat.map(entry => ({ path: entry.path, added: entry.added ?? 0, removed: entry.removed ?? 0 })),
		patch,
	};
}

export interface MergePullOptions {
	/** Worktree that has `targetBranch` checked out; the merge commit is created here. */
	targetDir: string;
	targetBranch: string;
	/** The desk whose branch is merged; moved up to the merge commit afterwards. */
	sourceDir: string;
	sourceBranch: string;
	message: string;
}

/**
 * Merge a pull request: the source branch's whole change lands on the target as one commit, and
 * the source desk then restarts from that commit.
 *
 * All or nothing. The change is applied only when it fits the target's current files exactly; a
 * target that has moved under it is refused with the source left untouched, for the author to
 * rebase and resubmit.
 *
 * @returns the merge commit.
 * @throws OfficeWorkspaceError when the target is not ready or the change does not apply.
 */
export async function mergePull(company: Company, options: MergePullOptions): Promise<string> {
	return withRepoLock(company.checkout, async () => {
		const target = vcs.requireGit(options.targetDir);
		const checkedOut = await target.currentBranch();
		if (checkedOut !== options.targetBranch) {
			throw new OfficeWorkspaceError(
				`Cannot merge into ${options.targetBranch}: ${options.targetDir} has ${checkedOut ?? "a detached HEAD"} checked out.`,
			);
		}
		if ((await target.statusSummary()).staged > 0) {
			throw new OfficeWorkspaceError(
				`Cannot merge into ${options.targetBranch}: it has staged changes. Commit or unstage them first.`,
			);
		}
		const base = (await target.mergeBase(options.targetBranch, options.sourceBranch)) ?? options.targetBranch;
		const patch = await target.diffTree(base, options.sourceBranch, true);
		if (!patch.trim()) {
			throw new OfficeWorkspaceError(`${options.sourceBranch} has nothing that ${options.targetBranch} lacks.`);
		}
		// Index first: it refuses unless every touched file matches the target's HEAD, and the
		// worktree check below then covers uncommitted edits to the same files.
		if (!(await target.canApplyPatch(patch, { cached: true })) || !(await target.canApplyPatch(patch, {}))) {
			throw new OfficeWorkspaceError(
				`${options.sourceBranch} no longer applies to ${options.targetBranch}: the same lines changed there, or the files have uncommitted edits. Rebase ${options.sourceBranch} onto ${options.targetBranch} and resubmit.`,
			);
		}
		await target.applyPatch(patch, { cached: true });
		await target.applyPatch(patch, {});
		await target.commitCreate(options.message, {});
		const commit = (await target.headSha()) ?? "";
		const source = vcs.requireGit(options.sourceDir);
		if (!(await source.isDirty())) await source.reset("hard", options.targetBranch);
		return commit;
	});
}
