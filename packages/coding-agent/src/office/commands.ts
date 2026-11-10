/**
 * The owner's command line for the Virtual Office, shared by `/office` in a session and
 * `npi office` in a shell: switch it on, size the company, edit the roster, and merge or send
 * back the pull requests the general manager approved.
 */
import type { Settings } from "../config/settings";
import { ownerMerge, ownerRequestChanges, readOfficeState, staffedOffices } from "./company";
import {
	addMember,
	OFFICE_CAPABILITIES,
	OFFICE_COUNT,
	OFFICE_ROLES,
	OFFICE_SCALES,
	type OfficeConfig,
	OfficeRosterError,
	removeMember,
	resizeOffice,
	updateMember,
} from "./model";
import { OWNER, type Pull, PullError } from "./pulls";
import { forgetOffice, OfficeMemoryError, readOfficeMemory, rememberNote } from "./memory";
import { cfgOfficeEnabled, cfgOfficeOffices, cfgOfficeScale } from "./settings";
import { OfficeWorkspaceError, openCompany } from "./workspace";

export const OFFICE_COMMAND_USAGE = [
	"/office                                   show the company and its pull requests",
	"/office on | off                          turn Virtual Office on or off",
	"/office scale team|studio|enterprise      1, 3 or 6 offices",
	"/office size <office> <3-6>               set an office's member count",
	"/office add <office> [model] [capability] add a worker",
	"/office remove <name>                     remove a worker",
	'/office set <name> model <selector>       the model a member runs on ("default" to clear)',
	"/office set <name> capability common|professional|expert",
	"/office set <name> role leader            make a member the office's leader",
	"/office merge <pr>                        merge an approved office pull request into your branch",
	"/office reject <pr> <reason>              send an office pull request back",
	"/office memory <office>                   what an office remembers about this project",
	"/office remember <office> <lesson>        give an office a lesson to keep",
	"/office forget <office>                   clear what an office remembers about this project",
].join("\n");

export interface OfficeCommandResult {
	text: string;
	/** The command was understood but refused, or malformed. */
	failed?: boolean;
}

/** Thrown for a malformed command; the message names what was expected. */
class OfficeUsageError extends Error {}

function oneOf<T extends string>(values: readonly T[], value: string | undefined, what: string): T {
	const match = values.find(candidate => candidate === value?.toLowerCase());
	if (!match) throw new OfficeUsageError(`Expected ${what}: ${values.join(", ")}.`);
	return match;
}

function officeNumber(value: string | undefined): number {
	const number = Number(value);
	if (!value || !Number.isInteger(number)) throw new OfficeUsageError("Expected an office number.");
	return number;
}

function pullNumber(value: string | undefined): number {
	const number = Number(value?.replace(/^#/, ""));
	if (!Number.isInteger(number) || number < 1) throw new OfficeUsageError("Expected a pull request number.");
	return number;
}

function describePullLine(pull: Pull): string {
	const from = pull.kind === "office" ? `office ${pull.office}` : `${pull.author} (office ${pull.office})`;
	const waiting = pull.kind === "office" && pull.status === "approved" ? `  ← /office merge ${pull.number}` : "";
	return `  #${pull.number} [${pull.status.replace("_", " ")}] ${pull.title} — ${from} → ${pull.target}${waiting}`;
}

async function renderState(settings: Settings, cwd: string): Promise<string> {
	const state = await readOfficeState(settings, cwd);
	const lines = [
		`Virtual Office: ${state.enabled ? "on" : "off"} · ${state.scale} (${OFFICE_COUNT[state.scale]} office${OFFICE_COUNT[state.scale] === 1 ? "" : "s"})`,
		state.company ? `Base branch: ${state.company.baseBranch}` : `No company here: ${state.reason}`,
	];
	for (const office of state.offices) {
		lines.push(`Office ${office.number}`);
		for (const member of office.members) {
			lines.push(
				`  ${member.id}  ${member.role.padEnd(6)}  ${member.capability.padEnd(12)}  ${member.model || "default model"}`,
			);
		}
	}
	const unfinished = state.pulls.filter(pull => pull.status !== "merged" && pull.status !== "closed");
	if (unfinished.length > 0) {
		lines.push("Pull requests:");
		for (const pull of unfinished) lines.push(describePullLine(pull));
	}
	return lines.join("\n");
}

/** The whole roster, dormant offices included, staffed up to the current scale. */
function roster(settings: Settings): readonly OfficeConfig[] {
	staffedOffices(settings);
	return cfgOfficeOffices.get(settings);
}

async function run(args: string[], settings: Settings, cwd: string): Promise<string> {
	const [verb, ...rest] = args;
	switch (verb?.toLowerCase()) {
		case undefined:
		case "status":
		case "prs":
			return renderState(settings, cwd);
		case "on":
		case "off": {
			cfgOfficeEnabled.set(settings, verb.toLowerCase() === "on");
			return renderState(settings, cwd);
		}
		case "scale": {
			cfgOfficeScale.set(settings, oneOf(OFFICE_SCALES, rest[0], "a company size"));
			return renderState(settings, cwd);
		}
		case "size": {
			cfgOfficeOffices.set(settings, resizeOffice(roster(settings), officeNumber(rest[0]), Number(rest[1])));
			return renderState(settings, cwd);
		}
		case "add": {
			const capability = rest[2] ? oneOf(OFFICE_CAPABILITIES, rest[2], "a capability") : undefined;
			const added = addMember(roster(settings), officeNumber(rest[0]), { model: rest[1], capability });
			cfgOfficeOffices.set(settings, added.offices);
			return `${added.member.id} joined office ${rest[0]}.\n${await renderState(settings, cwd)}`;
		}
		case "remove": {
			if (!rest[0]) throw new OfficeUsageError("Expected a member name.");
			cfgOfficeOffices.set(settings, removeMember(roster(settings), rest[0]));
			return `${rest[0]} left the company.\n${await renderState(settings, cwd)}`;
		}
		case "set": {
			const [name, field, ...value] = rest;
			if (!name || !field) throw new OfficeUsageError("Expected: set <name> model|capability|role <value>.");
			const text = value.join(" ").trim();
			const patch =
				field === "model"
					? { model: text === "default" ? "" : text }
					: field === "capability"
						? { capability: oneOf(OFFICE_CAPABILITIES, text, "a capability") }
						: field === "role"
							? { role: oneOf(OFFICE_ROLES, text, "a role") }
							: undefined;
			if (!patch) throw new OfficeUsageError("Expected one of: model, capability, role.");
			if (field === "model" && !text) throw new OfficeUsageError('Expected a model selector, or "default".');
			cfgOfficeOffices.set(settings, updateMember(roster(settings), name, patch));
			return renderState(settings, cwd);
		}
		case "merge": {
			const pull = await ownerMerge(cwd, pullNumber(rest[0]));
			return `Merged #${pull.number} "${pull.title}" into ${pull.target} as ${pull.mergeCommit?.slice(0, 12)}.`;
		}
		case "reject": {
			const pull = await ownerRequestChanges(cwd, pullNumber(rest[0]), rest.slice(1).join(" "));
			return `Sent #${pull.number} back to office ${pull.office}. Tell the general manager to have it fixed.`;
		}
		case "memory": {
			const office = officeNumber(rest[0]);
			const memory = await readOfficeMemory(await openCompany(cwd), office);
			if (memory.notes.length + memory.log.length === 0) {
				return `Office ${office} remembers nothing about this project yet.`;
			}
			const lines = [`Office ${office} remembers about this project:`];
			if (memory.notes.length > 0)
				lines.push("Lessons:", ...memory.notes.map(note => `  - ${note.text} (${note.by})`));
			if (memory.log.length > 0) {
				lines.push(
					"Merged work:",
					...memory.log.map(
						entry =>
							`  #${entry.pr} ${entry.title} — ${entry.author} → ${entry.target}${entry.files.length ? ` (${entry.files.length} file(s))` : ""}`,
					),
				);
			}
			return lines.join("\n");
		}
		case "remember": {
			const office = officeNumber(rest[0]);
			await rememberNote(await openCompany(cwd), office, OWNER, rest.slice(1).join(" "));
			return `Office ${office} will remember that.`;
		}
		case "forget": {
			const office = officeNumber(rest[0]);
			const had = await forgetOffice(await openCompany(cwd), office);
			return had
				? `Office ${office} forgot what it remembered about this project.`
				: `Office ${office} remembered nothing about this project.`;
		}
		default:
			throw new OfficeUsageError(`Unknown subcommand "${verb}".`);
	}
}

/** Run one owner command. Never throws for a refused or malformed command; see `failed`. */
export async function runOfficeCommand(args: string[], settings: Settings, cwd: string): Promise<OfficeCommandResult> {
	try {
		return { text: await run(args, settings, cwd) };
	} catch (error) {
		if (error instanceof OfficeUsageError)
			return { text: `${error.message}\n\n${OFFICE_COMMAND_USAGE}`, failed: true };
		if (
			error instanceof OfficeRosterError ||
			error instanceof PullError ||
			error instanceof OfficeWorkspaceError ||
			error instanceof OfficeMemoryError
		) {
			return { text: error.message, failed: true };
		}
		throw error;
	}
}
