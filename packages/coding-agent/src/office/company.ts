/**
 * The Virtual Office as one service: who sits where and what the company looks like right now.
 * The `office` tool, the `/office` command, `npi office` and the RPC `office_*` commands all go
 * through here, so a GUI sees exactly what the CLI does.
 *
 * Offices only investigate and report. Members read the owner's checkout; the general manager (the
 * main session) decides and makes the changes.
 */
import type { ScopeLike } from "../config/registry";
import { type MemberClaim, readClaims } from "./claims";
import {
	activeOffices,
	type Office,
	type OfficeConfig,
	type OfficeMember,
	type OfficeScale,
	staffOffices,
} from "./model";
import { type OfficeMemory, readOfficeMemories } from "./memory";
import { cfgOfficeEnabled, cfgOfficeOffices, cfgOfficeScale } from "./settings";
import { type OfficeRun, type OfficeUsage, readRuns, readUsage } from "./usage";
import { type Company, openCompany } from "./workspace";

/** The position a session holds in the company. */
export type Seat =
	| { kind: "manager"; company: Company; offices: Office[] }
	| { kind: "leader"; company: Company; office: Office; member: OfficeMember }
	| { kind: "worker"; company: Company; office: Office; member: OfficeMember };

/** A member's seat with the company it works for. */
export type MemberSeat = Exclude<Seat, { kind: "manager" }>;

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

// Agent id of a running member session → the seat it was given. Members run in this process, and
// an id is registered only for the length of the assignment that started it.
const memberSeats = new Map<string, MemberSeat>();

/** Give the member session that will run as `agentId` its seat. Returns the function that takes it back. */
export function registerMemberSeat(agentId: string, seat: MemberSeat): () => void {
	memberSeats.set(agentId, seat);
	return () => {
		if (memberSeats.get(agentId) === seat) memberSeats.delete(agentId);
	};
}

/**
 * The seat of a session: the main session (task depth 0) is the general manager; a subagent is a
 * member only when an office assignment started it under `agentId`. `null` when Virtual Office is
 * off, or for any other subagent (an ordinary `task` spawn has no seat and no `office` tool).
 */
export async function resolveSeat(
	settings: ScopeLike,
	cwd: string,
	taskDepth: number,
	agentId?: string | null,
): Promise<Seat | null> {
	if (!cfgOfficeEnabled.get(settings)) return null;
	if (taskDepth === 0) return { kind: "manager", company: await openCompany(cwd), offices: staffedOffices(settings) };
	return (agentId && memberSeats.get(agentId)) || null;
}

/** What an office is doing. */
export type OfficePhase = "working" | "idle";

export interface OfficeActivity {
	office: number;
	phase: OfficePhase;
	/** Members working right now. */
	working: string[];
	/** The assignment the office's leader is on, when there is one. */
	task?: string;
}

/** Runs a client gets with the state: enough for each member's recent history. */
const STATE_RUNS = 120;

/** What office `number` is doing, from who is working right now. */
export function describeActivity(number: number, claims: readonly MemberClaim[]): OfficeActivity {
	const mine = claims.filter(claim => claim.office === number);
	const working = mine.map(claim => claim.member);
	const task = (mine.find(claim => claim.role === "leader") ?? mine[0])?.task;
	return { office: number, phase: mine.length > 0 ? "working" : "idle", working, ...(task ? { task } : {}) };
}

/** Everything a client needs to draw the company: settings, roster, activity, spend and reports. */
export interface OfficeState {
	enabled: boolean;
	scale: OfficeScale;
	offices: Office[];
	/** `null` outside a git repository; `reason` then says why. */
	company: { checkout: string } | null;
	reason?: string;
	/** What each running office remembers about this project, in office order; empty without a company. */
	memory: OfficeMemory[];
	/** What each running office is doing, in office order; empty without a company. */
	activity: OfficeActivity[];
	/** Spend today and in total; `null` without a company. */
	usage: OfficeUsage | null;
	/** The most recent assignment runs, oldest first; a finished run names its report. */
	runs: OfficeRun[];
}

/** Snapshot of the company for the checkout containing `cwd`. Read-only apart from staffing. */
export async function readOfficeState(settings: ScopeLike, cwd: string): Promise<OfficeState> {
	const state: OfficeState = {
		enabled: cfgOfficeEnabled.get(settings),
		scale: cfgOfficeScale.get(settings),
		offices: staffedOffices(settings),
		company: null,
		memory: [],
		activity: [],
		usage: null,
		runs: [],
	};
	try {
		const company = await openCompany(cwd);
		state.company = { checkout: company.checkout };
		// First, so bookings the host already got as `office_usage` deltas are the ones it includes.
		state.usage = await readUsage(company);
		state.memory = await readOfficeMemories(
			company,
			state.offices.map(office => office.number),
		);
		const claims = await readClaims(company);
		state.activity = state.offices.map(office => describeActivity(office.number, claims));
		state.runs = (await readRuns(company)).slice(-STATE_RUNS);
	} catch (error) {
		state.reason = error instanceof Error ? error.message : String(error);
	}
	return state;
}
