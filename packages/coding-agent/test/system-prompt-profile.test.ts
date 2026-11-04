import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";

async function render(promptProfile: "full" | "lite", subagent = false): Promise<string> {
	const { systemPrompt } = await buildSystemPrompt({
		cwd: "/work/project",
		contextFiles: [],
		skills: [],
		rules: [],
		toolNames: [],
		activeRepoContext: null,
		promptProfile,
		subagent,
		workspaceTree: { rootPath: "/work/project", rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	});
	return systemPrompt.join("\n\n");
}

describe("system prompt profile", () => {
	it("lite renders a shorter tool-first prompt than full, and full keeps the staged workflow", async () => {
		const full = await render("full");
		const lite = await render("lite");
		expect(lite.length).toBeLessThan(full.length * 0.75);
		expect(lite).toContain("Tools first.");
		expect(lite).not.toContain("<contract>");
		expect(full).toContain("<contract>");
		expect(full).not.toContain("Tools first.");
	});

	it("lite keeps the subagent hand-off rule for subagents only", async () => {
		expect(await render("lite", true)).toContain("NEVER run builds, tests, or linters unless told to");
		expect(await render("lite")).not.toContain("NEVER run builds, tests, or linters unless told to");
	});
});
