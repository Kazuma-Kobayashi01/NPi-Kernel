/**
 * The Virtual Office as one service: who sits where, what the company looks like right now, and
 * the owner's own actions. The `office` tool, the `/office` command, `npi office` and the RPC
 * `office_*` commands all go through here, so a GUI sees exactly what the CLI does.
 */
import type { ScopeLike } from "../config/registry";
import {
	activeOffices,
	leaderOf,
	type Office,
	type OfficeConfig,
	type OfficeMember,
	type OfficeScale,
	staffOffices,
} from "./model";
import { type DeskClaim, readClaims } from "./desks";
import { logMerge, type OfficeMemory, readOfficeMemories } from "./memory";
import { assertMergeable, listPulls, type Pull, type PullActor, PullError, recordMerge, reviewPull } from "./pulls";
import { type OfficeRun, type OfficeUsage, readRuns, readUsage } from "./usage";
import { cfgOfficeEnabled, cfgOfficeOffices, cfgOfficeScale } from "./settings";
import {
	type Company,
	changedFilesOf,
	locateDesk,
	memberBranch,
	memberDesk,
	mergePull,
	officeBranch,
	officeDesk,
	openCompany,
} from "./workspace";

/** The position a session holds in the company. */
export type Seat =
	| { kind: "manager"; company: Company; offices: Office[] }
	| { kind: "leader"; company: Company; office: Office; member: OfficeMember }
	| { kind: "worker"; company: Company; office: Office; member: OfficeMember };

/** A desk: the worktree, its branch, and the branch one level up that it merges into. */
export interface Desk {
	dir: string;
	branch: string;
	upstream: string;
}

/**
 * The offices running at the configured scale. Offices the scale calls for but the roster lacks
 * are staffed and saved first, so the names handed out here are the ones every later session sees.
 */
export function staffedOffices(settings: ScopeLike): Office[] {
	const scale = cfgOfficeScale.get(settings);
	const saved: readonly OfficeConfig[] = cfgOfficeOffices.get(settings);
	const staffed = staffOffices(scale, saved);
	if (staffed.length !== saved.length) cfgOfficeOffices.set(settings, staffed);
	return activeOffices(scale, staffed);
}

/** The offices as saved, without staffing anything: what a member's own session reads. */
function savedOffices(settings: ScopeLike): Office[] {
	return activeOffices(cfgOfficeScale.get(settings), cfgOfficeOffices.get(settings));
}

/**
 * The seat of a session working in `cwd`: the main session is the general manager; a session
 * started at a desk is that desk's member. `null` when Virtual Office is off, or for any other
 * subagent (an ordinary `task` spawn has no seat and no `office` tool).
 */
export async function resolveSeat(settings: ScopeLike, cwd: string, taskDepth: number): Promise<Seat | null> {
	if (!cfgOfficeEnabled.get(settings)) return null;
	if (taskDepth === 0) return { kind: "manager", company: await openCompany(cwd), offices: staffedOffices(settings) };
	const location = await locateDesk(cwd);
	if (!location) return null;
	const office = savedOffices(settings).find(candidate => candidate.number === location.office);
	if (!office) return null;
	if (location.member === null) {
		return { kind: "leader", company: location.company, office, member: leaderOf(office) };
	}
	const member = office.members.find(candidate => candidate.id === location.member && candidate.role === "worker");
	return member ? { kind: "worker", company: location.company, office, member } : null;
}

export function deskOfOffice(company: Company, office: number): Desk {
	return { dir: officeDesk(company, office), branch: officeBranch(company, office), upstream: company.baseBranch };
}

export function deskOfWorker(company: Company, office: number, member: string): Desk {
	return {
		dir: memberDesk(company, office, member),
		branch: memberBranch(company, office, member),
		upstream: officeBranch(company, office),
	};
}

/** The seat's own desk; the general manager has none (they sit at the owner's checkout). */
export function deskOf(seat: Seat): Desk | null {
	if (seat.kind === "manager") return null;
	if (seat.kind === "leader") return deskOfOffice(seat.company, seat.office.number);
	return deskOfWorker(seat.company, seat.office.number, seat.member.id);
}

export function actorOf(seat: Seat): PullActor {
	if (seat.kind === "manager") return { kind: "manager" };
	return { kind: seat.kind, office: seat.office.number, member: seat.member.id };
}

/**
 * Merge approved pull request `number` as `actor`, one level up: a worker's into its office
 * branch, an office's into the base branch.
 *
 * @throws PullError when `actor` may not merge it or it is not approved.
 * @throws OfficeWorkspaceError when the change no longer applies to the target.
 */
export async function mergeApprovedPull(company: Company, number: number, actor: PullActor): Promise<Pull> {
	const pull = await assertMergeable(company, number, actor);
	if (pull.kind === "office" && pull.target !== company.baseBranch) {
		throw new PullError(
			`Pull request #${number} merges into ${pull.target}, but ${company.baseBranch} is checked out. Check out ${pull.target} first.`,
		);
	}
	const [targetDir, sourceDir] =
		pull.kind === "worker"
			? [officeDesk(company, pull.office), memberDesk(company, pull.office, pull.author)]
			: [company.checkout, officeDesk(company, pull.office)];
	const body = pull.body.trim();
	const files = await changedFilesOf(company, pull.source, pull.target);
	const commit = await mergePull(company, {
		targetDir,
		targetBranch: pull.target,
		sourceDir,
		sourceBranch: pull.source,
		message: `Merge PR #${pull.number}: ${pull.title}${body ? `\n\n${body}` : ""}`,
	});
	const merged = await recordMerge(company, number, commit);
	await logMerge(company, pull.office, {
		pr: pull.number,
		kind: pull.kind,
		title: pull.title,
		author: pull.author,
		target: pull.target,
		files,
	});
	return merged;
}

/** What an office is doing, most pressing first. */
export type OfficePhase = "working" | "reviewing" | "awaiting_owner" | "awaiting_manager" | "idle";

export interface OfficeActivity {
	office: number;
	phase: OfficePhase;
	/** Members at their desks right now. */
	working: string[];
	/** The assignment the office's leader is on, when there is one. */
	task?: string;
}

/** Runs a client gets with the state: enough for each member's recent history. */
const STATE_RUNS = 120;

/**
 * The phase of office `number`: someone at a desk comes first (a leader alone with worker pull
 * requests open is reviewing them), then whose turn it is on the office's own pull request.
 */
export function describeActivity(number: number, claims: readonly DeskClaim[], pulls: readonly Pull[]): OfficeActivity {
	const mine = claims.filter(claim => claim.office === number);
	const theirs = pulls.filter(pull => pull.office === number);
	const working = mine.map(claim => claim.member);
	const task = (mine.find(claim => claim.role === "leader") ?? mine[0])?.task;
	let phase: OfficePhase = "idle";
	if (mine.some(claim => claim.role === "worker")) phase = "working";
	else if (mine.length > 0) {
		phase = theirs.some(pull => pull.kind === "worker" && pull.status === "open") ? "reviewing" : "working";
	} else if (theirs.some(pull => pull.kind === "office" && pull.status === "approved")) phase = "awaiting_owner";
	else if (theirs.some(pull => pull.kind === "office" && pull.status === "open")) phase = "awaiting_manager";
	return { office: number, phase, working, ...(task ? { task } : {}) };
}

/** Everything a client needs to draw the company: settings, roster, branch and pull requests. */
export interface OfficeState {
	enabled: boolean;
	scale: OfficeScale;
	offices: Office[];
	/** `null` outside a git repository or on a detached HEAD; `reason` then says why. */
	company: { checkout: string; baseBranch: string } | null;
	reason?: string;
	pulls: Pull[];
	/** What each running office remembers about this project, in office order; empty without a company. */
	memory: OfficeMemory[];
	/** What each running office is doing, in office order; empty without a company. */
	activity: OfficeActivity[];
	/** Spend today and in total; `null` without a company. */
	usage: OfficeUsage | null;
	/** The most recent assignment runs, oldest first. */
	runs: OfficeRun[];
}

/** Snapshot of the company for the checkout containing `cwd`. Read-only apart from staffing. */
export async function readOfficeState(settings: ScopeLike, cwd: string): Promise<OfficeState> {
	const state: OfficeState = {
		enabled: cfgOfficeEnabled.get(settings),
		scale: cfgOfficeScale.get(settings),
		offices: staffedOffices(settings),
		company: null,
		pulls: [],
		memory: [],
		activity: [],
		usage: null,
		runs: [],
	};
	try {
		const company = await openCompany(cwd);
		state.company = { checkout: company.checkout, baseBranch: company.baseBranch };
		// First, so bookings the host already got as `office_usage` deltas are the ones it includes.
		state.usage = await readUsage(company);
		state.pulls = await listPulls(company);
		state.memory = await readOfficeMemories(
			company,
			state.offices.map(office => office.number),
		);
		const claims = await readClaims(company);
		state.activity = state.offices.map(office => describeActivity(office.number, claims, state.pulls));
		state.runs = (await readRuns(company)).slice(-STATE_RUNS);
	} catch (error) {
		state.reason = error instanceof Error ? error.message : String(error);
	}
	return state;
}

/** The user merges approved office pull request `number` into their checked-out branch. */
export async function ownerMerge(cwd: string, number: number): Promise<Pull> {
	return mergeApprovedPull(await openCompany(cwd), number, { kind: "owner" });
}

/** The user sends office pull request `number` back with `comment`, approved or not. */
export async function ownerRequestChanges(cwd: string, number: number, comment: string): Promise<Pull> {
	return reviewPull(await openCompany(cwd), number, { kind: "owner" }, "request_changes", comment);
}
