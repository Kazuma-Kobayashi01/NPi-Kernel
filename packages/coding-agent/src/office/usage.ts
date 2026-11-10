/**
 * What the company has spent, per member and per day, and the record of each assignment run.
 *
 * Usage is booked when it happens, into the bucket of the local calendar day, so "today" starts at
 * 00:00 local time and an assignment running across midnight is split between the two days. The
 * general manager is booked under `general-manager` (`MANAGER` in `model.ts`).
 *
 * Writes are batched: a busy member reports several times a second. A booking is not an office
 * change: hosts get it as a delta through {@link onOfficeUsage} and keep their own running totals,
 * so a working member does not make every client re-read the whole company.
 */
import { readStore, storePath, updateStore } from "./store";
import { type Company, openCompany } from "./workspace";

/** Days kept as separate buckets; older ones are folded into `earlier`. */
export const MAX_USAGE_DAYS = 400;
/** Assignment runs kept, newest last. */
export const MAX_OFFICE_RUNS = 240;
/** Longest task text kept with a run, in characters. */
const MAX_RUN_TASK_LENGTH = 400;
const FLUSH_DELAY_MS = 1500;

export interface UsageAmount {
	/** Input + output + cache-write tokens; cache reads are not counted. */
	tokens: number;
	/** Estimated cost in USD at the model catalog's prices. */
	cost: number;
	/** Model requests made. */
	requests: number;
}

/** One assignment handed to a member. */
export interface OfficeRun {
	id: string;
	office: number;
	member: string;
	/** Who assigned it: `general-manager` or the office's leader. */
	by: string;
	task: string;
	/** The member's session transcript, once known. */
	sessionFile?: string;
	startedAt: string;
	endedAt?: string;
	failed?: boolean;
	/** Title of the report the run handed in (see `reports.ts`); absent while running or when there was none. */
	report?: string;
}

export interface MemberUsage {
	today: UsageAmount;
	total: UsageAmount;
}

export interface OfficeUsage {
	/** The local day `today` covers, `YYYY-MM-DD`. */
	day: string;
	/** By member name; the general manager is under `general-manager`. Removed members stay. */
	members: Record<string, MemberUsage>;
	today: UsageAmount;
	total: UsageAmount;
}

interface UsageFile {
	days: Record<string, Record<string, UsageAmount>>;
	earlier: Record<string, UsageAmount>;
	runs: OfficeRun[];
}

const emptyFile = (): UsageFile => ({ days: {}, earlier: {}, runs: [] });
const zero = (): UsageAmount => ({ tokens: 0, cost: 0, requests: 0 });

function add(into: UsageAmount, amount: Partial<UsageAmount>): void {
	into.tokens += amount.tokens ?? 0;
	into.cost += amount.cost ?? 0;
	into.requests += amount.requests ?? 0;
}

/** The local calendar day of `date`, `YYYY-MM-DD`. */
export function localDay(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${String(date.getDate()).padStart(2, "0")}`;
}

const paths = new Map<string, string>();

function usagePath(company: Company): string {
	let file = paths.get(company.checkout);
	if (!file) {
		file = storePath(company, "usage.json");
		paths.set(company.checkout, file);
	}
	return file;
}

// file → day → member → amount not yet written.
const pending = new Map<string, Map<string, Map<string, UsageAmount>>>();
let timer: NodeJS.Timeout | undefined;

/** One booking, as {@link onOfficeUsage} listeners see it. */
export interface UsageBooking {
	/** The company's checkout. */
	checkout: string;
	member: string;
	/** The local day it was booked on, `YYYY-MM-DD`. */
	day: string;
	amount: UsageAmount;
}

const usageListeners = new Set<(booking: UsageBooking) => void>();

/** Call `listener` with every booking as it happens. Returns the unsubscribe function. */
export function onOfficeUsage(listener: (booking: UsageBooking) => void): () => void {
	usageListeners.add(listener);
	return () => usageListeners.delete(listener);
}

/** Book `amount` to `member` on the local day of `now`. Returns at once; the write is batched. */
export function recordUsage(company: Company, member: string, amount: Partial<UsageAmount>, now = new Date()): void {
	if (!amount.tokens && !amount.cost && !amount.requests) return;
	const file = usagePath(company);
	const day = localDay(now);
	const booking: UsageBooking = { checkout: company.checkout, member, day, amount: zero() };
	add(booking.amount, amount);
	for (const listener of usageListeners) listener(booking);
	let days = pending.get(file);
	if (!days) pending.set(file, (days = new Map()));
	let members = days.get(day);
	if (!members) days.set(day, (members = new Map()));
	let booked = members.get(member);
	if (!booked) members.set(member, (booked = zero()));
	add(booked, amount);
	if (!timer) {
		timer = setTimeout(() => void flushUsage(), FLUSH_DELAY_MS);
		timer.unref?.();
	}
}

/** Write everything {@link recordUsage} has booked so far. */
export async function flushUsage(): Promise<void> {
	if (timer) clearTimeout(timer);
	timer = undefined;
	const batch = [...pending];
	pending.clear();
	await Promise.all(
		batch.map(([file, days]) =>
			updateStore(
				file,
				emptyFile,
				value => {
					for (const [day, members] of days) {
						const bucket = (value.days[day] ??= {});
						for (const [member, amount] of members) add((bucket[member] ??= zero()), amount);
					}
					const kept = Object.keys(value.days).sort();
					for (const day of kept.slice(0, Math.max(0, kept.length - MAX_USAGE_DAYS))) {
						for (const [member, amount] of Object.entries(value.days[day])) {
							add((value.earlier[member] ??= zero()), amount);
						}
						delete value.days[day];
					}
				},
				{ notify: false },
			),
		),
	);
}

/** Usage today (the local day of `now`) and in total, per member and for the whole company. */
export async function readUsage(company: Company, now = new Date()): Promise<OfficeUsage> {
	await flushUsage();
	const file = await readStore(usagePath(company), emptyFile);
	const day = localDay(now);
	const usage: OfficeUsage = { day, members: {}, today: zero(), total: zero() };
	const member = (name: string): MemberUsage => (usage.members[name] ??= { today: zero(), total: zero() });
	for (const [name, amount] of Object.entries(file.earlier ?? {})) {
		add(member(name).total, amount);
		add(usage.total, amount);
	}
	for (const [bucketDay, members] of Object.entries(file.days ?? {})) {
		for (const [name, amount] of Object.entries(members)) {
			add(member(name).total, amount);
			add(usage.total, amount);
			if (bucketDay === day) {
				add(member(name).today, amount);
				add(usage.today, amount);
			}
		}
	}
	return usage;
}

/** Record that an assignment started. */
export async function startRun(company: Company, run: Omit<OfficeRun, "startedAt">, now = new Date()): Promise<void> {
	await updateStore(usagePath(company), emptyFile, file => {
		file.runs.push({ ...run, task: run.task.slice(0, MAX_RUN_TASK_LENGTH), startedAt: now.toISOString() });
		file.runs.splice(0, Math.max(0, file.runs.length - MAX_OFFICE_RUNS));
	});
}

/** Fill in what became known about run `id`: its transcript, its end, its report. */
export async function updateRun(
	company: Company,
	id: string,
	patch: Partial<Pick<OfficeRun, "sessionFile" | "endedAt" | "failed" | "report">>,
): Promise<void> {
	await updateStore(usagePath(company), emptyFile, file => {
		const run = file.runs.find(candidate => candidate.id === id);
		if (run) Object.assign(run, patch);
	});
}

/** Assignment runs, oldest first. */
export async function readRuns(company: Company): Promise<OfficeRun[]> {
	return (await readStore(usagePath(company), emptyFile)).runs ?? [];
}

/**
 * `file` when it is the transcript of one of this company's assignment runs, else `undefined`.
 * Lets a host read a member's past conversations, which no live subagent registry lists.
 */
export async function officeRunSessionFile(cwd: string, file: string): Promise<string | undefined> {
	try {
		const runs = await readRuns(await openCompany(cwd));
		return runs.some(run => run.sessionFile === file) ? file : undefined;
	} catch {
		return undefined;
	}
}
