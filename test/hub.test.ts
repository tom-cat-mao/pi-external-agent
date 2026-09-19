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

const QODER_HUB_MOCK = `#!/usr/bin/env node
const fs = require("node:fs");
const scenario = process.env.QODER_MOCK_SCENARIO ? JSON.parse(process.env.QODER_MOCK_SCENARIO) : {};
const logFile = process.env.QODER_MOCK_LOG_FILE;
function record(entry) { if (logFile) fs.appendFileSync(logFile, JSON.stringify(entry) + "\\n"); }
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
send({ type: "system", subtype: "init", protocol_version: "1.4.0", capabilities: [], commands: [],
  session_id: "sess-" + Date.now(), model: "auto", permissionMode: "bypass_permissions", qodercli_version: scenario.version === undefined ? "1.1.49" : scenario.version });
let buffer = "";
let index = 0;
const heldForSteer = new Map();
const heldForInterrupt = new Map();
function finish(turnIndex, plan) {
  for (const text of plan.chunks || []) {
    send({ type: "assistant", message: { model: "auto", content: [{ type: "text", text }] }, parent_tool_use_id: null });
  }
  const text = plan.answer !== undefined ? plan.answer : (plan.chunks || []).join(" ");
  send({ type: "result", subtype: "success", is_error: false, result: text || "OK", duration_ms: 1, duration_api_ms: 1,
    num_turns: 1, stop_reason: "end_turn", total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [],
    uuid: "r" + turnIndex, session_id: "sess-1" });
}
function runTurn() {
  const turnIndex = index++;
  const plan = (scenario.turns || [])[turnIndex] || { answer: "OK" };
  if (plan.completeOnSteer) { heldForSteer.set("s" + turnIndex, { turnIndex: turnIndex, plan: plan }); return; }
  if (plan.hold) { heldForInterrupt.set("c" + turnIndex, { turnIndex: turnIndex, plan: plan }); return; }
  finish(turnIndex, plan);
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	const lines = buffer.split("\\n");
	buffer = lines.pop();
	for (const line of lines) {
		if (!line.trim()) continue;
		let msg;
		try { msg = JSON.parse(line); } catch { continue; }
		if (msg.type === "user") {
			const parts = msg.message && Array.isArray(msg.message.content) ? msg.message.content : [];
			const text = parts.map(function (b) { return b.text || ""; }).join("");
			const steer = msg.shouldQuery === false;
			record({ kind: steer ? "steer" : "turn-input", text: text, priority: msg.priority, shouldQuery: msg.shouldQuery });
			if (steer) {
				const held = Array.from(heldForSteer.values());
				heldForSteer.clear();
				for (const entry of held) finish(entry.turnIndex, entry.plan);
			} else {
				runTurn();
			}
			continue;
		}
		if (msg.type === "control_request") {
			const subtype = msg.request && (msg.request.subtype || msg.request.type);
			record({ kind: "control-request", subtype: subtype });
			if (subtype === "interrupt") {
				send({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { still_queued: [] } } });
				const held = Array.from(heldForInterrupt.values());
				heldForInterrupt.clear();
				for (const entry of held) finish(entry.turnIndex, entry.plan);
			} else {
				send({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: "unsupported" } });
			}
			continue;
		}
	}
});
`;

const CLAUDE_ONESHOT_MOCK = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "CLAUDE_OK" }) + "\\n");
process.exit(0);
`;

function makeFixtureDir(files: Record<string, string>): string {
	const dir = mkdtempSync(path.join(tmpdir(), "hub-fixture-"));
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

async function call(name: string, params: Record<string, unknown>): Promise<any> {
	const tool = tools.get(name);
	assert.ok(tool, `missing tool ${name}`);
	return await tool.execute("call-id", params, undefined, undefined, { cwd: process.cwd() });
}

async function startQoder(dir: string, extra: Record<string, unknown> = {}): Promise<any> {
	return await call("external_agent_start", { agent: "qoder", task: "do the thing", mode: "yolo", cwd: dir, notify: "off", ...extra });
}

function mockLog(file: string): any[] {
	if (!existsSync(file)) return [];
	const text = readFileSync(file, "utf8").trim();
	return text ? text.split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

async function waitForLog(file: string, predicate: (lines: any[]) => boolean, label: string, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate(mockLog(file))) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out waiting for ${label}`);
}

test("hub: qoder start/wait/status expose a settled receipt, answer, and omitted effort", async () => {
	const dir = makeFixtureDir({ qodercli: QODER_HUB_MOCK });
	const restorePath = usePath(dir);
	const restoreScenario = withEnv({ QODER_MOCK_SCENARIO: JSON.stringify({ turns: [{ chunks: ["ANSWER-1"], answer: "ANSWER-1" }] }) });
	try {
		const started = await startQoder(dir, { mode: "readonly" });
		assert.equal(started.details.kind, "external-agent-start");
		assert.match(started.content[0].text, /Steering compatibility is pending initialization/);
		assert.doesNotMatch(started.content[0].text, /Steering is not currently available/);
		const snapshot = started.details.task;
		assert.equal(snapshot.agent, "qoder");
		assert.equal(snapshot.dispatch.effort.forwarded, false);
		assert.equal(snapshot.dispatch.effort.requested, undefined);
		assert.match(snapshot.dispatch.effort.note, /no effort override requested/i);
		const taskId = snapshot.taskId;

		const waited = await call("external_agent_wait", { taskIds: [taskId], timeout: 5 });
		assert.equal(waited.details.kind, "external-agent-wait");
		assert.match(waited.content[0].text, /ANSWER-1/);

		const status = await call("external_agent_status", { taskId });
		assert.equal(status.details.kind, "external-agent-status");
		assert.match(status.content[0].text, new RegExp(taskId));
		assert.equal(status.details.task.state, "done");
		assert.match(status.content[0].text, /external_agent_steer while running/);
		assert.doesNotMatch(status.content[0].text, /steering unavailable:/);
		assert.match(status.details.task.dispatch.effectivePolicy, /dont_ask.*disableAllHooks/);
		assert.equal(status.details.task.dispatch.stdin, "stream-json");
		assert.deepEqual(status.details.task.dispatch.argv.slice(0, 5), ["-p", "--output-format", "stream-json", "--input-format", "stream-json"]);
		assert.equal(status.details.task.dispatch.argv.includes("--acp"), false);
		assert.equal(status.details.task.dispatch.argv.includes("--reasoning-effort"), false);
	} finally {
		await call("external_agent_stop", { all: true });
		restoreScenario();
		restorePath();
	}
});

test("hub: qoder follow-up continues the settled session", async () => {
	const dir = makeFixtureDir({ qodercli: QODER_HUB_MOCK });
	const restorePath = usePath(dir);
	const restoreScenario = withEnv({
		QODER_MOCK_SCENARIO: JSON.stringify({ turns: [{ answer: "FIRST" }, { chunks: ["ignored"], answer: "SECOND" }] }),
	});
	try {
		const started = await startQoder(dir, { mode: "readonly" });
		const taskId = started.details.task.taskId;
		const first = await call("external_agent_wait", { taskIds: [taskId], timeout: 5 });
		assert.match(first.content[0].text, /FIRST/);

		const followed = await call("external_agent_follow_up", { taskId, message: "again" });
		assert.equal(followed.details.continued, true);
		assert.match(followed.content[0].text, /running again/i);

		const second = await call("external_agent_wait", { taskIds: [taskId], timeout: 5 });
		assert.match(second.content[0].text, /SECOND/);
		assert.doesNotMatch(second.content[0].text, /FIRST/);
	} finally {
		await call("external_agent_stop", { all: true });
		restoreScenario();
		restorePath();
	}
});

test("hub: qoder steer reaches the running session at the next step boundary", async () => {
	const dir = makeFixtureDir({ qodercli: QODER_HUB_MOCK });
	const restorePath = usePath(dir);
	const logFile = path.join(dir, "log.jsonl");
	const restoreScenario = withEnv({
		QODER_MOCK_SCENARIO: JSON.stringify({ turns: [{ chunks: ["WORKING"], answer: "STEERED", completeOnSteer: true }] }),
		QODER_MOCK_LOG_FILE: logFile,
	});
	try {
		const started = await startQoder(dir);
		const taskId = started.details.task.taskId;
		await waitForLog(logFile, (lines) => lines.some((entry) => entry.kind === "turn-input"), "the first turn to start");

		const steered = await call("external_agent_steer", { taskId, message: "change course" });
		assert.equal(steered.details.steered, true);
		assert.match(steered.details.note, /priority next/);

		const waited = await call("external_agent_wait", { taskIds: [taskId], timeout: 5 });
		assert.match(waited.content[0].text, /STEERED/);

		const steer = mockLog(logFile).find((entry) => entry.kind === "steer");
		assert.ok(steer, "steer reached the session");
		assert.equal(steer.priority, "next");
		assert.equal(steer.shouldQuery, false);
		assert.equal(steer.text, "change course");
	} finally {
		await call("external_agent_stop", { all: true });
		restoreScenario();
		restorePath();
	}
});

test("hub: running qoder follow-up points at the supported steer", async () => {
	const dir = makeFixtureDir({ qodercli: QODER_HUB_MOCK });
	const restorePath = usePath(dir);
	const logFile = path.join(dir, "log.jsonl");
	const restoreScenario = withEnv({
		QODER_MOCK_SCENARIO: JSON.stringify({ turns: [{ hold: true }] }),
		QODER_MOCK_LOG_FILE: logFile,
	});
	try {
		const started = await startQoder(dir);
		const taskId = started.details.task.taskId;
		await waitForLog(logFile, (lines) => lines.some((entry) => entry.kind === "turn-input"), "the first turn");
		const followed = await call("external_agent_follow_up", { taskId, message: "second question" });
		assert.equal(followed.details.continued, false);
		const text = followed.content[0].text;
		assert.match(text, /external_agent_steer/);
		assert.match(text, /still running/i);
	} finally {
		await call("external_agent_stop", { all: true });
		restoreScenario();
		restorePath();
	}
});

test("hub: old or unknown Qoder versions report steering unavailable without sending guidance", async () => {
	for (const version of ["1.0.18", null]) {
		const dir = makeFixtureDir({ qodercli: QODER_HUB_MOCK });
		const restorePath = usePath(dir);
		const logFile = path.join(dir, "log.jsonl");
		const restoreScenario = withEnv({
			QODER_MOCK_SCENARIO: JSON.stringify({ version, turns: [{ hold: true }] }),
			QODER_MOCK_LOG_FILE: logFile,
		});
		try {
			const started = await startQoder(dir);
			assert.match(started.content[0].text, /Steering compatibility is pending initialization/);
			const taskId = started.details.task.taskId;
			await waitForLog(logFile, (lines) => lines.some((entry) => entry.kind === "turn-input"), "the first turn");
			const status = await call("external_agent_status", { taskId });
			assert.match(status.content[0].text, /steering unavailable:/);
			assert.match(status.content[0].text, /1\.1\.49/);
			const steered = await call("external_agent_steer", { taskId, message: "must not reach CLI" });
			assert.equal(steered.details.steered, false);
			const followed = await call("external_agent_follow_up", { taskId, message: "not yet" });
			assert.equal(followed.details.continued, false);
			assert.doesNotMatch(followed.content[0].text, /external_agent_steer/);
			assert.equal(mockLog(logFile).filter((entry) => entry.kind === "steer").length, 0);
			assert.equal(mockLog(logFile).filter((entry) => entry.kind === "turn-input").length, 1);
		} finally {
			await call("external_agent_stop", { all: true });
			restoreScenario();
			restorePath();
		}
	}
});


test("hub: claude follow-up works over persistent session", async () => {
	// claude upgraded to yolo default with stream-json persistence like codebuddy
	const dir = makeFixtureDir({ claude: CLAUDE_ONESHOT_MOCK });
	const restorePath = usePath(dir);
	try {
		const started = await call("external_agent_start", { agent: "claude", task: "x", mode: "readonly", cwd: dir, notify: "off" });
		assert.equal(started.details.task.transport, "persistent");
		// the driver, not the CLI harness, answers can_use_tool: the receipt says so
		assert.equal(started.details.task.dispatch.readOnlyEnforcement, "driver-enforced");
		assert.match(started.content[0].text, /claude is degraded/);
	} finally {
		await call("external_agent_stop", { all: true });
		restorePath();
	}
});
test("hub: stop terminates a running qoder task", async () => {
	const dir = makeFixtureDir({ qodercli: QODER_HUB_MOCK });
	const restorePath = usePath(dir);
	const restoreScenario = withEnv({ QODER_MOCK_SCENARIO: JSON.stringify({ turns: [{ hold: true }] }) });
	try {
		const started = await startQoder(dir);
		const taskId = started.details.task.taskId;
		const stopped = await call("external_agent_stop", { taskId });
		assert.match(stopped.content[0].text, /Stopped/);
		assert.equal(stopped.details.state, "stopped");
	} finally {
		await call("external_agent_stop", { all: true });
		restoreScenario();
		restorePath();
	}
});

test("hub: unsupported qoder effort minimal is refused and explicit high is forwarded", async () => {
	const dir = makeFixtureDir({ qodercli: QODER_HUB_MOCK });
	const restorePath = usePath(dir);
	const restoreScenario = withEnv({ QODER_MOCK_SCENARIO: JSON.stringify({ turns: [{ answer: "OK" }] }) });
	try {
		const refused = await startQoder(dir, { mode: "readonly", effort: "minimal" });
		assert.equal(refused.details.refused, true);
		assert.match(refused.content[0].text, /Refused: qoder supports effort levels/);

		const forwarded = await startQoder(dir, { mode: "readonly", effort: "high" });
		assert.equal(forwarded.details.task.dispatch.effort.requested, "high");
		assert.equal(forwarded.details.task.dispatch.effort.forwarded, true);
	} finally {
		await call("external_agent_stop", { all: true });
		restoreScenario();
		restorePath();
	}
});
