import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SESSION_DRIVERS, type SessionDriver, type TurnOutcome } from "../src/drivers/index.ts";
import type { AgentEvent, Mode } from "../src/adapters.ts";

interface EdgeScenario {
	bootExit?: number;
	boot?: unknown[];
	turns?: unknown[][];
	steer?: unknown[];
	control?: Record<string, unknown[]>;
}

const QODER_EDGE_MOCK = `#!/usr/bin/env node
const fs = require("node:fs");
const scenario = JSON.parse(process.env.QODER_EDGE_SCENARIO || "{}");
const logFile = process.env.QODER_EDGE_LOG;
const argvFile = process.env.QODER_EDGE_ARGV;
function rec(entry) { if (logFile) fs.appendFileSync(logFile, JSON.stringify(entry) + "\\n"); }
if (argvFile) fs.appendFileSync(argvFile, JSON.stringify(process.argv.slice(2)) + "\\n");
function send(frame) {
  if (typeof frame === "string") { process.stdout.write(frame + "\\n"); return; }
  if (frame && typeof frame === "object" && typeof frame.$exit === "number") { process.exit(frame.$exit); }
  process.stdout.write(JSON.stringify(frame) + "\\n");
}
if (typeof scenario.bootExit === "number") process.exit(scenario.bootExit);
for (const frame of (scenario.boot || [{ type: "system", subtype: "init", session_id: "sess-1", capabilities: ["interrupt_cancel_queued_v1"], qodercli_version: "1.1.49" }])) send(frame);
let buffer = "";
let turnIndex = 0;
let lastSteerUuid = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function (chunk) {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg && msg.type === "user") {
      const parts = msg.message && Array.isArray(msg.message.content) ? msg.message.content : [];
      const text = parts.map(function (b) { return b.text || ""; }).join("");
      const steer = msg.shouldQuery === false;
      if (steer) lastSteerUuid = msg.uuid || "";
      rec({ kind: steer ? "steer" : "input", text: text, uuid: msg.uuid, priority: msg.priority, shouldQuery: msg.shouldQuery });
      const frames = steer ? (scenario.steer || []) : ((scenario.turns || [])[turnIndex++] || []);
      for (const frame of frames) {
        if (steer && frame && typeof frame === "object" && typeof frame.$exit !== "number") {
          send(JSON.parse(JSON.stringify(frame).split("__STEER_UUID__").join(lastSteerUuid)));
        } else send(frame);
      }
      continue;
    }
    if (msg && msg.type === "control_request") {
      const subtype = msg.request && (msg.request.subtype || msg.request.type);
      rec({ kind: "control_request", subtype: subtype, requestId: msg.request_id, request: msg.request });
      for (const frame of ((scenario.control || {})[subtype] || [])) {
        if (frame && typeof frame === "object" && typeof frame.$exit !== "number") {
          send(JSON.parse(JSON.stringify(frame).split("__REQUEST_ID__").join(msg.request_id)));
        } else send(frame);
      }
      continue;
    }
    if (msg && msg.type === "control_response") {
      rec({ kind: "control_response", response: msg.response });
      continue;
    }
  }
});
`;

const RESULT_OK = (text: string) => ({
	type: "result",
	subtype: "success",
	is_error: false,
	result: text,
	stop_reason: "end_turn",
	duration_ms: 1,
	duration_api_ms: 1,
	num_turns: 1,
	total_cost_usd: 0,
	usage: {},
	modelUsage: {},
	permission_denials: [],
	uuid: "result-uuid",
	session_id: "sess-1",
});

const PERMISSION_REQUEST = (requestId: unknown, toolUseId: string) => ({
	type: "control_request",
	request_id: requestId,
	request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" }, tool_use_id: toolUseId },
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readJsonl(file: string): any[] {
	if (!existsSync(file)) return [];
	const text = readFileSync(file, "utf8").trim();
	return text ? text.split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out waiting for ${label}`);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
	driver: SessionDriver;
	events: AgentEvent[];
	turns: TurnOutcome[];
	exits: Array<number | null>;
	logs: () => any[];
	argv: () => string[][];
}

async function spawnEdge(input: { mode: Mode; scenario?: EdgeScenario; task?: string }): Promise<Harness> {
	const dir = mkdtempSync(path.join(tmpdir(), "qoder-edge-"));
	const executable = path.join(dir, "qodercli");
	writeFileSync(executable, QODER_EDGE_MOCK);
	chmodSync(executable, 0o755);
	const logFile = path.join(dir, "log.jsonl");
	const argvFile = path.join(dir, "argv.jsonl");
	const previousPath = process.env.PATH;
	const previousScenario = process.env.QODER_EDGE_SCENARIO;
	const previousLog = process.env.QODER_EDGE_LOG;
	const previousArgv = process.env.QODER_EDGE_ARGV;
	process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ""}`;
	process.env.QODER_EDGE_SCENARIO = JSON.stringify(input.scenario ?? {});
	process.env.QODER_EDGE_LOG = logFile;
	process.env.QODER_EDGE_ARGV = argvFile;

	const driver = SESSION_DRIVERS.qoder!();
	const events: AgentEvent[] = [];
	const turns: TurnOutcome[] = [];
	const exits: Array<number | null> = [];
	driver.onEvent((event) => events.push(event));
	driver.onTurnEnd((outcome) => turns.push(outcome));
	driver.onExit((code) => exits.push(code));
	try {
		await driver.start({ task: input.task ?? "do the thing", cwd: dir, mode: input.mode });
	} catch (error) {
		driver.kill();
		throw error;
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousScenario === undefined) delete process.env.QODER_EDGE_SCENARIO;
		else process.env.QODER_EDGE_SCENARIO = previousScenario;
		if (previousLog === undefined) delete process.env.QODER_EDGE_LOG;
		else process.env.QODER_EDGE_LOG = previousLog;
		if (previousArgv === undefined) delete process.env.QODER_EDGE_ARGV;
		else process.env.QODER_EDGE_ARGV = previousArgv;
	}
	return { driver, events, turns, exits, logs: () => readJsonl(logFile), argv: () => readJsonl(argvFile) };
}

test("qoder edge: boot sends the SDK initialize control request before the first user message", async () => {
	const harness = await spawnEdge({ mode: "yolo", scenario: { turns: [[RESULT_OK("hello")]] } });
	try {
		await waitFor(() => harness.turns.length === 1, "first turn");
		const initializes = harness.logs().filter((entry) => entry.kind === "control_request" && entry.subtype === "initialize");
		assert.equal(
			initializes.length,
			1,
			"the SDK sends an initialize control_request before the first user message",
		);
	} finally {
		harness.driver.kill();
	}
});

test("qoder edge: an inbound control_request with a non-string request_id is answered instead of dropped", async () => {
	const harness = await spawnEdge({
		mode: "readonly",
		scenario: { turns: [[PERMISSION_REQUEST(42, "tu-1"), RESULT_OK("after")]] },
	});
	try {
		await waitFor(() => harness.turns.length === 1, "turn to settle");
		const answers = harness.logs().filter((entry) => entry.kind === "control_response");
		assert.equal(
			answers.length,
			1,
			"a non-string request_id is echoed back so the CLI is never left blocked on a reply it will never receive",
		);
	} finally {
		harness.driver.kill();
	}
});

test("qoder edge: the steer uuid is a UUID because the protocol keys commands by uuid", async () => {
	const harness = await spawnEdge({ mode: "yolo", scenario: { turns: [[]], steer: [RESULT_OK("steered")] } });
	try {
		await harness.driver.steer("narrow scope");
		await waitFor(() => harness.logs().filter((entry) => entry.kind === "steer").length === 1, "steer recorded");
		const steer = harness.logs().find((entry) => entry.kind === "steer");
		assert.match(
			steer.uuid ?? "",
			UUID_RE,
			"SDKUserMessage.uuid is typed UUID and command_lifecycle.command_uuid cancels by it",
		);
	} finally {
		harness.driver.kill();
	}
});

test("qoder edge: multiple steers keep send order and unique uuids", async () => {
	const harness = await spawnEdge({ mode: "yolo", scenario: { turns: [[]], steer: [RESULT_OK("steered")] } });
	try {
		await harness.driver.steer("first");
		await harness.driver.steer("second");
		await waitFor(() => harness.logs().filter((entry) => entry.kind === "steer").length === 2, "both steers recorded");
		const steers = harness.logs().filter((entry) => entry.kind === "steer");
		assert.deepEqual(steers.map((entry) => entry.text), ["first", "second"]);
		assert.equal(new Set(steers.map((entry) => entry.uuid)).size, 2);
		assert.equal(steers.every((entry) => entry.priority === "next" && entry.shouldQuery === false), true);
	} finally {
		harness.driver.kill();
	}
});

test("qoder edge: a context-only late steer joins the active turn without starting an extra model turn", async () => {
	const harness = await spawnEdge({ mode: "yolo", scenario: { turns: [[]], steer: [RESULT_OK("late result")] } });
	try {
		await waitFor(() => harness.logs().some((entry) => entry.kind === "input"), "task delivered");
		const result = await harness.driver.steer("context only");
		assert.equal(result.accepted, true);
		await waitFor(() => harness.turns.length === 1, "turn to settle");
		assert.deepEqual(harness.turns, [{ status: "done" }]);
		assert.equal(harness.logs().filter((entry) => entry.kind === "input").length, 1);
		await delay(120);
		assert.equal(harness.turns.length, 1);
		assert.equal(harness.logs().filter((entry) => entry.kind === "input").length, 1);
	} finally {
		harness.driver.kill();
	}
});

test("qoder edge: an interrupt that reports still-queued commands warns and ignores the leftover result", async () => {
	const harness = await spawnEdge({
		mode: "yolo",
		scenario: {
			turns: [[]],
			control: {
				interrupt: [
					{ type: "control_response", response: { subtype: "success", request_id: "__REQUEST_ID__", response: { still_queued: ["cmd-q"] } } },
					RESULT_OK("interrupted turn"),
					{ type: "command_lifecycle", command_uuid: "cmd-q", state: "started", uuid: "cl-1", session_id: "sess-1" },
					RESULT_OK("queued command result"),
				],
			},
		},
	});
	try {
		await waitFor(() => harness.logs().some((entry) => entry.kind === "input"), "task delivered");
		await harness.driver.cancel();
		await delay(150);
		assert.deepEqual(
			harness.turns,
			[{ status: "cancelled" }],
			"a cancelled turn is not re-settled by the leftover result of a still-queued command; the stop path reaps the session",
		);
		assert.equal(harness.events.some((event) => event.kind === "warning" && /still-queued/.test(event.text)), true);
		assert.equal(harness.events.some((event) => event.text === "queued command result"), false);
	} finally {
		harness.driver.kill();
	}
});

test("qoder edge: a discarded steer is surfaced instead of being reported as accepted", async () => {
	const harness = await spawnEdge({
		mode: "yolo",
		scenario: {
			turns: [[]],
			steer: [
				{ type: "command_lifecycle", command_uuid: "__STEER_UUID__", state: "discarded", uuid: "cl-d", session_id: "sess-1" },
				RESULT_OK("turn result"),
			],
		},
	});
	try {
		await harness.driver.steer("too late to matter");
		await waitFor(() => harness.turns.length === 1, "turn to settle");
		const surfaced = harness.events.some((event) => (event.kind === "warning" || event.kind === "error") && /discard/i.test(event.text));
		assert.equal(
			surfaced,
			true,
			"command_lifecycle state=discarded is surfaced instead of leaving the steer receipt claiming acceptance",
		);
	} finally {
		harness.driver.kill();
	}
});

test("qoder edge: an aborted/truncated assistant stream does not settle as a clean done", async () => {
	const harness = await spawnEdge({
		mode: "yolo",
		scenario: {
			turns: [
				[
					{ type: "assistant", aborted: true, message: { model: "auto", content: [{ type: "text", text: "half an ans" }] }, parent_tool_use_id: null },
					{ ...RESULT_OK(""), stop_reason: "interrupted" },
				],
			],
		},
	});
	try {
		await waitFor(() => harness.turns.length === 1, "turn to settle");
		assert.notEqual(
			harness.turns[0].status,
			"done",
			"SDKAssistantMessage.aborted does not become a clean done with an empty answer",
		);
	} finally {
		harness.driver.kill();
	}
});

test("qoder edge: a malformed result frame does not settle the turn with an empty answer", async () => {
	const harness = await spawnEdge({
		mode: "yolo",
		scenario: { turns: [[{ type: "result" }, RESULT_OK("GOOD")]] },
	});
	try {
		await waitFor(() => harness.turns.length === 1, "turn to settle");
		assert.deepEqual(
			harness.events,
			[{ kind: "message", text: "GOOD" }],
			"an incomplete result record does not settle the turn, so the real result still lands",
		);
	} finally {
		harness.driver.kill();
	}
});

test("qoder edge: junk and null frames never crash the driver and the real turn still completes", async () => {
	const harness = await spawnEdge({
		mode: "yolo",
		scenario: {
			turns: [
				[
					"{not json",
					"null",
					"[]",
					"42",
					{ type: "system", subtype: "status", status: "compacting" },
					RESULT_OK("SURVIVED"),
				],
			],
		},
	});
	try {
		await waitFor(() => harness.turns.length === 1, "turn to settle");
		assert.deepEqual(harness.turns[0], { status: "done" });
		assert.deepEqual(harness.events, [{ kind: "message", text: "SURVIVED" }]);
	} finally {
		harness.driver.kill();
	}
});

test("qoder edge: unknown inbound control request is answered with an error, never left to stall", async () => {
	const harness = await spawnEdge({
		mode: "yolo",
		scenario: {
			turns: [
				[
					{ type: "control_request", request_id: "k1", request: { subtype: "hook_callback" } },
					RESULT_OK("after unknown"),
				],
			],
		},
	});
	try {
		await waitFor(() => harness.turns.length === 1, "turn to settle");
		const answer = harness.logs().find((entry) => entry.kind === "control_response" && entry.response?.request_id === "k1");
		assert.equal(answer?.response?.subtype, "error");
		assert.equal(typeof answer?.response?.error, "string");
	} finally {
		harness.driver.kill();
	}
});

test("qoder edge: failed permission request is denied with a message in readonly and allowed in yolo", async () => {
	const readonly = await spawnEdge({
		mode: "readonly",
		scenario: { turns: [[PERMISSION_REQUEST("p1", "tu-r"), RESULT_OK("readonly done")]] },
	});
	try {
		await waitFor(() => readonly.turns.length === 1, "readonly turn");
		const answer = readonly.logs().find((entry) => entry.kind === "control_response" && entry.response?.request_id === "p1");
		assert.equal(answer?.response?.response?.behavior, "deny");
		assert.equal(typeof answer?.response?.response?.message, "string");
		assert.equal(answer?.response?.response?.toolUseID, "tu-r");
	} finally {
		readonly.driver.kill();
	}

	const yolo = await spawnEdge({
		mode: "yolo",
		scenario: { turns: [[PERMISSION_REQUEST("p2", "tu-y"), RESULT_OK("yolo done")]] },
	});
	try {
		await waitFor(() => yolo.turns.length === 1, "yolo turn");
		const answer = yolo.logs().find((entry) => entry.kind === "control_response" && entry.response?.request_id === "p2");
		assert.equal(answer?.response?.response?.behavior, "allow");
	} finally {
		yolo.driver.kill();
	}
});

test("qoder edge: partial assistant and stream_event frames are not double counted against the result", async () => {
	const harness = await spawnEdge({
		mode: "yolo",
		scenario: {
			turns: [
				[
					{ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "FIN" } }, uuid: "se-1", session_id: "sess-1" },
					{ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "AL" } }, uuid: "se-2", session_id: "sess-1" },
					{ type: "assistant", message: { model: "auto", content: [{ type: "text", text: "FINAL" }] }, parent_tool_use_id: null },
					RESULT_OK("FINAL"),
				],
			],
		},
	});
	try {
		await waitFor(() => harness.turns.length === 1, "turn to settle");
		assert.deepEqual(harness.events, [{ kind: "message", text: "FINAL" }]);
	} finally {
		harness.driver.kill();
	}
});

test("qoder edge: the interrupt request carries type interrupt and survives a missing cancel_queued capability", async () => {
	const harness = await spawnEdge({
		mode: "yolo",
		scenario: {
			turns: [[]],
			control: {
				interrupt: [
					{ type: "control_response", response: { subtype: "success", request_id: "__REQUEST_ID__", response: { still_queued: [] } } },
					RESULT_OK("interrupted"),
				],
			},
		},
	});
	try {
		await waitFor(() => harness.logs().some((entry) => entry.kind === "input"), "task delivered");
		await harness.driver.cancel();
		await waitFor(() => harness.turns.length === 1, "cancelled turn");
		const request = harness.logs().find((entry) => entry.kind === "control_request" && entry.subtype === "interrupt");
		assert.equal(request?.request?.type, "interrupt");
		assert.equal(harness.turns[0].status, "cancelled");
	} finally {
		harness.driver.kill();
	}
});

test("qoder edge: child exit mid-turn fails the turn and a later steer and follow-up are refused without new frames", async () => {
	const harness = await spawnEdge({ mode: "yolo", scenario: { turns: [[{ $exit: 7 }]] } });
	try {
		await waitFor(() => harness.turns.length === 1, "failed turn");
		assert.equal(harness.turns[0].status, "failed");
		await waitFor(() => harness.exits.length === 1, "exit callback");
		assert.equal(harness.exits[0], 7);
		const framesBefore = harness.logs().length;
		const steered = await harness.driver.steer("dead steer");
		assert.equal(steered.accepted, false);
		assert.equal(typeof (steered.accepted ? "" : steered.reason), "string");
		await assert.rejects(harness.driver.followUp("dead follow-up"));
		await delay(120);
		assert.equal(harness.logs().length, framesBefore);
	} finally {
		harness.driver.kill();
	}
});
