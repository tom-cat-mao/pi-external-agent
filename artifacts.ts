/**
 * Answer archive: pure filesystem + text helpers for persisting external-agent
 * answers and paging them back into the coordinator transcript.
 *
 * Two halves, both free of pi imports so they stay unit-testable:
 *   - store:   write an answer to <rootDir>/answers/<taskId>-turn<N>.md and
 *              return the handle the inline placeholder is built from.
 *   - recall:  byte-offset paging over a stored answer (readChunk), plus the
 *              summary/excerpt text that inlines when storage succeeds.
 *
 * The store is content-addressed but the path is deterministic (taskId + turn),
 * so a retry of the same turn re-reads the existing file and must agree with it
 * byte for byte; a disagreement is an error, never an overwrite. Files are
 * created 0600 inside a 0700 directory with O_EXCL|O_NOFOLLOW, so a symlink
 * planted at the target path fails the write instead of redirecting it.
 *
 * Why: .agents/notes/planned/2026-09-19-sol-pi-inspired-overhaul.md (contract 1).
 */

import { chmod, constants, mkdir, open, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

/** One archived answer: enough to render a placeholder and to recall it later. */
export interface StoredAnswer {
	/** Handle shown to the coordinator, `ans_<sha256 first 12 hex>`. */
	id: string;
	/** Absolute path of the archived file. */
	filePath: string;
	/** Size of the stored content in UTF-8 bytes. */
	bytes: number;
	/** Line count of the stored content, trailing newline not a line of its own. */
	lines: number;
	/** Full sha256 of the stored content, lowercase hex, no prefix. */
	sha256: string;
}

export interface PlaceholderOptions {
	/**
	 * Summary section to inline in place of the head/tail excerpt. The hub passes
	 * `extractSummary(text)` when the answer used the template; omission or an
	 * empty string falls back to the excerpt.
	 */
	summary?: string;
}

/** Handle metadata plus the archived text the excerpt branch is cut from. */
export interface PlaceholderMeta extends StoredAnswer {
	/** Task the answer belongs to, so the recall hint is copy-pasteable. */
	taskId: string;
	/** Answer as archived; when absent the placeholder degrades to the handle line. */
	text?: string;
}

export interface ReadLimits {
	maxBytes?: number;
	maxLines?: number;
}

export interface AnswerPage {
	/** The page, exactly as the bytes at the offset decoded — nothing dropped. */
	text: string;
	/** UTF-8 byte length of `text`. */
	bytes: number;
	/** Complete lines in `text`; a trailing newline does not open an empty line. */
	lines: number;
	/** Byte offset to resume from; equals the previous offset at EOF. */
	nextOffset: number;
	eof: boolean;
}

/** Page ceilings from the contract: ≤16KB/400 lines, with headroom held back. */
const DEFAULT_MAX_BYTES = 16 * 1024;
const DEFAULT_MAX_LINES = 400;
const BYTE_RESERVE = 512;
const LINE_RESERVE = 2;
/** Head/tail width of the no-summary placeholder, per side, in characters. */
const EXCERPT_CHARS = 500;
const OMISSION_MARK = "[...]";

/** sha256 of a string's UTF-8 bytes, lowercase hex. */
function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Line count under the repository convention: split on newlines, and a trailing
 * newline (which yields an empty tail element) does not count as its own line.
 * `"a\nb\n"` -> 2, `""` -> 0, `"\n"` -> 1.
 */
export function lineCount(text: string): number {
	const split = text.split("\n");
	if (split.length > 1 && split[split.length - 1] === "") split.pop();
	return split.length;
}

/**
 * Truncate to at most `limit` characters, then drop the trailing partial line.
 * When no newline exists in the window there is no whole line to keep, so the
 * character-clamped prefix is returned as-is.
 */
function wholeLinesAtStart(text: string, limit: number): string {
	const clipped = text.length <= limit ? text : text.slice(0, limit);
	const lastNewline = clipped.lastIndexOf("\n");
	return lastNewline === -1 ? clipped : clipped.slice(0, lastNewline + 1);
}

/** Truncate to at most `limit` characters, starting at the first whole line in the window. */
function wholeLinesAtEnd(text: string, limit: number): string {
	const clipped = text.length <= limit ? text : text.slice(text.length - limit);
	const newline = clipped.indexOf("\n");
	const wholeLines = newline === -1 ? clipped : clipped.slice(newline + 1);
	return wholeLines.replace(/\n$/, "");
}

/**
 * Head/tail excerpt used when the answer has no `## Summary` section: whole
 * lines only, ~`EXCERPT_CHARS` per side, with an explicit omission marker
 * between them. Answers short enough to fit both windows are returned whole.
 */
export function excerpt(text: string, maxChars = EXCERPT_CHARS): string {
	const trimmed = text.replace(/\s+$/, "");
	if (trimmed.length <= maxChars * 2) return trimmed;
	return `${wholeLinesAtStart(trimmed, maxChars)}\n${OMISSION_MARK}\n${wholeLinesAtEnd(trimmed, maxChars)}`;
}

/**
 * Persist one turn's answer under `<rootDir>/answers/<taskId>-turn<N>.md`.
 *
 * Creating the file is exclusive: if it already exists the stored copy is
 * compared byte for byte and reused when identical (the idempotent retry path),
 * and raises otherwise — the archive never overwrites a disagreeing answer.
 */
export async function ensureStored(rootDir: string, taskId: string, turnIndex: number, text: string): Promise<StoredAnswer> {
	const bytes = Buffer.from(text, "utf8");
	const sha256 = sha256Hex(text);
	const id = `ans_${sha256.slice(0, 12)}`;
	const dir = path.join(rootDir, "answers");
	const filePath = path.join(dir, `${taskId}-turn${turnIndex}.md`);

	await mkdir(dir, { recursive: true, mode: 0o700 });
	const existing = await writeExclusive(filePath, bytes);
	if (existing) {
		if (!existing.equals(bytes)) {
			throw new Error(`answer archive conflict at ${filePath}: stored content differs from the answer being archived`);
		}
		return { id, filePath, bytes: bytes.byteLength, lines: lineCount(text), sha256 };
	}
	await chmodBestEffort(filePath);
	return { id, filePath, bytes: bytes.byteLength, lines: lineCount(text), sha256 };
}

/**
 * O_EXCL|O_NOFOLLOW create. Returns null on success, or the bytes already at
 * the path when it pre-existed — the caller decides reuse vs. conflict.
 */
async function writeExclusive(filePath: string, bytes: Buffer): Promise<Buffer | null> {
	let handle;
	try {
		handle = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		return readFile(filePath);
	}
	try {
		await handle.writeFile(bytes);
	} finally {
		await handle.close();
	}
	return null;
}

/** umask can mask the create mode down but never up; make 0600 explicit. */
async function chmodBestEffort(filePath: string): Promise<void> {
	try {
		await chmod(filePath, 0o600);
	} catch {
		// Best effort only: the archive's job is durability, not exact mode bits.
	}
}

/**
 * Body of the `## Summary` section when the answer carries both `## Summary`
 * and `## Details`, else undefined. Section order is not required; the section
 * ends at the next `## ` heading.
 */
export function extractSummary(text: string): string | undefined {
	const summary = section(text, "## Summary");
	if (summary === undefined) return undefined;
	if (section(text, "## Details") === undefined) return undefined;
	return summary;
}

/** Body of the first `## <title>` section: heading excluded, next heading ends it, trimmed. */
function section(text: string, title: string): string | undefined {
	const heading = new RegExp(`^${title}[ \\t]*$(\\r?\\n)?`, "m").exec(text);
	if (!heading) return undefined;
	const rest = text.slice(heading.index + heading[0].length);
	const end = rest.search(/^## /m);
	return (end === -1 ? rest : rest.slice(0, end)).trim();
}

/**
 * Inline placeholder that replaces a full answer in the coordinator transcript:
 * a handle line, then either the summary or a head/tail excerpt. Recall is a
 * paging call on the existing status tool — no new tool surface.
 *
 * `meta.text` is the answer as archived; it is what the no-summary excerpt is
 * cut from, which keeps this a pure function (no filesystem read on the
 * hot path) and guarantees the placeholder quotes exactly what was stored.
 */
export function placeholderFor(meta: PlaceholderMeta, opts?: PlaceholderOptions): string {
	const handle =
		`[answer archived: ${meta.id} | ${meta.bytes} bytes | ${meta.lines} lines | ` +
		`sha256:${meta.sha256.slice(0, 8)} | recall: external_agent_status({taskId: "${meta.taskId}", offset})]`;
	const summary = opts?.summary?.trim();
	if (summary) return `${handle}\n${summary}`;
	return meta.text ? `${handle}\n${excerpt(meta.text)}` : handle;
}

/**
 * Read one page of a stored answer starting at a byte offset.
 *
 * The cut is clamped to a UTF-8 character boundary (a continuation byte at the
 * cut moves it back) and, line-count permitting, to a line boundary; EOF is
 * reported by `eof` so the caller stops paging instead of guessing at sizes.
 */
export async function readChunk(filePath: string, offset: number, limits: ReadLimits = {}): Promise<AnswerPage> {
	let start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
	const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES - BYTE_RESERVE;
	const maxLines = limits.maxLines ?? DEFAULT_MAX_LINES - LINE_RESERVE;

	const buffer = await readFile(filePath);
	if (start >= buffer.byteLength) return { text: "", bytes: 0, lines: 0, nextOffset: buffer.byteLength, eof: true };
	// A caller-supplied offset may land mid-character; snap it to the next lead byte.
	while (start < buffer.byteLength && (buffer[start] & 0xc0) === 0x80) start += 1;
	if (start >= buffer.byteLength) return { text: "", bytes: 0, lines: 0, nextOffset: buffer.byteLength, eof: true };

	const byteBudget = Math.min(Math.max(maxBytes, 1), buffer.byteLength - start);
	let cut = clampToCharacter(buffer, start + byteBudget);
	if (cut <= start) cut = charEnd(buffer, start); // budget below one character: emit it whole
	const text = buffer.toString("utf8", start, cut);
	const completeLines = lineCount(text);

	if (completeLines > maxLines) {
		const allowed = Math.max(1, maxLines);
		// Keep the nth newline so the page ends where a line does; byte count and
		// nextOffset follow the trimmed text, never the raw slice.
		let newlines = 0;
		let end = -1;
		for (let index = 0; index < text.length; index += 1) {
			if (text[index] !== "\n") continue;
			newlines += 1;
			if (newlines === allowed) {
				end = index + 1;
				break;
			}
		}
		if (end !== -1) {
			const page = text.slice(0, end);
			const bytes = Buffer.byteLength(page, "utf8");
			return { text: page, bytes, lines: lineCount(page), nextOffset: start + bytes, eof: start + bytes >= buffer.byteLength };
		}
	}

	cut = start + Buffer.byteLength(text, "utf8");
	return { text, bytes: cut - start, lines: completeLines, nextOffset: cut, eof: cut >= buffer.byteLength };
}

/**
 * Move a cut point off a multi-byte character. A continuation byte (0b10xxxxxx)
 * at the cut means the character straddles it, so step back to its lead byte.
 */
function clampToCharacter(buffer: Buffer, position: number): number {
	let index = Math.min(position, buffer.byteLength);
	if (index >= buffer.byteLength) return buffer.byteLength;
	if ((buffer[index] & 0xc0) !== 0x80) return index;
	while (index > 0 && (buffer[index] & 0xc0) === 0x80) index -= 1;
	return index;
}

/** First byte after the character starting at `position` (which must be a lead byte). */
function charEnd(buffer: Buffer, position: number): number {
	let index = position + 1;
	while (index < buffer.byteLength && (buffer[index] & 0xc0) === 0x80) index += 1;
	return index;
}
