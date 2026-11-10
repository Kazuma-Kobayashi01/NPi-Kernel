/**
 * The owner's command line for the Virtual Office, shared by `/office` in a session and
 * `npi office` in a shell: switch it on, size the company, edit the roster, and read the reports
 * the offices handed in.
 */
import type { Settings } from "../config/settings";
import { SUBAGENT_THINKING_LEVELS } from "../task/settings";
import { readOfficeState, staffedOffices } from "./company";
import {
	addMember,
	OFFICE_CAPABILITIES,
	OFFICE_COUNT,
	OFFICE_ROLES,
	OFFICE_SCALES,
	type OfficeConfig,
	OfficeRosterError,
	type OfficeThinking,
	removeMember,
	resizeOffice,
	updateMember,
} from "./model";
import { readReport } from "./reports";
import { readRuns } from "./usage";
import { forgetOffice, OfficeMemoryError, readOfficeMemory, rememberNote } from "./memory";
import { cfgOfficeEnabled, cfgOfficeOffices, cfgOfficeScale } from "./settings";
import { OfficeWorkspaceError, openCompany } from "./workspace";

export const OFFICE_COMMAND_USAGE = [
	"/office                                   open the Virtual Office panel (in the terminal UI)",
	"/office status                            show the company and its recent reports",
	"/office on | off                          turn Virtual Office on or off",
	"/office scale team|studio|enterprise      1, 3 or 6 offices",
	"/office size <office> <3-6>               set an office's member count",
	"/office add <office> [model] [capability] add a worker",
	"/office remove <name>                     remove a worker",
	'/office set <name> model <selector>       the model a member runs on ("default" to clear)',
	'/office set <name> thinking <level>       the thinking effort a member runs at ("default" to clear)',
	"/office set <name> capability common|professional|expert",
	"/office set <name> role leader            make a member the office's leader",
	"/office report [run]                      list recent reports, or print one",
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

/** Who wrote a lesson the owner gave an office from the command line. */
const OWNER = "owner";
/** Reports `/office report` lists. */
const LISTED_REPORTS = 12;

function describeRunLine(run: {
	id: string;
	office: number;
	member: string;
	endedAt?: string;
	failed?: boolean;
	report?: string;
}): string {
	const state = !run.endedAt ? "running" : run.failed ? "did not finish" : (run.report ?? "no report");
	return `  ${run.id}  office ${run.office}  ${run.member}  ${state}`;
}

async function renderState(settings: Settings, cwd: string): Promise<string> {
	const state = await readOfficeState(settings, cwd);
	const lines = [
		`Virtual Office: ${state.enabled ? "on" : "off"} · ${state.scale} (${OFFICE_COUNT[state.scale]} office${OFFICE_COUNT[state.scale] === 1 ? "" : "s"})`,
		state.company ? `Project: ${state.company.checkout}` : `No company here: ${state.reason}`,
	];
	for (const office of state.offices) {
		lines.push(`Office ${office.number}`);
		for (const member of office.members) {
			lines.push(
				`  ${member.id}  ${member.role.padEnd(6)}  ${member.capability.padEnd(12)}  ${member.model || "default model"}  ${member.thinking ? `${member.thinking} effort` : "default effort"}`,
			);
		}
	}
	const recent = state.runs.slice(-LISTED_REPORTS).reverse();
	if (recent.length > 0) {
		lines.push("Recent reports (/office report <run>):");
		for (const run of recent) lines.push(describeRunLine(run));
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
			const offices = roster(settings);
			cfgOfficeOffices.set(settings, removeMember(offices, rest[0]));
			return `${rest[0]} left the company.\n${await renderState(settings, cwd)}`;
		}
		case "set": {
			const [name, field, ...value] = rest;
			if (!name || !field)
				throw new OfficeUsageError("Expected: set <name> model|thinking|capability|role <value>.");
			const text = value.join(" ").trim();
			const patch =
				field === "model"
					? { model: text === "default" ? "" : text }
					: field === "thinking"
						? {
								thinking:
									text === "default"
										? ""
										: oneOf<OfficeThinking>(SUBAGENT_THINKING_LEVELS, text, "a thinking level"),
							}
						: field === "capability"
							? { capability: oneOf(OFFICE_CAPABILITIES, text, "a capability") }
							: field === "role"
								? { role: oneOf(OFFICE_ROLES, text, "a role") }
								: undefined;
			if (!patch) throw new OfficeUsageError("Expected one of: model, thinking, capability, role.");
			if ((field === "model" || field === "thinking") && !text)
				throw new OfficeUsageError('Expected a value, or "default".');
			cfgOfficeOffices.set(settings, updateMember(roster(settings), name, patch));
			return renderState(settings, cwd);
		}
		case "report": {
			const company = await openCompany(cwd);
			if (!rest[0]) {
				const runs = (await readRuns(company)).slice(-LISTED_REPORTS).reverse();
				if (runs.length === 0) return "No office has handed in a report yet.";
				return ["Recent reports (/office report <run>):", ...runs.map(describeRunLine)].join("\n");
			}
			const text = await readReport(company, rest[0]);
			if (text === undefined) throw new OfficeUsageError(`No report is kept for run ${rest[0]}.`);
			return text.trimEnd();
		}
		case "memory": {
			const office = officeNumber(rest[0]);
			const memory = await readOfficeMemory(await openCompany(cwd), office);
			if (memory.notes.length === 0) {
				return `Office ${office} remembers nothing about this project yet.`;
			}
			return [
				`Office ${office} remembers about this project:`,
				...memory.notes.map(note => `  - ${note.text} (${note.by})`),
			].join("\n");
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
			error instanceof OfficeWorkspaceError ||
			error instanceof OfficeMemoryError
		) {
			return { text: error.message, failed: true };
		}
		throw error;
	}
}
