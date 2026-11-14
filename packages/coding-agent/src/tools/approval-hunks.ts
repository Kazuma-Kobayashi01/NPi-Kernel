import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { diffLines, editDiffString } from "@oh-my-pi/pi-natives";
import { isEnoent, prompt } from "@oh-my-pi/pi-utils";
import partialApprovalTemplate from "../prompts/tools/approval-partial.md" with { type: "text" };
import { decodeUtf8Text } from "./read-format";

/** Preserve every byte of UTF-8 text, including the BOM and line terminators. */
export async function readApprovalText(path: string): Promise<string | null> {
	try {
		const bytes = await Bun.file(path).bytes();
		const text = decodeUtf8Text(bytes);
		if (text === null) throw new Error(`Cannot partially approve non-UTF-8 text: ${path}`);
		return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? `\uFEFF${text}` : text;
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

/** Indices are zero-based across the whole proposal, not per file. */
export interface ApprovalHunk {
	index: number;
	path: string;
	header: string;
	lines: string[];
}

export interface HunkApprovalProposal {
	hunks: ApprovalHunk[];
	apply(selected: readonly number[], signal?: AbortSignal): Promise<AgentToolResult<unknown>>;
}

/** Optional capability of file-mutating tools; preparing it must not mutate disk or session snapshots. */
export interface HunkApprovalTool {
	prepareHunkApproval(args: unknown, signal?: AbortSignal): Promise<HunkApprovalProposal | undefined>;
}

export interface ApprovalFileChange {
	path: string;
	before: string | null;
	after: string | null;
	/** Moves are indivisible: selecting one must not turn it into a copy. */
	moveTo?: string;
	moveBefore?: string | null;
}

interface TextHunk {
	start: number;
	end: number;
	replacement: string;
	view: ApprovalHunk;
}

function textHunks(file: ApprovalFileChange, firstIndex: number): TextHunk[] {
	const hunks: TextHunk[] = [];
	let offset = 0;
	let oldLine = 1;
	let newLine = 1;
	let pending: TextHunk | undefined;
	let removed = 0;
	let added = 0;
	const finish = () => {
		if (!pending) return;
		pending.view.header = `@@ -${oldLine - (removed === 0 ? 1 : 0)},${removed} +${newLine - (added === 0 ? 1 : 0)},${added} @@`;
		hunks.push(pending);
		oldLine += removed;
		newLine += added;
		pending = undefined;
		removed = 0;
		added = 0;
	};
	for (const run of diffLines(file.before ?? "", file.after ?? "")) {
		if (!run.added && !run.removed) {
			finish();
			offset += run.value.length;
			oldLine += run.count;
			newLine += run.count;
			continue;
		}
		pending ??= {
			start: offset,
			end: offset,
			replacement: "",
			view: { index: firstIndex + hunks.length, path: file.path, header: "", lines: [] },
		};
		const lines = run.value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
		pending.view.lines.push(...lines.map(line => `${run.added ? "+" : "-"}${line.replace(/\r?\n$/, "")}`));
		if (!run.value.endsWith("\n")) pending.view.lines.push("\\ No newline at end of file");
		if (run.removed) {
			offset += run.value.length;
			pending.end = offset;
			removed += run.count;
		} else {
			pending.replacement += run.value;
			added += run.count;
		}
	}
	finish();
	return hunks;
}

export function validateHunkSelection(hunks: readonly ApprovalHunk[], selected: readonly number[]): void {
	const indices = new Set(hunks.map(hunk => hunk.index));
	if (new Set(selected).size !== selected.length || selected.some(index => !Number.isInteger(index) || !indices.has(index))) {
		throw new Error("Invalid approval hunk selection");
	}
}

/** Frozen proposal + exact slices: the host can only choose, never supply replacement text. */
export function createHunkApproval(
	files: readonly ApprovalFileChange[],
	write: (file: ApprovalFileChange, content: string | null, signal?: AbortSignal) => Promise<void>,
): HunkApprovalProposal {
	let nextIndex = 0;
	const plans = files.map(file => {
		let changes = textHunks(file, nextIndex);
		if (file.before === null || file.after === null || file.moveTo) {
			// Creation/deletion/rename is one atomic filesystem operation, including empty files.
			changes = [{ start: 0, end: (file.before ?? "").length, replacement: file.after ?? "", view: {
				index: nextIndex, path: file.path,
				header: file.moveTo ? `Move to ${file.moveTo}` : file.before === null ? "Create file" : "Delete file",
				lines: changes.flatMap(change => [change.view.header, ...change.view.lines]),
			} }];
		}
		nextIndex += changes.length;
		return { file, changes };
	});
	const hunks = plans.flatMap(plan => plan.changes.map(change => change.view));
	return {
		hunks,
		async apply(selected, signal) {
			validateHunkSelection(hunks, selected);
			const chosen = new Set(selected);
			if (chosen.size === 0) throw new Error("Tool call denied by user: no hunks selected");
			const read = readApprovalText;
			const verify = async (file: ApprovalFileChange) => {
				if (await read(file.path) !== file.before || (file.moveTo && await read(file.moveTo) !== file.moveBefore)) {
					throw new Error(`Partial approval is stale: ${file.path} changed since the approval diff was prepared. No further hunks were written; re-read the file and propose a new edit.`);
				}
			};
			// Check the entire proposal before the first write, including files the user rejected.
			for (const { file } of plans) await verify(file);
			const appliedFiles: { path: string; diff: string; oldText: string; newText: string; op: string; moveTo?: string }[] = [];
			for (const { file, changes } of plans) {
				const accepted = changes.filter(change => chosen.has(change.view.index));
				if (accepted.length === 0) continue;
				signal?.throwIfAborted();
				await verify(file);
				let content = file.before ?? "";
				for (const change of accepted.toReversed()) {
					content = content.slice(0, change.start) + change.replacement + content.slice(change.end);
				}
				await write(file, file.after === null ? null : content, signal);
				appliedFiles.push({
					path: file.path, diff: editDiffString(file.before ?? "", content, file.path).diff,
					oldText: file.before ?? "", newText: file.after === null ? "" : content,
					op: file.after === null ? "delete" : file.before === null ? "create" : "update",
					...(file.moveTo ? { moveTo: file.moveTo } : {}),
				});
			}
			const applied = hunks.filter(hunk => chosen.has(hunk.index)).map(hunk => hunk.index);
			const rejected = hunks.filter(hunk => !chosen.has(hunk.index)).map(hunk => hunk.index);
			return {
				content: [{ type: "text", text: prompt.render(partialApprovalTemplate, {
					applied: applied.join(", "), rejected: rejected.length ? rejected.join(", ") : "none",
					hunks: hunks.map(hunk => ({ ...hunk, status: chosen.has(hunk.index) ? "applied" : "rejected" })),
				}) }],
				details: {
					appliedHunks: applied, rejectedHunks: rejected,
					diff: appliedFiles.map(file => file.diff).join("\n"),
					perFileResults: appliedFiles,
					...(appliedFiles.length === 1 ? { resolvedPath: appliedFiles[0].moveTo ?? appliedFiles[0].path } : {}),
				},
			};
		},
	};
}
