/**
 * Tools that run agent-chosen code on the host and do not go through the `bash` tool's exec backend. While the
 * VM is the command backend they are switched off, otherwise the model could simply run the same code there.
 */
export const HOST_CODE_TOOLS: readonly string[] = ["eval", "python", "debug"];

export interface ToolPolicyResult {
	/** The tool names to make active. */
	active: string[];
	/** The tools this policy took away, to give back when the VM stops being the backend. */
	removed: string[];
}

/**
 * Compute the active tools for `vmIsBackend`. `previouslyRemoved` is what an earlier call took away; turning the
 * policy off gives back exactly those, never a tool the user had switched off.
 */
export function applyHostCodePolicy(
	active: readonly string[],
	previouslyRemoved: readonly string[],
	vmIsBackend: boolean,
): ToolPolicyResult {
	if (vmIsBackend) {
		const taken = active.filter(name => HOST_CODE_TOOLS.includes(name));
		return {
			active: active.filter(name => !HOST_CODE_TOOLS.includes(name)),
			removed: [...new Set([...previouslyRemoved, ...taken])],
		};
	}
	const back = previouslyRemoved.filter(name => !active.includes(name));
	return { active: [...active, ...back], removed: [] };
}
