/**
 * Offline tests for external_agent_compare: one synchronous call hands the same
 * task to several agent CLIs and returns their answers side by side.
 *
 * No real external agent is invoked. The host pi modules are stubbed via
 * registerHooks and every agent is a mock executable on PATH, so the tests
 * exercise the real dispatch path (validation, task registry, receipts, the
 * aggregated compare report) without a network or a vendor CLI.
 *
 * Run with `node --test test/compare.test.ts` on Node 22.18+ / 26.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
		if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
		return nextLoad(url, context);
	},
});

const hub = (await import("../index.ts")) as { default: (pi: unknown) => void };
moduleHooks.deregister();
const tools = new Map<string, any>();
const lifecycle = new Map<string, (event: { reason: string }) => void>();
hub.default({
	registerTool: (tool: any) => tools.set(tool.name, tool),
	registerMessageRenderer: () => {},
	on: (event: string, handler: (event: { reason: string }) => void) => lifecycle.set(event, handler),
	sendMessage: () => {},
});
afterEach(() => lifecycle.get("session_shutdown")!({ reason: "quit" }));

/**
 * Two one-shot agents, both shaped like the CLIs their adapters parse:
 *   kimi_1 -> a single compact `{type:"result",result}` line (kimi_1 family)
 *   kimi   -> OpenAI-style chat records (kimi stream-json)
 * COMPARE_MOCK_HOLD makes kimi accept its turn and never settle, which is what
 * the timeout path needs; COMPARE_MOCK_ANSWER overrides the answer text so the
 * truncation bound can be exercised.
 */
const COMPARE_MOCKS: Record<string, string> = {
	kimi_1: `#!/usr/bin/env node
const fs = require("node:fs");
const argvFile = process.env.COMPARE_MOCK_ARGV_FILE;
if (argvFile) fs.appendFileSync(argvFile, JSON.stringify({ bin: "kimi_1", argv: process.argv.slice(2) }) + "\\n");
const answer = process.env.COMPARE_MOCK_ANSWER || "CLAUDE-ANSWER";
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: answer }) + "\\n", function () { process.exit(0); });
`,
	kimi: `#!/usr/bin/env node
const fs = require("node:fs");
const argvFile = process.env.COMPARE_MOCK_ARGV_FILE;
if (argvFile) fs.appendFileSync(argvFile, JSON.stringify({ bin: "kimi", argv: process.argv.slice(2) }) + "\\n");
if (process.env.COMPARE_MOCK_HOLD === "1") {
	setInterval(function () {}, 1000);
} else {
	const answer = process.env.COMPARE_MOCK_ANSWER || "KIMI-ANSWER";
	process.stdout.write(JSON.stringify({ role: "assistant", content: answer }) + "\\n", function () { process.exit(0); });
}
`,
	// codex is driven over `codex app-server` (JSON-RPC), i.e. the persistent
	// session arm of the compare dispatch rather than the one-shot arm.
	// COMPARE_MOCK_COALESCE writes the turn/start response and both completion
	// notifications as ONE chunk, the arrival order a fast turn produces when
	// the reader is busy; the default is three writes, which usually arrive as
	// three separate reads. Both orders must settle.
	codex: `#!/usr/bin/env node
const fs = require("node:fs");
const turnFile = process.env.COMPARE_MOCK_TURN_FILE;
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function (chunk) {
	buffer += chunk;
	const lines = buffer.split("\\n");
	buffer = lines.pop();
	for (const line of lines) {
		if (!line.trim()) continue;
		let msg; try { msg = JSON.parse(line); } catch { continue; }
		if (msg.method === "initialize") {
			process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
		} else if (msg.method === "thread/start") {
			process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "thread-1" } } }) + "\\n");
		} else if (msg.method === "turn/start") {
			if (turnFile) fs.appendFileSync(turnFile, JSON.stringify(msg.params) + "\\n");
			const reply = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: "turn-1" } } }) + "\\n";
			const item = JSON.stringify({ jsonrpc: "2.0", method: "item/completed", params: { item: { type: "agentMessage", text: "CODEX-ANSWER" } } }) + "\\n";
			const done = JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { status: "completed" } } }) + "\\n";
			if (process.env.COMPARE_MOCK_COALESCE === "1") {
				process.stdout.write(reply + item + done);
			} else {
				process.stdout.write(reply);
				process.stdout.write(item);
				process.stdout.write(done);
			}
		}
	}
});
`,
};

function makeFixtureDir(files: Record<string, string>): string {
	const dir = mkdtempSync(path.join(tmpdir(), "compare-fixture-"));
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

async function call(name: string, params: Record<string, unknown>, cwd = process.cwd()): Promise<any> {
	const tool = tools.get(name);
	assert.ok(tool, `missing tool ${name}`);
	return await tool.execute("call-id", params, undefined, undefined, { cwd });
}

function compare(params: Record<string, unknown>, cwd = process.cwd()): Promise<any> {
	return call("external_agent_compare", params, cwd);
}

function mockLog(file: string): any[] {
	if (!existsSync(file)) return [];
	const text = readFileSync(file, "utf8").trim();
	return text ? text.split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

test("compare: dispatches several agents and returns one aggregated side-by-side receipt", async () => {
	const dir = makeFixtureDir(COMPARE_MOCKS);
	const restorePath = usePath(dir);
	try {
		const compared = await compare(
			{
				task: "say which module owns the task registry",
				agents: [
					{ agent: "kimi", mode: "yolo" },
					{ agent: "kimi", mode: "yolo" },
				],
			},
			dir,
		);

		const { details } = compared;
		assert.equal(details.kind, "external-agent-compare");
		assert.equal(details.timedOut, false);
		assert.equal(details.aborted, false);
		assert.equal(details.results.length, 2);

const [kimi_1, kimi_2] = details.results;
		assert.equal(kimi_1.index, 0);
		assert.equal(kimi_1.agent, "kimi");
		assert.equal(kimi_1.refused, false);
		assert.equal(kimi_1.state, "done");
		assert.equal(kimi_1.answer, "KIMI-ANSWER");
		assert.equal(kimi_1.answerTruncated, false);
		assert.equal(kimi_1.mode, "yolo");
		assert.equal(kimi_1.cwd, dir);
		assert.equal(typeof kimi_1.taskId, "string");
		assert.equal(kimi_1.dispatch.version, 1);
		assert.equal(kimi_1.dispatch.argv[kimi_1.dispatch.promptArgIndex], "say which module owns the task registry");
		assert.equal(kimi_1.dispatch.notify, "off");
		assert.equal(kimi_1.dispatch.transport, "oneshot");
		assert.equal(kimi_1.dispatch.effort.requested, undefined);
		assert.equal(kimi_1.dispatch.effort.forwarded, false);
		assert.equal(kimi_1.dispatch.argv.includes("--effort"), false);

		assert.equal(kimi_2.index, 1);
		assert.equal(kimi_2.agent, "kimi");
		assert.equal(kimi_2.refused, false);
		assert.equal(kimi_2.state, "done");
		assert.equal(kimi_2.answer, "KIMI-ANSWER");
		assert.equal(kimi_2.mode, "yolo");

		const text = compared.content[0].text;
		assert.match(text, /sync blocking call/);
		assert.match(text, /never diffs, scores or ranks/);
		assert.match(text, /summary: 2 specs · 2 dispatched · 2 done/);
		// Answers come back verbatim, in request order, with no verdict attached.
		assert.ok(text.indexOf("CLAUDE-ANSWER") !== -1 && text.indexOf("CLAUDE-ANSWER") < text.indexOf("KIMI-ANSWER"));
		assert.doesNotMatch(text, /\bidentical\b|\bdiverged?\b|\bwinner\b/);

		// Compare tasks are ordinary hub tasks: status sees them and they can be stopped.
		const status = await call("external_agent_status", { taskId: kimi.taskId });
		assert.equal(status.details.task.state, "done");
		assert.equal(status.details.task.notify, "off");
	} finally {
		await call("external_agent_stop", { all: true });
		restorePath();
	}
});

test("compare: a refused spec is recorded while the other specs still run", async () => {
	const dir = makeFixtureDir(COMPARE_MOCKS);
	const restorePath = usePath(dir);
	try {
		const compared = await compare(
			{
				task: "summarize the entry points",
				agents: [
					{ agent: "pi", mode: "readonly" },
					{ agent: "codebuddy", mode: "readonly", effort: "high" },
					{ agent: "qodercli", mode: "yolo" },
				],
			},
			dir,
		);

		const results = compared.details.results;
		assert.equal(results.length, 3);
		assert.equal(results[0].refused, true);
		assert.equal(results[0].refused, false);
		assert.equal(results[0].taskId, undefined);
		assert.equal(results[0].state, undefined);
		assert.equal(results[1].refused, true);
		assert.equal(results[1].refused, false);
		assert.match(results[1].reason, /effort.*high/);
		assert.equal(results[2].refused, false);
		assert.equal(results[2].state, "done");
		assert.equal(results[2].answer, "CLAUDE-ANSWER");

		const text = compared.content[0].text;
		assert.match(text, /summary: 3 specs · 3 dispatched · 3 done/);
		assert.match(text, /Refused: kimi is yolo-only/);
		assert.match(text, /summary: 3 specs · 2 refused · 1 dispatched · 1 done/);
	} finally {
		await call("external_agent_stop", { all: true });
		restorePath();
	}
});

test("compare: a non-readonly spec conflicts with a task already running in that directory", async () => {
	const dir = makeFixtureDir(COMPARE_MOCKS);
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ COMPARE_MOCK_HOLD: "1" });
	try {
		// A yolo task is already mutating this directory; dispatching another one
		// here is the same refusal external_agent_start would give.
		const running = await call("external_agent_start", { agent: "kimi", task: "hold the directory", mode: "yolo", cwd: dir, notify: "off" });
		assert.equal(running.details.task.state, "running");

		const compared = await compare(
			{
				task: "review the change",
				agents: [
					{ agent: "kimi", mode: "yolo" },
					{ agent: "kimi", mode: "yolo" },
				],
			},
			dir,
		);

		const [conflicted, reader] = compared.details.results;
		assert.equal(conflicted.refused, true);
		assert.match(conflicted.reason, new RegExp(`${running.details.task.taskId} is already running a yolo task in `));
		assert.equal(reader.refused, false);
		assert.equal(reader.state, "done");
		assert.equal(reader.answer, "CLAUDE-ANSWER");
	} finally {
		await call("external_agent_stop", { all: true });
		restoreEnv();
		restorePath();
	}
});

test("compare: timeout returns the settled answers plus the taskIds still running", async () => {
	const dir = makeFixtureDir(COMPARE_MOCKS);
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ COMPARE_MOCK_HOLD: "1" });
	try {
		const compared = await compare(
			{
				task: "answer slowly",
				agents: [
					{ agent: "kimi", mode: "yolo" },
					{ agent: "kimi", mode: "yolo" },
				],
				timeout: 5,
			},
			dir,
		);

		assert.equal(compared.details.kind, "external-agent-compare");
		assert.equal(compared.details.timedOut, true);
		assert.equal(compared.details.aborted, false);

		const [settled, pending] = compared.details.results;
		assert.equal(settled.state, "done");
		assert.equal(settled.answer, "CLAUDE-ANSWER");
		assert.equal(pending.state, "running");
		assert.equal(pending.answer, undefined);
		assert.equal(typeof pending.taskId, "string");

		const text = compared.content[0].text;
		assert.match(text, /deadline passed before every agent settled/i);
		assert.ok(text.includes(`Still running: ${pending.taskId}.`));
		assert.ok(text.includes(`external_agent_wait taskIds=["${pending.taskId}"]`));
		assert.match(text, /summary: 2 specs · 2 dispatched · 1 done · 1 still running/);

		// Nobody is left holding that answer, so its callback was handed back.
		const status = await call("external_agent_status", { taskId: pending.taskId });
		assert.equal(status.details.task.state, "running");
		assert.equal(status.details.task.notify, "steer");
	} finally {
		await call("external_agent_stop", { all: true });
		restoreEnv();
		restorePath();
	}
});

test("compare: the schema requires 2..8 agents and execute refuses counts outside that", async () => {
	const tool = tools.get("external_agent_compare");
	assert.ok(tool, "external_agent_compare is not registered");
	const agents = tool.parameters.properties.agents;
	assert.equal(agents.type, "array");
	assert.equal(agents.minItems, 2);
	assert.equal(agents.maxItems, 8);
	assert.equal(agents.items.properties.agent.type, "string");
	assert.deepEqual(agents.items.properties.agent.enum, ["codex", "pi", "kimi", "codebuddy", "kimi_1", "reasonix", "qoder"]);

	const single = await compare({ task: "t", agents: [{ agent: "kimi", mode: "readonly" }] });
	assert.match(single.content[0].text, /at least 2 agent specs \(got 1\)/);
	assert.deepEqual(single.details.results, []);

	const empty = await compare({ task: "t", agents: [] });
	assert.match(empty.content[0].text, /at least 2 agent specs \(got 0\)/);

	const tooMany = await compare({ task: "t", agents: Array.from({ length: 9 }, () => ({ agent: "kimi", mode: "readonly" })) });
	assert.match(tooMany.content[0].text, /at most 8 agent specs \(got 9\)/);
	assert.deepEqual(tooMany.details.results, []);
});

test("compare: omitted effort adds no flag to any spawn argv while explicit effort is forwarded", async () => {
	const dir = makeFixtureDir(COMPARE_MOCKS);
	const logFile = path.join(dir, "argv.jsonl");
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ COMPARE_MOCK_ARGV_FILE: logFile });
	try {
		await compare(
			{
				task: "t",
				agents: [
					{ agent: "kimi", mode: "yolo" },
					{ agent: "kimi", mode: "yolo" },
				],
			},
			dir,
		);
		const omitted = mockLog(logFile);
		assert.equal(omitted.length, 2);
		for (const entry of omitted) {
			assert.equal(entry.argv.includes("--effort"), false, `${entry.bin} forwarded an effort flag when none was requested`);
		}

		writeFileSync(logFile, "");
		const explicit = await compare(
			{
				task: "t",
				agents: [
					{ agent: "kimi", mode: "readonly", effort: "high" },
					{ agent: "kimi", mode: "readonly" },
				],
			},
			dir,
		);
		const forwarded = mockLog(logFile);
		const kimi_1 = forwarded.filter((entry) => entry.bin === "kimi_1");
		assert.equal(kimi_1.length, 1);
		const flagIndex = kimi_1[0].argv.indexOf("--effort");
		assert.notEqual(flagIndex, -1);
		assert.equal(kimi_1[0].argv[flagIndex + 1], "high");
		assert.equal(forwarded.filter((entry) => entry.bin === "kimi").every((entry) => !entry.argv.includes("--effort")), true);
		assert.equal(explicit.details.results[0].dispatch.effort.requested, "high");
		assert.equal(explicit.details.results[0].dispatch.effort.forwarded, true);
	} finally {
		await call("external_agent_stop", { all: true });
		restoreEnv();
		restorePath();
	}
});

test("compare: a persistent-session agent rides its session driver in the same batch as a one-shot one", async () => {
	const dir = makeFixtureDir(COMPARE_MOCKS);
	const turnFile = path.join(dir, "turn-start.jsonl");
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ COMPARE_MOCK_TURN_FILE: turnFile });
	try {
		const compared = await compare(
			{
				task: "name the transport this agent uses",
				agents: [
					{ agent: "codex", mode: "yolo", effort: "high" },
					{ agent: "kimi", mode: "readonly" },
				],
			},
			dir,
		);

		const [session, oneshot] = compared.details.results;
		assert.equal(session.agent, "codex");
		assert.equal(session.refused, false);
		assert.equal(session.state, "done");
		assert.equal(session.answer, "CODEX-ANSWER");
		// codex has a session driver, so compare used it instead of the one-shot argv.
		assert.equal(session.dispatch.transport, "persistent");
		assert.equal(session.dispatch.stdin, "jsonrpc");
		assert.equal(session.dispatch.effort.requested, "high");
		assert.equal(session.dispatch.effort.forwarded, true);
		// The explicit effort reached the protocol, and omission is still the default.
		const turnStart = mockLog(turnFile);
		assert.equal(turnStart.length, 1);
		assert.equal(turnStart[0].effort, "high");

		// Use kimi instead of kimi_1 - both are yolo by default
		// kimi_1 is now persistent like codebuddy/qoter
		assert.equal(oneshot.agent, "kimi");
		assert.equal(oneshot.state, "done");
		assert.equal(oneshot.dispatch.transport, "oneshot");
		assert.equal(oneshot.dispatch.effort.requested, undefined);

		const text = compared.content[0].text;
		assert.match(text, /summary: 2 specs · 2 dispatched · 2 done/);
	} finally {
		await call("external_agent_stop", { all: true });
		restoreEnv();
		restorePath();
	}
});

/**
 * Regression for a driver race, not a test artifact: `codex app-server` may
 * write the turn/start response and the turn's completion notifications in one
 * chunk, so the completion is read in the same synchronous batch as the
 * response — before the awaited response continuation would have marked the
 * turn active. The driver used to drop that completion, leaving the task
 * running until the batch deadline. COMPARE_MOCK_COALESCE makes that ordering
 * deterministic; the default three-write fixture only hits it ~50% of the time
 * and never when the test runs alone.
 */
test("compare: a codex turn whose completion shares the turn/start response chunk still settles", async () => {
	const dir = makeFixtureDir(COMPARE_MOCKS);
	const turnFile = path.join(dir, "turn-start.jsonl");
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ COMPARE_MOCK_TURN_FILE: turnFile, COMPARE_MOCK_COALESCE: "1" });
	try {
		const compared = await compare(
			{
				task: "name the transport this agent uses",
				agents: [
					{ agent: "codex", mode: "yolo" },
					{ agent: "kimi", mode: "readonly" },
				],
			},
			dir,
		);

		const [session, oneshot] = compared.details.results;
		assert.equal(session.refused, false);
		assert.equal(session.state, "done");
		assert.equal(session.answer, "CODEX-ANSWER");
		assert.equal(session.dispatch.transport, "persistent");
		assert.equal(oneshot.state, "done");
		assert.equal(mockLog(turnFile).length, 1);
		assert.equal(compared.details.timedOut, false);
		assert.match(compared.content[0].text, /summary: 2 specs · 2 dispatched · 2 done/);
	} finally {
		await call("external_agent_stop", { all: true });
		restoreEnv();
		restorePath();
	}
});

test("compare: long answers are trimmed to the preview bound and flagged as truncated", async () => {
	const dir = makeFixtureDir(COMPARE_MOCKS);
	const restorePath = usePath(dir);
	const long = "x".repeat(9_000);
	const restoreEnv = withEnv({ COMPARE_MOCK_ANSWER: long });
	try {
		const compared = await compare(
			{
				task: "t",
				agents: [
					{ agent: "kimi", mode: "yolo" },
					{ agent: "kimi", mode: "yolo" },
				],
			},
			dir,
		);

		const kimi_1 = compared.details.results[0];
		assert.equal(kimi_1.state, "done");
		assert.equal(kimi_1.answerTruncated, true);
		assert.ok(kimi_1.answer.length < long.length);
		assert.match(kimi_1.answer, /truncated 1000 chars/);

		const text = compared.content[0].text;
		assert.match(text, /answer truncated at 8000 chars/);
		assert.ok(text.includes(`external_agent_status taskId="${kimi_1.taskId}" has the full text`));
	} finally {
		await call("external_agent_stop", { all: true });
		restoreEnv();
		restorePath();
	}
});
