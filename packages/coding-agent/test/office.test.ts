import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runOfficeCommand } from "@oh-my-pi/pi-coding-agent/office/commands";
import {
	deskOfOffice,
	deskOfWorker,
	mergeApprovedPull,
	readOfficeState,
	resolveSeat,
	staffedOffices,
} from "@oh-my-pi/pi-coding-agent/office/company";
import { cfgOfficeOffices } from "@oh-my-pi/pi-coding-agent/office/settings";
import { claimDesk, readClaims } from "@oh-my-pi/pi-coding-agent/office/desks";
import { onOfficeChange, storePath } from "@oh-my-pi/pi-coding-agent/office/store";
import {
	flushUsage,
	onOfficeUsage,
	readUsage,
	recordUsage,
	type UsageBooking,
} from "@oh-my-pi/pi-coding-agent/office/usage";
import {
	MAX_NOTE_LENGTH,
	MAX_OFFICE_NOTES,
	readOfficeMemory,
	rememberNote,
} from "@oh-my-pi/pi-coding-agent/office/memory";
import {
	activeOffices,
	leaderOf,
	type OfficeConfig,
	removeMember,
	staffOffices,
	updateMember,
	validateOffices,
	workersOf,
} from "@oh-my-pi/pi-coding-agent/office/model";
import { getPull, type PullActor, reviewPull, submitPull } from "@oh-my-pi/pi-coding-agent/office/pulls";
import {
	type Company,
	commitDesk,
	OfficeWorkspaceError,
	openCompany,
	prepareDesk,
} from "@oh-my-pi/pi-coding-agent/office/workspace";
import { getWorktreesDir, setWorktreesDir, TempDir } from "@oh-my-pi/pi-utils";
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

describe("office pull requests", () => {
	let tmp: TempDir;
	let repoDir: string;
	let company: Company;
	let settings: Settings;
	let previousWorktrees: string;
	let leader: PullActor;
	let workerName: string;

	beforeEach(async () => {
		tmp = await TempDir.create("omp-office-");
		// macOS temp paths are symlinks; git reports the resolved form.
		const root = await fs.realpath(tmp.path());
		repoDir = path.join(root, "repo");
		previousWorktrees = getWorktreesDir();
		setWorktreesDir(path.join(root, "wt"));
		await fs.mkdir(repoDir);
		await $`git init -q -b main`.cwd(repoDir);
		await $`git config user.name Tester`.cwd(repoDir);
		await $`git config user.email tester@example.com`.cwd(repoDir);
		await Bun.write(path.join(repoDir, "app.txt"), "one\ntwo\nthree\n");
		await $`git add -A`.cwd(repoDir);
		await $`git commit -q -m init`.cwd(repoDir);

		settings = Settings.isolated({ "office.enabled": true, "worktree.clone": false });
		const seat = await resolveSeat(settings, repoDir, 0);
		if (seat?.kind !== "manager") throw new Error("expected the main session to be the general manager");
		company = seat.company;
		const office = seat.offices[0];
		leader = { kind: "leader", office: 1, member: leaderOf(office).id };
		workerName = workersOf(office)[0].id;
		await prepareDesk(company, deskOfOffice(company, 1), settings);
		await prepareDesk(company, deskOfWorker(company, 1, workerName), settings);
	});

	afterEach(async () => {
		setWorktreesDir(previousWorktrees);
		await tmp.remove();
	});

	/** The worker edits `app.txt` at their desk and submits it. */
	async function workerSubmits(content: string, title: string) {
		const desk = deskOfWorker(company, 1, workerName);
		await Bun.write(path.join(desk.dir, "app.txt"), content);
		await commitDesk(company, desk, title);
		return submitPull(company, {
			kind: "worker",
			office: 1,
			author: workerName,
			title,
			body: "",
			source: desk.branch,
			target: desk.upstream,
		});
	}

	it("seats a session by the desk it runs at", async () => {
		const atOffice = await resolveSeat(settings, deskOfOffice(company, 1).dir, 1);
		expect(atOffice?.kind).toBe("leader");
		const atWorker = await resolveSeat(settings, deskOfWorker(company, 1, workerName).dir, 2);
		expect(atWorker?.kind === "worker" && atWorker.member.id).toBe(workerName);
		// An ordinary subagent in the owner's checkout has no seat.
		expect(await resolveSeat(settings, repoDir, 1)).toBeNull();
	});

	it("moves a change up one reviewed level at a time, ending with the owner", async () => {
		const workerPull = await workerSubmits("one\nTWO\nthree\n", "Shout two");

		// Nobody but the office's leader reviews it, and it does not merge unapproved.
		await expect(reviewPull(company, workerPull.number, { kind: "manager" }, "approve", "")).rejects.toThrow(
			/reviewed by the leader of office 1/,
		);
		await expect(mergeApprovedPull(company, workerPull.number, leader)).rejects.toThrow(/only after/);

		await reviewPull(company, workerPull.number, leader, "approve", "");
		await mergeApprovedPull(company, workerPull.number, leader);
		const officeDesk = deskOfOffice(company, 1);
		expect(await Bun.file(path.join(officeDesk.dir, "app.txt")).text()).toBe("one\nTWO\nthree\n");
		// The base branch is untouched until the owner merges.
		expect(await Bun.file(path.join(repoDir, "app.txt")).text()).toBe("one\ntwo\nthree\n");

		await commitDesk(company, officeDesk, "Office 1 work");
		const officePull = await submitPull(company, {
			kind: "office",
			office: 1,
			author: leader.kind === "leader" ? leader.member : "",
			title: "Shout two",
			body: "",
			source: officeDesk.branch,
			target: officeDesk.upstream,
		});
		await reviewPull(company, officePull.number, { kind: "manager" }, "approve", "");

		// The general manager approves but cannot merge into the owner's branch.
		await expect(mergeApprovedPull(company, officePull.number, { kind: "manager" })).rejects.toThrow(
			/Only they can merge it/,
		);
		const merged = await runOfficeCommand(["merge", String(officePull.number)], settings, repoDir);
		expect(merged.failed).toBeUndefined();
		expect(await Bun.file(path.join(repoDir, "app.txt")).text()).toBe("one\nTWO\nthree\n");
		expect((await getPull(company, officePull.number)).status).toBe("merged");
		expect(await vcs.requireGit(repoDir).isDirty()).toBe(false);
	});

	it("restarts a worker desk whose work reached the base branch, though no commit of it did", async () => {
		const workerPull = await workerSubmits("one\nTWO\nthree\n", "Shout two");
		await reviewPull(company, workerPull.number, leader, "approve", "");
		await mergeApprovedPull(company, workerPull.number, leader);
		const officeDesk = deskOfOffice(company, 1);
		const officePull = await submitPull(company, {
			kind: "office",
			office: 1,
			author: leader.kind === "leader" ? leader.member : "",
			title: "Shout two",
			body: "",
			source: officeDesk.branch,
			target: officeDesk.upstream,
		});
		await reviewPull(company, officePull.number, { kind: "manager" }, "approve", "");
		await mergeApprovedPull(company, officePull.number, { kind: "owner" });

		// The worker's branch still holds the office-level squash commit, which main never got.
		const workerDesk = deskOfWorker(company, 1, workerName);
		await prepareDesk(company, workerDesk, settings);
		const repo = vcs.requireGit(repoDir);
		expect(await repo.resolveRef(workerDesk.branch)).toBe(await repo.resolveRef("main"));

		// The next round's change applies cleanly instead of colliding with the merged one.
		const next = await workerSubmits("one\nTWO\nTHREE\n", "Shout three");
		await reviewPull(company, next.number, leader, "approve", "");
		await mergeApprovedPull(company, next.number, leader);
		expect(await Bun.file(path.join(officeDesk.dir, "app.txt")).text()).toBe("one\nTWO\nTHREE\n");
	});

	it("refuses a merge the target has moved under, leaving both sides as they were", async () => {
		const pull = await workerSubmits("one\nTWO\nthree\n", "Shout two");
		await reviewPull(company, pull.number, leader, "approve", "");

		const officeDesk = deskOfOffice(company, 1);
		await Bun.write(path.join(officeDesk.dir, "app.txt"), "one\nzwei\nthree\n");
		await commitDesk(company, officeDesk, "Translate two");

		await expect(mergeApprovedPull(company, pull.number, leader)).rejects.toBeInstanceOf(OfficeWorkspaceError);
		expect(await Bun.file(path.join(officeDesk.dir, "app.txt")).text()).toBe("one\nzwei\nthree\n");
		expect(await vcs.requireGit(officeDesk.dir).isDirty()).toBe(false);
		expect((await getPull(company, pull.number)).status).toBe("approved");
	});

	it("puts a pull request back up for review when its author resubmits", async () => {
		const first = await workerSubmits("one\nTWO\nthree\n", "Shout two");
		await reviewPull(company, first.number, leader, "request_changes", "Shout three as well.");
		const second = await workerSubmits("one\nTWO\nTHREE\n", "Shout two and three");
		expect(second.number).toBe(first.number);
		expect(second.status).toBe("open");
		expect(second.reviews).toHaveLength(1);
	});

	it("remembers each merged pull request in its office's log, across both levels", async () => {
		const workerPull = await workerSubmits("one\nTWO\nthree\n", "Shout two");
		await reviewPull(company, workerPull.number, leader, "approve", "");
		await mergeApprovedPull(company, workerPull.number, leader);
		const officeDesk = deskOfOffice(company, 1);
		const officePull = await submitPull(company, {
			kind: "office",
			office: 1,
			author: leader.kind === "leader" ? leader.member : "",
			title: "Shout two",
			body: "",
			source: officeDesk.branch,
			target: officeDesk.upstream,
		});
		await reviewPull(company, officePull.number, { kind: "manager" }, "approve", "");
		await mergeApprovedPull(company, officePull.number, { kind: "owner" });

		const state = await readOfficeState(settings, repoDir);
		const log = state.memory[0].log;
		expect(log.map(entry => [entry.pr, entry.kind, entry.target, entry.files])).toEqual([
			[workerPull.number, "worker", officeDesk.branch, ["app.txt"]],
			[officePull.number, "office", "main", ["app.txt"]],
		]);
		// Another office of the same project remembers nothing of it.
		expect((await readOfficeMemory(company, 2)).log).toEqual([]);
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

	it("lets one process at a time take a desk, and drops a claim whose process is gone", async () => {
		const desk = deskOfWorker(company, 1, workerName).dir;
		const claim = { desk, office: 1, member: workerName, role: "worker" as const, task: "fix it" };
		const release = await claimDesk(company, claim);
		expect(release).not.toBeNull();
		expect(await claimDesk(company, claim)).toBeNull();
		expect((await readOfficeState(settings, repoDir)).activity[0]).toMatchObject({
			phase: "working",
			working: [workerName],
			task: "fix it",
		});
		await release?.();
		expect(await readClaims(company)).toEqual([]);

		// A claim left by a process that died does not block the desk.
		const dir = storePath(company, "desks");
		const [name] = await fs.readdir(dir).catch(() => [] as string[]);
		expect(name).toBeUndefined();
		const again = await claimDesk(company, claim);
		const [file] = await fs.readdir(dir);
		await Bun.write(path.join(dir, file), JSON.stringify({ ...claim, pid: 2 ** 30, startedAt: "" }));
		expect(await readClaims(company)).toEqual([]);
		expect(await claimDesk(company, claim)).not.toBeNull();
		await again?.();
	});

	it("names the office's phase from its pull requests when nobody is at a desk", async () => {
		expect((await readOfficeState(settings, repoDir)).activity[0].phase).toBe("idle");
		const workerPull = await workerSubmits("one\ntwo\nthree\nfour\n", "Add four");
		await reviewPull(company, workerPull.number, leader, "approve", "");
		await mergeApprovedPull(company, workerPull.number, leader);
		const desk = deskOfOffice(company, 1);
		await commitDesk(company, desk, "Add four");
		const officePull = await submitPull(company, {
			kind: "office",
			office: 1,
			author: leader.kind === "leader" ? leader.member : "",
			title: "Add four",
			body: "",
			source: desk.branch,
			target: desk.upstream,
		});
		expect((await readOfficeState(settings, repoDir)).activity[0].phase).toBe("awaiting_manager");
		await reviewPull(company, officePull.number, { kind: "manager" }, "approve", "");
		expect((await readOfficeState(settings, repoDir)).activity[0].phase).toBe("awaiting_owner");
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

	it("has no company on a detached HEAD", async () => {
		await $`git checkout -q --detach`.cwd(repoDir);
		await expect(openCompany(repoDir)).rejects.toThrow(/HEAD is detached/);
	});
});
