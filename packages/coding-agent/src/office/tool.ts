/**
 * The `office` tool: how each seat in a Virtual Office acts on the company.
 *
 * Offices only investigate and report. The general manager hands questions to offices; a leader
 * answers small ones itself and splits large ones across its workers; every member reads the
 * owner's checkout with read-only tools and finishes with a report. Nothing here changes files,
 * branches or commits: the general manager acts on the reports itself.
 */
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt, Snowflake } from "@oh-my-pi/pi-utils";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { RosterTier } from "../config/model-roster";
import leaderRole from "../prompts/office/leader.md" with { type: "text" };
import workerRole from "../prompts/office/worker.md" with { type: "text" };
import officeDescription from "../prompts/tools/office.md" with { type: "text" };
import { AgentRegistry } from "../registry/agent-registry";
import { getBundledAgent } from "../task/agents";
import { configuredSelection } from "../task/delegation-runtime";
import { cfgTaskEnableLsp, cfgTaskMaxRuntimeMs } from "../task/settings";
import {
	reserveStructuredSubagentId,
	runStructuredSubagent,
	StructuredSubagentError,
} from "../task/structured-subagent";
import type { AgentDefinition } from "../task/types";
import type { ToolSession } from "../tools";
import { toolResult } from "../tools/tool-result";
import { claimMember } from "./claims";
import { type MemberSeat, registerMemberSeat, resolveSeat, type Seat, staffedOffices } from "./company";
import { type OfficeMemory, OfficeMemoryError, readOfficeMemories, readOfficeMemory, rememberNote } from "./memory";
import {
	leaderOf,
	MANAGER,
	OFFICE_MEMBER_TOOLS,
	type Office,
	type OfficeCapability,
	type OfficeMember,
	type OfficeRole,
	workersOf,
} from "./model";
import { readReport, saveReport } from "./reports";
import { cfgOfficeAssignmentTimeoutMs, cfgOfficeEnabled } from "./settings";
import { readRuns, recordUsage, startRun, updateRun } from "./usage";
import { type Company, OfficeWorkspaceError, openCompany } from "./workspace";

const officeSchema = type({
	action: type('"status" | "assign" | "report" | "remember"').describe("what to do"),
	"assignments?": type({
		to: type("string").describe("office number (general manager) or worker name (leader)"),
		task: type("string").describe("the question to investigate and what the report must cover"),
	})
		.array()
		.describe("assign: who investigates what"),
	"run?": type("string").describe("report: the run id of an earlier assignment"),
	"note?": type("string").describe("remember: one lesson about this project for your office"),
});

type OfficeParams = typeof officeSchema.infer;

export interface OfficeToolDetails {
	action: OfficeParams["action"];
	seat: Seat["kind"];
	meta?: OutputMeta;
}

/** The roster tier a member's capability runs on when no model is set for them (Auto hosts). */
const CAPABILITY_TIER: Record<OfficeCapability, RosterTier> = {
	expert: "flagship",
	professional: "high",
	common: "standard",
};

/** Recent runs `status` lists. */
const STATUS_RUNS = 8;

interface Assignment {
	label: string;
	member: OfficeMember;
	office: Office;
	seat: MemberSeat;
	agent: AgentDefinition;
	task: string;
}

/** Template input for an office's memory block in the role briefs. */
async function memoryContext(company: Company, office: number): Promise<{ memory: OfficeMemory; remembers: boolean }> {
	const memory = await readOfficeMemory(company, office);
	return { memory, remembers: memory.notes.length > 0 };
}

function memberAgent(member: OfficeMember, office: Office, rolePrompt: string): AgentDefinition {
	const base = getBundledAgent("task");
	if (!base) throw new Error("Bundled task agent is unavailable");
	return {
		...base,
		name: member.id,
		description: `${member.role === "leader" ? "Leader" : "Worker"} of office ${office.number} (${member.capability})`,
		systemPrompt: `${base.systemPrompt}\n\n${rolePrompt}`,
		tools: [...OFFICE_MEMBER_TOOLS],
		spawns: undefined,
		filePath: undefined,
	};
}

/** A leader's run holds its workers' runs, so it gets this many worker limits. */
const LEADER_TIMEOUT_FACTOR = 4;

/**
 * How long one assignment may run before it is stopped and reported as not finished, so one stuck
 * member cannot hold up the company: the office limit (a leader gets several), else the subagent one.
 */
function assignmentTimeout(settings: ToolSession["settings"], role: OfficeRole): number {
	const limit = cfgOfficeAssignmentTimeoutMs.get(settings);
	if (limit <= 0) return cfgTaskMaxRuntimeMs.get(settings);
	return role === "leader" ? limit * LEADER_TIMEOUT_FACTOR : limit;
}

export class OfficeTool implements AgentTool<typeof officeSchema, OfficeToolDetails> {
	readonly name = "office";
	// The owner configured the company and members only read, so assigning needs no consent prompt.
	readonly approval = "read" as const;
	readonly label = "Office";
	readonly summary = "Have the Virtual Office investigate a question and report back";
	readonly description: string;
	readonly parameters = officeSchema;
	readonly strict = true;
	readonly loadMode = "essential";
	readonly intent = (args: Partial<OfficeParams>) =>
		args.action === "assign" ? "assigning an investigation" : `office ${args.action ?? ""}`;

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
			const seat = await resolveSeat(
				session.settings,
				session.cwd,
				session.taskDepth ?? 0,
				session.getAgentId?.() ?? null,
			);
			return seat ? new OfficeTool(session, seat) : null;
		} catch (error) {
			// Not a git repository: there is no company to run here.
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
			// The owner may have edited the roster since the last call.
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
				case "report":
					return await this.#report(params);
				case "remember":
					return await this.#remember(params);
			}
		} catch (error) {
			if (error instanceof OfficeWorkspaceError || error instanceof OfficeMemoryError) {
				throw new ToolError(error.message);
			}
			throw error;
		}
	}

	#result(action: OfficeParams["action"], text: string): AgentToolResult<OfficeToolDetails> {
		return toolResult<OfficeToolDetails>({ action, seat: this.seat.kind }).text(text).done();
	}

	async #status(): Promise<AgentToolResult<OfficeToolDetails>> {
		const seat = this.seat;
		const offices = seat.kind === "manager" ? seat.offices : [seat.office];
		const lines: string[] = [];
		const memories = await readOfficeMemories(
			seat.company,
			offices.map(office => office.number),
		);
		for (const [index, office] of offices.entries()) {
			lines.push(`Office ${office.number} — remembers ${memories[index].notes.length} lesson(s)`);
			for (const member of office.members) {
				lines.push(
					`  ${member.id} — ${member.role}, ${member.capability}, ${member.model || "default model"}, ${member.thinking ? `${member.thinking} effort` : "default effort"}`,
				);
			}
		}
		const numbers = new Set(offices.map(office => office.number));
		const runs = (await readRuns(seat.company)).filter(run => numbers.has(run.office)).slice(-STATUS_RUNS);
		lines.push(runs.length > 0 ? "Recent reports (read one with `report` and its run id):" : "No reports yet.");
		for (const run of runs.reverse()) {
			const state = !run.endedAt ? "running" : run.failed ? "did not finish" : (run.report ?? "no report");
			lines.push(`  ${run.id} — office ${run.office}, ${run.member}: ${state}`);
		}
		return this.#result("status", lines.join("\n"));
	}

	/** Resolve one `assignments[]` entry to the member, seat and role brief it names. */
	async #resolveAssignment(to: string, task: string): Promise<Assignment> {
		const seat = this.seat;
		if (seat.kind === "worker") throw new ToolError("Workers do not assign work. Investigate, then report.");
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
			const role = prompt.render(leaderRole, {
				member,
				office: office.number,
				...(await memoryContext(company, office.number)),
				checkout: company.checkout,
				workers: workersOf(office),
			});
			return {
				label: `Office ${office.number}`,
				member,
				office,
				seat: { kind: "leader", company, office, member },
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
		const role = prompt.render(workerRole, {
			member,
			office: office.number,
			...(await memoryContext(company, office.number)),
			leader: seat.member,
			checkout: company.checkout,
		});
		return {
			label: member.id,
			member,
			office,
			seat: { kind: "worker", company, office, member },
			agent: memberAgent(member, office, role),
			task,
		};
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
		if (new Set(assignments.map(assignment => assignment.member.id)).size !== assignments.length) {
			throw new ToolError("Each assignee takes one question per call. Combine them, or assign them in turn.");
		}
		const { company } = this.seat;
		const by = this.seat.kind === "manager" ? MANAGER : this.seat.member.id;
		const releases: Array<() => Promise<void> | void> = [];
		try {
			for (const assignment of assignments) {
				const release = await claimMember(company, {
					office: assignment.office.number,
					member: assignment.member.id,
					role: assignment.member.role,
					task: assignment.task,
				});
				if (!release) throw new ToolError(`${assignment.label} is still working on an earlier assignment.`);
				releases.push(release);
			}
			const running = new Set(assignments.map(assignment => assignment.label));
			const progress = () =>
				onUpdate?.({
					content: [{ type: "text", text: `Investigating: ${[...running].join(", ") || "wrapping up"}` }],
					details: { action: "assign", seat: this.seat.kind },
				});
			progress();
			const outcomes = await Promise.all(
				assignments.map(async (assignment, index) => {
					const runId = Snowflake.next();
					const member = assignment.member.id;
					await startRun(company, {
						id: runId,
						office: assignment.office.number,
						member,
						by,
						task: assignment.task,
					});
					// The member's session finds its seat by the agent id it runs under.
					const agentId = await reserveStructuredSubagentId(this.session, { label: member });
					releases.push(registerMemberSeat(agentId, assignment.seat));
					// The runner reports running totals; book what each report adds, when it adds it.
					const booked = { tokens: 0, cost: 0, requests: 0 };
					let sessionFile: string | undefined;
					// The roster is the owner's confirmation: the member runs on their configured
					// model and effort, resolved without an Ask.
					const selection = configuredSelection(this.session, {
						model: assignment.member.model || undefined,
						thinking: assignment.member.thinking || undefined,
						tier: CAPABILITY_TIER[assignment.member.capability],
					});
					try {
						const execution = await runStructuredSubagent({
							session: this.session,
							invocationKind: "task",
							assignment: assignment.task,
							agentDefinition: assignment.agent,
							delegationSelection: selection,
							delegationPinned: true,
							cwd: company.checkout,
							structured: false,
							identity: { id: agentId, label: member },
							index,
							parentToolCallId: toolCallId,
							detached: false,
							enableLsp: (this.session.enableLsp ?? true) && cfgTaskEnableLsp.get(this.session.settings),
							enableIrc: false,
							maxRuntimeMs: assignmentTimeout(this.session.settings, assignment.member.role),
							signal,
							onProgress: update => {
								recordUsage(company, member, {
									tokens: update.tokens - booked.tokens,
									cost: update.cost - booked.cost,
									requests: update.requests - booked.requests,
								});
								booked.tokens = update.tokens;
								booked.cost = update.cost;
								booked.requests = update.requests;
								if (!sessionFile) {
									sessionFile = AgentRegistry.global().get(update.id)?.sessionFile ?? undefined;
									if (sessionFile) void updateRun(company, runId, { sessionFile });
								}
							},
						});
						const { result } = execution;
						const failed = result.exitCode !== 0 || result.error !== undefined || result.aborted === true;
						return {
							assignment,
							runId,
							failed,
							text: result.output.trim() || result.error || result.stderr.trim(),
						};
					} catch (error) {
						if (!(error instanceof StructuredSubagentError)) throw error;
						return { assignment, runId, failed: true, text: error.message };
					} finally {
						running.delete(assignment.label);
						progress();
					}
				}),
			);
			const endedAt = new Date().toISOString();
			const sections: string[] = [];
			for (const { assignment, runId, failed, text } of outcomes) {
				const report = text ? await saveReport(company, runId, text) : undefined;
				await updateRun(company, runId, { endedAt, failed, report });
				const who =
					assignment.label === assignment.member.id
						? assignment.label
						: `${assignment.label} (${assignment.member.id})`;
				sections.push(`## ${who}${failed ? " — did not finish" : ""} · run ${runId}\n${text || "(no report)"}`);
			}
			return this.#result("assign", sections.join("\n\n"));
		} finally {
			await Promise.all(releases.map(release => release()));
		}
	}

	async #report(params: OfficeParams): Promise<AgentToolResult<OfficeToolDetails>> {
		const runId = params.run?.trim();
		if (!runId) throw new ToolError("`report` needs `run`, the run id `status` lists.");
		const text = await readReport(this.seat.company, runId);
		if (text === undefined) throw new ToolError(`No report is kept for run ${runId}.`);
		return this.#result("report", text);
	}

	async #remember(params: OfficeParams): Promise<AgentToolResult<OfficeToolDetails>> {
		const seat = this.seat;
		if (seat.kind === "manager") {
			throw new ToolError(
				"Offices keep their own memory. Ask the office to remember it when you assign its next question.",
			);
		}
		await rememberNote(seat.company, seat.office.number, seat.member.id, params.note ?? "");
		const memory = await readOfficeMemory(seat.company, seat.office.number);
		return this.#result(
			"remember",
			`Office ${seat.office.number} will remember that (${memory.notes.length} lesson(s) kept for this project).`,
		);
	}
}
