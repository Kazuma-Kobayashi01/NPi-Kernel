/**
 * Fullscreen `/office` panel (the /settings idiom): a tab for the company, one per office and one
 * for the reports they handed in. ↑/↓ move, Enter opens or changes the selected row, Esc goes back.
 *
 * The panel owns no rules. Every change is an `/office …` command handed to `run`, and the state
 * is re-read afterwards, so it can never disagree with the command line. With `watch` it also
 * follows the company live: a change re-reads the state, and booked usage arrives as deltas the
 * panel adds up itself, so a working member never makes it re-read the whole company.
 */
import { type Component, matchesKey, routeSgrMouseInput } from "../index";
import { ListDialogFrame } from "../chrome/list-dialog";
import { divider, row } from "../chrome/overlay-box";
import { getTabBarTheme } from "../chrome/shared";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import { formatKeyHint } from "../app-keybindings";
import { Input } from "../components/input";
import { type Tab, TabBar } from "../components/tab-bar";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import { theme } from "../theme/theme";
import { padToWidth } from "../render/utils";
import { replaceTabs, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils";

export interface OfficePanelMember {
	id: string;
	role: string;
	capability: string;
	/** Empty for the default model. */
	model: string;
	/** Thinking effort; empty for the default. */
	thinking?: string;
}

export interface OfficePanelOffice {
	number: number;
	members: OfficePanelMember[];
}

export interface OfficePanelMemory {
	office: number;
	notes: { by: string; text: string }[];
}

export interface OfficePanelAmount {
	tokens: number;
	/** Estimated USD. */
	cost: number;
	requests: number;
}

export interface OfficePanelUsage {
	/** The local day `today` covers, `YYYY-MM-DD`. */
	day: string;
	/** By member name; the general manager is `general-manager`. */
	members: Record<string, { today: OfficePanelAmount; total: OfficePanelAmount }>;
	today: OfficePanelAmount;
	total: OfficePanelAmount;
}

export interface OfficePanelActivity {
	office: number;
	/** `working` or `idle`. */
	phase: string;
	working: string[];
	task?: string;
}

export interface OfficePanelRun {
	id: string;
	office: number;
	member: string;
	by: string;
	task: string;
	startedAt: string;
	endedAt?: string;
	failed?: boolean;
	/** Title of the report the run handed in. */
	report?: string;
}

export interface OfficePanelState {
	enabled: boolean;
	scale: string;
	offices: OfficePanelOffice[];
	company: { checkout?: string } | null;
	/** Why there is no company here. */
	reason?: string;
	memory: OfficePanelMemory[];
	activity?: OfficePanelActivity[];
	usage?: OfficePanelUsage | null;
	/** Recent assignment runs, oldest first. */
	runs?: OfficePanelRun[];
}

/** Usage one member booked, as a delta to add to `OfficePanelState.usage`. */
export interface OfficePanelBooking {
	checkout: string;
	member: string;
	day: string;
	amount: OfficePanelAmount;
}

export interface OfficePanelOptions {
	load: () => Promise<OfficePanelState>;
	/** Run one `/office` command (its words, without the leading `/office`). */
	run: (args: string[]) => Promise<{ text: string; failed?: boolean }>;
	/** Model selectors a member can be put on. */
	models: readonly string[];
	/** Company sizes with the number of offices each runs. */
	scales: readonly { id: string; offices: number }[];
	capabilities: readonly string[];
	/** Thinking efforts a member on `model` (empty: the default model) can be set to. */
	thinkingLevels?: (model: string) => readonly string[];
	minMembers: number;
	maxMembers: number;
	/** The report run `runId` handed in; `undefined` when none is kept. */
	loadReport?: (runId: string) => Promise<string | undefined>;
	/** Follow the company live; returns the function that stops. */
	watch?: (listeners: { change: () => void; usage: (booking: OfficePanelBooking) => void }) => () => void;
	requestRender: () => void;
	onClose: () => void;
}

interface Row {
	label: string;
	value?: string;
	/** Section title: not selectable. */
	heading?: boolean;
	act?: () => void;
}

/** A page stacked on top of the tabs; Esc pops it. */
type Page =
	| { kind: "member"; id: string }
	| { kind: "report"; runId: string; title: string; text?: string; error?: string }
	| { kind: "pick"; title: string; choices: { label: string; value: string }[]; onPick: (value: string) => void }
	| { kind: "confirm"; title: string; yes: string; onYes: () => void }
	| { kind: "input"; title: string; onSubmit: (value: string) => void };

const COMPANY_TAB = "company";
const REPORTS_TAB = "reports";
const officeTab = (number: number): string => `office:${number}`;
const MANAGER = "general-manager";
/** Recent assignments listed on an office tab and a member page; the Reports tab lists more. */
const RECENT_RUNS = 8;
/** A burst of changes (members starting and finishing in quick succession) is read once. */
const RELOAD_DELAY_MS = 150;

const PHASE_LABELS: Record<string, string> = { working: "investigating", idle: "idle" };

/** Reports the Reports tab lists, newest first. */
const LISTED_REPORTS = 40;

const zero = (): OfficePanelAmount => ({ tokens: 0, cost: 0, requests: 0 });
const plus = (a: OfficePanelAmount | undefined, b: OfficePanelAmount | undefined): OfficePanelAmount => ({
	tokens: (a?.tokens ?? 0) + (b?.tokens ?? 0),
	cost: (a?.cost ?? 0) + (b?.cost ?? 0),
	requests: (a?.requests ?? 0) + (b?.requests ?? 0),
});

/** The local calendar day of `date`, `YYYY-MM-DD`, as omp books usage. */
function localDay(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${String(date.getDate()).padStart(2, "0")}`;
}

/** `usage` with "today" started over for `day`; the same object when it already covers it. */
export function rollUsageDay(usage: OfficePanelUsage, day: string): OfficePanelUsage {
	if (usage.day === day) return usage;
	const members: OfficePanelUsage["members"] = {};
	for (const [name, member] of Object.entries(usage.members)) members[name] = { today: zero(), total: member.total };
	return { ...usage, day, members, today: zero() };
}

/**
 * `usage` with `booking` added. A booking on a later day starts "today" over first; one on an
 * earlier day (a run that crossed midnight, reported late) only counts toward the total.
 */
export function bookUsage(usage: OfficePanelUsage, booking: OfficePanelBooking): OfficePanelUsage {
	const next = rollUsageDay(usage, booking.day > usage.day ? booking.day : usage.day);
	const today = booking.day === next.day;
	const prior = next.members[booking.member] ?? { today: zero(), total: zero() };
	return {
		...next,
		members: {
			...next.members,
			[booking.member]: {
				today: today ? plus(prior.today, booking.amount) : prior.today,
				total: plus(prior.total, booking.amount),
			},
		},
		today: today ? plus(next.today, booking.amount) : next.today,
		total: plus(next.total, booking.amount),
	};
}

/** "950", "41.2k", "1.8M". */
function shortTokens(tokens: number): string {
	const n = Math.max(0, tokens);
	if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`;
	return String(Math.floor(n));
}

/** "$12.47"; four decimals under a cent so a small run is not "$0.00". */
function usd(cost: number): string {
	const n = Math.max(0, cost);
	return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function spend(amount: OfficePanelAmount): string {
	return `${shortTokens(amount.tokens)} tokens · ${usd(amount.cost)}`;
}

/** "14:05" today, else "11-09 14:05". */
function when(iso: string, now: Date): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	return localDay(date) === localDay(now) ? time : `${localDay(date).slice(5)} ${time}`;
}

export class OfficePanelComponent implements Component {
	#options: OfficePanelOptions;
	#tabBar: TabBar;
	#state: OfficePanelState | undefined;
	#pages: Page[] = [];
	#cursor = 0;
	#scroll = 0;
	#busy = false;
	#status: { text: string; failed: boolean } | undefined;
	#input = new Input();
	#rows: Row[] = [];
	#lastViewportRows = 10;
	#tabRowStart = 0;
	#tabRowCount = 0;
	#bodyRowStart = 0;
	/** Width rows are laid out for; a report page wraps to it. */
	#innerWidth = 80;
	#unwatch: (() => void) | undefined;
	#reloadTimer: NodeJS.Timeout | undefined;
	#closed = false;

	constructor(options: OfficePanelOptions) {
		this.#options = options;
		this.#tabBar = new TabBar("", this.#tabs(), getTabBarTheme(), 0);
		this.#tabBar.showHint = false;
		this.#tabBar.onTabChange = () => {
			this.#resetCursor();
			this.#options.requestRender();
		};
		this.#input.prompt = "";
		this.#input.focused = true;
		void this.#reload();
		this.#unwatch = options.watch?.({
			change: () => this.#scheduleReload(),
			usage: booking => this.#book(booking),
		});
	}

	#close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#unwatch?.();
		this.#unwatch = undefined;
		if (this.#reloadTimer) clearTimeout(this.#reloadTimer);
		this.#reloadTimer = undefined;
		this.#options.onClose();
	}

	#scheduleReload(): void {
		if (this.#closed || this.#reloadTimer) return;
		this.#reloadTimer = setTimeout(() => {
			this.#reloadTimer = undefined;
			if (!this.#closed) void this.#reload();
		}, RELOAD_DELAY_MS);
		this.#reloadTimer.unref?.();
	}

	/** Spend is billed here: a booking is added to the totals without re-reading the company. */
	#book(booking: OfficePanelBooking): void {
		const state = this.#state;
		if (this.#closed || !state?.usage) return;
		if (state.company?.checkout && booking.checkout !== state.company.checkout) return;
		this.#state = { ...state, usage: bookUsage(state.usage, booking) };
		this.#options.requestRender();
	}

	/** Usage with "today" as of now: nobody may be working at midnight to say it started over. */
	#usage(): OfficePanelUsage | undefined {
		const usage = this.#state?.usage;
		if (!usage) return undefined;
		const rolled = rollUsageDay(usage, localDay(new Date()));
		if (rolled !== usage && this.#state) this.#state = { ...this.#state, usage: rolled };
		return rolled;
	}

	#memberSpend(name: string): { today: OfficePanelAmount; total: OfficePanelAmount } {
		return this.#usage()?.members[name] ?? { today: zero(), total: zero() };
	}

	#officeSpend(office: OfficePanelOffice): { today: OfficePanelAmount; total: OfficePanelAmount } {
		let today = zero();
		let total = zero();
		for (const member of office.members) {
			const used = this.#memberSpend(member.id);
			today = plus(today, used.today);
			total = plus(total, used.total);
		}
		return { today, total };
	}

	#activity(number: number): OfficePanelActivity | undefined {
		return this.#state?.activity?.find(candidate => candidate.office === number);
	}

	#runRows(runs: OfficePanelRun[], withMember: boolean, limit = RECENT_RUNS): Row[] {
		const now = new Date();
		return runs
			.slice(-limit)
			.reverse()
			.map(run => {
				const outcome = !run.endedAt ? "running" : run.failed ? "did not finish" : "report";
				const subject = (run.report ?? run.task).replace(/\s+/g, " ").trim();
				const who = withMember ? `${run.member}: ` : "";
				return {
					label: `${who}${subject}`,
					value: `${outcome} · ${when(run.startedAt, now)}`,
					// A finished run opens its report; a running one has none yet.
					act: run.endedAt ? () => this.#openReport(run) : undefined,
				};
			});
	}

	/** Push the report page for `run` and load its text. */
	#openReport(run: OfficePanelRun): void {
		const page: Extract<Page, { kind: "report" }> = {
			kind: "report",
			runId: run.id,
			title: run.report ?? run.task.replace(/\s+/g, " ").trim(),
		};
		this.#push(page);
		const load = this.#options.loadReport;
		if (!load) {
			page.error = "This host cannot read reports.";
			return;
		}
		void load(run.id).then(
			text => {
				if (text === undefined) page.error = "No report is kept for this run.";
				else page.text = text;
				this.#options.requestRender();
			},
			(error: unknown) => {
				page.error = error instanceof Error ? error.message : String(error);
				this.#options.requestRender();
			},
		);
	}

	invalidate(): void {
		this.#tabBar.invalidate();
	}

	#tabs(): Tab[] {
		const offices = this.#state?.offices ?? [];
		return [
			{ id: COMPANY_TAB, label: "Company" },
			...offices.map(office => ({ id: officeTab(office.number), label: `Office ${office.number}` })),
			{ id: REPORTS_TAB, label: "Reports" },
		];
	}

	async #reload(): Promise<void> {
		try {
			this.#state = await this.#options.load();
		} catch (error) {
			this.#status = { text: error instanceof Error ? error.message : String(error), failed: true };
		}
		if (this.#closed) return;
		this.#tabBar.setTabs(this.#tabs());
		this.#tabBar.invalidate();
		this.#options.requestRender();
	}

	/** Run a command, show its first line, and re-read the company. `then` runs after a success. */
	#run(args: string[], then?: () => void): void {
		if (this.#busy) return;
		this.#busy = true;
		this.#options.requestRender();
		void (async () => {
			try {
				const result = await this.#options.run(args);
				this.#status = { text: result.text.split("\n")[0] ?? "", failed: result.failed === true };
				if (!result.failed) then?.();
			} catch (error) {
				this.#status = { text: error instanceof Error ? error.message : String(error), failed: true };
			} finally {
				this.#busy = false;
				await this.#reload();
			}
		})();
	}

	#push(page: Page): void {
		this.#pages.push(page);
		this.#input.setValue("");
		this.#resetCursor();
		this.#options.requestRender();
	}

	#pop(): void {
		this.#pages.pop();
		this.#resetCursor();
		this.#options.requestRender();
	}

	#resetCursor(): void {
		this.#cursor = 0;
		this.#scroll = 0;
	}

	#findMember(id: string): { office: OfficePanelOffice; member: OfficePanelMember } | undefined {
		for (const office of this.#state?.offices ?? []) {
			const member = office.members.find(candidate => candidate.id === id);
			if (member) return { office, member };
		}
		return undefined;
	}

	#companyRows(state: OfficePanelState): Row[] {
		const scale = this.#options.scales.find(candidate => candidate.id === state.scale);
		const rows: Row[] = [
			{
				label: "Virtual Office",
				value: state.enabled ? "on" : "off",
				act: () => this.#run([state.enabled ? "off" : "on"]),
			},
			{
				label: "Company size",
				value: scale ? `${scale.id} · ${scale.offices} office${scale.offices === 1 ? "" : "s"}` : state.scale,
				act: () =>
					this.#push({
						kind: "pick",
						title: "Company size",
						choices: this.#options.scales.map(candidate => ({
							label: `${candidate.id} · ${candidate.offices} office${candidate.offices === 1 ? "" : "s"}`,
							value: candidate.id,
						})),
						onPick: value => this.#run(["scale", value], () => this.#pop()),
					}),
			},
			{ label: "Project", value: state.company?.checkout ?? `none — ${state.reason ?? "no repository"}` },
			{ label: "Offices", heading: true },
		];
		for (const office of state.offices) {
			const leader = office.members.find(member => member.role === "leader");
			const activity = this.#activity(office.number);
			const phase =
				activity && activity.phase !== "idle" ? `${PHASE_LABELS[activity.phase] ?? activity.phase} · ` : "";
			rows.push({
				label: `Office ${office.number}`,
				value: `${phase}${office.members.length} members · leader ${leader?.id ?? "none"}`,
				act: () => this.#tabBar.selectTab(officeTab(office.number)),
			});
		}
		const reports = (state.runs ?? []).filter(run => run.endedAt);
		if (reports.length > 0) {
			rows.push({ label: "Latest reports", heading: true }, ...this.#runRows(reports, true, 3));
		}
		const usage = this.#usage();
		if (usage) {
			rows.push({ label: "Spend (estimated at catalog prices)", heading: true });
			rows.push({ label: "Today", value: `${spend(usage.today)} · ${usage.today.requests} requests` });
			rows.push({ label: "In total", value: `${spend(usage.total)} · ${usage.total.requests} requests` });
			const manager = this.#memberSpend(MANAGER);
			rows.push({
				label: "General manager",
				value: `${usd(manager.today.cost)} today · ${usd(manager.total.cost)} total`,
			});
			for (const office of state.offices) {
				const used = this.#officeSpend(office);
				rows.push({
					label: `Office ${office.number}`,
					value: `${usd(used.today.cost)} today · ${usd(used.total.cost)} total`,
				});
			}
		}
		return rows;
	}

	#officeRows(state: OfficePanelState, office: OfficePanelOffice): Row[] {
		const { minMembers, maxMembers } = this.#options;
		const rows: Row[] = [{ label: "Members", heading: true }];
		for (const member of office.members) {
			rows.push({
				label: `${member.id}  ${member.role.padEnd(6)}  ${member.capability}`,
				value: `${member.model || "default model"}${member.thinking ? ` · ${member.thinking}` : ""}`,
				act: () => this.#push({ kind: "member", id: member.id }),
			});
		}
		rows.push({
			label: "Member count",
			value: String(office.members.length),
			act: () => {
				const choices = [];
				for (let size = minMembers; size <= maxMembers; size++)
					choices.push({ label: `${size} members`, value: String(size) });
				this.#push({
					kind: "pick",
					title: `Office ${office.number} member count`,
					choices,
					onPick: value => this.#run(["size", String(office.number), value], () => this.#pop()),
				});
			},
		});
		if (office.members.length < maxMembers) {
			rows.push({ label: "Add a worker", act: () => this.#run(["add", String(office.number)]) });
		}
		const activity = this.#activity(office.number);
		if (activity) {
			rows.push({ label: "Now", heading: true });
			rows.push({ label: "Doing", value: PHASE_LABELS[activity.phase] ?? activity.phase });
			if (activity.working.length > 0) rows.push({ label: "Working", value: activity.working.join(", ") });
			if (activity.task) rows.push({ label: `Task: ${activity.task.replace(/\s+/g, " ").trim()}` });
		}
		if (state.usage) {
			const used = this.#officeSpend(office);
			rows.push({ label: "Spend", heading: true });
			rows.push({ label: "Today", value: spend(used.today) });
			rows.push({ label: "In total", value: spend(used.total) });
			for (const member of office.members) {
				const mine = this.#memberSpend(member.id);
				rows.push({ label: member.id, value: `${usd(mine.today.cost)} today · ${usd(mine.total.cost)} total` });
			}
		}
		const runs = (state.runs ?? []).filter(run => run.office === office.number);
		if (runs.length > 0) rows.push({ label: "Recent assignments", heading: true }, ...this.#runRows(runs, true));
		const memory = state.memory.find(candidate => candidate.office === office.number);
		rows.push({ label: "Memory of this project", heading: true });
		for (const note of memory?.notes ?? []) rows.push({ label: `Lesson: ${note.text}`, value: note.by });
		if (state.company) {
			rows.push({
				label: "Add a lesson",
				act: () =>
					this.#push({
						kind: "input",
						title: `A lesson for office ${office.number}`,
						onSubmit: value => this.#run(["remember", String(office.number), value], () => this.#pop()),
					}),
			});
			if ((memory?.notes.length ?? 0) > 0) {
				rows.push({
					label: "Forget everything",
					act: () =>
						this.#push({
							kind: "confirm",
							title: `Clear what office ${office.number} remembers about this project?`,
							yes: "Forget everything",
							onYes: () => this.#run(["forget", String(office.number)], () => this.#pop()),
						}),
				});
			}
		}
		return rows;
	}

	#reportsRows(state: OfficePanelState): Row[] {
		const runs = state.runs ?? [];
		if (runs.length === 0)
			return [{ label: "No reports yet. The general manager assigns questions with the `office` tool." }];
		const rows: Row[] = [];
		for (const office of state.offices) {
			const theirs = runs.filter(run => run.office === office.number);
			if (theirs.length === 0) continue;
			rows.push({ label: `Office ${office.number}`, heading: true }, ...this.#runRows(theirs, true, LISTED_REPORTS));
		}
		return rows;
	}

	#memberRows(id: string): Row[] {
		const found = this.#findMember(id);
		if (!found) return [{ label: `${id} is no longer in the company.` }];
		const { office, member } = found;
		const rows: Row[] = [
			{
				label: "Model",
				value: member.model || "default model",
				act: () =>
					this.#push({
						kind: "pick",
						title: `Model for ${member.id}`,
						choices: [
							{ label: "default model", value: "default" },
							...this.#options.models.map(model => ({ label: model, value: model })),
						],
						onPick: value => this.#run(["set", member.id, "model", value], () => this.#pop()),
					}),
			},
			{
				label: "Capability",
				value: member.capability,
				act: () =>
					this.#push({
						kind: "pick",
						title: `Capability of ${member.id}`,
						choices: this.#options.capabilities.map(value => ({ label: value, value })),
						onPick: value => this.#run(["set", member.id, "capability", value], () => this.#pop()),
					}),
			},
			{
				label: "Thinking effort",
				value: member.thinking || "default",
				act: () =>
					this.#push({
						kind: "pick",
						title: `Thinking effort of ${member.id}`,
						choices: [
							{ label: "default", value: "default" },
							...(this.#options.thinkingLevels?.(member.model) ?? []).map(value => ({ label: value, value })),
						],
						onPick: value => this.#run(["set", member.id, "thinking", value], () => this.#pop()),
					}),
			},
			{ label: "Role", value: `${member.role} · office ${office.number}` },
		];
		if (member.role !== "leader") {
			rows.push({
				label: "Make leader",
				act: () => this.#run(["set", member.id, "role", "leader"]),
			});
			rows.push({
				label: "Remove from the company",
				act: () =>
					this.#push({
						kind: "confirm",
						title: `Remove ${member.id}? The name is not reused.`,
						yes: "Remove",
						// Pop the confirmation and the member page: the member is gone.
						onYes: () =>
							this.#run(["remove", member.id], () => {
								this.#pages.length = 0;
								this.#resetCursor();
							}),
					}),
			});
		}
		if (this.#state?.usage) {
			const used = this.#memberSpend(member.id);
			rows.push({ label: "Spend", heading: true });
			rows.push({ label: "Today", value: `${spend(used.today)} · ${used.today.requests} requests` });
			rows.push({ label: "In total", value: `${spend(used.total)} · ${used.total.requests} requests` });
		}
		const runs = (this.#state?.runs ?? []).filter(run => run.member === member.id);
		if (runs.length > 0) rows.push({ label: "Recent assignments", heading: true }, ...this.#runRows(runs, false));
		return rows;
	}

	/** The report on its own page, wrapped to the panel; ↑/↓ scroll it. */
	#reportPageRows(page: Extract<Page, { kind: "report" }>): Row[] {
		if (page.error) return [{ label: page.error }];
		if (page.text === undefined) return [{ label: "Loading report…" }];
		const width = Math.max(10, this.#innerWidth - 2);
		const rows: Row[] = [];
		for (const line of replaceTabs(page.text.trimEnd()).split("\n")) {
			if (!line.trim()) {
				rows.push({ label: "" });
				continue;
			}
			for (const piece of wrapTextWithAnsi(line, width)) rows.push({ label: piece });
		}
		return rows;
	}

	/** Model choices narrowed by what was typed into a picker. */
	#pickChoices(page: Extract<Page, { kind: "pick" }>): { label: string; value: string }[] {
		const filter = this.#input.getValue().trim().toLowerCase();
		return filter ? page.choices.filter(choice => choice.label.toLowerCase().includes(filter)) : page.choices;
	}

	/** Pickers long enough to need it get a type-to-filter field. */
	#filters(page: Page | undefined): boolean {
		return page?.kind === "pick" && page.choices.length > 8;
	}

	#buildRows(): Row[] {
		const state = this.#state;
		if (!state) return [{ label: "Loading…" }];
		const page = this.#pages.at(-1);
		if (page?.kind === "member") return this.#memberRows(page.id);
		if (page?.kind === "report") return this.#reportPageRows(page);
		if (page?.kind === "pick") {
			const choices = this.#filters(page) ? this.#pickChoices(page) : page.choices;
			if (choices.length === 0) return [{ label: "Nothing matches." }];
			return choices.map(choice => ({ label: choice.label, act: () => page.onPick(choice.value) }));
		}
		if (page?.kind === "confirm") {
			return [
				{ label: "Cancel", act: () => this.#pop() },
				{ label: page.yes, act: page.onYes },
			];
		}
		if (page?.kind === "input") return [];
		const tab = this.#tabBar.getActiveTab().id;
		if (tab === REPORTS_TAB) return this.#reportsRows(state);
		const office = state.offices.find(candidate => officeTab(candidate.number) === tab);
		return office ? this.#officeRows(state, office) : this.#companyRows(state);
	}

	#title(): string {
		const page = this.#pages.at(-1);
		if (!page) return "Virtual Office";
		if (page.kind === "member") return `Virtual Office · ${page.id}`;
		return `Virtual Office · ${page.title}`;
	}

	#renderRow(item: Row, selected: boolean, innerWidth: number): string {
		if (item.heading) return theme.fg("accent", theme.bold(item.label));
		const marker = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
		const value = item.value ?? "";
		const valueWidth = Math.min(visibleWidth(value), Math.max(0, Math.floor(innerWidth / 2)));
		const labelWidth = Math.max(4, innerWidth - 2 - (valueWidth > 0 ? valueWidth + 2 : 0));
		const label = padToWidth(truncateToWidth(item.label, labelWidth), labelWidth);
		const shown =
			valueWidth > 0 ? `  ${theme.fg(item.act ? "accent" : "muted", truncateToWidth(value, valueWidth))}` : "";
		const text = item.act ? label : theme.fg("muted", label);
		return `${marker}${selected ? theme.bold(text) : text}${shown}`;
	}

	render(width: number): readonly string[] {
		const height = Math.max(14, process.stdout.rows || 40);
		const innerWidth = Math.max(20, width - 4);
		this.#innerWidth = innerWidth;
		const page = this.#pages.at(-1);
		const tabLines = page ? [] : this.#tabBar.render(innerWidth);
		const field = page?.kind === "input" || this.#filters(page);
		const rows = this.#buildRows();
		this.#rows = rows;
		this.#clampCursor();

		// Fixed chrome: title, tabs or field, divider, rows…, status, divider, hint, bottom border.
		const headRows = page ? (field ? 1 : 0) : tabLines.length;
		const contentRows = Math.max(4, height - headRows - (headRows > 0 ? 1 : 0) - 5);
		this.#lastViewportRows = contentRows;
		if (this.#cursor < this.#scroll) this.#scroll = this.#cursor;
		if (this.#cursor >= this.#scroll + contentRows) this.#scroll = this.#cursor - contentRows + 1;
		// Keep a section title in view above the first row it heads.
		if (this.#scroll > 0 && rows[this.#scroll - 1]?.heading && this.#cursor < this.#scroll + contentRows - 1)
			this.#scroll--;
		this.#scroll = Math.max(0, Math.min(this.#scroll, Math.max(0, rows.length - contentRows)));

		const frame = new ListDialogFrame(width, this.#title());
		const out = frame.lines;
		this.#tabRowStart = out.length;
		this.#tabRowCount = tabLines.length;
		for (const line of tabLines) out.push(row(line, width));
		if (field) {
			const prefix = theme.fg("dim", page?.kind === "input" ? "› " : "filter › ");
			out.push(
				row(`${prefix}${this.#input.render(Math.max(4, innerWidth - visibleWidth(prefix)))[0] ?? ""}`, width),
			);
		}
		if (headRows > 0) out.push(divider(width));
		this.#bodyRowStart = out.length;
		for (let i = 0; i < contentRows; i++) {
			const index = this.#scroll + i;
			const item = rows[index];
			out.push(row(item ? this.#renderRow(item, index === this.#cursor, innerWidth) : "", width));
		}
		const status = this.#busy
			? theme.fg("dim", "Working…")
			: this.#status
				? theme.fg(this.#status.failed ? "error" : "success", truncateToWidth(this.#status.text, innerWidth))
				: "";
		out.push(row(status, width));

		const cancel = editorKey("tui.select.cancel");
		const move = `${editorKeys("tui.select.up", "tui.select.down")} move`;
		let hint: string;
		if (page?.kind === "input") hint = `${formatKeyHint("enter")} save · ${cancel} back`;
		else if (page) hint = `${move} · ${formatKeyHint("enter")} select · ${cancel} back`;
		else hint = `←/→ tab · ${move} · ${formatKeyHint("enter")} open or change · ${cancel} close`;
		return frame.finish(hint);
	}

	#selectable(index: number): boolean {
		const item = this.#rows[index];
		return item !== undefined && !item.heading;
	}

	#clampCursor(): void {
		const last = this.#rows.length - 1;
		this.#cursor = Math.max(0, Math.min(this.#cursor, last));
		if (this.#selectable(this.#cursor)) return;
		for (let i = this.#cursor + 1; i <= last; i++) {
			if (this.#selectable(i)) {
				this.#cursor = i;
				return;
			}
		}
		for (let i = this.#cursor - 1; i >= 0; i--) {
			if (this.#selectable(i)) {
				this.#cursor = i;
				return;
			}
		}
	}

	#move(delta: number): void {
		const step = delta < 0 ? -1 : 1;
		let index = this.#cursor;
		for (let left = Math.abs(delta); left > 0; left--) {
			let next = index + step;
			while (next >= 0 && next < this.#rows.length && !this.#selectable(next)) next += step;
			if (next < 0 || next >= this.#rows.length) break;
			index = next;
		}
		this.#cursor = index;
		this.#options.requestRender();
	}

	#back(): void {
		if (this.#pages.length > 0) this.#pop();
		else this.#close();
	}

	handleInput(data: string): void {
		const page = this.#pages.at(-1);
		if (
			routeSgrMouseInput(data, event => {
				if (event.wheel !== null) {
					this.#move(event.wheel * 2);
					return true;
				}
				const tabLine = event.row - this.#tabRowStart;
				if (!page && tabLine >= 0 && tabLine < this.#tabRowCount) {
					const tab = this.#tabBar.tabAt(tabLine, event.col - 2);
					if (event.motion) {
						this.#tabBar.setHoverTab(tab?.id ?? null);
						this.#options.requestRender();
					} else if (event.leftClick && tab) {
						this.#tabBar.selectTab(tab.id);
					}
					return true;
				}
				const index = this.#scroll + event.row - this.#bodyRowStart;
				if (event.leftClick && !this.#busy && index >= this.#scroll && this.#selectable(index)) {
					this.#cursor = index;
					this.#options.requestRender();
					this.#rows[index]?.act?.();
				}
				return true;
			})
		) {
			return;
		}
		if (matchesSelectCancel(data)) {
			this.#back();
			return;
		}
		if (this.#busy) return;
		if (page?.kind === "input") {
			if (matchesKey(data, "return")) {
				const value = this.#input.getValue().trim();
				if (value) page.onSubmit(value);
				return;
			}
			this.#input.handleInput(data);
			this.#options.requestRender();
			return;
		}
		if (matchesKey(data, "return")) {
			this.#rows[this.#cursor]?.act?.();
			return;
		}
		if (matchesSelectUp(data)) return this.#move(-1);
		if (matchesSelectDown(data)) return this.#move(1);
		if (matchesSelectPageUp(data)) return this.#move(-this.#lastViewportRows);
		if (matchesSelectPageDown(data)) return this.#move(this.#lastViewportRows);
		if (this.#filters(page)) {
			this.#input.handleInput(data);
			this.#resetCursor();
			this.#options.requestRender();
			return;
		}
		if (matchesKey(data, "home")) return this.#move(-Number.MAX_SAFE_INTEGER);
		if (matchesKey(data, "end")) return this.#move(Number.MAX_SAFE_INTEGER);
		if (page) return;
		if (matchesKey(data, "q")) {
			this.#close();
			return;
		}
		if (
			matchesKey(data, "left") ||
			matchesKey(data, "right") ||
			matchesKey(data, "tab") ||
			matchesKey(data, "shift+tab")
		) {
			this.#tabBar.handleInput(data);
		}
	}
}
