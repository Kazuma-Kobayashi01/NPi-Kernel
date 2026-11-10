/**
 * Virtual Office roster: the configured offices and their members.
 *
 * An office is a small team — one Leader who assigns and reviews, the rest Workers who do the
 * work. Members keep the name they were given when they joined (`Worker-xxxxxx`) until they are
 * removed, so a roster reads the same from one session to the next.
 *
 * Everything here is pure: the functions take a roster and return a new one. Persisting it is the
 * job of `office/settings.ts`, running it the job of `office/tool.ts`.
 */
import { isRecord } from "@oh-my-pi/pi-utils";

/** How many offices a company runs. */
export const OFFICE_SCALES = ["team", "studio", "enterprise"] as const;
export type OfficeScale = (typeof OFFICE_SCALES)[number];

/** Offices each scale runs. */
export const OFFICE_COUNT: Record<OfficeScale, number> = { team: 1, studio: 3, enterprise: 6 };

export const OFFICE_ROLES = ["leader", "worker"] as const;
export type OfficeRole = (typeof OFFICE_ROLES)[number];

/** A member's seniority; the Leader matches task difficulty to it. */
export const OFFICE_CAPABILITIES = ["common", "professional", "expert"] as const;
export type OfficeCapability = (typeof OFFICE_CAPABILITIES)[number];

export const MIN_OFFICE_MEMBERS = 3;
export const MAX_OFFICE_MEMBERS = 6;

const MEMBER_ID_RE = /^Worker-[0-9a-f]{6}$/;

export interface OfficeMember {
	/** Fixed name, `Worker-xxxxxx`. Never reassigned while the member exists. */
	id: string;
	role: OfficeRole;
	/** Model selector the member runs on; empty = the session's default subagent model. */
	model: string;
	capability: OfficeCapability;
}

export interface OfficeConfig {
	members: OfficeMember[];
}

/** A configured office with its 1-based number. */
export interface Office extends OfficeConfig {
	number: number;
}

/** Thrown for a roster edit the rules forbid; the message is shown to the user as is. */
export class OfficeRosterError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OfficeRosterError";
	}
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
	return typeof value === "string" && (values as readonly string[]).includes(value);
}

/**
 * Rejects a malformed `office.offices` value. Runs on every settings load and write, so a
 * hand-edited config fails with the offending office and member named.
 */
export function validateOffices(value: unknown): void {
	if (value === undefined || value === null) return;
	if (!Array.isArray(value)) throw new Error("Invalid office.offices: expected a list of offices.");
	const seen = new Set<string>();
	value.forEach((office, index) => {
		const at = `office.offices[${index}]`;
		if (!isRecord(office) || !Array.isArray(office.members)) {
			throw new Error(`Invalid ${at}: expected { members: [...] }.`);
		}
		const members: unknown[] = office.members;
		if (members.length < MIN_OFFICE_MEMBERS || members.length > MAX_OFFICE_MEMBERS) {
			throw new Error(
				`Invalid ${at}: an office has ${MIN_OFFICE_MEMBERS} to ${MAX_OFFICE_MEMBERS} members, got ${members.length}.`,
			);
		}
		let leaders = 0;
		for (const member of members) {
			if (!isRecord(member) || typeof member.id !== "string" || !MEMBER_ID_RE.test(member.id)) {
				throw new Error(`Invalid ${at}: every member needs an id of the form Worker-xxxxxx (six hex digits).`);
			}
			if (seen.has(member.id)) throw new Error(`Invalid ${at}: member ${member.id} is listed twice.`);
			seen.add(member.id);
			if (!isOneOf(OFFICE_ROLES, member.role)) {
				throw new Error(`Invalid ${at}: ${member.id} has role ${Bun.inspect(member.role)}; use leader or worker.`);
			}
			if (!isOneOf(OFFICE_CAPABILITIES, member.capability)) {
				throw new Error(
					`Invalid ${at}: ${member.id} has capability ${Bun.inspect(member.capability)}; use common, professional or expert.`,
				);
			}
			if (typeof member.model !== "string") {
				throw new Error(`Invalid ${at}: ${member.id} needs a model (a selector string, or "" to inherit).`);
			}
			if (member.role === "leader") leaders++;
		}
		if (leaders !== 1) throw new Error(`Invalid ${at}: an office has exactly one leader, got ${leaders}.`);
	});
}

function takenIds(offices: readonly OfficeConfig[]): Set<string> {
	return new Set(offices.flatMap(office => office.members.map(member => member.id)));
}

/** A fresh `Worker-xxxxxx` name not in `taken`; the new name is added to `taken`. */
export function newMemberId(taken: Set<string>): string {
	for (;;) {
		const bytes = crypto.getRandomValues(new Uint8Array(3));
		const id = `Worker-${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
		if (taken.has(id)) continue;
		taken.add(id);
		return id;
	}
}

function newOffice(taken: Set<string>): OfficeConfig {
	return {
		members: Array.from({ length: MIN_OFFICE_MEMBERS }, (_, index) => ({
			id: newMemberId(taken),
			role: index === 0 ? "leader" : "worker",
			model: "",
			capability: index === 0 ? "expert" : "common",
		})),
	};
}

/**
 * The roster grown to the scale's office count. Existing offices and names are kept as they are;
 * only missing offices are staffed (one leader, two workers). Offices beyond the count stay in the
 * roster, dormant, so scaling back up brings the same people back.
 */
export function staffOffices(scale: OfficeScale, offices: readonly OfficeConfig[]): OfficeConfig[] {
	const staffed = offices.map(office => ({ members: office.members.map(member => ({ ...member })) }));
	const taken = takenIds(staffed);
	while (staffed.length < OFFICE_COUNT[scale]) staffed.push(newOffice(taken));
	return staffed;
}

/** The offices that run at this scale, numbered from 1. */
export function activeOffices(scale: OfficeScale, offices: readonly OfficeConfig[]): Office[] {
	return offices
		.slice(0, OFFICE_COUNT[scale])
		.map((office, index) => ({ number: index + 1, members: office.members }));
}

export function leaderOf(office: OfficeConfig): OfficeMember {
	const leader = office.members.find(member => member.role === "leader");
	if (!leader) throw new OfficeRosterError("This office has no leader.");
	return leader;
}

export function workersOf(office: OfficeConfig): OfficeMember[] {
	return office.members.filter(member => member.role === "worker");
}

/** The office (0-based index) and position of a member, by exact name. */
function locate(offices: readonly OfficeConfig[], id: string): { office: number; member: number } {
	for (let office = 0; office < offices.length; office++) {
		const member = offices[office].members.findIndex(candidate => candidate.id === id);
		if (member >= 0) return { office, member };
	}
	throw new OfficeRosterError(`No member named ${id}.`);
}

function officeAt(offices: readonly OfficeConfig[], number: number): number {
	if (!Number.isInteger(number) || number < 1 || number > offices.length) {
		throw new OfficeRosterError(`No office ${number}; offices are numbered 1 to ${offices.length}.`);
	}
	return number - 1;
}

function withMembers(offices: readonly OfficeConfig[], index: number, members: OfficeMember[]): OfficeConfig[] {
	return offices.map((office, at) => (at === index ? { members } : office));
}

/** Add a worker to office `number`. */
export function addMember(
	offices: readonly OfficeConfig[],
	number: number,
	options: { model?: string; capability?: OfficeCapability } = {},
): { offices: OfficeConfig[]; member: OfficeMember } {
	const index = officeAt(offices, number);
	const members = offices[index].members;
	if (members.length >= MAX_OFFICE_MEMBERS) {
		throw new OfficeRosterError(`Office ${number} is full (${MAX_OFFICE_MEMBERS} members).`);
	}
	const member: OfficeMember = {
		id: newMemberId(takenIds(offices)),
		role: "worker",
		model: options.model ?? "",
		capability: options.capability ?? "common",
	};
	return { offices: withMembers(offices, index, [...members, member]), member };
}

/** Remove a worker. The leader cannot be removed, and an office keeps at least three members. */
export function removeMember(offices: readonly OfficeConfig[], id: string): OfficeConfig[] {
	const at = locate(offices, id);
	const members = offices[at.office].members;
	if (members[at.member].role === "leader") {
		throw new OfficeRosterError(`${id} leads office ${at.office + 1}. Make another member the leader first.`);
	}
	if (members.length <= MIN_OFFICE_MEMBERS) {
		throw new OfficeRosterError(`Office ${at.office + 1} needs at least ${MIN_OFFICE_MEMBERS} members.`);
	}
	return withMembers(
		offices,
		at.office,
		members.filter(member => member.id !== id),
	);
}

/** Change one member's model, capability or role. Making a member the leader demotes the old one. */
export function updateMember(
	offices: readonly OfficeConfig[],
	id: string,
	patch: { model?: string; capability?: OfficeCapability; role?: OfficeRole },
): OfficeConfig[] {
	const at = locate(offices, id);
	const current = offices[at.office].members[at.member];
	if (patch.role === "worker" && current.role === "leader") {
		throw new OfficeRosterError(
			`${id} leads office ${at.office + 1}. Make another member the leader and ${id} becomes a worker.`,
		);
	}
	const promoted = patch.role === "leader" && current.role !== "leader";
	const members = offices[at.office].members.map(member => {
		if (member.id === id) {
			return {
				...member,
				...(patch.model !== undefined ? { model: patch.model.trim() } : {}),
				...(patch.capability !== undefined ? { capability: patch.capability } : {}),
				...(patch.role !== undefined ? { role: patch.role } : {}),
			};
		}
		return promoted && member.role === "leader" ? { ...member, role: "worker" as const } : member;
	});
	return withMembers(offices, at.office, members);
}

/** Set office `number` to `count` members by adding workers or removing the most recent ones. */
export function resizeOffice(offices: readonly OfficeConfig[], number: number, count: number): OfficeConfig[] {
	if (!Number.isInteger(count) || count < MIN_OFFICE_MEMBERS || count > MAX_OFFICE_MEMBERS) {
		throw new OfficeRosterError(`An office has ${MIN_OFFICE_MEMBERS} to ${MAX_OFFICE_MEMBERS} members.`);
	}
	let next = [...offices];
	const index = officeAt(next, number);
	while (next[index].members.length < count) next = addMember(next, number).offices;
	while (next[index].members.length > count) {
		const last = workersOf(next[index]).at(-1);
		if (!last) break;
		next = removeMember(next, last.id);
	}
	return next;
}
