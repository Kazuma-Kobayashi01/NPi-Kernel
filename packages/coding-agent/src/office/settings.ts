/**
 * Settings declared by this domain (see `config/registry.ts`).
 */
import { register } from "../config/registry";
import { OFFICE_SCALES, type OfficeConfig, validateOffices } from "./model";

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
			"Run the session as a company: the main chat is the general manager and hands work to offices, each with a leader and workers on their own git branches. Changes reach your branch only through reviewed pull requests, and the last merge waits for you. Manage the roster with `/office`.",
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

/**
 * The roster: one entry per office, each with 3 to 6 members. Edited through `/office`,
 * `npi office` and the RPC `office_*` commands rather than by hand; the names in it are permanent.
 */
export const cfgOfficeOffices = register({
	id: "office.offices",
	type: "array",
	default: NO_OFFICES,
	validate: validateOffices,
});
