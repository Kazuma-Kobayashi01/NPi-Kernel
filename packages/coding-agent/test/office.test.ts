import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { claimMember, readClaims } from "@oh-my-pi/pi-coding-agent/office/claims";
import { runOfficeCommand } from "@oh-my-pi/pi-coding-agent/office/commands";
import {
	readOfficeState,
	registerMemberSeat,
	resolveSeat,
	staffedOffices,
} from "@oh-my-pi/pi-coding-agent/office/company";
import {
	MAX_NOTE_LENGTH,
	MAX_OFFICE_NOTES,
	readOfficeMemory,
	rememberNote,
} from "@oh-my-pi/pi-coding-agent/office/memory";
import {
	activeOffices,
	leaderOf,
	OFFICE_MEMBER_TOOLS,
	type OfficeConfig,
	removeMember,
	staffOffices,
	updateMember,
	validateOffices,
	workersOf,
} from "@oh-my-pi/pi-coding-agent/office/model";
import { MAX_OFFICE_REPORTS, readReport, reportTitle, saveReport } from "@oh-my-pi/pi-coding-agent/office/reports";
import { cfgOfficeOffices } from "@oh-my-pi/pi-coding-agent/office/settings";
import { onOfficeChange, storePath } from "@oh-my-pi/pi-coding-agent/office/store";
import {
	flushUsage,
	onOfficeUsage,
	readUsage,
	recordUsage,
	startRun,
	type UsageBooking,
	updateRun,
} from "@oh-my-pi/pi-coding-agent/office/usage";
import { type Company, OfficeWorkspaceError, openCompany } from "@oh-my-pi/pi-coding-agent/office/workspace";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

describe("office roster", () => {
	it("keeps every existing name when the company grows", () => {
		const team = staffOffices("team", []);
		const studio = staffOffices("studio", team);
		expect(studio).toHaveLength(3);
		expect(studio[0]).toEqual(team[0]);
		const names = studio.flatMap(office => office.members.map(member => member.id));
		expect(new Set(names).size).toBe(names.length);
	});

	it("promoting a worker demotes the previous leader", () => {
		const offices = staffOffices("team", []);
		const oldLeader = leaderOf(offices[0]);
		const promoted = workersOf(offices[0])[0];
		const next = updateMember(offices, promoted.id, { role: "leader" });
		expect(leaderOf(next[0]).id).toBe(promoted.id);
		expect(next[0].members.find(member => member.id === oldLeader.id)?.role).toBe("worker");
		validateOffices(next);
	});

	it("refuses to leave an office leaderless or under three members", () => {
		const offices = staffOffices("team", []);
		expect(() => removeMember(offices, leaderOf(offices[0]).id)).toThrow(/leads office 1/);
		expect(() => removeMember(offices, workersOf(offices[0])[0].id)).toThrow(/at least 3/);
		expect(() => updateMember(offices, leaderOf(offices[0]).id, { role: "worker" })).toThrow(/Make another member/);
	});

	it("rejects a hand-edited roster with two leaders", () => {
		const offices: OfficeConfig[] = staffOffices("team", []);
		const broken = [{ members: offices[0].members.map(member => ({ ...member, role: "leader" })) }];
		expect(() => validateOffices(broken)).toThrow(/exactly one leader, got 3/);
	});

	it("reads a roster saved before members had an effort as inherit, and refuses an unknown level", () => {
		const offices = staffOffices("team", []);
		// What an older config file holds: no `thinking` key at all.
		const legacy = offices.map(office => ({
			members: office.members.map(({ thinking: _thinking, ...member }) => member),
		})) as unknown as OfficeConfig[];
		expect(() => validateOffices(legacy)).not.toThrow();
		expect(activeOffices("team", legacy)[0]!.members[0]!.thinking).toBe("");
		const broken = [{ members: offices[0].members.map(member => ({ ...member, thinking: "turbo" })) }];
		expect(() => validateOffices(broken)).toThrow(/has thinking "turbo"/);
	});

	it("sets and clears a member's thinking effort through the owner command", async () => {
		const settings = Settings.isolated({ "office.scale": "team" });
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-office-command-"));
		try {
			const member = workersOf(staffedOffices(settings)[0]!)[0]!;
			const set = await runOfficeCommand(["set", member.id, "thinking", "high"], settings, cwd);
			expect(set.failed).toBeUndefined();
			expect(set.text).toContain(`${member.id}`);
			expect(set.text).toContain("high effort");
			expect(cfgOfficeOffices.get(settings)[0]!.members.find(entry => entry.id === member.id)?.thinking).toBe(
				Effort.High,
			);
			const cleared = await runOfficeCommand(["set", member.id, "thinking", "default"], settings, cwd);
			expect(cleared.text).toContain("default effort");
			expect(cfgOfficeOffices.get(settings)[0]!.members.find(entry => entry.id === member.id)?.thinking).toBe("");
			expect((await runOfficeCommand(["set", member.id, "thinking", "turbo"], settings, cwd)).failed).toBe(true);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});

describe("office company", () => {
	let tmp: TempDir;
	let repoDir: string;
	let company: Company;
	let settings: Settings;
	let workerName: string;

	beforeEach(async () => {
		tmp = await TempDir.create("omp-office-");
		// macOS temp paths are symlinks; git reports the resolved form.
		repoDir = path.join(await fs.realpath(tmp.path()), "repo");
		await fs.mkdir(repoDir);
		await $`git init -q -b main`.cwd(repoDir);
		await $`git config user.name Tester`.cwd(repoDir);
		await $`git config user.email tester@example.com`.cwd(repoDir);
		await Bun.write(path.join(repoDir, "app.txt"), "one\n");
		await $`git add -A`.cwd(repoDir);
		await $`git commit -q -m init`.cwd(repoDir);
		settings = Settings.isolated({ "office.enabled": true });
		company = await openCompany(repoDir);
		workerName = workersOf(staffedOffices(settings)[0])[0].id;
	});

	afterEach(async () => {
		await tmp.remove();
	});

	it("seats the main session as general manager and a subagent only while an assignment registered it", async () => {
		expect((await resolveSeat(settings, repoDir, 0))?.kind).toBe("manager");
		const office = staffedOffices(settings)[0];
		const seat = { kind: "leader" as const, company, office, member: leaderOf(office) };
		// An ordinary subagent, or one whose assignment is over, has no seat.
		expect(await resolveSeat(settings, repoDir, 1, "Some-agent")).toBeNull();
		const release = registerMemberSeat("Leader-run-1", seat);
		expect(await resolveSeat(settings, repoDir, 1, "Leader-run-1")).toBe(seat);
		release();
		expect(await resolveSeat(settings, repoDir, 1, "Leader-run-1")).toBeNull();
	});

	it("gives members reading tools only: no shell, no writes, no edits, no subagents", () => {
		for (const forbidden of ["bash", "eval", "write", "edit", "apply_patch", "task"]) {
			expect(OFFICE_MEMBER_TOOLS).not.toContain(forbidden);
		}
		expect(OFFICE_MEMBER_TOOLS).toContain("read");
	});

	it("keeps each run's report, names it by its first line, and drops the oldest past the limit", async () => {
		await startRun(company, { id: "100", office: 1, member: workerName, by: "general-manager", task: "Where is X?" });
		const title = await saveReport(company, "100", "## X lives in app.txt\n\nEvidence: app.txt:1\n");
		await updateRun(company, "100", { endedAt: new Date().toISOString(), report: title });
		expect(title).toBe("X lives in app.txt");
		expect(await readReport(company, "100")).toContain("Evidence: app.txt:1");
		expect((await readOfficeState(settings, repoDir)).runs.at(-1)?.report).toBe("X lives in app.txt");

		const listed = await runOfficeCommand(["report"], settings, repoDir);
		expect(listed.text).toContain("X lives in app.txt");
		expect((await runOfficeCommand(["report", "100"], settings, repoDir)).text).toContain("Evidence: app.txt:1");
		expect((await runOfficeCommand(["report", "999"], settings, repoDir)).failed).toBe(true);

		for (let index = 0; index < MAX_OFFICE_REPORTS; index++) await saveReport(company, String(1000 + index), "r");
		expect(await readReport(company, "100")).toBeUndefined();
		expect(await readReport(company, String(1000 + MAX_OFFICE_REPORTS - 1))).toBe("r\n");
		expect(reportTitle("\n\n# Title\nbody")).toBe("Title");
	});

	it("lets one process at a time have a member working, and drops a claim whose process is gone", async () => {
		const claim = { office: 1, member: workerName, role: "worker" as const, task: "find it" };
		const release = await claimMember(company, claim);
		expect(release).not.toBeNull();
		expect(await claimMember(company, claim)).toBeNull();
		expect((await readOfficeState(settings, repoDir)).activity[0]).toMatchObject({
			phase: "working",
			working: [workerName],
			task: "find it",
		});
		await release?.();
		expect(await readClaims(company)).toEqual([]);
		expect((await readOfficeState(settings, repoDir)).activity[0].phase).toBe("idle");

		// A claim left by a process that died does not block the member.
		const again = await claimMember(company, claim);
		const dir = storePath(company, "working");
		const [file] = await fs.readdir(dir);
		await Bun.write(path.join(dir, file), JSON.stringify({ ...claim, pid: 2 ** 30, startedAt: "" }));
		expect(await readClaims(company)).toEqual([]);
		expect(await claimMember(company, claim)).not.toBeNull();
		await again?.();
	});

	it("keeps an office's lessons once each, newest within the cap, until forgotten", async () => {
		await rememberNote(company, 1, workerName, "Run the checks from the repo root.");
		await rememberNote(company, 1, workerName, "Run the checks from the repo root.");
		expect((await readOfficeMemory(company, 1)).notes).toHaveLength(1);

		for (let index = 0; index < MAX_OFFICE_NOTES; index++)
			await rememberNote(company, 1, workerName, `lesson ${index}`);
		const notes = (await readOfficeMemory(company, 1)).notes;
		expect(notes).toHaveLength(MAX_OFFICE_NOTES);
		expect(notes[0].text).toBe("lesson 0");
		expect(notes.at(-1)?.text).toBe(`lesson ${MAX_OFFICE_NOTES - 1}`);

		await expect(rememberNote(company, 1, workerName, "x".repeat(MAX_NOTE_LENGTH + 1))).rejects.toThrow(/at most/);

		const forgot = await runOfficeCommand(["forget", "1"], settings, repoDir);
		expect(forgot.failed).toBeUndefined();
		expect((await readOfficeMemory(company, 1)).notes).toEqual([]);
	});

	it("books usage to the local day it happened on, so a run across midnight is split", async () => {
		const before = new Date(2026, 10, 9, 23, 59, 30);
		const after = new Date(2026, 10, 10, 0, 0, 30);
		let changes = 0;
		const bookings: UsageBooking[] = [];
		const stop = onOfficeChange(() => changes++);
		const stopUsage = onOfficeUsage(booking => bookings.push(booking));
		recordUsage(company, workerName, { tokens: 100, cost: 0.5, requests: 1 }, before);
		recordUsage(company, workerName, { tokens: 40, cost: 0.2, requests: 1 }, after);
		recordUsage(company, "general-manager", { tokens: 10, cost: 0.1, requests: 1 }, after);
		await flushUsage();
		stop();
		stopUsage();
		// Bookings reach hosts as deltas; writing the ledger is not an office change.
		expect(changes).toBe(0);
		expect(bookings.map(b => [b.member, b.day, b.amount.tokens])).toEqual([
			[workerName, "2026-11-09", 100],
			[workerName, "2026-11-10", 40],
			["general-manager", "2026-11-10", 10],
		]);
		expect(bookings[0].checkout).toBe(company.checkout);

		const usage = await readUsage(company, after);
		expect(usage.day).toBe("2026-11-10");
		expect(usage.members[workerName].today.tokens).toBe(40);
		expect(usage.members[workerName].total.tokens).toBe(140);
		expect(usage.today).toEqual({ tokens: 50, cost: expect.closeTo(0.3, 6), requests: 2 });
		expect(usage.total.cost).toBeCloseTo(0.8, 6);
		// The next day starts from zero; the total stays.
		const nextDay = await readUsage(company, new Date(2026, 10, 11, 8));
		expect(nextDay.today.tokens).toBe(0);
		expect(nextDay.total.tokens).toBe(150);
	});

	it("works on a detached HEAD, and has no company outside a repository", async () => {
		await $`git checkout -q --detach`.cwd(repoDir);
		expect((await openCompany(repoDir)).checkout).toBe(repoDir);
		await expect(openCompany(os.tmpdir())).rejects.toBeInstanceOf(OfficeWorkspaceError);
	});
});
