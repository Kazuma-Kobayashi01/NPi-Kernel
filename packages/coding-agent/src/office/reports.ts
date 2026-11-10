/**
 * The reports offices hand in. Each assignment run ends with its member's report, kept as
 * `npi-office/reports/<run id>.md` next to the other office records so the general manager, the
 * `/office report` command and GUI hosts can read it again later. Bounded: the oldest go first.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { storePath } from "./store";
import type { Company } from "./workspace";

/** Reports kept per repository. */
export const MAX_OFFICE_REPORTS = 120;
/** Longest report title kept on a run, in characters. */
const MAX_TITLE_LENGTH = 120;

function reportsDir(company: Company): string {
	return storePath(company, "reports");
}

/** Run ids are snowflakes: digits only, so they are safe as file names. */
function reportFile(company: Company, runId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error(`Invalid run id: ${runId}`);
	return path.join(reportsDir(company), `${runId}.md`);
}

/** The report's title: its first non-empty line without Markdown heading marks. */
export function reportTitle(text: string): string {
	const line = text.split("\n").find(candidate => candidate.trim()) ?? "";
	const plain = line.replace(/^\s*#+\s*/, "").trim();
	return plain.length > MAX_TITLE_LENGTH ? `${plain.slice(0, MAX_TITLE_LENGTH - 1)}…` : plain;
}

/** Keep `text` as the report of run `runId`, dropping the oldest reports past the limit. Returns its title. */
export async function saveReport(company: Company, runId: string, text: string): Promise<string> {
	await Bun.write(reportFile(company, runId), text.endsWith("\n") ? text : `${text}\n`);
	const names = (await fs.readdir(reportsDir(company))).filter(name => name.endsWith(".md"));
	// Snowflakes sort by time once they have the same length; pad so mixed lengths still do.
	const byAge = names.sort((a, b) => a.padStart(32, "0").localeCompare(b.padStart(32, "0")));
	for (const stale of byAge.slice(0, Math.max(0, byAge.length - MAX_OFFICE_REPORTS))) {
		await fs.rm(path.join(reportsDir(company), stale), { force: true });
	}
	return reportTitle(text);
}

/** The report of run `runId`, or `undefined` when it was never written or has been dropped. */
export async function readReport(company: Company, runId: string): Promise<string | undefined> {
	try {
		return await Bun.file(reportFile(company, runId)).text();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}
