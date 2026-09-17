/**
 * Enforces the repository's documentation model:
 *   - word and line budgets for AGENTS.md, docs/, postmortems, READMEs and decision notes
 *   - present-tense docs carry no history words
 *   - every decision note follows the Problem / Decision / Alternatives / Consequences template
 *   - no INDEX.md under .agents/notes
 *   - AGENTS.md relative links resolve to existing files
 *
 * Reads files relative to the repo root; imports node builtins only.
 * Run with `node --test test/docs-budget.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const NOTE_HEADINGS = ["## Problem", "## Decision", "## Alternatives considered", "## Consequences"];
const HISTORY_WORDS = /previously|no longer|renamed|used to|以前|不再|改名为/i;
const PRESENT_TENSE_DOCS = ["AGENTS.md", "docs/architecture.md", "docs/adapters.md", "docs/qoder.md"];
const LINK = /\]\(([^)]+)\)/g;
const ALT_START = /^\s*(\d+)[.)]\s+(.*)$/;

function read(rel) {
	const full = join(ROOT, rel);
	assert.ok(existsSync(full), `${rel}: required file is missing`);
	return readFileSync(full, "utf8");
}

function words(text) {
	return text.split(/\s+/).filter(Boolean).length;
}

function lines(text) {
	const split = text.split("\n");
	if (split.length > 0 && split[split.length - 1] === "") split.pop();
	return split.length;
}

/** Markdown files under dirRel, repo-relative and sorted; missing directory means empty. */
function markdownFiles(dirRel, recursive = true) {
	const dir = join(ROOT, dirRel);
	if (!existsSync(dir)) return [];
	const found = [];
	const walk = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				if (recursive) walk(full);
			} else if (entry.isFile() && entry.name.endsWith(".md")) {
				found.push(relative(ROOT, full));
			}
		}
	};
	walk(dir);
	return found.sort();
}

/** Numbered items of the "## Alternatives considered" section, continuation lines included. */
function alternativeBlocks(text) {
	const heading = text.match(/^## Alternatives considered[ \t]*$/m);
	if (!heading) return [];
	const rest = text.slice(heading.index + heading[0].length);
	const end = rest.search(/^## /m);
	const section = end === -1 ? rest : rest.slice(0, end);
	const blocks = [];
	let current = null;
	for (const line of section.split("\n")) {
		const start = line.match(ALT_START);
		if (start) {
			if (current) blocks.push(current);
			current = { label: start[1], text: start[2] };
		} else if (current) {
			current.text += `\n${line}`;
		}
	}
	if (current) blocks.push(current);
	return blocks;
}

test("documentation budgets: words and lines", () => {
	const violations = [];
	const checkWords = (rel, max) => {
		const count = words(read(rel));
		if (count > max) violations.push(`${rel}: ${count} words exceeds the ${max}-word budget`);
	};
	const checkLines = (rel, max) => {
		const count = lines(read(rel));
		if (count > max) violations.push(`${rel}: ${count} lines exceeds the ${max}-line budget`);
	};

	checkWords("AGENTS.md", 550);
	for (const rel of markdownFiles("docs", false)) checkWords(rel, 650);
	for (const rel of markdownFiles("docs/postmortem")) checkWords(rel, 800);
	for (const rel of ["README.md", "README.zh-CN.md"]) checkLines(rel, 70);
	for (const rel of markdownFiles(".agents/notes")) checkLines(rel, 120);

	assert.deepEqual(violations, [], `documentation budgets exceeded:\n${violations.join("\n")}`);
});

test("present-tense docs contain no history words", () => {
	const violations = [];
	for (const rel of PRESENT_TENSE_DOCS) {
		read(rel)
			.split("\n")
			.forEach((line, index) => {
				const match = line.match(HISTORY_WORDS);
				if (match) violations.push(`${rel}:${index + 1}: history word "${match[0]}" (belongs in a note or postmortem)`);
			});
	}
	assert.deepEqual(violations, [], `history words in present-tense docs:\n${violations.join("\n")}`);
});

test("decision notes follow the template", () => {
	const violations = [];
	for (const rel of markdownFiles(".agents/notes")) {
		const text = read(rel);
		const headings = text.split("\n").map((line) => line.replace(/\s+$/, ""));
		for (const heading of NOTE_HEADINGS) {
			if (!headings.includes(heading)) violations.push(`${rel}: missing heading "${heading}"`);
		}
		for (const block of alternativeBlocks(text)) {
			if (!block.text.includes("Strongest reason:")) {
				violations.push(`${rel}: alternative ${block.label} is missing "Strongest reason:"`);
			}
			if (!block.text.includes("Why rejected:")) {
				violations.push(`${rel}: alternative ${block.label} is missing "Why rejected:"`);
			}
		}
	}
	assert.deepEqual(violations, [], `note template violations:\n${violations.join("\n")}`);
});

test("no INDEX.md exists under .agents/notes", () => {
	const found = markdownFiles(".agents/notes").filter((rel) => basename(rel) === "INDEX.md");
	assert.deepEqual(found, [], `.agents/notes must not contain INDEX.md (the folder is the status):\n${found.join("\n")}`);
});

test("AGENTS.md relative links resolve to existing files", () => {
	const targets = [...read("AGENTS.md").matchAll(LINK)].map((match) => match[1].trim());
	const broken = [];
	for (const target of targets) {
		if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue; // external URL or in-page anchor
		const path = target.split("#")[0].split("?")[0];
		if (!path) continue;
		if (!existsSync(join(ROOT, path))) broken.push(`AGENTS.md: link target does not exist: ${target}`);
	}
	assert.deepEqual(broken, [], `broken relative links in AGENTS.md:\n${broken.join("\n")}`);
});
