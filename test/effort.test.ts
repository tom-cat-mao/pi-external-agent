/**
 * Regression tests for the opt-in effort policy:
 *   - omitting effort sends no effort flag/field to any adapter or driver;
 *   - explicitly supplied effort is forwarded (and mapped) on every path that
 *     supports it, and off is treated as an explicit level, not as omission.
 *
 * No real external agent is invoked: the one-shot and persistent argv paths are
 * pure functions, and the codex app-server protocol is exercised against a mock
 * `codex` executable that records its turn/start params.
 *
 * Run with `node --test test/effort.test.ts` on Node 22.18+ / 26.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ADAPTERS, AGENT_IDS } from "../adapters.ts";
import { SESSION_DRIVERS } from "../sessions.ts";
import type { AgentId, Effort } from "../adapters.ts";

function effortPayload(argv: string[]): string | undefined {
	const cIndex = argv.indexOf("-c");
	if (cIndex !== -1 && argv[cIndex + 1]?.startsWith("model_reasoning_effort=")) return argv[cIndex + 1];
	for (const flag of ["--effort", "--thinking", "--reasoning-effort"]) {
		const index = argv.indexOf(flag);
		if (index !== -1) return argv[index + 1];
	}
	return undefined;
}

const INDEX_SOURCE = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

function sliceBetween(source: string, start: string, end: string): string {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from + start.length);
	assert.notEqual(from, -1, `missing source marker: ${start}`);
	assert.notEqual(to, -1, `missing source marker: ${end}`);
	return source.slice(from, to);
}

function prose(source: string): string {
	const literals = [...source.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map((match) => match[1]);
	return literals.join(" ").replace(/\s+/g, " ").trim();
}

const START_TOOL_SOURCE = sliceBetween(
	INDEX_SOURCE,
	'name: "external_agent_start"',
	'name: "external_agent_status"',
);
const DESCRIPTION_SURFACE = prose(sliceBetween(START_TOOL_SOURCE, "description: [", "promptSnippet:"));
const GUIDELINES_SURFACE = prose(sliceBetween(START_TOOL_SOURCE, "promptGuidelines: [", "parameters:"));
const EFFORT_PARAM_SURFACE = prose(sliceBetween(START_TOOL_SOURCE, "effort: Type.Optional(", "notify: Type.Optional("));

const COMPLEXITY_TO_EFFORT = [
	/fast lookup/i,
	/hard design/i,
	/hard debug/i,
	/low\/minimal/i,
	/high\/xhigh/i,
	/tune reasoning depth/i,
];

test("metadata: external_agent_start surfaces do not recommend inferring effort from task complexity", () => {
	assert.doesNotMatch(INDEX_SOURCE, /low\/minimal for fast lookups/);
	assert.doesNotMatch(INDEX_SOURCE, /high\/xhigh for hard/);
	for (const surface of [DESCRIPTION_SURFACE, GUIDELINES_SURFACE, EFFORT_PARAM_SURFACE]) {
		for (const pattern of COMPLEXITY_TO_EFFORT) {
			assert.doesNotMatch(surface, pattern, `complexity-based effort recommendation reintroduced: ${pattern}`);
		}
	}
});

test("metadata: effort is described as opt-in on description, schema, and the named guideline", () => {
	assert.match(DESCRIPTION_SURFACE, /opt-in reasoning-effort override/i);
	assert.match(DESCRIPTION_SURFACE, /never infer a level from task complexity/i);
	assert.match(DESCRIPTION_SURFACE, /target CLI\/config default/i);

	assert.match(EFFORT_PARAM_SURFACE, /opt-in reasoning-effort override/i);
	assert.match(EFFORT_PARAM_SURFACE, /explicitly requests an/i);
	assert.match(EFFORT_PARAM_SURFACE, /Omit it to inherit the target CLI\/config default/i);

	const effortGuideline = INDEX_SOURCE.split("\n").find((line) =>
		line.includes("Never infer an effort level from task complexity"),
	);
	assert.ok(effortGuideline, "the opt-in effort promptGuideline is missing");
	assert.match(effortGuideline, /external_agent_start/);
	assert.match(effortGuideline, /explicitly requests a reasoning-effort/i);
	assert.match(effortGuideline, /omit it entirely/i);
	assert.match(effortGuideline, /target CLI\/config default/i);
});

test("one-shot: omitting effort adds no effort argument and invents no default", () => {
	for (const id of AGENT_IDS) {
		const adapter = ADAPTERS[id];
		const dispatch = adapter.buildDispatch({ task: "t", cwd: "/tmp", mode: adapter.defaultMode });
		assert.equal(effortPayload(dispatch.argv), undefined, `${id} forwarded an effort argument when none was requested`);
		assert.equal(dispatch.effort.requested, undefined, `${id} invented a requested effort`);
		assert.equal(dispatch.effort.forwarded, false, `${id} marked effort as forwarded`);
		assert.match(dispatch.effort.note, /no effort override requested/i, `${id} note does not state the default applies`);
	}
});

const ONESHOT_FORWARD: Array<{ id: AgentId; level: Effort; payload: string }> = [
	{ id: "codex", level: "high", payload: `model_reasoning_effort="high"` },
	{ id: "pi", level: "low", payload: "low" },
	{ id: "codebuddy", level: "xhigh", payload: "xhigh" },
	{ id: "claude", level: "max", payload: "max" },
	{ id: "reasonix", level: "medium", payload: "high" },
];

test("one-shot: explicitly supplied effort is forwarded with the adapter's mapping", () => {
	for (const { id, level, payload } of ONESHOT_FORWARD) {
		const adapter = ADAPTERS[id];
		const dispatch = adapter.buildDispatch({ task: "t", cwd: "/tmp", mode: adapter.defaultMode, effort: level });
		assert.equal(effortPayload(dispatch.argv), payload, `${id} did not forward ${level} as expected`);
		assert.equal(dispatch.effort.requested, level, `${id} receipt lost the requested level`);
		assert.equal(dispatch.effort.forwarded, true, `${id} receipt did not mark effort forwarded`);
	}
});

test("one-shot: off is an explicit override, not the same as omitting effort", () => {
	const codex = ADAPTERS.codex.buildDispatch({ task: "t", cwd: "/tmp", mode: "yolo", effort: "off" });
	assert.equal(effortPayload(codex.argv), `model_reasoning_effort="none"`);
	const pi = ADAPTERS.pi.buildDispatch({ task: "t", cwd: "/tmp", mode: "yolo", effort: "off" });
	assert.equal(effortPayload(pi.argv), "off");
	const reasonix = ADAPTERS.reasonix.buildDispatch({ task: "t", cwd: "/tmp", mode: "yolo", effort: "off" });
	assert.equal(effortPayload(reasonix.argv), "disabled");
});

test("one-shot kimi: effort is never forwarded (refusal is enforced upstream)", () => {
	const dispatch = ADAPTERS.kimi.buildDispatch({ task: "t", cwd: "/tmp", mode: "yolo", effort: "high" });
	assert.equal(effortPayload(dispatch.argv), undefined);
	assert.equal(dispatch.effort.forwarded, false);
});

test("persistent pi rpc: omitted effort adds no --thinking; explicit level is forwarded", () => {
	const driver = SESSION_DRIVERS.pi!();
	assert.equal(effortPayload(driver.buildArgv({ task: "t", cwd: "/tmp", mode: "yolo" })), undefined);
	assert.equal(effortPayload(driver.buildArgv({ task: "t", cwd: "/tmp", mode: "yolo", effort: "off" })), "off");
});

test("persistent codebuddy ACP: omitted effort adds no --effort; explicit level is forwarded", () => {
	const driver = SESSION_DRIVERS.codebuddy!();
	assert.equal(effortPayload(driver.buildArgv({ task: "t", cwd: "/tmp", mode: "yolo" })), undefined);
	assert.equal(effortPayload(driver.buildArgv({ task: "t", cwd: "/tmp", mode: "yolo", effort: "high" })), "high");
});

test("persistent reasonix ACP: effort is never forwarded, requested or not", () => {
	const driver = SESSION_DRIVERS.reasonix!();
	assert.equal(effortPayload(driver.buildArgv({ task: "t", cwd: "/tmp", mode: "yolo" })), undefined);
	assert.equal(effortPayload(driver.buildArgv({ task: "t", cwd: "/tmp", mode: "yolo", effort: "high" })), undefined);
});

const CODEX_MOCK = `#!/usr/bin/env node
const fs = require("node:fs");
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
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
    } else if (msg.method === "thread/start") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "thread-1" } } }) + "\\n");
    } else if (msg.method === "turn/start") {
      if (process.env.EFFORT_CAPTURE_FILE) fs.appendFileSync(process.env.EFFORT_CAPTURE_FILE, JSON.stringify(msg.params) + "\\n");
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: "turn-1" } } }) + "\\n");
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { status: "completed" } } }) + "\\n");
    }
  }
});
`;

async function readCapturedTurnStart(file: string): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (existsSync(file)) {
			const text = readFileSync(file, "utf8").trim();
			if (text) {
				const lines = text.split("\n").filter(Boolean);
				return JSON.parse(lines[lines.length - 1]);
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`mock codex recorded no turn/start params at ${file}`);
}

async function captureCodexTurnStart(effort?: Effort): Promise<Record<string, unknown>> {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-ext-effort-codex-"));
	const mock = path.join(dir, "codex");
	writeFileSync(mock, CODEX_MOCK);
	chmodSync(mock, 0o755);
	const capture = path.join(dir, "turn-start.jsonl");
	const originalPath = process.env.PATH;
	const originalCapture = process.env.EFFORT_CAPTURE_FILE;
	process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ""}`;
	process.env.EFFORT_CAPTURE_FILE = capture;
	const driver = SESSION_DRIVERS.codex!();
	try {
		await driver.start({ task: "t", cwd: dir, mode: "yolo", effort });
		return await readCapturedTurnStart(capture);
	} finally {
		driver.kill();
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalCapture === undefined) delete process.env.EFFORT_CAPTURE_FILE;
		else process.env.EFFORT_CAPTURE_FILE = originalCapture;
	}
}

test("persistent codex app-server: omitted effort sends no protocol field; explicit effort is mapped", async () => {
	const absent = await captureCodexTurnStart();
	assert.equal("effort" in absent, false, "turn/start carried an effort field when none was requested");

	const high = await captureCodexTurnStart("high");
	assert.equal(high.effort, "high");

	const off = await captureCodexTurnStart("off");
	assert.equal(off.effort, "none");
});
