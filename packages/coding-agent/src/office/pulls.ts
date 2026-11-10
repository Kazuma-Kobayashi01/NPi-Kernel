/**
 * The office's pull requests. They are local records, not GitHub PRs: each names a source branch,
 * the branch one level up it wants to merge into, and the reviews it has had. The ledger lives in
 * the repository's git directory, so it is shared by every desk and never shows up as a change.
 *
 * The chain of command is enforced here, not left to the prompts:
 *
 *   worker → office branch     reviewed and merged by that office's leader
 *   office → base branch       reviewed by the general manager, merged by the owner (the user)
 *
 * Nobody reviews their own pull request, and nothing merges without an approval.
 */
import { readStore, storePath, updateStore } from "./store";
import type { Company } from "./workspace";

export type PullKind = "worker" | "office";

/**
 * `open` awaits review; `changes_requested` is back with its author; `approved` may be merged by
 * whoever holds the merge right; `merged` and `closed` are final.
 */
export type PullStatus = "open" | "changes_requested" | "approved" | "merged" | "closed";

export interface PullReview {
	/** Member name, or {@link MANAGER} / {@link OWNER}. */
	by: string;
	verdict: "approve" | "request_changes";
	comment: string;
	at: string;
}

export interface Pull {
	number: number;
	kind: PullKind;
	office: number;
	/** Member who opened it: a worker, or the office's leader for an office pull request. */
	author: string;
	title: string;
	body: string;
	source: string;
	target: string;
	status: PullStatus;
	reviews: PullReview[];
	createdAt: string;
	updatedAt: string;
	mergeCommit?: string;
}

/** Reviewer name of the general manager (the main session). */
export const MANAGER = "general-manager";
/** Reviewer name of the user, who owns the base branch. */
export const OWNER = "owner";

/** Who is acting on a pull request. */
export type PullActor =
	| { kind: "owner" }
	| { kind: "manager" }
	| { kind: "leader"; office: number; member: string }
	| { kind: "worker"; office: number; member: string };

/** Thrown when an action breaks the review chain; the message tells the actor what to do instead. */
export class PullError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PullError";
	}
}

interface Ledger {
	next: number;
	pulls: Pull[];
}

const emptyLedger = (): Ledger => ({ next: 1, pulls: [] });

function ledgerPath(company: Company): string {
	return storePath(company, "pulls.json");
}

function readLedger(file: string): Promise<Ledger> {
	return readStore(file, emptyLedger);
}

function update<T>(company: Company, change: (ledger: Ledger) => T): Promise<T> {
	return updateStore(ledgerPath(company), emptyLedger, change);
}

function actorName(actor: PullActor): string {
	if (actor.kind === "owner") return OWNER;
	if (actor.kind === "manager") return MANAGER;
	return actor.member;
}

function find(ledger: Ledger, number: number): Pull {
	const pull = ledger.pulls.find(candidate => candidate.number === number);
	if (!pull) throw new PullError(`There is no pull request #${number}.`);
	return pull;
}

/** Whether `actor` is the one who reviews `pull`. */
function reviews(actor: PullActor, pull: Pull): boolean {
	if (pull.kind === "worker") return actor.kind === "leader" && actor.office === pull.office;
	return actor.kind === "manager";
}

/** Whether `actor` is the one who merges `pull` once it is approved. */
function merges(actor: PullActor, pull: Pull): boolean {
	if (pull.kind === "worker") return actor.kind === "leader" && actor.office === pull.office;
	return actor.kind === "owner";
}

function reviewerTitle(pull: Pull): string {
	return pull.kind === "worker" ? `the leader of office ${pull.office}` : "the general manager";
}

/** Every pull request under the company's base branch, oldest first. */
export async function listPulls(company: Company): Promise<Pull[]> {
	const officePrefix = `office/${company.baseBranch}/o`;
	return (await readLedger(ledgerPath(company))).pulls.filter(
		pull => pull.target === company.baseBranch || pull.target.startsWith(officePrefix),
	);
}

export async function getPull(company: Company, number: number): Promise<Pull> {
	return find(await readLedger(ledgerPath(company)), number);
}

/**
 * Open a pull request for `source`, or put the author's unfinished one for that branch back up for
 * review with the new title and body. A branch has at most one unfinished pull request.
 */
export async function submitPull(
	company: Company,
	request: Pick<Pull, "kind" | "office" | "author" | "title" | "body" | "source" | "target">,
): Promise<Pull> {
	return update(company, ledger => {
		const now = new Date().toISOString();
		const existing = ledger.pulls.find(
			pull => pull.source === request.source && pull.status !== "merged" && pull.status !== "closed",
		);
		if (existing) {
			Object.assign(existing, { title: request.title, body: request.body, status: "open", updatedAt: now });
			return existing;
		}
		const pull: Pull = {
			...request,
			number: ledger.next++,
			status: "open",
			reviews: [],
			createdAt: now,
			updatedAt: now,
		};
		ledger.pulls.push(pull);
		return pull;
	});
}

/**
 * Record a review. Approving makes the pull request mergeable; requesting changes hands it back to
 * its author.
 *
 * @throws PullError when `actor` is not this pull request's reviewer, or it is not up for review.
 */
export async function reviewPull(
	company: Company,
	number: number,
	actor: PullActor,
	verdict: PullReview["verdict"],
	comment: string,
): Promise<Pull> {
	return update(company, ledger => {
		const pull = find(ledger, number);
		// The owner outranks the general manager: they may send an approved office PR back.
		const ownerVeto = actor.kind === "owner" && pull.kind === "office" && verdict === "request_changes";
		if (!reviews(actor, pull) && !ownerVeto) {
			throw new PullError(`Pull request #${number} is reviewed by ${reviewerTitle(pull)}, not by you.`);
		}
		if (pull.status !== "open" && !(ownerVeto && pull.status === "approved")) {
			throw new PullError(`Pull request #${number} is ${pull.status.replace("_", " ")}, not up for review.`);
		}
		if (verdict === "request_changes" && !comment.trim()) {
			throw new PullError("Say what has to change when you request changes.");
		}
		const now = new Date().toISOString();
		pull.reviews.push({ by: actorName(actor), verdict, comment: comment.trim(), at: now });
		pull.status = verdict === "approve" ? "approved" : "changes_requested";
		pull.updatedAt = now;
		return pull;
	});
}

/**
 * Check that `actor` may merge pull request `number` right now.
 *
 * @throws PullError when it is unapproved, already final, or someone else's to merge.
 */
export async function assertMergeable(company: Company, number: number, actor: PullActor): Promise<Pull> {
	const pull = await getPull(company, number);
	if (!merges(actor, pull)) {
		throw new PullError(
			pull.kind === "worker"
				? `Pull request #${number} is merged by the leader of office ${pull.office}.`
				: `Pull request #${number} merges into ${pull.target}, which belongs to the user. Only they can merge it, with /office merge ${number}.`,
		);
	}
	if (pull.status !== "approved") {
		throw new PullError(
			`Pull request #${number} is ${pull.status.replace("_", " ")}; it merges only after ${reviewerTitle(pull)} approves it.`,
		);
	}
	return pull;
}

/** Mark an approved pull request merged at `commit`. */
export async function recordMerge(company: Company, number: number, commit: string): Promise<Pull> {
	return update(company, ledger => {
		const pull = find(ledger, number);
		pull.status = "merged";
		pull.mergeCommit = commit;
		pull.updatedAt = new Date().toISOString();
		return pull;
	});
}
