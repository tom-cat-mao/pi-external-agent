import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const STUBS: Record<string, string> = {
	"@earendil-works/pi-coding-agent": `export function keyHint(key, description) { return key + " " + description; }`,
	"@earendil-works/pi-ai": `export function StringEnum(values, options) { return Object.assign({ type: "string", enum: Array.from(values) }, options || {}); }`,
	"@earendil-works/pi-tui": `export class Text { constructor(text, x, y) { this.text = text; this.x = x; this.y = y; } }`,
	typebox: `export const Type = {
		Object(properties, options) { return Object.assign({ type: "object", properties }, options || {}); },
		Optional(schema) { return schema; },
		String(options) { return Object.assign({ type: "string" }, options || {}); },
		Number(options) { return Object.assign({ type: "number" }, options || {}); },
		Boolean(options) { return Object.assign({ type: "boolean" }, options || {}); },
		Array(items, options) { return Object.assign({ type: "array", items }, options || {}); },
	};`,
};

const moduleHooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (Object.prototype.hasOwnProperty.call(STUBS, specifier)) return { url: `stub:${specifier}`, shortCircuit: true };
		return nextResolve(specifier, context);
	},
	load(url, context, nextLoad) {
		if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
		return nextLoad(url, context);
	},
});

const hub = (await import("../index.ts")) as { default: (pi: unknown) => void };
moduleHooks.deregister();

const tools = new Map<string, any>();
const lifecycle = new Map<string, (event?: unknown) => void>();
const messages: Array<{ content: string; deliverAs?: string }> = [];
hub.default({
	registerTool: (tool: any) => tools.set(tool.name, tool),
	registerMessageRenderer: () => {},
	on: (event: string, handler: (event?: unknown) => void) => lifecycle.set(event, handler),
	sendMessage: (message: any, options: any) => messages.push({ content: String(message?.content ?? ""), deliverAs: options?.deliverAs }),
});
afterEach(async () => {
	messages.length = 0;
	await call("external_agent_stop", { all: true });
	lifecycle.get("session_shutdown")!({ reason: "quit" });
});

/** Wires the settle notification callback, exactly like a real session start does. */
function armNotifications(): void {
	lifecycle.get("session_start")?.({});
}

// ---------------------------------------------------------------------------
// Fixtures: a real git repository and real git calls (the isolate path shells out)
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

const GIT_IDENTITY = ["-c", "user.email=w4@test", "-c", "user.name=w4"];

/**
 * A fresh repository, one commit deep. realpath matters: git reports the physical
 * path, and macOS temp dirs are reached through a symlink (/var -> /private/var).
 */
function makeGitRepo(): string {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "w4-repo-")));
	writeFileSync(path.join(dir, ".gitignore"), ".external-agent/\n");
	writeFileSync(path.join(dir, "README.md"), "# fixture\n");
	git(dir, "init", "-q");
	git(dir, ...GIT_IDENTITY, "add", "-A");
	git(dir, ...GIT_IDENTITY, "commit", "-qm", "init");
	return dir;
}

/** A non-repo directory holding the mock binaries for one test. */
function makeFixtureDir(files: Record<string, string>): string {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "w4-fixture-")));
	for (const [name, source] of Object.entries(files)) {
		const file = path.join(dir, name);
		writeFileSync(file, source);
		chmodSync(file, 0o755);
	}
	return dir;
}

function withEnv(values: Record<string, string>): () => void {
	const previous = new Map<string, string | undefined>();
	for (const key of Object.keys(values)) {
		previous.set(key, process.env[key]);
		process.env[key] = values[key];
	}
	return () => {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

/**
 * claude is driven over the stream-json session channel: system/init + answered
 * initialize, then one result record per user message. Both fixtures below take
 * the task out of that user message — the argv no longer carries it.
 */
const CLAUDE_SESSION_PREAMBLE = `const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
send({ type: "system", subtype: "init", session_id: "sess-1", model: "mock", permissionMode: "bypassPermissions", tools: [] });
let buffer = "";
process.stdin.setEncoding("utf8");
function handle(msg) {
	if (msg.type === "control_request") {
		send({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } });
		return;
	}
	if (msg.type !== "user" || msg.shouldQuery === false) return;
	const task = (msg.message && Array.isArray(msg.message.content) ? msg.message.content : [])
		.map(function (block) { return block.text || ""; }).join("");
`;

const CLAUDE_WRITE_MOCK = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.env.CLAUDE_MOCK_LOG_FILE) fs.appendFileSync(process.env.CLAUDE_MOCK_LOG_FILE, JSON.stringify({ cwd: process.cwd() }) + "\\n");
fs.writeFileSync("ISOLATED.txt", "worker output\\n");
${CLAUDE_SESSION_PREAMBLE}	send({ type: "result", subtype: "success", is_error: false, result: "ISOLATED_OK",
		usage: { input_tokens: 1, output_tokens: 1 } });
}
process.stdin.on("data", function (chunk) {
	buffer += chunk;
	const lines = buffer.split("\\n");
	buffer = lines.pop();
	for (const line of lines) {
		if (!line.trim()) continue;
		let msg;
		try { msg = JSON.parse(line); } catch { continue; }
		handle(msg);
	}
});
`;

/** Answers with a structured claim built from the task the session was sent. */
const CLAUDE_ECHO_MOCK = `#!/usr/bin/env node
${CLAUDE_SESSION_PREAMBLE}	const answer = "## Summary\\nclaim " + task + "\\n\\n## Details\\nsee src/index.ts:4 for " + task + "\\n";
	send({ type: "result", subtype: "success", is_error: false, result: answer,
		usage: { input_tokens: 3, output_tokens: 4 } });
}
process.stdin.on("data", function (chunk) {
	buffer += chunk;
	const lines = buffer.split("\\n");
	buffer = lines.pop();
	for (const line of lines) {
		if (!line.trim()) continue;
		let msg;
		try { msg = JSON.parse(line); } catch { continue; }
		handle(msg);
	}
});
`;

/** The exact answer text the echo mock produces for one task, after trim. */
function echoAnswer(task: string): string {
	return `## Summary\nclaim ${task}\n\n## Details\nsee src/index.ts:4 for ${task}`;
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

let sessionDir = "";

async function call(name: string, params: Record<string, unknown>): Promise<any> {
	const tool = tools.get(name);
	assert.ok(tool, `missing tool ${name}`);
	return await tool.execute("call-id", params, undefined, undefined, {
		cwd: process.cwd(),
		sessionManager: { getSessionDir: () => sessionDir },
	});
}

function resultText(result: any): string {
	return (result.content as Array<{ text: string }>).map((block) => block.text).join("\n");
}

/**
 * Blocks until the task settled and its settle-time finalize ran (archive, verify,
 * diff, notice — the notice is the last step). Polling status instead of calling
 * external_agent_wait is deliberate: a wait would claim that notice, and this file
 * asserts on it.
 */
async function settleTask(taskId: string): Promise<void> {
	const deadline = Date.now() + 20_000;
	const noticed = () =>
		messages.some((message) => message.content.includes(`External agent ${taskId} `) && message.content.includes(" done after "));
	while (Date.now() < deadline) {
		const status = await call("external_agent_status", { taskId });
		if (status.details.task.state !== "running" && noticed()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`${taskId} did not settle with a notice within 20s`);
}

// ---------------------------------------------------------------------------
// isolate
// ---------------------------------------------------------------------------

test("w4: isolate runs the worker in its own worktree and leaves the main checkout untouched", async () => {
	armNotifications();
	const repo = makeGitRepo();
	const binDir = makeFixtureDir({ claude: CLAUDE_WRITE_MOCK });
	const logFile = path.join(binDir, "cwd.jsonl");
	const restore = withEnv({ PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`, CLAUDE_MOCK_LOG_FILE: logFile });
	try {
		const started = await call("external_agent_start", {
			agent: "claude",
			task: "write ISOLATED.txt",
			mode: "write",
			cwd: repo,
			isolate: true,
		});
		const taskId = started.details.task.taskId;
		const worktreePath = path.join(repo, ".external-agent", "worktrees", taskId);
		const receipt = started.details.task.dispatch;

		assert.equal(started.details.task.cwd, worktreePath, "the task cwd is the worktree");
		assert.equal(receipt.cwd, worktreePath, "the spawn cwd is the worktree");
		assert.deepEqual(receipt.worktree, { path: worktreePath, branch: `ea-${taskId}`, base: repo });
		assert.match(resultText(started), new RegExp(`worktree: .*${taskId} \\(branch ea-${taskId}\\)`));

		await settleTask(taskId);
		assert.equal(JSON.parse(readFileSync(logFile, "utf8").trim()).cwd, worktreePath, "the child process really ran in the worktree");
		assert.equal(existsSync(path.join(worktreePath, "ISOLATED.txt")), true, "the worker's write landed in the worktree");
		assert.equal(existsSync(path.join(repo, "ISOLATED.txt")), false, "nothing was written into the main checkout");
		assert.equal(git(repo, "status", "--porcelain"), "", "the main checkout is untouched");

		// Only create, never merge and never delete: the worktree stays, on its branch.
		assert.equal(existsSync(worktreePath), true, "the worktree is retained");
		assert.match(git(repo, "worktree", "list", "--porcelain"), new RegExp(`^branch refs/heads/ea-${taskId}$`, "m"));

		const status = resultText(await call("external_agent_status", { taskId }));
		assert.match(status, new RegExp(`worktree: .*${taskId} \\(branch ea-${taskId}\\)`));
		assert.match(status, /worktree diff: no diff · 1 uncommitted\/untracked/);
		assert.match(status, /retained worktrees: ea-/);
		assert.match(resultText(await call("external_agent_status", {})), /retained worktrees: ea-/);

		// The settle notice carries the same facts, and states them without asking.
		const notice = messages.find((message) => message.content.includes(`External agent ${taskId}`));
		assert.ok(notice, "the settle notification arrived");
		assert.match(notice.content, new RegExp(`worktree: .*${taskId} \\(branch ea-${taskId}\\)`));
		assert.match(notice.content, /retained worktrees: ea-[^\s(]+\(/);
		assert.doesNotMatch(notice.content, /please|clean ?up|should|must|delete|remove/i);

		// The hub marks the runtime dir in .git/info/exclude (local, uncommitted ignore)…
		const excludePath = path.join(repo, ".git", "info", "exclude");
		const marks = () => readFileSync(excludePath, "utf8").split("\n").filter((line) => line.trim() === ".external-agent/").length;
		assert.equal(marks(), 1, "info/exclude marks .external-agent/ exactly once");

		// …and stays idempotent across later isolated dispatches.
		const again = await call("external_agent_start", {
			agent: "claude",
			task: "write AGAIN.txt",
			mode: "write",
			cwd: repo,
			isolate: true,
		});
		await settleTask(again.details.task.taskId);
		assert.equal(marks(), 1, "a second isolated task does not duplicate the mark");
	} finally {
		restore();
	}
});

test("w4: isolate refuses a cwd that is not a git repository without leaving anything behind", async () => {
	const dir = makeFixtureDir({ claude: CLAUDE_WRITE_MOCK });
	const restore = withEnv({ PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` });
	try {
		const result = await call("external_agent_start", {
			agent: "claude",
			task: "write ISOLATED.txt",
			mode: "write",
			cwd: dir,
			isolate: true,
			notify: "off",
		});
		const text = resultText(result);
		assert.match(text, /^Refused: /);
		assert.match(text, /not inside a git repository/);
		assert.equal(result.details.refused, true);
		assert.equal(existsSync(path.join(dir, ".external-agent")), false, "no half-made worktree directory");
	} finally {
		restore();
	}
});

test("w4: compare with isolate gives every slot its own worktree, so same-repo writers do not collide", async () => {
	const repo = makeGitRepo();
	const binDir = makeFixtureDir({ claude: CLAUDE_ECHO_MOCK });
	const restore = withEnv({ PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` });
	try {
		const result = await call("external_agent_compare", {
			task: "SHARED",
			agents: [
				{ agent: "claude", cwd: repo, mode: "write", task: "ALPHA_TASK" },
				{ agent: "claude", cwd: repo, mode: "write", task: "BETA_TASK" },
			],
			isolate: true,
			board: "",
			timeout: 30,
		});
		const results = result.details.results;
		assert.equal(results.filter((entry: any) => entry.refused).length, 0, "two writers in one repo were both dispatched");
		const paths = results.map((entry: any) => entry.dispatch.worktree.path);
		assert.equal(new Set(paths).size, 2, "each slot got its own worktree");
		for (const entry of results) {
			assert.equal(entry.dispatch.worktree.base, repo);
			assert.equal(entry.dispatch.worktree.branch, `ea-${entry.taskId}`);
			assert.equal(entry.dispatch.cwd, entry.dispatch.worktree.path);
			assert.equal(existsSync(entry.dispatch.worktree.path), true);
		}
		assert.equal(git(repo, "status", "--porcelain"), "", "the main checkout is untouched");
	} finally {
		restore();
	}
});

test("w4: the retained-worktree line folds past five and lists the oldest first", async () => {
	armNotifications();
	const repo = makeGitRepo();
	const worktreeRoot = path.join(repo, ".external-agent", "worktrees");
	mkdirSync(worktreeRoot, { recursive: true });
	const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
	for (const [name, age] of [["old-a", 10], ["old-b", 8], ["old-c", 6], ["old-d", 4], ["old-e", 2]] as Array<[string, number]>) {
		const dir = path.join(worktreeRoot, name);
		mkdirSync(dir);
		utimesSync(dir, daysAgo(age), daysAgo(age));
	}
	const binDir = makeFixtureDir({ claude: CLAUDE_WRITE_MOCK });
	const restore = withEnv({ PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` });
	try {
		const started = await call("external_agent_start", {
			agent: "claude",
			task: "write",
			mode: "write",
			cwd: repo,
			isolate: true,
		});
		const taskId = started.details.task.taskId;
		await settleTask(taskId);
		// Six directories exist (five hand-made plus this task's); only the oldest
		// three are named, and the fold is stated as a count.
		const status = resultText(await call("external_agent_status", { taskId }));
		assert.match(status, /retained worktrees: ea-old-a\(10d\), ea-old-b\(8d\), ea-old-c\(6d\), \+3 more/);
	} finally {
		restore();
	}
});

test("w4: a failed worktree add refuses the dispatch and never touches an already-retained worktree", async () => {
	const repo = makeGitRepo();
	// Same taskId the next dispatch will get, already occupied by a retained
	// worktree with uncommitted work: that is the one thing the hub must not delete.
	const stale = path.join(repo, ".external-agent", "worktrees", "claude-1");
	mkdirSync(stale, { recursive: true });
	writeFileSync(path.join(stale, "keep.txt"), "uncommitted work\n");
	const binDir = makeFixtureDir({ claude: CLAUDE_WRITE_MOCK });
	const restore = withEnv({ PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` });
	try {
		const result = await call("external_agent_start", {
			agent: "claude",
			task: "write",
			mode: "write",
			cwd: repo,
			isolate: true,
			notify: "off",
		});
		const text = resultText(result);
		assert.match(text, /^Refused: /);
		assert.match(text, /git worktree add failed/);
		assert.equal(result.details.refused, true);
		assert.equal(readFileSync(path.join(stale, "keep.txt"), "utf8"), "uncommitted work\n", "retained work survived the refusal");
	} finally {
		restore();
	}
});

// ---------------------------------------------------------------------------
// board
// ---------------------------------------------------------------------------

test("w4: compare appends one board row per settled slot and reports the digest", async () => {
	sessionDir = mkdtempSync(path.join(tmpdir(), "w4-session-"));
	const dir = makeFixtureDir({ claude: CLAUDE_ECHO_MOCK });
	const restore = withEnv({ PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` });
	try {
		const result = await call("external_agent_compare", {
			task: "SHARED",
			agents: [
				{ agent: "claude", cwd: dir, mode: "readonly", task: "ALPHA_TASK" },
				{ agent: "kimi", cwd: dir, mode: "readonly" },
				{ agent: "claude", cwd: dir, mode: "readonly", task: "BETA_TASK" },
			],
			timeout: 30,
		});
		const text = resultText(result);
		const boardPath = path.join(sessionDir, "external-agent", "board.jsonl");
		assert.match(text, /board: .*board\.jsonl \(\+2 entries\)/);
		assert.equal(result.details.results[1].refused, true, "the kimi slot was refused");

		const rows = readFileSync(boardPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(rows.length, 2, "one row per settled slot; the refused slot wrote none");
		const expectedKeys = ["ts", "taskId", "agent", "mode", "claim", "anchors", "answerRef", "answerSha256", "status", "supersedes"];
		for (const row of rows) {
			assert.deepEqual(Object.keys(row).sort(), [...expectedKeys].sort());
			assert.equal(row.agent, "claude");
			assert.equal(row.mode, "readonly");
			assert.equal(row.status, "unverified");
			assert.equal(row.supersedes, null);
			assert.match(row.taskId, /^claude-\d+$/);
			assert.match(row.answerRef, /^ans_[a-f0-9]{12}$/, "the structured answer was archived");
			assert.deepEqual(row.anchors, ["src/index.ts:4"]);
			assert.equal(typeof row.ts, "string");
		}
		const claims = rows.map((row) => row.claim).sort();
		assert.deepEqual(claims, ["claim ALPHA_TASK", "claim BETA_TASK"]);
		for (const row of rows) {
			const marker = row.claim.replace("claim ", "");
			assert.equal(row.answerSha256, sha256(echoAnswer(marker)), "the hash is of the answer as archived");
		}
		assert.match(text.split("\n").at(-1)!, /^board: /, "the digest is the report's last line");
	} finally {
		restore();
	}
});

test("w4: board \"\" disables the board without touching the compare result", async () => {
	sessionDir = mkdtempSync(path.join(tmpdir(), "w4-session-"));
	const dir = makeFixtureDir({ claude: CLAUDE_ECHO_MOCK });
	const restore = withEnv({ PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` });
	try {
		const result = await call("external_agent_compare", {
			task: "SHARED",
			agents: [
				{ agent: "claude", cwd: dir, mode: "readonly", task: "ALPHA_TASK" },
				{ agent: "claude", cwd: dir, mode: "readonly", task: "BETA_TASK" },
			],
			board: "",
			timeout: 30,
		});
		const text = resultText(result);
		assert.doesNotMatch(text, /board:/);
		assert.match(text, /summary: 2 specs · 2 dispatched · 2 done/);
		assert.equal(existsSync(path.join(sessionDir, "external-agent", "board.jsonl")), false, "nothing was written");
	} finally {
		restore();
	}
});

test("w4: a board write failure is reported as unavailable and never fails the compare", async () => {
	sessionDir = mkdtempSync(path.join(tmpdir(), "w4-session-"));
	const dir = makeFixtureDir({ claude: CLAUDE_ECHO_MOCK });
	const blocker = path.join(dir, "blocker.txt");
	writeFileSync(blocker, "not a directory\n");
	const restore = withEnv({ PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` });
	try {
		const result = await call("external_agent_compare", {
			task: "SHARED",
			agents: [
				{ agent: "claude", cwd: dir, mode: "readonly", task: "ALPHA_TASK" },
				{ agent: "claude", cwd: dir, mode: "readonly", task: "BETA_TASK" },
			],
			board: path.join(blocker, "board.jsonl"),
			timeout: 30,
		});
		const text = resultText(result);
		assert.match(text, /board: unavailable \(/);
		assert.match(text, /summary: 2 specs · 2 dispatched · 2 done/);
		assert.equal(result.details.results.filter((entry: any) => entry.state === "done").length, 2);
		assert.match(text.split("\n").at(-1)!, /^board: unavailable/);
	} finally {
		restore();
	}
});
