/**
 * Fullscreen `/office` panel (the /settings idiom): a tab for the company, one per office and one
 * for pull requests. ↑/↓ move, Enter opens or changes the selected row, Esc goes back.
 *
 * The panel owns no rules. Every change is an `/office …` command handed to `run`, and the state
 * is re-read afterwards, so it can never disagree with the command line.
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
import { truncateToWidth, visibleWidth } from "../utils";

export interface OfficePanelMember {
	id: string;
	role: string;
	capability: string;
	/** Empty for the default model. */
	model: string;
}

export interface OfficePanelOffice {
	number: number;
	members: OfficePanelMember[];
}

export interface OfficePanelPull {
	number: number;
	kind: "worker" | "office";
	office: number;
	author: string;
	title: string;
	body: string;
	target: string;
	status: string;
	reviews: { by: string; verdict: string; comment: string }[];
}

export interface OfficePanelMemory {
	office: number;
	notes: { by: string; text: string }[];
	log: { pr: number; title: string; author: string; target: string }[];
}

export interface OfficePanelState {
	enabled: boolean;
	scale: string;
	offices: OfficePanelOffice[];
	company: { baseBranch: string } | null;
	/** Why there is no company here. */
	reason?: string;
	pulls: OfficePanelPull[];
	memory: OfficePanelMemory[];
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
	minMembers: number;
	maxMembers: number;
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
	| { kind: "pull"; number: number }
	| { kind: "pick"; title: string; choices: { label: string; value: string }[]; onPick: (value: string) => void }
	| { kind: "confirm"; title: string; yes: string; onYes: () => void }
	| { kind: "input"; title: string; onSubmit: (value: string) => void };

const COMPANY_TAB = "company";
const PULLS_TAB = "pulls";
const officeTab = (number: number): string => `office:${number}`;

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
	}

	invalidate(): void {
		this.#tabBar.invalidate();
	}

	#tabs(): Tab[] {
		const offices = this.#state?.offices ?? [];
		const waiting = this.#waiting().length;
		return [
			{ id: COMPANY_TAB, label: "Company" },
			...offices.map(office => ({ id: officeTab(office.number), label: `Office ${office.number}` })),
			{ id: PULLS_TAB, label: waiting > 0 ? `Pull requests (${waiting})` : "Pull requests" },
		];
	}

	/** Office pull requests the general manager approved: the ones only the owner can settle. */
	#waiting(): OfficePanelPull[] {
		return (this.#state?.pulls ?? []).filter(pull => pull.kind === "office" && pull.status === "approved");
	}

	async #reload(): Promise<void> {
		try {
			this.#state = await this.#options.load();
		} catch (error) {
			this.#status = { text: error instanceof Error ? error.message : String(error), failed: true };
		}
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

	#pullLabel(pull: OfficePanelPull): string {
		const from = pull.kind === "office" ? `office ${pull.office}` : `${pull.author} · office ${pull.office}`;
		return `#${pull.number} ${pull.title} — ${from} → ${pull.target}`;
	}

	#pullRow(pull: OfficePanelPull): Row {
		return {
			label: this.#pullLabel(pull),
			value: pull.status.replace("_", " "),
			act: () => this.#push({ kind: "pull", number: pull.number }),
		};
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
			{ label: "Base branch", value: state.company?.baseBranch ?? `none — ${state.reason ?? "no repository"}` },
			{ label: "Offices", heading: true },
		];
		for (const office of state.offices) {
			const leader = office.members.find(member => member.role === "leader");
			rows.push({
				label: `Office ${office.number}`,
				value: `${office.members.length} members · leader ${leader?.id ?? "none"}`,
				act: () => this.#tabBar.selectTab(officeTab(office.number)),
			});
		}
		const waiting = this.#waiting();
		if (waiting.length > 0) {
			rows.push({ label: "Waiting for you", heading: true });
			for (const pull of waiting) rows.push(this.#pullRow(pull));
		}
		return rows;
	}

	#officeRows(state: OfficePanelState, office: OfficePanelOffice): Row[] {
		const { minMembers, maxMembers } = this.#options;
		const rows: Row[] = [{ label: "Members", heading: true }];
		for (const member of office.members) {
			rows.push({
				label: `${member.id}  ${member.role.padEnd(6)}  ${member.capability}`,
				value: member.model || "default model",
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
		const memory = state.memory.find(candidate => candidate.office === office.number);
		rows.push({ label: "Memory of this project", heading: true });
		for (const note of memory?.notes ?? []) rows.push({ label: `Lesson: ${note.text}`, value: note.by });
		for (const entry of memory?.log ?? []) {
			rows.push({ label: `Merged #${entry.pr} ${entry.title}`, value: `${entry.author} → ${entry.target}` });
		}
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
			if ((memory?.notes.length ?? 0) + (memory?.log.length ?? 0) > 0) {
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

	#pullsRows(state: OfficePanelState): Row[] {
		if (state.pulls.length === 0) return [{ label: "No pull requests yet." }];
		const done = (pull: OfficePanelPull) => pull.status === "merged" || pull.status === "closed";
		const rows: Row[] = [];
		const unfinished = state.pulls.filter(pull => !done(pull));
		const finished = state.pulls.filter(done).reverse();
		if (unfinished.length > 0)
			rows.push({ label: "In progress", heading: true }, ...unfinished.map(p => this.#pullRow(p)));
		if (finished.length > 0) rows.push({ label: "Finished", heading: true }, ...finished.map(p => this.#pullRow(p)));
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
		return rows;
	}

	#pullPageRows(number: number): Row[] {
		const pull = this.#state?.pulls.find(candidate => candidate.number === number);
		if (!pull) return [{ label: `Pull request #${number} is gone.` }];
		const rows: Row[] = [
			{ label: "Status", value: pull.status.replace("_", " ") },
			{
				label: "From",
				value: pull.kind === "office" ? `office ${pull.office}` : `${pull.author} · office ${pull.office}`,
			},
			{ label: "Into", value: pull.target },
		];
		if (pull.kind === "office" && pull.status === "approved") {
			rows.push(
				{
					label: `Merge into ${pull.target}`,
					act: () =>
						this.#push({
							kind: "confirm",
							title: `Merge #${pull.number} "${pull.title}" into ${pull.target}?`,
							yes: "Merge",
							onYes: () => this.#run(["merge", String(pull.number)], () => this.#pop()),
						}),
				},
				{
					label: "Send back with a reason",
					act: () =>
						this.#push({
							kind: "input",
							title: `Why does #${pull.number} go back?`,
							onSubmit: value => this.#run(["reject", String(pull.number), value], () => this.#pop()),
						}),
				},
			);
		}
		const body = pull.body.trim();
		if (body) {
			rows.push({ label: "Description", heading: true });
			for (const line of body.split("\n")) rows.push({ label: line });
		}
		if (pull.reviews.length > 0) {
			rows.push({ label: "Reviews", heading: true });
			for (const review of pull.reviews) {
				const verdict = review.verdict === "approve" ? "approved" : "requested changes";
				rows.push({ label: `${review.by} ${verdict}${review.comment ? `: ${review.comment}` : ""}` });
			}
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
		if (page?.kind === "pull") return this.#pullPageRows(page.number);
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
		if (tab === PULLS_TAB) return this.#pullsRows(state);
		const office = state.offices.find(candidate => officeTab(candidate.number) === tab);
		return office ? this.#officeRows(state, office) : this.#companyRows(state);
	}

	#title(): string {
		const page = this.#pages.at(-1);
		if (!page) return "Virtual Office";
		if (page.kind === "member") return `Virtual Office · ${page.id}`;
		if (page.kind === "pull") {
			const pull = this.#state?.pulls.find(candidate => candidate.number === page.number);
			return `Virtual Office · #${page.number}${pull ? ` ${pull.title}` : ""}`;
		}
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
		else this.#options.onClose();
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
			this.#options.onClose();
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
