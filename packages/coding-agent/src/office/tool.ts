/**
 * The `office` tool: how each seat in a Virtual Office acts on the company.
 *
 * One tool, three seats. The general manager assigns to offices and reviews their pull requests;
 * a leader assigns to workers, reviews and merges theirs, and submits the office's own; a worker
 * submits. What a seat may do is checked here and again in `pulls.ts`, never left to the prompt.
 */
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import leaderRole from "../prompts/office/leader.md" with { type: "text" };
import workerRole from "../prompts/office/worker.md" with { type: "text" };
import officeDescription from "../prompts/tools/office.md" with { type: "text" };
import { getBundledAgent } from "../task/agents";
import { cfgTaskEnableLsp, cfgTaskMaxRuntimeMs } from "../task/settings";
import { runStructuredSubagent, StructuredSubagentError } from "../task/structured-subagent";
import type { AgentDefinition } from "../task/types";
import type { ToolSession } from "../tools";
import { toolResult } from "../tools/tool-result";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import {
	actorOf,
	type Desk,
	deskOf,
	deskOfOffice,
	deskOfWorker,
	mergeApprovedPull,
	resolveSeat,
	type Seat,
	staffedOffices,
} from "./company";
import { leaderOf, type Office, type OfficeMember, workersOf } from "./model";
import { type OfficeMemory, OfficeMemoryError, readOfficeMemories, readOfficeMemory, rememberNote } from "./memory";
import { getPull, listPulls, type Pull, PullError, reviewPull, submitPull } from "./pulls";
import { cfgOfficeEnabled } from "./settings";
import { type Company, commitDesk, describeChange, OfficeWorkspaceError, openCompany, prepareDesk } from "./workspace";

const officeSchema = type({
	action: type('"status" | "assign" | "submit" | "diff" | "review" | "merge" | "remember"').describe("what to do"),
	"assignments?": type({
		to: type("string").describe("office number (general manager) or worker name (leader)"),
		task: type("string").describe("self-contained task for the assignee"),
	})
		.array()
		.describe("assign: who does what"),
	"pr?": type("number").describe("diff, review, merge: pull request number"),
	"title?": type("string").describe("submit: pull request title"),
	"body?": type("string").describe("submit: what changed and how it was checked"),
	"verdict?": type('"approve" | "request_changes"').describe("review: the decision"),
	"comment?": type("string").describe("review: feedback; required when requesting changes"),
	"note?": type("string").describe("remember: one lesson about this project for your office"),
});

type OfficeParams = typeof officeSchema.infer;

export interface OfficeToolDetails {
	action: OfficeParams["action"];
	seat: Seat["kind"];
	/** Pull requests the call opened, changed or listed. */
	pulls?: Pull[];
	meta?: OutputMeta;
}

/** Largest patch `diff` returns; a reviewer reads the rest at the desk. */
const DIFF_MAX_BYTES = 60_000;

// One assignment per desk at a time, across every seat in this process: two sessions at the
// same worktree would overwrite each other.
const busyDesks = new Set<string>();

interface Assignment {
	label: string;
	member: OfficeMember;
	office: Office;
	desk: Desk;
	agent: AgentDefinition;
	task: string;
}

function describePull(pull: Pull): string {
	const last = pull.reviews.at(-1);
	const review = last
		? ` — ${last.by}: ${last.verdict.replace("_", " ")}${last.comment ? ` (${last.comment})` : ""}`
		: "";
	const who = pull.kind === "office" ? `office ${pull.office}` : `${pull.author}, office ${pull.office}`;
	return `#${pull.number} [${pull.status.replace("_", " ")}] ${pull.title} — ${who}, ${pull.source} → ${pull.target}${review}`;
}

/** Template input for an office's memory block in the role briefs. */
async function memoryContext(company: Company, office: number): Promise<{ memory: OfficeMemory; remembers: boolean }> {
	const memory = await readOfficeMemory(company, office);
	return { memory, remembers: memory.notes.length + memory.log.length > 0 };
}

function memberAgent(member: OfficeMember, office: Office, rolePrompt: string): AgentDefinition {
	const base = getBundledAgent("task");
	if (!base) throw new Error("Bundled task agent is unavailable");
	return {
		...base,
		name: member.id,
		description: `${member.role === "leader" ? "Leader" : "Worker"} of office ${office.number} (${member.capability})`,
		systemPrompt: `${base.systemPrompt}\n\n${rolePrompt}`,
		filePath: undefined,
	};
}

export class OfficeTool implements AgentTool<typeof officeSchema, OfficeToolDetails> {
	readonly name = "office";
	readonly approval = "exec" as const;
	readonly label = "Office";
	readonly summary = "Assign work to the Virtual Office and move it up through pull requests";
	readonly description: string;
	readonly parameters = officeSchema;
	readonly strict = true;
	readonly loadMode = "essential";
	readonly intent = (args: Partial<OfficeParams>) =>
		args.action === "assign"
			? "assigning work"
			: args.pr
				? `${args.action} PR #${args.pr}`
				: `office ${args.action ?? ""}`;

	constructor(
		private readonly session: ToolSession,
		private seat: Seat,
	) {
		this.description = prompt.render(officeDescription, { seat: seat.kind });
	}

	/** The tool for this session's seat; `null` when Virtual Office is off or the session has no seat. */
	static async createIf(session: ToolSession): Promise<OfficeTool | null> {
		if (!cfgOfficeEnabled.get(session.settings)) return null;
		try {
			const seat = await resolveSeat(session.settings, session.cwd, session.taskDepth ?? 0);
			return seat ? new OfficeTool(session, seat) : null;
		} catch (error) {
			// Not a git repository, or a detached HEAD: there is no company to run here.
			if (error instanceof OfficeWorkspaceError) return null;
			throw error;
		}
	}

	async execute(
		toolCallId: string,
		params: OfficeParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<OfficeToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<OfficeToolDetails>> {
		try {
			// The owner may have switched branches or edited the roster since the last call.
			if (this.seat.kind === "manager") {
				this.seat = {
					kind: "manager",
					company: await openCompany(this.session.cwd),
					offices: staffedOffices(this.session.settings),
				};
			}
			switch (params.action) {
				case "status":
					return await this.#status();
				case "assign":
					return await this.#assign(toolCallId, params, signal, onUpdate);
				case "submit":
					return await this.#submit(params);
				case "diff":
					return await this.#diff(params);
				case "review":
					return await this.#review(params);
				case "merge":
					return await this.#merge(params);
				case "remember":
					return await this.#remember(params);
			}
		} catch (error) {
			if (
				error instanceof PullError ||
				error instanceof OfficeWorkspaceError ||
				error instanceof OfficeMemoryError
			) {
				throw new ToolError(error.message);
			}
			throw error;
		}
	}

	#result(action: OfficeParams["action"], text: string, pulls?: Pull[]): AgentToolResult<OfficeToolDetails> {
		return toolResult<OfficeToolDetails>({ action, seat: this.seat.kind, pulls }).text(text).done();
	}

	#pr(params: OfficeParams): number {
		if (params.pr === undefined) throw new ToolError(`\`${params.action}\` needs \`pr\`, the pull request number.`);
		return params.pr;
	}

	/** Pull requests this seat has a part in: all of them for the manager, the office's otherwise. */
	async #visiblePulls(): Promise<Pull[]> {
		const seat = this.seat;
		const pulls = await listPulls(seat.company);
		if (seat.kind === "manager") return pulls;
		const inOffice = pulls.filter(pull => pull.office === seat.office.number);
		return seat.kind === "leader" ? inOffice : inOffice.filter(pull => pull.author === seat.member.id);
	}

	async #status(): Promise<AgentToolResult<OfficeToolDetails>> {
		const seat = this.seat;
		const offices = seat.kind === "manager" ? seat.offices : [seat.office];
		const lines = [`Base branch: ${seat.company.baseBranch}`];
		const memories = await readOfficeMemories(
			seat.company,
			offices.map(office => office.number),
		);
		for (const [index, office] of offices.entries()) {
			const memory = memories[index];
			lines.push(
				`Office ${office.number} — remembers ${memory.notes.length} lesson(s), ${memory.log.length} merged pull request(s)`,
			);
			for (const member of office.members) {
				lines.push(
					`  ${member.id} — ${member.role}, ${member.capability}${member.model ? `, ${member.model}` : ""}`,
				);
			}
		}
		const pulls = await this.#visiblePulls();
		const unfinished = pulls.filter(pull => pull.status !== "merged" && pull.status !== "closed");
		lines.push(unfinished.length > 0 ? "Pull requests:" : "No pull requests are waiting.");
		for (const pull of unfinished) lines.push(`  ${describePull(pull)}`);
		lines.push(`Merged so far: ${pulls.filter(pull => pull.status === "merged").length}`);
		return this.#result("status", lines.join("\n"), pulls);
	}

	/** Resolve one `assignments[]` entry to the member, desk and role brief it names. */
	async #resolveAssignment(to: string, task: string): Promise<Assignment> {
		const seat = this.seat;
		if (seat.kind === "worker") throw new ToolError("Workers do not assign work. Do the task, then `submit`.");
		const { company } = seat;
		if (seat.kind === "manager") {
			const number = Number(/\d+/.exec(to)?.[0]);
			const office = seat.offices.find(candidate => candidate.number === number);
			if (!office) {
				throw new ToolError(
					`No office "${to}". Offices: ${seat.offices.map(candidate => candidate.number).join(", ")}.`,
				);
			}
			const member = leaderOf(office);
			const desk = deskOfOffice(company, office.number);
			const role = prompt.render(leaderRole, {
				member,
				office: office.number,
				...(await memoryContext(company, office.number)),
				baseBranch: company.baseBranch,
				deskDir: desk.dir,
				deskBranch: desk.branch,
				workers: workersOf(office),
			});
			return {
				label: `Office ${office.number}`,
				member,
				office,
				desk,
				agent: memberAgent(member, office, role),
				task,
			};
		}
		const office = seat.office;
		const member = workersOf(office).find(candidate => candidate.id === to.trim());
		if (!member) {
			throw new ToolError(
				`No worker "${to}" in your office. Workers: ${workersOf(office)
					.map(candidate => candidate.id)
					.join(", ")}.`,
			);
		}
		const desk = deskOfWorker(company, office.number, member.id);
		const role = prompt.render(workerRole, {
			member,
			office: office.number,
			...(await memoryContext(company, office.number)),
			leader: seat.member,
			deskDir: desk.dir,
			deskBranch: desk.branch,
			upstreamBranch: desk.upstream,
		});
		return { label: member.id, member, office, desk, agent: memberAgent(member, office, role), task };
	}

	async #assign(
		toolCallId: string,
		params: OfficeParams,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<OfficeToolDetails> | undefined,
	): Promise<AgentToolResult<OfficeToolDetails>> {
		const requested = params.assignments ?? [];
		if (requested.length === 0) throw new ToolError("`assign` needs `assignments`: [{ to, task }].");
		const assignments = await Promise.all(requested.map(entry => this.#resolveAssignment(entry.to, entry.task)));
		const desks = new Set(assignments.map(assignment => assignment.desk.dir));
		if (desks.size !== assignments.length) {
			throw new ToolError("Each assignee takes one task per call. Combine the tasks, or assign them in turn.");
		}
		const busy = assignments.find(assignment => busyDesks.has(assignment.desk.dir));
		if (busy) throw new ToolError(`${busy.label} is still working on an earlier assignment.`);

		const { company } = this.seat;
		for (const assignment of assignments) busyDesks.add(assignment.desk.dir);
		try {
			for (const assignment of assignments) await prepareDesk(company, assignment.desk, this.session.settings);
			const running = new Set(assignments.map(assignment => assignment.label));
			const report = () =>
				onUpdate?.({
					content: [{ type: "text", text: `Working: ${[...running].join(", ") || "wrapping up"}` }],
					details: { action: "assign", seat: this.seat.kind },
				});
			report();
			const outcomes = await Promise.all(
				assignments.map(async (assignment, index) => {
					try {
						const execution = await runStructuredSubagent({
							session: this.session,
							invocationKind: "task",
							assignment: assignment.task,
							agentDefinition: assignment.agent,
							model: assignment.member.model || undefined,
							cwd: assignment.desk.dir,
							structured: false,
							identity: { label: assignment.member.id },
							index,
							parentToolCallId: toolCallId,
							detached: false,
							enableLsp: (this.session.enableLsp ?? true) && cfgTaskEnableLsp.get(this.session.settings),
							enableIrc: false,
							maxRuntimeMs: cfgTaskMaxRuntimeMs.get(this.session.settings),
							signal,
						});
						const { result } = execution;
						const failed = result.exitCode !== 0 || result.error !== undefined || result.aborted === true;
						return { assignment, failed, text: result.output.trim() || result.error || result.stderr.trim() };
					} catch (error) {
						if (!(error instanceof StructuredSubagentError)) throw error;
						return { assignment, failed: true, text: error.message };
					} finally {
						running.delete(assignment.label);
						report();
					}
				}),
			);
			const pulls = await this.#visiblePulls();
			const sections = outcomes.map(({ assignment, failed, text }) => {
				const theirs = pulls.filter(
					pull => pull.source === assignment.desk.branch && pull.status !== "merged" && pull.status !== "closed",
				);
				const waiting =
					theirs.length > 0 ? theirs.map(describePull).join("\n") : "No pull request is waiting from them.";
				return `## ${assignment.label === assignment.member.id ? assignment.label : `${assignment.label} (${assignment.member.id})`}${failed ? " — did not finish" : ""}\n${text || "(no report)"}\n\n${waiting}`;
			});
			return this.#result("assign", sections.join("\n\n"), pulls);
		} finally {
			for (const assignment of assignments) busyDesks.delete(assignment.desk.dir);
		}
	}

	async #submit(params: OfficeParams): Promise<AgentToolResult<OfficeToolDetails>> {
		const seat = this.seat;
		const desk = deskOf(seat);
		if (seat.kind === "manager" || !desk) {
			throw new ToolError(
				"The general manager submits nothing: offices submit to you, and the user merges what you approve.",
			);
		}
		const title = params.title?.trim();
		if (!title) throw new ToolError("`submit` needs a `title`.");
		const change = await commitDesk(seat.company, desk, title);
		if (change.files.length === 0) {
			throw new ToolError(
				`Nothing to submit: ${desk.branch} changes nothing that ${desk.upstream} does not already have.`,
			);
		}
		const pull = await submitPull(seat.company, {
			kind: seat.kind === "leader" ? "office" : "worker",
			office: seat.office.number,
			author: seat.member.id,
			title,
			body: params.body?.trim() ?? "",
			source: desk.branch,
			target: desk.upstream,
		});
		const reviewer = seat.kind === "leader" ? "the general manager" : "your leader";
		return this.#result(
			"submit",
			`Pull request #${pull.number} is up for review by ${reviewer}: ${change.commits} commit(s), ${change.files.length} file(s), ${pull.source} → ${pull.target}.`,
			[pull],
		);
	}

	async #diff(params: OfficeParams): Promise<AgentToolResult<OfficeToolDetails>> {
		const pull = await getPull(this.seat.company, this.#pr(params));
		const change = await describeChange(this.seat.company, pull.source, pull.target, DIFF_MAX_BYTES);
		const files = change.files.map(file => `  ${file.path} (+${file.added} −${file.removed})`);
		const cut =
			Buffer.byteLength(change.patch) >= DIFF_MAX_BYTES
				? `\n\n[Patch cut at ${DIFF_MAX_BYTES} bytes. Read the rest with: git diff ${pull.target}...${pull.source}]`
				: "";
		return this.#result(
			"diff",
			`${describePull(pull)}\n${pull.body ? `\n${pull.body}\n` : ""}\nFiles:\n${files.join("\n")}\n\n${change.patch}${cut}`,
			[pull],
		);
	}

	async #review(params: OfficeParams): Promise<AgentToolResult<OfficeToolDetails>> {
		if (!params.verdict) throw new ToolError('`review` needs a `verdict`: "approve" or "request_changes".');
		const pull = await reviewPull(
			this.seat.company,
			this.#pr(params),
			actorOf(this.seat),
			params.verdict,
			params.comment ?? "",
		);
		const next =
			pull.status === "changes_requested"
				? `It is back with ${pull.kind === "office" ? `office ${pull.office}` : pull.author}; assign them the fix.`
				: pull.kind === "office"
					? `It now waits for the user: tell them to run /office merge ${pull.number}.`
					: "Merge it with `merge`.";
		return this.#result("review", `${describePull(pull)}\n${next}`, [pull]);
	}

	async #remember(params: OfficeParams): Promise<AgentToolResult<OfficeToolDetails>> {
		const seat = this.seat;
		if (seat.kind === "manager") {
			throw new ToolError(
				"Offices keep their own memory. Ask the office to remember it when you assign or review its work.",
			);
		}
		await rememberNote(seat.company, seat.office.number, seat.member.id, params.note ?? "");
		const memory = await readOfficeMemory(seat.company, seat.office.number);
		return this.#result(
			"remember",
			`Office ${seat.office.number} will remember that (${memory.notes.length} lesson(s) kept for this project).`,
		);
	}

	async #merge(params: OfficeParams): Promise<AgentToolResult<OfficeToolDetails>> {
		const pull = await mergeApprovedPull(this.seat.company, this.#pr(params), actorOf(this.seat));
		return this.#result(
			"merge",
			`Merged #${pull.number} into ${pull.target} as ${pull.mergeCommit?.slice(0, 12)}. ${pull.author}'s desk restarts from there.`,
			[pull],
		);
	}
}
