import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as os from "node:os";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => vi.restoreAllMocks());

async function delegation(modelRoster?: Array<{ tier: string; model: string }>): Promise<string> {
	using dir = TempDir.createSync("@omp-system-prompt-roster-");
	spyOn(os, "homedir").mockReturnValue(dir.join("home"));
	const cwd = dir.join("project");
	const result = await buildSystemPrompt({
		cwd,
		contextFiles: [],
		skills: [],
		rules: [],
		toolNames: ["task"],
		workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		delegationAppetite: "moderate",
		modelRoster,
	});
	return result.systemPrompt.join("\n\n");
}

describe("model roster in the delegation guidance", () => {
	it("lists the configured tiers and lets a tier selector skip the Ask", async () => {
		const text = await delegation([
			{ tier: "flagship", model: "anthropic/claude-opus-5-5" },
			{ tier: "economy", model: "mock/cheap" },
		]);
		expect(text).toContain("`@flagship` (anthropic/claude-opus-5-5): architecture");
		expect(text).toContain("`@economy` (mock/cheap): search");
		expect(text).not.toContain("`@high`");
		expect(text).toContain("Other per-task `model`/`effort` values carry only");
	});

	it("keeps the plain rule without a roster", async () => {
		for (const roster of [undefined, []]) {
			const text = await delegation(roster);
			expect(text).not.toContain("Model roster");
			expect(text).toContain("Per-task `model`/`effort` carry only the user's explicit form answer");
		}
	});
});
