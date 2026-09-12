import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
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

registerHooks({
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
const tools = new Map<string, any>();
hub.default({
	registerTool: (tool: any) => tools.set(tool.name, tool),
	registerMessageRenderer: () => {},
	on: () => {},
	sendMessage: () => {},
});

const QODER_HUB_MOCK = `#!/usr/bin/env node
const scenario = process.env.QODER_MOCK_SCENARIO ? JSON.parse(process.env.QODER_MOCK_SCENARIO) : {};
let buffer = "";
let index = 0;
const held = new Map();
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
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
			send({ jsonrpc: "2.0", id: msg.id, result: { agentCapabilities: { _meta: {} } } });
		} else if (msg.method === "session/new") {
			send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-" + Date.now() } });
		} else if (msg.method === "session/prompt") {
			const plan = (scenario.prompts || [])[index] || { chunks: ["OK"] };
			const current = index++;
			const finish = () => {
				for (const text of plan.chunks || []) {
					send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
				}
				send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: plan.stopReason || "end_turn", _meta: {} } });
				if (plan.exit !== undefined) setTimeout(() => process.exit(plan.exit), 100);
			};
			if (plan.hold) held.set(current, finish); else finish();
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

test("hub: qoder start/wait/status expose a settled receipt, answer, and omitted effort", async () => {
	const dir = makeFixtureDir({ qodercli: QODER_HUB_MOCK });
	const restorePath = usePath(dir);
	const restoreScenario = withEnv({ QODER_MOCK_SCENARIO: JSON.stringify({ prompts: [{ chunks: ["ANSWER-1"], exit: 0 }] }) });
	try {
		const started = await startQoder(dir, { mode: "readonly" });
		assert.equal(started.details.kind, "external-agent-start");
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
		assert.match(status.content[0].text, /done/);
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
		QODER_MOCK_SCENARIO: JSON.stringify({ prompts: [{ chunks: ["FIRST"] }, { chunks: ["SECOND"], exit: 0 }] }),
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
	} finally {
		await call("external_agent_stop", { all: true });
		restoreScenario();
		restorePath();
	}
});

test("hub: qoder steer is refused for a follow-up-only agent", async () => {
	const dir = makeFixtureDir({ qodercli: QODER_HUB_MOCK });
	const restorePath = usePath(dir);
	const restoreScenario = withEnv({ QODER_MOCK_SCENARIO: JSON.stringify({ prompts: [{ hold: true }] }) });
	try {
		const started = await startQoder(dir);
		const taskId = started.details.task.taskId;
		const steered = await call("external_agent_steer", { taskId, message: "change course" });
		assert.equal(steered.details.steered, false);
		assert.match(steered.content[0].text, /does not support mid-run steering/i);
	} finally {
		await call("external_agent_stop", { all: true });
		restoreScenario();
		restorePath();
	}
});

test("hub: running qoder follow-up does not suggest unsupported steer", async () => {
	const dir = makeFixtureDir({ qodercli: QODER_HUB_MOCK });
	const restorePath = usePath(dir);
	const restoreScenario = withEnv({ QODER_MOCK_SCENARIO: JSON.stringify({ prompts: [{ hold: true }] }) });
	try {
		const started = await startQoder(dir);
		const taskId = started.details.task.taskId;
		const followed = await call("external_agent_follow_up", { taskId, message: "second question" });
		assert.equal(followed.details.continued, false);
		const text = followed.content[0].text;
		assert.doesNotMatch(text, /external_agent_steer/);
		assert.match(text, /still running/i);
	} finally {
		await call("external_agent_stop", { all: true });
		restoreScenario();
		restorePath();
	}
});

test("hub: one-shot task follow-up is refused", async () => {
	const dir = makeFixtureDir({ claude: CLAUDE_ONESHOT_MOCK });
	const restorePath = usePath(dir);
	try {
		const started = await call("external_agent_start", { agent: "claude", task: "x", mode: "readonly", cwd: dir, notify: "off" });
		assert.equal(started.details.task.transport, "oneshot");
		const taskId = started.details.task.taskId;
		const followed = await call("external_agent_follow_up", { taskId, message: "y" });
		assert.equal(followed.details.continued, false);
		assert.match(followed.content[0].text, /runs as a one-shot process/i);
	} finally {
		await call("external_agent_stop", { all: true });
		restorePath();
	}
});

test("hub: stop terminates a running qoder task", async () => {
	const dir = makeFixtureDir({ qodercli: QODER_HUB_MOCK });
	const restorePath = usePath(dir);
	const restoreScenario = withEnv({ QODER_MOCK_SCENARIO: JSON.stringify({ prompts: [{ hold: true }] }) });
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
	const restoreScenario = withEnv({ QODER_MOCK_SCENARIO: JSON.stringify({ prompts: [{ chunks: ["OK"], exit: 0 }] }) });
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
