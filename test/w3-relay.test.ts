import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const lifecycle = new Map<string, (event: { reason: string }) => void>();
hub.default({
	registerTool: (tool: any) => tools.set(tool.name, tool),
	registerMessageRenderer: () => {},
	on: (event: string, handler: (event: { reason: string }) => void) => lifecycle.set(event, handler),
	sendMessage: () => {},
});
afterEach(async () => {
	await call("external_agent_stop", { all: true });
	lifecycle.get("session_shutdown")!({ reason: "quit" });
});

/** Persistent Qoder session mock, copied from test/hub.test.ts (same wire contract). */
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

/** One turn, then the process is gone: the session the hub can no longer reach. */
const QODER_EXIT_MOCK = `#!/usr/bin/env node
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
send({ type: "system", subtype: "init", protocol_version: "1.4.0", capabilities: [], commands: [],
  session_id: "sess-exit", model: "auto", permissionMode: "bypass_permissions", qodercli_version: "1.1.49" });
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	const lines = buffer.split("\\n");
	buffer = lines.pop();
	for (const line of lines) {
		if (!line.trim()) continue;
		let msg;
		try { msg = JSON.parse(line); } catch { continue; }
		if (msg.type === "control_request") {
			send({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } });
			continue;
		}
		if (msg.type === "user") {
			send({ type: "result", subtype: "success", is_error: false, result: "EXITED_ANSWER", duration_ms: 1,
			  duration_api_ms: 1, num_turns: 1, stop_reason: "end_turn", total_cost_usd: 0, usage: {}, modelUsage: {},
			  permission_denials: [], uuid: "r1", session_id: "sess-exit" });
			process.exit(0);
		}
	}
});
`;

const CLAUDE_MOCK = `#!/usr/bin/env node
const fs = require("node:fs");
const answer = process.env.CLAUDE_MOCK_ANSWER_FILE ? fs.readFileSync(process.env.CLAUDE_MOCK_ANSWER_FILE, "utf8") : "CLAUDE_OK";
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: answer,
  usage: { input_tokens: 12, output_tokens: 5 }, total_cost_usd: 0.01 }) + "\\n");
`;

function makeFixtureDir(files: Record<string, string>): string {
	const dir = mkdtempSync(path.join(tmpdir(), "w3-fixture-"));
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

/** A fresh archive root per test: task ids restart with the registry, and the store never overwrites. */
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

function mockLog(file: string): any[] {
	if (!existsSync(file)) return [];
	const text = readFileSync(file, "utf8").trim();
	return text ? text.split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

function steers(file: string): any[] {
	return mockLog(file).filter((entry) => entry.kind === "steer");
}

/** A steer is a write to a child's stdin; let it land before reading the log. */
async function relayedToSession(file: string, count = 1): Promise<any[]> {
	await waitUntil(`${count} relayed message(s) to reach the session`, () => steers(file).length >= count);
	return steers(file);
}

function turnInputs(file: string): any[] {
	return mockLog(file).filter((entry) => entry.kind === "turn-input");
}

async function waitUntil(label: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out waiting for ${label}`);
}

/** Block until the task's current turn is over, so the next dispatch sees a settled session. */
async function settleTask(taskId: string): Promise<void> {
	const waited = await call("external_agent_wait", { taskIds: [taskId], timeout: 20 });
	const state = waited.details.tasks[0].state;
	assert.notEqual(state, "running", `${taskId} was still running after 20s`);
}

async function startQoder(cwd: string): Promise<string> {
	const started = await call("external_agent_start", { agent: "qoder", task: `inspect ${cwd}`, mode: "readonly", cwd, notify: "off" });
	return started.details.task.taskId;
}

/** An answer long enough to archive, with one `path:line` reference on every detail line. */
function workerAnswer(marker: string): string {
	const line = `finding ${marker} src/auth/session.ts:10-12 expires without refresh\n`;
	return `## Summary\nconclusion ${marker}\n\n## Details\n${line.repeat(90)}`;
}

/** The body between the envelope's `body:` line and its `anchors:` line. */
function envelopeBody(text: string): string {
	const start = text.indexOf("body:\n");
	const end = text.indexOf("\nanchors:");
	assert.ok(start !== -1 && end > start, `no envelope body in: ${text.slice(0, 300)}`);
	return text.slice(start + "body:\n".length, end);
}

test("w3: relay injects the source answer into a running session as an envelope", async () => {
	sessionDir = mkdtempSync(path.join(tmpdir(), "w3-session-"));
	const dir = makeFixtureDir({ claude: CLAUDE_MOCK, qodercli: QODER_HUB_MOCK });
	const answerFile = path.join(dir, "answer.txt");
	writeFileSync(answerFile, workerAnswer("ALPHA"));
	const logFile = path.join(dir, "log.jsonl");
	const restore = withEnv({
		PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
		CLAUDE_MOCK_ANSWER_FILE: answerFile,
		QODER_MOCK_LOG_FILE: logFile,
		QODER_MOCK_SCENARIO: JSON.stringify({ turns: [{ hold: true }] }),
	});
	try {
		const source = await call("external_agent_start", { agent: "claude", task: "dig in", mode: "readonly", cwd: dir, notify: "off" });
		const sourceId = source.details.task.taskId;
		await settleTask(sourceId);
		const targetId = await startQoder(dir);
		await waitUntil("the target's first turn", () => turnInputs(logFile).length > 0);

		const relayed = await call("external_agent_follow_up", { taskId: targetId, message: "", fromTaskId: sourceId, purpose: "challenge" });
		assert.equal(relayed.details.relayed, true);
		assert.equal(relayed.details.via, "steer");
		assert.equal(relayed.details.hop, 1);
		assert.equal(relayed.details.purpose, "challenge");
		assert.match(String(relayed.details.archiveId), /^ans_[a-f0-9]{12}$/);
		assert.deepEqual(relayed.details.anchors, ["src/auth/session.ts:10-12"]);
		const receipt = resultText(relayed).split("\n");
		assert.equal(
			receipt[0],
			`relayed ${sourceId}→${targetId}: ${relayed.details.bytes} bytes · sha256:${relayed.details.sha256.slice(0, 8)} · via steer · hop 1`,
		);
		assert.ok(
			receipt.some((line) => line.startsWith("[answer archived:") && line.includes(`"${sourceId}"`)),
			"the archived source handle travels with the receipt",
		);
		// The receipt quotes the excerpt itself, capped, before the handle line.
		const full = resultText(relayed);
		const preview = full.slice(receipt[0].length + 1, full.indexOf("[answer archived:"));
		assert.ok(preview.includes("conclusion ALPHA"), "the coordinator sees what was sent");
		assert.ok(preview.length <= 501, `excerpt preview capped at 500 chars, got ${preview.length}`);
		assert.match(full, /keeps running, with the message injected at its next step boundary/);

		const [steer] = await relayedToSession(logFile);
		assert.ok(steer, "the envelope reached the target session");
		assert.ok(steer.text.includes("You are answering another worker"), "the envelope speaks as a peer");
		assert.ok(steer.text.includes(`from: ${sourceId}`));
		assert.ok(steer.text.includes(`to: ${targetId}`));
		assert.ok(steer.text.includes("purpose: challenge"));
		assert.ok(envelopeBody(steer.text).includes("finding ALPHA"));
		assert.ok(steer.text.includes("anchors:\n- src/auth/session.ts:10-12"));
		assert.ok(steer.text.includes("Output contract"), "the output contract reaches the worker");

		const status = await call("external_agent_status", { taskId: targetId });
		assert.match(resultText(status), /relays received: 1/);
	} finally {
		restore();
	}
});

test("w3: the receipt hash matches the bytes that arrived, and offset/length choose the window", async () => {
	sessionDir = mkdtempSync(path.join(tmpdir(), "w3-session-"));
	const dir = makeFixtureDir({ claude: CLAUDE_MOCK, qodercli: QODER_HUB_MOCK });
	const answerFile = path.join(dir, "answer.txt");
	writeFileSync(answerFile, workerAnswer("BETA"));
	const logFile = path.join(dir, "log.jsonl");
	const restore = withEnv({
		PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
		CLAUDE_MOCK_ANSWER_FILE: answerFile,
		QODER_MOCK_LOG_FILE: logFile,
		QODER_MOCK_SCENARIO: JSON.stringify({ turns: [{ hold: true }] }),
	});
	try {
		const source = await call("external_agent_start", { agent: "claude", task: "dig in", mode: "readonly", cwd: dir, notify: "off" });
		const sourceId = source.details.task.taskId;
		await settleTask(sourceId);
		const targetId = await startQoder(dir);
		await waitUntil("the target's first turn", () => turnInputs(logFile).length > 0);

		const relayed = await call("external_agent_follow_up", {
			taskId: targetId,
			message: "",
			fromTaskId: sourceId,
			offset: 200,
			length: 300,
		});
		assert.equal(relayed.details.relayed, true);
		assert.ok(relayed.details.bytes > 100 && relayed.details.bytes <= 300, `expected a ~300-byte window, got ${relayed.details.bytes}`);
		const body = envelopeBody((await relayedToSession(logFile))[0].text);
		assert.equal(createHash("sha256").update(body, "utf8").digest("hex"), relayed.details.sha256);
		assert.equal(Buffer.byteLength(body, "utf8"), relayed.details.bytes);

		// The same window is a prefix of what recall reads from that offset in the archive.
		const page = resultText(await call("external_agent_status", { taskId: sourceId, offset: 200 }));
		assert.ok(page.includes(body), "the relayed window starts where it claims to");
		assert.ok(body.length < page.length, "and stays narrower than the recall page");
	} finally {
		restore();
	}
});

test("w3: a third hop is refused instead of the workers negotiating among themselves", async () => {
	sessionDir = mkdtempSync(path.join(tmpdir(), "w3-session-"));
	const dir = makeFixtureDir({ claude: CLAUDE_MOCK, qodercli: QODER_HUB_MOCK });
	const answerFile = path.join(dir, "answer.txt");
	writeFileSync(answerFile, "ONE_SHOT_SOURCE_ANSWER");
	const restore = withEnv({
		PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
		CLAUDE_MOCK_ANSWER_FILE: answerFile,
		QODER_MOCK_SCENARIO: JSON.stringify({ turns: [{ answer: "TURN-1" }, { answer: "TURN-2" }] }),
	});
	try {
		const source = await call("external_agent_start", { agent: "claude", task: "dig in", mode: "readonly", cwd: dir, notify: "off" });
		const sourceId = source.details.task.taskId;
		await settleTask(sourceId);
		const firstId = await startQoder(dir);
		await settleTask(firstId);
		const secondId = await startQoder(dir);
		await settleTask(secondId);

		const hop1 = await call("external_agent_follow_up", { taskId: firstId, message: "", fromTaskId: sourceId });
		assert.equal(hop1.details.relayed, true);
		assert.equal(hop1.details.via, "followUp");
		assert.equal(hop1.details.hop, 1);
		assert.match(resultText(hop1), /is running again in the same session/);
		await settleTask(firstId);

		const hop2 = await call("external_agent_follow_up", { taskId: secondId, message: "", fromTaskId: firstId });
		assert.equal(hop2.details.relayed, true);
		assert.equal(hop2.details.hop, 2);
		await settleTask(secondId);

		const refused = await call("external_agent_follow_up", { taskId: firstId, message: "", fromTaskId: secondId });
		assert.equal(refused.details.relayed, false);
		assert.match(resultText(refused), /already sits 2 hops from the coordinator and the limit is 2/);
		const status = resultText(await call("external_agent_status", { taskId: firstId }));
		assert.match(status, /relays received: 1/, "the refused hop did not count as a delivery");
	} finally {
		restore();
	}
});

test("w3: relay refuses a one-shot target and a dead session rather than degrading to a new task", async () => {
	sessionDir = mkdtempSync(path.join(tmpdir(), "w3-session-"));
	const dir = makeFixtureDir({ claude: CLAUDE_MOCK, qodercli: QODER_EXIT_MOCK });
	const answerFile = path.join(dir, "answer.txt");
	writeFileSync(answerFile, "RELAY_THIS_BODY");
	const restore = withEnv({ PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`, CLAUDE_MOCK_ANSWER_FILE: answerFile });
	try {
		const source = await call("external_agent_start", { agent: "claude", task: "dig in", mode: "readonly", cwd: dir, notify: "off" });
		const sourceId = source.details.task.taskId;
		await settleTask(sourceId);

		const oneShotId = (
			await call("external_agent_start", { agent: "claude", task: "target", mode: "readonly", cwd: dir, notify: "off" })
		).details.task.taskId;
		await settleTask(oneShotId);
		const refusedOneshot = await call("external_agent_follow_up", { taskId: oneShotId, message: "", fromTaskId: sourceId });
		assert.equal(refusedOneshot.details.relayed, false);
		assert.match(resultText(refusedOneshot), /runs as a one-shot process/);

		const deadId = await startQoder(dir);
		await settleTask(deadId);
		await waitUntil("the session process to go away", async () => {
			const status = await call("external_agent_status", { taskId: deadId });
			return status.details.task.sessionAlive === false;
		});
		assert.match(resultText(await call("external_agent_status", { taskId: deadId })), /session: reclaimed/);
		const refusedDead = await call("external_agent_follow_up", { taskId: deadId, message: "", fromTaskId: sourceId });
		assert.equal(refusedDead.details.relayed, false);
		assert.match(resultText(refusedDead), /session process for .* has been reclaimed/);

		const listed = await call("external_agent_status", {});
		assert.equal(listed.details.tasks.length, 3, "no replacement task was dispatched");
	} finally {
		restore();
	}
});

test("w3: an unsettled, unknown or self source is refused without touching either session", async () => {
	sessionDir = mkdtempSync(path.join(tmpdir(), "w3-session-"));
	const dir = makeFixtureDir({ qodercli: QODER_HUB_MOCK });
	const logFile = path.join(dir, "log.jsonl");
	const restore = withEnv({
		PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
		QODER_MOCK_LOG_FILE: logFile,
		QODER_MOCK_SCENARIO: JSON.stringify({ turns: [{ hold: true }] }),
	});
	try {
		const runningId = await startQoder(dir);
		const targetId = await startQoder(dir);
		await waitUntil("both sessions to take their first turn", () => turnInputs(logFile).length >= 2);

		const unsettled = await call("external_agent_follow_up", { taskId: targetId, message: "", fromTaskId: runningId });
		assert.match(resultText(unsettled), /is still running, so it has no settled answer to relay/);
		const unknown = await call("external_agent_follow_up", { taskId: targetId, message: "", fromTaskId: "nope-1" });
		assert.match(resultText(unknown), /unknown fromTaskId "nope-1"/);
		const badPurpose = await call("external_agent_follow_up", { taskId: targetId, message: "", fromTaskId: runningId, purpose: "settle-it" });
		assert.match(resultText(badPurpose), /purpose must be reproduce, combine or challenge/);
		const self = await call("external_agent_follow_up", { taskId: targetId, message: "", fromTaskId: targetId });
		assert.match(resultText(self), /cannot relay to itself/);
		assert.equal(steers(logFile).length, 0, "a refusal never reaches a session");
		assert.deepEqual(turnInputs(logFile).map((entry) => entry.text), [`inspect ${dir}`, `inspect ${dir}`]);
	} finally {
		restore();
	}
});

test("w3: a plain follow-up still sends the caller's message verbatim and reports no relay fields", async () => {
	sessionDir = mkdtempSync(path.join(tmpdir(), "w3-session-"));
	const dir = makeFixtureDir({ qodercli: QODER_HUB_MOCK });
	const logFile = path.join(dir, "log.jsonl");
	const restore = withEnv({
		PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
		QODER_MOCK_LOG_FILE: logFile,
		QODER_MOCK_SCENARIO: JSON.stringify({ turns: [{ answer: "FIRST" }, { answer: "SECOND" }, { hold: true }] }),
	});
	try {
		const started = await call("external_agent_start", { agent: "qoder", task: "do the thing", mode: "readonly", cwd: dir, notify: "off" });
		const taskId = started.details.task.taskId;
		await settleTask(taskId);

		const followed = await call("external_agent_follow_up", { taskId, message: "again" });
		assert.equal(followed.details.continued, true);
		assert.equal(followed.details.relayed, undefined);
		assert.match(resultText(followed), /in the same session; it is running again/);
		assert.doesNotMatch(resultText(followed), /relayed/);
		await settleTask(taskId);

		const held = await call("external_agent_follow_up", { taskId, message: "third" });
		assert.equal(held.details.continued, true);
		const whileRunning = await call("external_agent_follow_up", { taskId, message: "fourth" });
		assert.equal(whileRunning.details.continued, false);
		assert.match(resultText(whileRunning), /is still running/);

		await waitUntil("the third message to reach the session", () => turnInputs(logFile).length >= 3);
		assert.deepEqual(turnInputs(logFile).map((entry) => entry.text), ["do the thing", "again", "third"]);
		assert.equal(steers(logFile).length, 0);
	} finally {
		restore();
	}
});

test("w3: an unarchived answer is selected by bytes, on character boundaries", async () => {
	sessionDir = mkdtempSync(path.join(tmpdir(), "w3-session-"));
	const dir = makeFixtureDir({ claude: CLAUDE_MOCK, qodercli: QODER_HUB_MOCK });
	const answerFile = path.join(dir, "answer.txt");
	const answer = `αααββγ ${"inline note about src/index.ts:4 holds ".repeat(6)}`;
	writeFileSync(answerFile, answer);
	const logFile = path.join(dir, "log.jsonl");
	const restore = withEnv({
		PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
		CLAUDE_MOCK_ANSWER_FILE: answerFile,
		QODER_MOCK_LOG_FILE: logFile,
		QODER_MOCK_SCENARIO: JSON.stringify({ turns: [{ hold: true }] }),
	});
	try {
		const source = await call("external_agent_start", { agent: "claude", task: "look", mode: "readonly", cwd: dir, notify: "off" });
		const sourceId = source.details.task.taskId;
		await settleTask(sourceId);
		assert.doesNotMatch(resultText(await call("external_agent_status", { taskId: sourceId })), /answer archived:/, "kept inline");
		const targetId = await startQoder(dir);
		await waitUntil("the target's first turn", () => turnInputs(logFile).length > 0);

		// Byte 3 is the tail of the second α, so a window opened there starts at byte 4 instead.
		const relayed = await call("external_agent_follow_up", {
			taskId: targetId,
			message: "ignored hint",
			fromTaskId: sourceId,
			offset: 3,
			length: 46,
		});
		assert.equal(relayed.details.relayed, true);
		assert.equal(relayed.details.archiveId, undefined);
		const body = envelopeBody((await relayedToSession(logFile))[0].text);
		assert.equal(body, Buffer.from(answer, "utf8").subarray(4, 50).toString("utf8"));
		assert.doesNotMatch(body, /\uFFFD/, "no half character crossed the wire");
		assert.deepEqual(relayed.details.anchors, ["src/index.ts:4"]);
		assert.match(resultText(relayed), /your message parameter was not sent/, "an ignored parameter is said out loud");

		const past = await call("external_agent_follow_up", { taskId: targetId, message: "", fromTaskId: sourceId, offset: 10_000 });
		assert.equal(past.details.relayed, false);
		assert.match(resultText(past), /no answer text at offset 10000/);
	} finally {
		restore();
	}
});
