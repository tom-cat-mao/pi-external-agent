import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SESSION_DRIVERS, type SessionDriver, type TurnOutcome } from "../sessions.ts";
import type { AgentEvent, Effort, Mode } from "../adapters.ts";

interface MockPermission {
	options: Array<{ optionId?: string; kind?: string }>;
}

interface MockPrompt {
	chunks?: string[];
	stopReason?: string;
	error?: { code: number; message: string };
	meta?: Record<string, unknown>;
	permission?: MockPermission;
	hold?: boolean;
	exit?: number;
}

interface MockScenario {
	sessionId?: string;
	meta?: Record<string, unknown>;
	prompts?: MockPrompt[];
}

const QODER_ACP_MOCK = `#!/usr/bin/env node
const fs = require("node:fs");
const scenario = process.env.QODER_MOCK_SCENARIO ? JSON.parse(process.env.QODER_MOCK_SCENARIO) : {};
const argvFile = process.env.QODER_MOCK_ARGV_FILE;
const logFile = process.env.QODER_MOCK_LOG_FILE;
function record(entry) { if (logFile) fs.appendFileSync(logFile, JSON.stringify(entry) + "\\n"); }
if (argvFile) fs.appendFileSync(argvFile, JSON.stringify(process.argv.slice(2)) + "\\n");
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
let buffer = "";
let promptIndex = 0;
const waiting = new Map();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      record({ kind: "request", method: msg.method });
      send({ jsonrpc: "2.0", id: msg.id, result: { agentCapabilities: { _meta: scenario.meta || {} } } });
    } else if (msg.method === "session/new") {
      record({ kind: "request", method: msg.method });
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: scenario.sessionId || "sess-1" } });
    } else if (msg.method === "session/prompt") {
      const plan = (scenario.prompts || [])[promptIndex] || { chunks: [], stopReason: "end_turn" };
      const index = promptIndex++;
      const text = msg.params && msg.params.prompt ? msg.params.prompt.map(function (p) { return p.text; }).join("") : "";
      record({ kind: "prompt", index: index, text: text });
      const finish = function () {
        const chunks = plan.chunks || [];
        for (const chunk of chunks) {
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } } } });
        }
        if (plan.exit) process.exit(plan.exit);
        if (plan.error) { send({ jsonrpc: "2.0", id: msg.id, error: plan.error }); return; }
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: plan.stopReason || "end_turn", _meta: plan.meta || {} } });
      };
      if (plan.permission) {
        const permissionId = 9000 + index;
        waiting.set(permissionId, finish);
        send({ jsonrpc: "2.0", id: permissionId, method: "session/request_permission", params: { sessionId: msg.params.sessionId, options: plan.permission.options } });
      } else if (plan.hold) {
        waiting.set("cancel-" + index, finish);
      } else {
        finish();
      }
    } else if (msg.method === "session/cancel") {
      record({ kind: "request", method: msg.method });
      for (const entry of waiting) {
        if (String(entry[0]).startsWith("cancel-")) { waiting.delete(entry[0]); entry[1](); }
      }
    } else if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      record({ kind: "permission-response", id: msg.id, result: msg.result, error: msg.error });
      const callback = waiting.get(msg.id);
      if (callback) { waiting.delete(msg.id); callback(); }
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
	writeFileSync(executable, QODER_ACP_MOCK);
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

test("qoder ACP transport: initialize, session/new, prompt success, follow-up answer isolation", async () => {
	const harness = await spawnQoder({
		mode: "yolo",
		scenario: {
			prompts: [
				{ chunks: ["PONG"], stopReason: "end_turn" },
				{ chunks: ["PONG-2"], stopReason: "end_turn" },
			],
		},
	});
	try {
		await waitFor(() => harness.turns.length === 1, "first turn");
		assert.deepEqual(harness.turns[0], { status: "done" });
		assert.deepEqual(harness.events, [{ kind: "message", text: "PONG" }]);
		const afterFirst = harness.events.length;
		await harness.driver.followUp("second question");
		await waitFor(() => harness.turns.length === 2, "second turn");
		assert.deepEqual(harness.turns[1], { status: "done" });
		assert.deepEqual(harness.events.slice(afterFirst), [{ kind: "message", text: "PONG-2" }]);
		const prompts = harness.logs().filter((entry) => entry.kind === "prompt");
		assert.equal(prompts.length, 2);
		assert.equal(prompts[0].text, "do the thing");
		assert.equal(prompts[1].text, "second question");
	} finally {
		harness.driver.kill();
	}
});

test("qoder ACP transport: readonly permission request without a reject option fails closed", async () => {
	const harness = await spawnQoder({
		mode: "readonly",
		scenario: {
			prompts: [{ permission: { options: [{ optionId: "allow_once", kind: "allow_once" }] } }],
		},
	});
	try {
		await waitFor(() => harness.turns.length === 1, "readonly turn");
		const response = harness.logs().find((entry) => entry.kind === "permission-response");
		assert.ok(response);
		assert.equal(response.result.outcome.outcome, "cancelled");
		assert.equal(response.result.outcome.optionId, undefined);
		assert.equal(harness.turns[0].status, "done");
	} finally {
		harness.driver.kill();
	}
});

test("qoder ACP transport: write permission request fails closed, or selects a reject option when offered", async () => {
	const noReject = await spawnQoder({
		mode: "write",
		scenario: {
			prompts: [{ permission: { options: [{ optionId: "allow_once", kind: "allow_once" }] } }],
		},
	});
	try {
		await waitFor(() => noReject.turns.length === 1, "write no-reject turn");
		const response = noReject.logs().find((entry) => entry.kind === "permission-response");
		assert.ok(response);
		assert.equal(response.result.outcome.outcome, "cancelled");
	} finally {
		noReject.driver.kill();
	}

	const withReject = await spawnQoder({
		mode: "write",
		scenario: {
			prompts: [
				{
					permission: {
						options: [
							{ optionId: "allow_once", kind: "allow_once" },
							{ optionId: "reject_once", kind: "reject_once" },
						],
					},
				},
			],
		},
	});
	try {
		await waitFor(() => withReject.turns.length === 1, "write reject turn");
		const response = withReject.logs().find((entry) => entry.kind === "permission-response");
		assert.ok(response);
		assert.equal(response.result.outcome.outcome, "selected");
		assert.equal(response.result.outcome.optionId, "reject_once");
	} finally {
		withReject.driver.kill();
	}
});

test("qoder ACP transport: yolo permission request selects allow", async () => {
	const harness = await spawnQoder({
		mode: "yolo",
		scenario: {
			prompts: [{ permission: { options: [{ optionId: "allow_once", kind: "allow_once" }] } }],
		},
	});
	try {
		await waitFor(() => harness.turns.length === 1, "yolo turn");
		const response = harness.logs().find((entry) => entry.kind === "permission-response");
		assert.ok(response);
		assert.equal(response.result.outcome.optionId, "allow_once");
	} finally {
		harness.driver.kill();
	}
});

test("qoder ACP transport: prompt RPC error fails the turn", async () => {
	const harness = await spawnQoder({
		mode: "yolo",
		scenario: { prompts: [{ error: { code: -32000, message: "qoder rpc boom" } }] },
	});
	try {
		await waitFor(() => harness.turns.length === 1, "rpc error turn");
		assert.equal(harness.turns[0].status, "failed");
		assert.match(harness.turns[0].error ?? "", /qoder rpc boom/);
	} finally {
		harness.driver.kill();
	}
});

test("qoder ACP transport: refusal stop reason fails the turn with the meta error", async () => {
	const harness = await spawnQoder({
		mode: "yolo",
		scenario: {
			prompts: [{ stopReason: "refusal", meta: { errorMessage: "Qoder API error: FORBIDDEN" } }],
		},
	});
	try {
		await waitFor(() => harness.turns.length === 1, "refusal turn");
		assert.equal(harness.turns[0].status, "failed");
		assert.match(harness.turns[0].error ?? "", /FORBIDDEN/);
		assert.equal(harness.events.some((event) => event.kind === "error" && /FORBIDDEN/.test(event.text)), true);
	} finally {
		harness.driver.kill();
	}
});

test("qoder ACP transport: cancellation settles the turn as cancelled", async () => {
	const harness = await spawnQoder({
		mode: "yolo",
		scenario: { prompts: [{ hold: true, stopReason: "cancelled" }] },
	});
	try {
		await waitFor(() => harness.logs().some((entry) => entry.kind === "prompt"), "prompt to reach mock");
		await harness.driver.cancel();
		await waitFor(() => harness.turns.length === 1, "cancelled turn");
		assert.equal(harness.turns[0].status, "cancelled");
		assert.equal(harness.logs().some((entry) => entry.method === "session/cancel"), true);
	} finally {
		harness.driver.kill();
	}
});

test("qoder ACP transport: mid-turn process exit fails the turn and reports the exit code", async () => {
	const harness = await spawnQoder({
		mode: "yolo",
		scenario: { prompts: [{ chunks: ["partial"], exit: 1 }] },
	});
	try {
		await waitFor(() => harness.turns.length === 1, "failed turn");
		assert.equal(harness.turns[0].status, "failed");
		await waitFor(() => harness.exits.length === 1, "exit callback");
		assert.equal(harness.exits[0], 1);
	} finally {
		harness.driver.kill();
	}
});

test("qoder ACP transport: omitted effort adds no --reasoning-effort to the real spawn argv", async () => {
	const harness = await spawnQoder({
		mode: "yolo",
		scenario: { prompts: [{ chunks: ["ok"] }] },
	});
	try {
		await waitFor(() => harness.argv().length > 0, "argv capture");
		const argv = harness.argv()[0];
		assert.equal(argv[0], "--acp");
		assert.equal(argv.includes("--reasoning-effort"), false);
		assert.equal(argv[argv.indexOf("--permission-mode") + 1], "bypass_permissions");
	} finally {
		harness.driver.kill();
	}
});

test("qoder ACP transport: explicit effort and model are forwarded in the real spawn argv", async () => {
	const harness = await spawnQoder({
		mode: "write",
		model: "qoder-lite",
		effort: "high",
		scenario: { prompts: [{ chunks: ["ok"] }] },
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

test("qoder ACP transport: readonly spawn argv carries the harness allowlist and omits effort", async () => {
	const harness = await spawnQoder({
		mode: "readonly",
		scenario: { prompts: [{ chunks: ["ok"] }] },
	});
	try {
		await waitFor(() => harness.argv().length > 0, "argv capture");
		const argv = harness.argv()[0];
		assert.equal(argv[argv.indexOf("--permission-mode") + 1], "dont_ask");
		assert.equal(argv[argv.indexOf("--tools") + 1], "Read,Grep,Glob,WebSearch,WebFetch");
		assert.equal(argv.includes("--strict-mcp-config"), true);
		assert.equal(argv.includes("--reasoning-effort"), false);
	} finally {
		harness.driver.kill();
	}
});
