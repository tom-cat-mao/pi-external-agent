import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SESSION_DRIVERS, type SessionDriver, type TurnOutcome } from "../sessions.ts";
import type { AgentEvent, Effort, Mode } from "../adapters.ts";

interface MockTurn {
	/** Assistant text records. The driver must NOT surface these as the answer. */
	chunks?: string[];
	/** Explicit `result.result`; defaults to the joined chunks. */
	answer?: string;
	result?: "success" | "error";
	errors?: string[];
	/** Kill the process before any result is written. */
	exitBeforeResult?: number;
	/** Hold the turn open until a steer arrives (models step-boundary injection). */
	completeOnSteer?: boolean;
	/** Hold the turn open until the driver interrupts it. */
	hold?: boolean;
	/** Ask the host to approve a tool before finishing. */
	askPermission?: boolean;
	toolName?: string;
}

interface MockScenario {
	exitBeforeInit?: number;
	turns?: MockTurn[];
}

const QODER_STREAM_MOCK = `#!/usr/bin/env node
const fs = require("node:fs");
const scenario = process.env.QODER_MOCK_SCENARIO ? JSON.parse(process.env.QODER_MOCK_SCENARIO) : {};
const argvFile = process.env.QODER_MOCK_ARGV_FILE;
const logFile = process.env.QODER_MOCK_LOG_FILE;
function record(entry) { if (logFile) fs.appendFileSync(logFile, JSON.stringify(entry) + "\\n"); }
if (argvFile) fs.appendFileSync(argvFile, JSON.stringify(process.argv.slice(2)) + "\\n");
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
function finish(index, plan) {
  for (const chunk of plan.chunks || []) {
    send({ type: "assistant", message: { model: "auto", content: [{ type: "text", text: chunk }] }, parent_tool_use_id: null });
  }
  const base = { type: "result", duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1,
    stop_reason: "end_turn", total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [],
    uuid: "result-" + index, session_id: "sess-1" };
  if (plan.result === "error") {
    send(Object.assign(base, { subtype: "error_during_execution", is_error: true, errors: plan.errors || ["qoder boom"] }));
  } else {
    const text = plan.answer !== undefined ? plan.answer : (plan.chunks || []).join(" ");
    send(Object.assign(base, { subtype: "success", result: text || "OK" }));
  }
  record({ kind: "result-sent", index: index });
}
if (scenario.exitBeforeInit !== undefined) process.exit(scenario.exitBeforeInit);
send({ type: "system", subtype: "init", protocol_version: "1.4.0", capabilities: [],
  commands: [], session_id: "sess-1", model: "auto", permissionMode: "bypass_permissions" });
let buffer = "";
let turnIndex = 0;
const heldForSteer = new Map();
const heldForInterrupt = new Map();
const heldForPermission = new Map();
function runTurn() {
  const index = turnIndex++;
  const plan = (scenario.turns || [])[index] || { answer: "OK" };
  record({ kind: "turn-started", index: index });
  if (plan.exitBeforeResult !== undefined) { process.exit(plan.exitBeforeResult); return; }
  if (plan.completeOnSteer) { heldForSteer.set("s" + index, { index: index, plan: plan }); return; }
  if (plan.hold) { heldForInterrupt.set("c" + index, { index: index, plan: plan }); return; }
  if (plan.askPermission) {
    heldForPermission.set("p" + index, { index: index, plan: plan });
    send({ type: "control_request", request_id: "p" + index,
      request: { subtype: "can_use_tool", tool_name: plan.toolName || "Bash", input: {}, tool_use_id: "tu-" + index } });
    return;
  }
  finish(index, plan);
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", function (chunk) {
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
      record({ kind: steer ? "steer" : "turn-input", text: text, priority: msg.priority,
        shouldQuery: msg.shouldQuery, uuid: msg.uuid });
      if (steer) {
        const held = Array.from(heldForSteer.values());
        heldForSteer.clear();
        for (const entry of held) finish(entry.index, entry.plan);
      } else {
        runTurn();
      }
      continue;
    }
    if (msg.type === "control_request") {
      const subtype = msg.request && (msg.request.subtype || msg.request.type);
      record({ kind: "control-request", subtype: subtype, requestId: msg.request_id });
      if (subtype === "interrupt") {
        send({ type: "control_response", response: { subtype: "success", request_id: msg.request_id,
          response: { still_queued: [] } } });
        const held = Array.from(heldForInterrupt.values());
        heldForInterrupt.clear();
        for (const entry of held) finish(entry.index, entry.plan);
      } else {
        send({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: "unsupported" } });
      }
      continue;
    }
    if (msg.type === "control_response") {
      const response = msg.response || {};
      record({ kind: "control-response", requestId: response.request_id, response: response.response, error: response.error });
      const entry = heldForPermission.get(response.request_id);
      if (entry) { heldForPermission.delete(response.request_id); finish(entry.index, entry.plan); }
      continue;
    }
  }
});
`;

function readJsonl(file: string): any[] {
	if (!existsSync(file)) return [];
	const text = readFileSync(file, "utf8").trim();
	return text ? text.split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out waiting for ${label}`);
}

interface Harness {
	driver: SessionDriver;
	events: AgentEvent[];
	turns: TurnOutcome[];
	exits: Array<number | null>;
	dir: string;
	argv: () => string[][];
	logs: () => any[];
}

async function spawnQoder(input: {
	mode: Mode;
	model?: string;
	effort?: Effort;
	task?: string;
	scenario?: MockScenario;
}): Promise<Harness> {
	const dir = mkdtempSync(path.join(tmpdir(), "qoder-session-"));
	const executable = path.join(dir, "qodercli");
	writeFileSync(executable, QODER_STREAM_MOCK);
	chmodSync(executable, 0o755);
	const argvFile = path.join(dir, "argv.jsonl");
	const logFile = path.join(dir, "log.jsonl");
	const previousPath = process.env.PATH;
	const previousScenario = process.env.QODER_MOCK_SCENARIO;
	const previousArgv = process.env.QODER_MOCK_ARGV_FILE;
	const previousLog = process.env.QODER_MOCK_LOG_FILE;
	process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ""}`;
	process.env.QODER_MOCK_SCENARIO = JSON.stringify(input.scenario ?? {});
	process.env.QODER_MOCK_ARGV_FILE = argvFile;
	process.env.QODER_MOCK_LOG_FILE = logFile;

	const driver = SESSION_DRIVERS.qoder!();
	const events: AgentEvent[] = [];
	const turns: TurnOutcome[] = [];
	const exits: Array<number | null> = [];
	driver.onEvent((event) => events.push(event));
	driver.onTurnEnd((outcome) => turns.push(outcome));
	driver.onExit((code) => exits.push(code));
	try {
		await driver.start({
			task: input.task ?? "do the thing",
			cwd: dir,
			mode: input.mode,
			model: input.model,
			effort: input.effort,
		});
	} catch (error) {
		driver.kill();
		throw error;
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousScenario === undefined) delete process.env.QODER_MOCK_SCENARIO;
		else process.env.QODER_MOCK_SCENARIO = previousScenario;
		if (previousArgv === undefined) delete process.env.QODER_MOCK_ARGV_FILE;
		else process.env.QODER_MOCK_ARGV_FILE = previousArgv;
		if (previousLog === undefined) delete process.env.QODER_MOCK_LOG_FILE;
		else process.env.QODER_MOCK_LOG_FILE = previousLog;
	}
	return { driver, events, turns, exits, dir, argv: () => readJsonl(argvFile), logs: () => readJsonl(logFile) };
}

test("qoder stream-json: init handshake, one result per turn, answer not duplicated from assistant text", async () => {
	const harness = await spawnQoder({
		mode: "yolo",
		scenario: {
			// The assistant records repeat the answer on purpose: the parser must
			// take the turn's answer from `result` only, or every turn doubles.
			turns: [{ chunks: ["PONG", "PONG"], answer: "PONG" }],
		},
	});
	try {
		await waitFor(() => harness.turns.length === 1, "first turn");
		assert.deepEqual(harness.turns[0], { status: "done" });
		assert.deepEqual(harness.events, [{ kind: "message", text: "PONG" }]);
		const inputs = harness.logs().filter((entry) => entry.kind === "turn-input");
		assert.equal(inputs.length, 1);
		assert.equal(inputs[0].text, "do the thing");
		assert.equal(inputs[0].priority, undefined);
		assert.equal(inputs[0].shouldQuery, undefined);
		assert.match(inputs[0].uuid ?? "", /^pi-/);
	} finally {
		harness.driver.kill();
	}
});

test("qoder stream-json: follow-up continues the session with an isolated answer", async () => {
	const harness = await spawnQoder({
		mode: "yolo",
		scenario: { turns: [{ answer: "PONG" }, { chunks: ["noise"], answer: "PONG-2" }] },
	});
	try {
		await waitFor(() => harness.turns.length === 1, "first turn");
		const afterFirst = harness.events.length;
		await harness.driver.followUp("second question");
		await waitFor(() => harness.turns.length === 2, "second turn");
		assert.deepEqual(harness.turns[1], { status: "done" });
		assert.deepEqual(harness.events.slice(afterFirst), [{ kind: "message", text: "PONG-2" }]);
		const inputs = harness.logs().filter((entry) => entry.kind === "turn-input");
		assert.equal(inputs.length, 2);
		assert.equal(inputs[1].text, "second question");
	} finally {
		harness.driver.kill();
	}
});

test("qoder stream-json: steer uses priority next + shouldQuery false, joins the active turn, and settles it once", async () => {
	const harness = await spawnQoder({
		mode: "yolo",
		scenario: {
			// The turn only ends after the steer lands: this is the documented
			// step-boundary injection, not an interrupt and not a new turn.
			turns: [{ chunks: ["working"], answer: "steered result", completeOnSteer: true }],
		},
	});
	try {
		await waitFor(() => harness.logs().some((entry) => entry.kind === "turn-started"), "turn to start");
		assert.deepEqual(harness.turns, []);
		const result = await harness.driver.steer("narrow the scope");
		assert.equal(result.accepted, true);
		await waitFor(() => harness.turns.length === 1, "steered turn to settle");
		assert.deepEqual(harness.turns[0], { status: "done" });

		const steers = harness.logs().filter((entry) => entry.kind === "steer");
		assert.equal(steers.length, 1);
		assert.equal(steers[0].text, "narrow the scope");
		assert.equal(steers[0].priority, "next");
		assert.equal(steers[0].shouldQuery, false);

		// Exactly one turn started and one result produced: the steer never
		// became an independent turn, so nothing can settle early or arrive late.
		assert.equal(harness.logs().filter((entry) => entry.kind === "turn-started").length, 1);
		assert.equal(harness.logs().filter((entry) => entry.kind === "result-sent").length, 1);
		assert.deepEqual(harness.events, [{ kind: "message", text: "steered result" }]);

		await waitFor(() => harness.logs().length > 0, "log flush");
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(harness.turns.length, 1);
	} finally {
		harness.driver.kill();
	}
});

test("qoder stream-json: steer is refused once the turn has settled", async () => {
	const harness = await spawnQoder({ mode: "yolo", scenario: { turns: [{ answer: "done" }] } });
	try {
		await waitFor(() => harness.turns.length === 1, "turn to settle");
		const result = await harness.driver.steer("too late");
		assert.equal(result.accepted, false);
		assert.match(result.accepted ? "" : result.reason, /no turn is currently running/);
	} finally {
		harness.driver.kill();
	}
});

test("qoder stream-json: result error fails the turn and surfaces an error event", async () => {
	const harness = await spawnQoder({
		mode: "yolo",
		scenario: { turns: [{ result: "error", errors: ["Qoder API error: FORBIDDEN"] }] },
	});
	try {
		await waitFor(() => harness.turns.length === 1, "error turn");
		assert.equal(harness.turns[0].status, "failed");
		assert.match(harness.turns[0].error ?? "", /FORBIDDEN/);
		assert.equal(harness.events.some((event) => event.kind === "error" && /FORBIDDEN/.test(event.text)), true);
	} finally {
		harness.driver.kill();
	}
});

test("qoder stream-json: a process that dies before the init handshake makes start() fail", async () => {
	await assert.rejects(
		spawnQoder({ mode: "yolo", scenario: { exitBeforeInit: 3 } }),
		/init handshake|exited/,
	);
});

test("qoder stream-json: mid-turn process exit fails the turn and reports the exit code", async () => {
	const harness = await spawnQoder({ mode: "yolo", scenario: { turns: [{ exitBeforeResult: 1 }] } });
	try {
		await waitFor(() => harness.turns.length === 1, "failed turn");
		assert.equal(harness.turns[0].status, "failed");
		await waitFor(() => harness.exits.length === 1, "exit callback");
		assert.equal(harness.exits[0], 1);
	} finally {
		harness.driver.kill();
	}
});

test("qoder stream-json: cancel sends the documented interrupt control request and settles cancelled", async () => {
	const harness = await spawnQoder({ mode: "yolo", scenario: { turns: [{ hold: true, answer: "interrupted" }] } });
	try {
		await waitFor(() => harness.logs().some((entry) => entry.kind === "turn-started"), "turn to start");
		await harness.driver.cancel();
		await waitFor(() => harness.turns.length === 1, "cancelled turn");
		assert.equal(harness.turns[0].status, "cancelled");
		const requests = harness.logs().filter((entry) => entry.kind === "control-request");
		assert.equal(requests.length, 1);
		assert.equal(requests[0].subtype, "interrupt");
	} finally {
		harness.driver.kill();
	}
});

test("qoder stream-json: an inbound can_use_tool control request is answered, never ignored", async () => {
	const denied = await spawnQoder({
		mode: "readonly",
		scenario: { turns: [{ askPermission: true, toolName: "Bash", answer: "finished" }] },
	});
	try {
		await waitFor(() => denied.turns.length === 1, "readonly permission turn");
		const responses = denied.logs().filter((entry) => entry.kind === "control-response");
		assert.equal(responses.length, 1);
		assert.equal(responses[0].response.behavior, "deny");
		assert.equal(typeof responses[0].response.message, "string");
		assert.equal(responses[0].error, undefined);
	} finally {
		denied.driver.kill();
	}

	const allowed = await spawnQoder({
		mode: "yolo",
		scenario: { turns: [{ askPermission: true, toolName: "Bash", answer: "finished" }] },
	});
	try {
		await waitFor(() => allowed.turns.length === 1, "yolo permission turn");
		const responses = allowed.logs().filter((entry) => entry.kind === "control-response");
		assert.equal(responses.length, 1);
		assert.equal(responses[0].response.behavior, "allow");
	} finally {
		allowed.driver.kill();
	}
});

test("qoder stream-json: omitted effort adds no --reasoning-effort to the real spawn argv", async () => {
	const harness = await spawnQoder({ mode: "yolo", scenario: { turns: [{ answer: "ok" }] } });
	try {
		await waitFor(() => harness.argv().length > 0, "argv capture");
		const argv = harness.argv()[0];
		assert.deepEqual(argv.slice(0, 4), ["-p", "--output-format", "stream-json", "--input-format"]);
		assert.equal(argv[4], "stream-json");
		assert.equal(argv.includes("--reasoning-effort"), false);
		assert.equal(argv[argv.indexOf("--permission-mode") + 1], "bypass_permissions");
		assert.equal(argv.includes("do the thing"), false);
	} finally {
		harness.driver.kill();
	}
});

test("qoder stream-json: explicit effort and model are forwarded in the real spawn argv", async () => {
	const harness = await spawnQoder({
		mode: "write",
		model: "qoder-lite",
		effort: "high",
		scenario: { turns: [{ answer: "ok" }] },
	});
	try {
		await waitFor(() => harness.argv().length > 0, "argv capture");
		const argv = harness.argv()[0];
		assert.equal(argv[argv.indexOf("--permission-mode") + 1], "accept_edits");
		assert.equal(argv[argv.indexOf("--model") + 1], "qoder-lite");
		assert.equal(argv[argv.indexOf("--reasoning-effort") + 1], "high");
	} finally {
		harness.driver.kill();
	}
});

test("qoder stream-json: readonly spawn argv carries the harness allowlist and omits effort", async () => {
	const harness = await spawnQoder({ mode: "readonly", scenario: { turns: [{ answer: "ok" }] } });
	try {
		await waitFor(() => harness.argv().length > 0, "argv capture");
		const argv = harness.argv()[0];
		assert.equal(argv.includes("--acp"), false);
		assert.equal(argv[argv.indexOf("--permission-mode") + 1], "dont_ask");
		assert.equal(argv[argv.indexOf("--tools") + 1], "Read,Grep,Glob,WebSearch,WebFetch");
		assert.equal(argv.includes("--strict-mcp-config"), true);
		assert.equal(argv.includes("--reasoning-effort"), false);
	} finally {
		harness.driver.kill();
	}
});
