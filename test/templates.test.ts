/**
 * Tests for the template module: three-tier lookup and override, the error when
 * no tier has the file, frontmatter parsing, and {{TASK}} substitution.
 *
 * Only node builtins and temp directories are involved — no pi packages, and no
 * dependence on the operator's real ~/.pi.
 * Run with `node --test test/templates.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyTemplate, loadTemplate, TASK_PLACEHOLDER } from "../src/templates.ts";

const BUILTINS = ["evidence-research", "verify-report", "review-report", "relay-envelope", "board-entry"];

function sandbox(): { projectDir: string; homeDir: string; builtinDir: string } {
	const root = mkdtempSync(path.join(tmpdir(), "pi-templates-"));
	return {
		projectDir: path.join(root, "project"),
		homeDir: path.join(root, "home"),
		builtinDir: path.join(root, "builtin"),
	};
}

/** Tier-relative path for a template file, matching the documented lookup. */
function tierFile(dirs: { projectDir: string; homeDir: string; builtinDir: string }, source: "project" | "user" | "builtin", name: string): string {
	if (source === "project") return path.join(dirs.projectDir, ".pi", "external-agent", "templates", `${name}.md`);
	if (source === "user") return path.join(dirs.homeDir, ".pi", "agent", "external-agent", "templates", `${name}.md`);
	return path.join(dirs.builtinDir, `${name}.md`);
}

function put(dirs: Parameters<typeof tierFile>[0], source: "project" | "user" | "builtin", name: string, text: string): string {
	const file = tierFile(dirs, source, name);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, text);
	return file;
}

function template(marker: string, extraFrontmatter = ""): string {
	return `---\nname: ${marker}\nversion: 1\n${extraFrontmatter}---\nHeader ${marker}.\n\nTask:\n\n${TASK_PLACEHOLDER}\n\n## Summary\nFooter ${marker}.\n`;
}

test("lookup prefers project over user over builtin", async () => {
	const dirs = sandbox();
	put(dirs, "builtin", "shared", template("builtin"));
	put(dirs, "user", "shared", template("user"));
	put(dirs, "project", "shared", template("project"));

	const top = await loadTemplate("shared", dirs);
	assert.equal(top.source, "project");
	assert.match(top.body, /Header project/);

	rmSync(path.dirname(tierFile(dirs, "project", "shared")), { recursive: true, force: true });
	const middle = await loadTemplate("shared", dirs);
	assert.equal(middle.source, "user");
	assert.match(middle.body, /Header user/);

	rmSync(path.dirname(tierFile(dirs, "user", "shared")), { recursive: true, force: true });
	const bottom = await loadTemplate("shared", dirs);
	assert.equal(bottom.source, "builtin");
	assert.match(bottom.body, /Header builtin/);
});

test("a project template shadows a different builtin of the same name", async () => {
	const dirs = sandbox();
	put(dirs, "builtin", "verify-report", template("builtin"));
	const file = put(dirs, "project", "verify-report", template("project"));

	const loaded = await loadTemplate("verify-report", dirs);
	assert.equal(loaded.source, "project");
	assert.equal(loaded.name, "project");
	assert.equal(loaded.body.includes("Header builtin"), false);
	assert.equal(file.includes(path.join(".pi", "external-agent", "templates")), true);
});

test("missing template lists every path looked in", async () => {
	const dirs = sandbox();
	await assert.rejects(() => loadTemplate("absent", dirs), (error: Error) => {
		assert.match(error.message, /template "absent" not found/);
		for (const source of ["project", "user", "builtin"] as const) {
			assert.ok(error.message.includes(tierFile(dirs, source, "absent")), `error omits ${source} path: ${error.message}`);
		}
		return true;
	});
});

test("without a projectDir only the user and builtin tiers are searched", async () => {
	const dirs = sandbox();
	await assert.rejects(() => loadTemplate("absent", { homeDir: dirs.homeDir, builtinDir: dirs.builtinDir }), (error: Error) => {
		assert.equal(error.message.includes(dirs.projectDir), false);
		assert.ok(error.message.includes(tierFile(dirs, "user", "absent")));
		assert.ok(error.message.includes(tierFile(dirs, "builtin", "absent")));
		return true;
	});
});

test("frontmatter keeps name, version and description out of the body", async () => {
	const dirs = sandbox();
	put(dirs, "builtin", "meta", `---\nname: meta\nversion: 3\ndescription: "A quoted, colon-bearing summary: yes"\n# comment\nignored: whatever\n---\n\nBody only.\n${TASK_PLACEHOLDER}\n`);

	const loaded = await loadTemplate("meta", { builtinDir: dirs.builtinDir, homeDir: dirs.homeDir });
	assert.equal(loaded.name, "meta");
	assert.equal(loaded.version, 3);
	assert.equal(loaded.description, "A quoted, colon-bearing summary: yes");
	assert.equal(loaded.body, `Body only.\n${TASK_PLACEHOLDER}`);
	assert.equal(loaded.body.includes("version"), false);
});

test("frontmatter is optional; defaults are the requested name and version 1", async () => {
	const dirs = sandbox();
	put(dirs, "builtin", "plain", `Just a header.\n\n${TASK_PLACEHOLDER}\n\n## Summary\n`);

	const loaded = await loadTemplate("plain", { builtinDir: dirs.builtinDir, homeDir: dirs.homeDir });
	assert.equal(loaded.name, "plain");
	assert.equal(loaded.version, 1);
	assert.equal(loaded.description, "");
	assert.match(loaded.body, /^Just a header\./);
});

test("broken frontmatter is reported instead of swallowed", async () => {
	const dirs = sandbox();
	put(dirs, "builtin", "unclosed", `---\nname: unclosed\n${TASK_PLACEHOLDER}\n`);
	put(dirs, "builtin", "badversion", `---\nversion: v2\n---\n${TASK_PLACEHOLDER}\n`);

	await assert.rejects(() => loadTemplate("unclosed", { builtinDir: dirs.builtinDir, homeDir: dirs.homeDir }), /never closed/);
	await assert.rejects(() => loadTemplate("badversion", { builtinDir: dirs.builtinDir, homeDir: dirs.homeDir }), /positive integer/);
});

test("template names are restricted to a safe basename", async () => {
	const dirs = sandbox();
	for (const name of ["../../etc/passwd", "a/b", ".hidden", ""]) {
		await assert.rejects(() => loadTemplate(name, dirs), /basename/);
	}
});

test("applyTemplate splits the body into header and footer around the task", () => {
	const body = `Role: reviewer.\n\nTask:\n\n${TASK_PLACEHOLDER}\n\n## Summary\nAnchor every claim.\n`;
	const rendered = applyTemplate(body, "check the parser\nfor line handling");

	assert.equal(rendered.includes(TASK_PLACEHOLDER), false);
	assert.ok(rendered.startsWith("Role: reviewer.\n\nTask:\n\n"));
	assert.ok(rendered.endsWith("\n\n## Summary\nAnchor every claim.\n"));
	const [header, footer] = [rendered.slice(0, rendered.indexOf("check the parser")), rendered.slice(rendered.indexOf("for line handling"))];
	assert.ok(header.includes("Role:"));
	assert.ok(footer.includes("Anchor every claim."));
});

test("applyTemplate demands exactly one placeholder", () => {
	assert.throws(() => applyTemplate("no placeholder here", "task"), /no \{\{TASK\}\} placeholder/);
	assert.throws(() => applyTemplate(`${TASK_PLACEHOLDER} then ${TASK_PLACEHOLDER}`, "task"), /more than one/);
});

test("the five builtins ship with frontmatter and one placeholder in the right order", async () => {
	const emptyHome = mkdtempSync(path.join(tmpdir(), "pi-templates-nohome-"));
	for (const name of BUILTINS) {
		const loaded = await loadTemplate(name, { homeDir: emptyHome });
		assert.equal(loaded.source, "builtin", `${name} should come from the package`);
		assert.equal(loaded.name, name);
		assert.equal(loaded.version, 1, `${name} frontmatter version`);
		assert.ok(loaded.description.length > 0, `${name} needs a description`);
		assert.equal([...loaded.body.matchAll(/\{\{TASK\}\}/g)].length, 1, `${name} needs exactly one placeholder`);

		const at = loaded.body.indexOf(TASK_PLACEHOLDER);
		const footer = loaded.body.slice(at + TASK_PLACEHOLDER.length);
		assert.match(footer, /^Output contract/m, `${name} footer must state the output contract`);
		assert.ok(footer.split("\n").some((line) => line.startsWith("## ") || line.includes("anchors:")), `${name} footer must end with the reply shape`);

		const rendered = applyTemplate(loaded.body, "do the thing");
		assert.ok(rendered.startsWith(loaded.body.slice(0, at).trim()), `${name} header must survive rendering`);
		assert.ok(rendered.includes("do the thing"));
	}
	rmSync(emptyHome, { recursive: true, force: true });
});
