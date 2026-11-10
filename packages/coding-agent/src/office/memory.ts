/**
 * What each office remembers about a project: the pull requests it got merged and the lessons its
 * members wrote down. Kept per repository (not per branch), like a department's experience of a
 * client: it carries over between sessions and is handed to the office's members with every
 * assignment.
 *
 * Both lists are bounded; the oldest entries drop off first.
 */
import { readStore, storePath, updateStore } from "./store";
import type { Company } from "./workspace";

/** Lessons kept per office. */
export const MAX_OFFICE_NOTES = 40;
/** Merged pull requests kept per office. */
export const MAX_OFFICE_LOG = 30;
/** Longest note accepted, in characters; a note is a lesson, not a report. */
export const MAX_NOTE_LENGTH = 600;

export interface OfficeNote {
	/** Member who wrote it. */
	by: string;
	text: string;
	at: string;
}

export interface OfficeLogEntry {
	pr: number;
	kind: "worker" | "office";
	title: string;
	author: string;
	/** Branch it merged into. */
	target: string;
	files: string[];
	at: string;
}

export interface OfficeMemory {
	office: number;
	notes: OfficeNote[];
	log: OfficeLogEntry[];
}

interface MemoryFile {
	offices: Record<string, { notes: OfficeNote[]; log: OfficeLogEntry[] }>;
}

const emptyFile = (): MemoryFile => ({ offices: {} });

function memoryPath(company: Company): string {
	return storePath(company, "memory.json");
}

function slot(file: MemoryFile, office: number): { notes: OfficeNote[]; log: OfficeLogEntry[] } {
	const key = String(office);
	file.offices[key] ??= { notes: [], log: [] };
	return file.offices[key];
}

/** Thrown for a note the office will not keep; the message says why. */
export class OfficeMemoryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OfficeMemoryError";
	}
}

/** The memory of office `office` (empty when it has none yet). */
export async function readOfficeMemory(company: Company, office: number): Promise<OfficeMemory> {
	const file = await readStore(memoryPath(company), emptyFile);
	const entry = file.offices[String(office)];
	return { office, notes: entry?.notes ?? [], log: entry?.log ?? [] };
}

/** The memory of each office in `offices`, in that order. */
export async function readOfficeMemories(company: Company, offices: readonly number[]): Promise<OfficeMemory[]> {
	const file = await readStore(memoryPath(company), emptyFile);
	return offices.map(office => {
		const entry = file.offices[String(office)];
		return { office, notes: entry?.notes ?? [], log: entry?.log ?? [] };
	});
}

/**
 * Keep a lesson for office `office`. A note the office already holds word for word is not added
 * twice.
 *
 * @throws OfficeMemoryError for an empty or overlong note.
 */
export async function rememberNote(company: Company, office: number, by: string, text: string): Promise<OfficeNote> {
	const trimmed = text.trim();
	if (!trimmed) throw new OfficeMemoryError("Write the lesson in `note`.");
	if (trimmed.length > MAX_NOTE_LENGTH) {
		throw new OfficeMemoryError(
			`A note holds at most ${MAX_NOTE_LENGTH} characters; this one has ${trimmed.length}. Keep the lesson, drop the story.`,
		);
	}
	return updateStore(memoryPath(company), emptyFile, file => {
		const memory = slot(file, office);
		const existing = memory.notes.find(note => note.text === trimmed);
		if (existing) return existing;
		const note: OfficeNote = { by, text: trimmed, at: new Date().toISOString() };
		memory.notes.push(note);
		memory.notes.splice(0, Math.max(0, memory.notes.length - MAX_OFFICE_NOTES));
		return note;
	});
}

/** Record a merged pull request in its office's log. */
export async function logMerge(company: Company, office: number, entry: Omit<OfficeLogEntry, "at">): Promise<void> {
	await updateStore(memoryPath(company), emptyFile, file => {
		const memory = slot(file, office);
		memory.log.push({ ...entry, at: new Date().toISOString() });
		memory.log.splice(0, Math.max(0, memory.log.length - MAX_OFFICE_LOG));
	});
}

/** Forget everything office `office` remembers about this project. Returns whether it had anything. */
export async function forgetOffice(company: Company, office: number): Promise<boolean> {
	return updateStore(memoryPath(company), emptyFile, file => {
		const key = String(office);
		const had = (file.offices[key]?.notes.length ?? 0) + (file.offices[key]?.log.length ?? 0) > 0;
		delete file.offices[key];
		return had;
	});
}
