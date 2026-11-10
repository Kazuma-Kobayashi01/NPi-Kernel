/**
 * Settings declared by this domain (see `config/registry.ts`).
 */
import { register } from "../config/registry";
import { normalizeOffices, OFFICE_SCALES, type OfficeConfig, validateOffices } from "./model";

const NO_OFFICES: readonly OfficeConfig[] = [];

export const cfgOfficeEnabled = register({
	id: "office.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Virtual Office",
		label: "Virtual Office",
		description:
			"Give the session a research department: the main chat is the general manager and can hand questions to offices, each a leader and workers who investigate read-only (no shell, no edits) and report back. The general manager decides and makes the changes itself. Manage the roster with `/office`.",
	},
});

export const cfgOfficeScale = register({
	id: "office.scale",
	type: "enum",
	values: OFFICE_SCALES,
	default: "team",
	ui: {
		tab: "tasks",
		group: "Virtual Office",
		label: "Company Size",
		description: "How many offices the general manager can hand work to",
		options: [
			{ value: "team", label: "Team", description: "1 office" },
			{ value: "studio", label: "Studio", description: "3 offices" },
			{ value: "enterprise", label: "Enterprise", description: "6 offices" },
		],
	},
});

export const cfgOfficeAssignmentTimeoutMs = register({
	id: "office.assignmentTimeoutMs",
	type: "number",
	default: 900_000,
	ui: {
		tab: "tasks",
		group: "Virtual Office",
		label: "Assignment Time Limit",
		description:
			"Longest one worker investigation may run (ms) before it is stopped and reported as not finished, so one stuck member cannot hold up the whole company. A leader, whose assignment includes its workers' runs, gets four times as long. 0 falls back to the subagent limit (`task.maxRuntimeMs`).",
		options: [
			{ value: "900000", label: "15 minutes", description: "Default" },
			{ value: "1800000", label: "30 minutes" },
			{ value: "3600000", label: "1 hour" },
			{ value: "0", label: "Subagent limit" },
		],
	},
});

/**
 * The roster: one entry per office, each with 3 to 6 members. Edited through `/office`,
 * `npi office` and the RPC `office_*` commands rather than by hand; the names in it are permanent.
 */
export const cfgOfficeOffices = register({
	id: "office.offices",
	type: "array",
	default: NO_OFFICES,
	validate: validateOffices,
	// Rosters saved before members had an effort get "" so every reader sees the full shape.
	normalize: value => normalizeOffices(value as readonly OfficeConfig[]),
});
