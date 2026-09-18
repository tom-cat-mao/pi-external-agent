/**
 * Answer archive: round-trip paging, idempotent store, summary extraction and
 * placeholder shape. Filesystem only — nothing here needs pi stubs.
 *
 * Run with `node --test test/answer-store.test.ts`.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureStored, extractSummary, lineCount, placeholderFor, readChunk, type ReadLimits } from "../artifacts.ts";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "answer-store-"));
	roots.push(root);
	return root;
}

after(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Answers big enough to page, with multibyte characters on every line. */
function buildAnswer(lineTotal: number): string {
	const lines = ["# Report", ""];
	for (let index = 0; index < lineTotal; index += 1) {
		lines.push(`line ${index}: 数据 报告 ✅ — payload ${"x".repeat(20 + (index % 7))}`);
	}
	return `${lines.join("\n")}\n`;
}

/** Page a stored answer to EOF, asserting page bookkeeping along the way. */
async function pageAll(filePath: string, limits?: ReadLimits): Promise<{ text: string; pages: number }> {
	let offset = 0;
	let text = "";
	let pages = 0;
	for (;;) {
		const page = await readChunk(filePath, offset, limits);
		pages += 1;
		assert.equal(page.bytes, Buffer.byteLength(page.text, "utf8"), "page.bytes counts the returned text");
		assert.equal(page.lines, lineCount(page.text), "page.lines counts the returned text");
		assert.ok(!page.text.includes("\uFFFD"), `page ${pages} cut through a character`);
		text += page.text;
		if (page.eof) break;
		assert.ok(page.nextOffset > offset, `page ${pages} did not advance (offset ${offset})`);
		assert.ok(pages < 10_000, "paging did not terminate");
		offset = page.nextOffset;
	}
	return { text, pages };
}

test("ensureStored writes a content-addressed copy with handle metadata", async () => {
	const root = await makeRoot();
	const text = "# Answer\n\nThe build is green.\n";
	const stored = await ensureStored(root, "task-1", 0, text);

	assert.equal(stored.sha256, sha256(text));
	assert.equal(stored.id, `ans_${stored.sha256.slice(0, 12)}`);
	assert.equal(stored.filePath, path.join(root, "answers", "task-1-turn0.md"));
	assert.equal(stored.bytes, Buffer.byteLength(text, "utf8"));
	assert.equal(stored.lines, lineCount(text));
	assert.equal(await readFile(stored.filePath, "utf8"), text);

	assert.equal((await stat(stored.filePath)).mode & 0o777, 0o600, "answer file is owner-only");
	assert.equal((await stat(path.join(root, "answers"))).mode & 0o777, 0o700, "answers dir is owner-only");
});

test("ensureStored reuses an identical copy and refuses a conflicting one", async () => {
	const root = await makeRoot();
	const text = "stable answer\n";
	const first = await ensureStored(root, "task-2", 1, text);
	const [second, concurrent] = await Promise.all([
		ensureStored(root, "task-2", 1, text),
		ensureStored(root, "task-2", 1, text),
	]);
	assert.deepEqual(second, first);
	assert.deepEqual(concurrent, first);
	assert.equal(await readFile(first.filePath, "utf8"), text);

	const conflicting = path.join(root, "answers", "task-3-turn0.md");
	await mkdir(path.dirname(conflicting), { recursive: true });
	await writeFile(conflicting, "different answer\n");
	await assert.rejects(ensureStored(root, "task-3", 0, "the answer being archived\n"), /answer archive conflict/);
	assert.equal(await readFile(conflicting, "utf8"), "different answer\n", "conflict must not overwrite");
});

test("paged reads concatenate back to the original bytes", async () => {
	const root = await makeRoot();
	const text = buildAnswer(120);
	const stored = await ensureStored(root, "task-4", 0, text);

	const defaults = await pageAll(stored.filePath);
	assert.equal(defaults.pages, 1, "default page covers a small answer");
	assert.equal(defaults.text, text);

	const small = await pageAll(stored.filePath, { maxBytes: 400, maxLines: 6 });
	assert.ok(small.pages > 1, "small limits force multiple pages");
	assert.equal(small.text, text);
	assert.equal(sha256(small.text), stored.sha256);
});

test("readChunk clamps to UTF-8 character boundaries at every budget", async () => {
	const root = await makeRoot();
	const text = "a\u00e9\u4e2d\ud83d\ude00b\u00e9\u4e2d\ud83d\ude00c\n\u4e2d\u6587\u6d4b\u8bd5\ud83c\udf89\n";
	const stored = await ensureStored(root, "task-5", 0, text);

	for (let maxBytes = 1; maxBytes <= 40; maxBytes += 1) {
		const { text: rebuilt } = await pageAll(stored.filePath, { maxBytes, maxLines: 1000 });
		assert.equal(rebuilt, text, `round trip broke at maxBytes=${maxBytes}`);
	}
});

test("readChunk honours line limits and reports EOF", async () => {
	const root = await makeRoot();
	const text = buildAnswer(40);
	const stored = await ensureStored(root, "task-6", 0, text);

	const first = await readChunk(stored.filePath, 0, { maxLines: 3, maxBytes: 64 * 1024 });
	assert.ok(first.lines <= 3, `page has ${first.lines} lines`);
	assert.ok(first.text.endsWith("\n"), "a line-limited page ends on a line boundary");
	assert.equal(first.eof, false);

	const past = await readChunk(stored.filePath, stored.bytes, {});
	assert.deepEqual({ text: past.text, bytes: past.bytes, eof: past.eof }, { text: "", bytes: 0, eof: true });
	assert.equal(past.nextOffset, stored.bytes);

	const negative = await readChunk(stored.filePath, -5, { maxLines: 3, maxBytes: 64 * 1024 });
	assert.equal(negative.text, first.text, "a negative offset reads from the start");
});

test("extractSummary returns the Summary body only when Details is present", () => {
	const templated = "# Report\n\n## Summary\n\nTwo files changed.\n\n## Details\n\n- a.ts:1\n";
	assert.equal(extractSummary(templated), "Two files changed.");

	const reversed = "## Details\n\nbody\n\n## Summary\n\nSummary first in reading order.\n";
	assert.equal(extractSummary(reversed), "Summary first in reading order.");

	const crlf = "## Summary\r\nCRLF body\r\n\r\n## Details\r\nrest\r\n";
	assert.equal(extractSummary(crlf), "CRLF body");

	const noDetails = "## Summary\nOrphan summary.\n";
	assert.equal(extractSummary(noDetails), undefined);

	const noSummary = "## Details\nOnly details.\n";
	assert.equal(extractSummary(noSummary), undefined);

	assert.equal(extractSummary("plain answer, no sections"), undefined);
	assert.equal(extractSummary("## Summary\n\n## Details\nbody\n"), "", "empty summary stays empty, not undefined");
});

test("placeholderFor inlines the summary when there is one", async () => {
	const root = await makeRoot();
	const text = buildAnswer(60);
	const stored = await ensureStored(root, "task-7", 0, text);
	const placeholder = placeholderFor({ ...stored, taskId: "task-7", text }, { summary: "Two files changed." });
	const [handle, ...rest] = placeholder.split("\n");

	assert.match(
		handle!,
		/^\[answer archived: ans_[0-9a-f]{12} \| \d+ bytes \| \d+ lines \| sha256:[0-9a-f]{8} \| recall: external_agent_status\(\{taskId: "task-7", offset\}\)\]$/,
	);
	assert.equal(handle, `[answer archived: ${stored.id} | ${stored.bytes} bytes | ${stored.lines} lines | sha256:${stored.sha256.slice(0, 8)} | recall: external_agent_status({taskId: "task-7", offset})]`);
	assert.equal(rest.join("\n"), "Two files changed.");
	assert.ok(!placeholder.includes("[...]"), "an answer with a summary needs no excerpt");
});

test("placeholderFor falls back to a head/tail excerpt", async () => {
	const root = await makeRoot();
	const text = buildAnswer(200);
	const stored = await ensureStored(root, "task-8", 0, text);
	const placeholder = placeholderFor({ ...stored, taskId: "task-8", text });
	const [handle, ...bodyParts] = placeholder.split("\n");
	const body = bodyParts.join("\n");

	assert.ok(handle!.startsWith(`[answer archived: ${stored.id} |`));
	assert.ok(body!.startsWith("# Report"), "excerpt starts at the head");
	assert.ok(body!.includes("[...]"), "excerpt marks the omission");
	assert.ok(body!.endsWith(text.trimEnd().split("\n").at(-1)!), "excerpt ends with the tail's whole last line");
	assert.ok(placeholder.length < text.length, "placeholder is smaller than the answer");

	const short = placeholderFor({ ...stored, taskId: "task-8", text: "# Short\n\nAll of it.\n" });
	assert.equal(short.split("\n").slice(1).join("\n"), "# Short\n\nAll of it.", "a short answer is quoted whole");
	assert.ok(!short.includes("[...]"));

	const bare = placeholderFor({ ...stored, taskId: "task-8" });
	assert.equal(bare, handle, "handle-only when no text is available");
	assert.equal(bare.split("\n").length, 1);
});
