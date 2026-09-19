/**
 * The waiter claim/release contract: a wait that returns the answer replaces the
 * settle push, an aborted or timed-out wait releases it, and concurrent waits
 * settle the task exactly once.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
		if (url.startsWith("stub:")) return { source: STUBS[url.slice(5)], format: "module", shortCircuit: true };
		return nextLoad(url, context);
	},
});

const hub = (await import("../index.ts")) as { default: (pi: unknown) => void };
moduleHooks.deregister();

const tools = new Map<string, any>();
const lifecycle = new Map<string, (event?: unknown) => void>();
const pushes: string[] = [];
hub.default({
	registerTool: (tool: any) => tools.set(tool.name, tool),
	registerMessageRenderer: () => {},
	on: (event: string, handler: (event?: unknown) => void) => lifecycle.set(event, handler),
	sendMessage: (message: any) => pushes.push(String(message?.content ?? "")),
	exec: async () => ({ stdout: "VERIFY_OK", stderr: "", code: 0 }),
});

afterEach(async () => {
	await call("external_agent_stop", { all: true });
	lifecycle.get("session_shutdown")!({ reason: "quit" });
	pushes.length = 0;
});

/** Wires the settle callback, exactly like a real session start does. */
function armNotifications(): void {
	lifecycle.get("session_start")?.({});
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** A fresh repository, one commit deep (the isolate path shells out to real git). */
function makeGitRepo(): string {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "wd-repo-")));
	writeFileSync(path.join(dir, ".gitignore"), ".external-agent/\n");
	writeFileSync(path.join(dir, "README.md"), "# fixture\n");
	git(dir, "init", "-q");
	git(dir, "-c", "user.email=wd@test", "-c", "user.name=wd", "add", "-A");
	git(dir, "-c", "user.email=wd@test", "-c", "user.name=wd", "commit", "-qm", "init");
	return dir;
}

function makeFixtureDir(files: Record<string, string>): string {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "wd-fixture-")));
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

function usePath(dir: string): () => void {
	return withEnv({ PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` });
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(20);
	}
	throw new Error(`timed out waiting for ${label}`);
}

/**
 * The gate is the task text: the mock waits until a file of that name exists, so
 * the test — not the scheduler — decides when the task settles. The answer text
 * comes from WAIT_MOCK_ANSWER.
 */
const GATED_CLAUDE_MOCK = `#!/usr/bin/env node
const fs = require("node:fs");
const at = process.argv.indexOf("-p");
const gate = at === -1 ? "" : (process.argv[at + 1] || "");
if (gate) {
  const started = Date.now();
  while (!fs.existsSync(gate)) {
    if (Date.now() - started > 60000) process.exit(3);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false,
  result: process.env.WAIT_MOCK_ANSWER || "WAIT_OK", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");
process.exit(0);
`;

async function call(name: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
	const tool = tools.get(name);
	assert.ok(tool, `missing tool ${name}`);
	return await tool.execute("call-id", params, signal, undefined, { cwd: process.cwd() });
}

function resultText(result: any): string {
	return (result.content as Array<{ text: string }>).map((block) => block.text).join("\n");
}

/** Started gated: the task text is the gate file, so the caller controls the settle. */
async function startGated(gate: string, extra: Record<string, unknown> = {}): Promise<string> {
	const start = await call("external_agent_start", { agent: "claude", task: gate, mode: "readonly", ...extra });
	return start.details.task.taskId;
}

test("wait-dedup: a wait that returns the answer suppresses the settle push", async () => {
	const dir = makeFixtureDir({ claude: GATED_CLAUDE_MOCK });
	const gate = path.join(dir, "gate");
	const restorePath = usePath(dir);
	const restore = withEnv({ WAIT_MOCK_ANSWER: "DEDUP_OK" });
	armNotifications();
	try {
		const taskId = await startGated(gate, { cwd: dir });
		const waiting = call("external_agent_wait", { taskIds: [taskId], timeout: 20 });
		await sleep(150); // the wait is registered and polling now
		writeFileSync(gate, "go");
		const waited = await waiting;
		assert.match(resultText(waited), /DEDUP_OK/);
		await sleep(200);
		assert.equal(pushes.length, 0, `expected no push, got: ${pushes.join(" | ")}`);
	} finally {
		restore();
		restorePath();
	}
});

test("wait-dedup: an aborted wait releases the notice", async () => {
	const dir = makeFixtureDir({ claude: GATED_CLAUDE_MOCK });
	const gate = path.join(dir, "gate");
	const restorePath = usePath(dir);
	const restore = withEnv({ WAIT_MOCK_ANSWER: "RELEASE_OK" });
	armNotifications();
	try {
		const taskId = await startGated(gate, { cwd: dir });
		const controller = new AbortController();
		const waiting = call("external_agent_wait", { taskIds: [taskId], timeout: 20 }, controller.signal);
		await sleep(150);
		controller.abort();
		const waited = await waiting;
		assert.match(resultText(waited), /Wait aborted before the tasks settled/);
		assert.equal(pushes.length, 0);
		writeFileSync(gate, "go");
		await waitFor(() => pushes.length > 0, "settle push after an aborted wait");
		assert.equal(pushes.length, 1);
		assert.match(pushes[0], new RegExp(taskId));
		assert.match(pushes[0], /RELEASE_OK/);
	} finally {
		restore();
		restorePath();
	}
});

test("wait-dedup: a task that outlives the timeout still notifies when it settles", async () => {
	const dir = makeFixtureDir({ claude: GATED_CLAUDE_MOCK });
	const gate = path.join(dir, "gate");
	const restorePath = usePath(dir);
	const restore = withEnv({ WAIT_MOCK_ANSWER: "LATE_OK" });
	armNotifications();
	try {
		const taskId = await startGated(gate, { cwd: dir });
		const waited = await call("external_agent_wait", { taskIds: [taskId], timeout: 5 });
		assert.equal(waited.details.timedOut, true);
		assert.equal(pushes.length, 0);
		writeFileSync(gate, "go");
		await waitFor(() => pushes.length > 0, "settle push after a timed-out wait");
		assert.equal(pushes.length, 1);
		assert.match(pushes[0], /LATE_OK/);
	} finally {
		restore();
		restorePath();
	}
});

test("wait-dedup: mode any claims the settled task and leaves the running one armed", async () => {
	const dir = makeFixtureDir({ claude: GATED_CLAUDE_MOCK });
	const gateA = path.join(dir, "gate-a");
	const gateB = path.join(dir, "gate-b");
	const restorePath = usePath(dir);
	const restore = withEnv({ WAIT_MOCK_ANSWER: "ANY_OK" });
	armNotifications();
	try {
		const taskA = await startGated(gateA, { cwd: dir });
		const taskB = await startGated(gateB, { cwd: dir });
		const waiting = call("external_agent_wait", { taskIds: [taskA, taskB], mode: "any", timeout: 20 });
		await sleep(150);
		writeFileSync(gateA, "go");
		const waited = await waiting;
		assert.match(resultText(waited), /ANY_OK/);
		await sleep(300);
		assert.equal(pushes.length, 0, "the claimed task must not also be pushed");
		writeFileSync(gateB, "go");
		await waitFor(() => pushes.length > 0, "push for the still-running task");
		assert.equal(pushes.length, 1);
		assert.match(pushes[0], new RegExp(taskB));
		assert.ok(!pushes[0].includes(taskA), "the claimed task must not appear in another task's push");
	} finally {
		restore();
		restorePath();
	}
});

test("wait-dedup: concurrent waits settle the task once", async () => {
	const dir = makeFixtureDir({ claude: GATED_CLAUDE_MOCK });
	const gate = path.join(dir, "gate");
	const restorePath = usePath(dir);
	const restore = withEnv({ WAIT_MOCK_ANSWER: "SOLO_OK" });
	armNotifications();
	try {
		const taskId = await startGated(gate, { cwd: dir });
		const first = call("external_agent_wait", { taskIds: [taskId], timeout: 20 });
		const second = call("external_agent_wait", { taskIds: [taskId], timeout: 20 });
		await sleep(150);
		writeFileSync(gate, "go");
		const [one, two] = await Promise.all([first, second]);
		assert.match(resultText(one), /SOLO_OK/);
		assert.match(resultText(two), /SOLO_OK/);
		await sleep(300);
		assert.equal(pushes.length, 0, `expected no push, got: ${pushes.join(" | ")}`);
	} finally {
		restore();
		restorePath();
	}
});

test("wait-dedup: the wait report carries the verify and worktree lines the push carries", async () => {
	const repo = makeGitRepo();
	const fixture = makeFixtureDir({ claude: GATED_CLAUDE_MOCK });
	const gate = path.join(fixture, "gate");
	const restorePath = usePath(fixture);
	const restore = withEnv({ WAIT_MOCK_ANSWER: "EVIDENCE_OK" });
	armNotifications();
	try {
		const taskId = await startGated(gate, {
			cwd: repo,
			isolate: true,
			verify: { command: "npm test" },
		});
		const waiting = call("external_agent_wait", { taskIds: [taskId], timeout: 20 });
		await sleep(150);
		writeFileSync(gate, "go");
		const text = resultText(await waiting);
		assert.match(text, /EVIDENCE_OK/);
		assert.match(text, /verify: `npm test` — exit 0/);
		assert.match(text, /worktree: .*\(branch ea-/);
	} finally {
		restore();
		restorePath();
	}
});
