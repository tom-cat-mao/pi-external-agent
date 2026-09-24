/**
 * Offline tests for lazy tool activation: a session opens with
 * wait/compare/steer/follow_up parked, the first dispatch that really runs
 * brings them back, and that dispatch's own result carries the announcement.
 *
 * No real external agent is invoked. The host pi modules are stubbed via
 * registerHooks and the agent is a mock executable on PATH, so the tests
 * exercise the real dispatch path (validation, registry, activation handshake)
 * without a network or a vendor CLI.
 *
 * Run with `node --test test/lazy-activation.test.ts`.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SESSION_DRIVERS } from "../src/drivers/index.ts";

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

const hub = (await import("../src/index.ts")) as { default: (pi: unknown) => void };
// The same module instance the extension entry uses: the activation state this
// suite inspects is the one the handshake writes.
const { taskRegistry } = (await import("../src/hub/registry.ts")) as {
	taskRegistry: { toolActivation?: { activated: boolean } };
};
moduleHooks.deregister();

/** The tool surface the design splits in two, spelled out rather than imported. */
const FIXED_TOOLS = ["external_agent_start", "external_agent_status", "external_agent_stop"];
const LAZY_TOOLS = ["external_agent_wait", "external_agent_compare", "external_agent_steer", "external_agent_follow_up"];
const NOTICE = `Tools ${LAZY_TOOLS.join(", ")} are now active.`;
/** A host tool the hub knows nothing about, to prove other choices survive. */
const BYSTANDER = "bash";

const tools = new Map<string, any>();
const lifecycle = new Map<string, (event: unknown) => void>();
const activeTools = new Set<string>();
const setActiveCalls: string[][] = [];

function resetHost(): void {
	activeTools.clear();
	for (const name of [...FIXED_TOOLS, ...LAZY_TOOLS, BYSTANDER]) activeTools.add(name);
	setActiveCalls.length = 0;
}

/** The host stub: a real active-tool list, and every write to it recorded. */
const host: Record<string, any> = {
	registerTool: (tool: any) => tools.set(tool.name, tool),
	registerMessageRenderer: () => {},
	on: (event: string, handler: (event: unknown) => void) => lifecycle.set(event, handler),
	sendMessage: () => {},
	getActiveTools: () => [...activeTools],
	setActiveTools: (names: string[]) => {
		setActiveCalls.push([...names]);
		activeTools.clear();
		for (const name of names) activeTools.add(name);
	},
};
hub.default(host);

afterEach(() => lifecycle.get("session_shutdown")!({ reason: "quit" }));

const startSession = (event: Record<string, unknown> = {}) => lifecycle.get("session_start")!(event);

/**
 * pi's reload sequence, in the order pi runs it: session_shutdown{reload}, the
 * host reinstating every extension tool on its active list, then
 * session_start{reload}. The hub registry survives it — that is the contract the
 * activation state leans on. (Precedent: test/wait-dedup.test.ts.)
 */
function reloadSession(): void {
	lifecycle.get("session_shutdown")!({ reason: "reload" });
	for (const name of [...FIXED_TOOLS, ...LAZY_TOOLS]) activeTools.add(name);
	startSession({ reason: "reload" });
}

function activeList(): string[] {
	return [...activeTools].sort();
}

function noticeCount(result: any): number {
	return result.content.reduce((n: number, block: any) => n + (typeof block.text === "string" ? block.text.split("are now active").length - 1 : 0), 0);
}

function withPath(dir: string): () => void {
	const previous = process.env.PATH;
	process.env.PATH = `${dir}${path.delimiter}${previous ?? ""}`;
	return () => {
		if (previous === undefined) delete process.env.PATH;
		else process.env.PATH = previous;
	};
}

/** The claude stream-json session mock: initialize, then one result record per user message. */
const CLAUDE_MOCK = `#!/usr/bin/env node
const send = function (value) { process.stdout.write(JSON.stringify(value) + "\\n"); };
send({ type: "system", subtype: "init", session_id: "sess-1", model: "mock", permissionMode: "bypassPermissions", tools: [] });
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function (chunk) {
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
		if (msg.type === "user" && msg.shouldQuery !== false) {
			send({ type: "result", subtype: "success", is_error: false, result: "LAZY-ANSWER", usage: { input_tokens: 7, output_tokens: 3 } });
		}
	}
});
`;

/** The kimi one-shot spelling, reachable only while kimi has no session driver: one chat record, then exit. */
const KIMI_MOCK = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ role: "assistant", content: "ONESHOT-ANSWER" }) + "\\n", function () { process.exit(0); });
`;

function makeFixtureDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "lazy-activation-"));
	for (const [name, source] of Object.entries({ claude: CLAUDE_MOCK, kimi: KIMI_MOCK })) {
		const file = path.join(dir, name);
		writeFileSync(file, source);
		chmodSync(file, 0o755);
	}
	return dir;
}

async function call(name: string, params: Record<string, unknown>, cwd: string): Promise<any> {
	const tool = tools.get(name);
	assert.ok(tool, `missing tool ${name}`);
	return await tool.execute("call-id", params, undefined, undefined, { cwd });
}

test("lazy activation: session_start parks the four and leaves other tools alone", () => {
	resetHost();
	startSession();

	assert.deepEqual(activeList(), [...FIXED_TOOLS, BYSTANDER].sort());
	assert.equal(setActiveCalls.length, 1, "parking is one write");
});

test("lazy activation: the first dispatch activates all seven and announces it once", async () => {
	const dir = makeFixtureDir();
	const restorePath = withPath(dir);
	resetHost();
	startSession();
	try {
		const first = await call("external_agent_start", { agent: "claude", task: "say hello", mode: "readonly", cwd: dir, notify: "off" }, dir);
		assert.equal(first.details.task.state, "running");
		assert.deepEqual(activeList(), [...FIXED_TOOLS, ...LAZY_TOOLS, BYSTANDER].sort());
		assert.equal(setActiveCalls.length, 2, "parking then one additive activation");
		// Additive: the host's list stays in place, the four are appended to it.
		assert.deepEqual(setActiveCalls[1], [...FIXED_TOOLS, BYSTANDER, ...LAZY_TOOLS]);

		// Another tool's result never carries the line: only the dispatch that
		// activated does.
		const status = await call("external_agent_status", { taskId: first.details.task.taskId }, dir);
		assert.equal(noticeCount(status), 0);

		const text = first.content.map((block: any) => block.text ?? "").join("\n");
		assert.equal(noticeCount(first), 1);
		assert.ok(text.includes(NOTICE), `activation line missing from:\n${text}`);
		// The dispatch receipt is untouched: same details, same report text.
		assert.equal(first.details.kind, "external-agent-start");
		assert.match(text, /Started claude as /);
	} finally {
		await call("external_agent_stop", { all: true }, dir);
		restorePath();
	}
});

test("lazy activation: a refused dispatch neither activates nor announces", async () => {
	const dir = makeFixtureDir();
	const restorePath = withPath(dir);
	resetHost();
	startSession();
	try {
		// claude offers no "minimal" level, so the hub refuses before anything spawns.
		const refused = await call("external_agent_start", { agent: "claude", task: "say hello", mode: "readonly", effort: "minimal", cwd: dir }, dir);
		assert.match(refused.content[0].text, /^Refused: /);
		assert.deepEqual(activeList(), [...FIXED_TOOLS, BYSTANDER].sort());
		assert.equal(setActiveCalls.length, 1, "only the parking write");
		assert.equal(noticeCount(refused), 0);

		// The one-shot announcement is still ahead: the refusal did not burn it.
		const started = await call("external_agent_start", { agent: "claude", task: "say hello", mode: "readonly", cwd: dir, notify: "off" }, dir);
		assert.deepEqual(activeList(), [...FIXED_TOOLS, ...LAZY_TOOLS, BYSTANDER].sort());
		assert.equal(noticeCount(started), 1);
	} finally {
		await call("external_agent_stop", { all: true }, dir);
		restorePath();
	}
});

test("lazy activation: a one-shot dispatch activates the four as well", async () => {
	const dir = makeFixtureDir();
	const restorePath = withPath(dir);
	// Every adapter has a session driver, so the one-shot transport is reachable
	// only while an agent has none: removing kimi's entry picks that path.
	const savedDriver = SESSION_DRIVERS.kimi;
	delete SESSION_DRIVERS.kimi;
	resetHost();
	startSession();
	try {
		const started = await call("external_agent_start", { agent: "kimi", task: "say hello", mode: "yolo", cwd: dir, notify: "off" }, dir);
		assert.equal(started.details.task.transport, "oneshot");
		assert.deepEqual(activeList(), [...FIXED_TOOLS, ...LAZY_TOOLS, BYSTANDER].sort());
		assert.equal(setActiveCalls.length, 2, "parking then one additive activation");
		assert.equal(noticeCount(started), 1);
	} finally {
		SESSION_DRIVERS.kimi = savedDriver;
		await call("external_agent_stop", { all: true }, dir);
		restorePath();
	}
});

test("lazy activation: a host without a tool-list API parks nothing and activates nothing", async () => {
	const dir = makeFixtureDir();
	const restorePath = withPath(dir);
	resetHost();
	const saved = { get: host.getActiveTools, set: host.setActiveTools };
	delete host.getActiveTools;
	delete host.setActiveTools;
	try {
		startSession();
		assert.equal(setActiveCalls.length, 0);

		const started = await call("external_agent_start", { agent: "claude", task: "say hello", mode: "readonly", cwd: dir, notify: "off" }, dir);
		assert.equal(setActiveCalls.length, 0, "nothing is written to a list the host does not expose");
		// Nothing was parked on such a host, so the line describes the truth anyway.
		assert.equal(noticeCount(started), 1);
	} finally {
		await call("external_agent_stop", { all: true }, dir);
		host.getActiveTools = saved.get;
		host.setActiveTools = saved.set;
		restorePath();
	}
});

test("lazy activation: a reload before any dispatch parks the four again", () => {
	resetHost();
	startSession();

	reloadSession();

	assert.deepEqual(activeList(), [...FIXED_TOOLS, BYSTANDER].sort());
	assert.equal(setActiveCalls.length, 2, "the host reinstated all seven; the hub parks them once more");
	assert.equal(taskRegistry.toolActivation?.activated, false);
});

test("lazy activation: a reload after an activation keeps the earned state and re-arms nothing", async () => {
	const dir = makeFixtureDir();
	const restorePath = withPath(dir);
	resetHost();
	startSession();
	try {
		const first = await call("external_agent_start", { agent: "claude", task: "first", mode: "readonly", cwd: dir, notify: "off" }, dir);
		assert.equal(noticeCount(first), 1);
		assert.equal(setActiveCalls.length, 2, "parking then one additive activation");

		reloadSession();

		// pi reinstated all seven, which is exactly the earned state: no write.
		assert.deepEqual(activeList(), [...FIXED_TOOLS, ...LAZY_TOOLS, BYSTANDER].sort());
		assert.equal(setActiveCalls.length, 2, "restoring what the host already reinstated is not a write");
		assert.equal(taskRegistry.toolActivation?.activated, true, "a reload does not re-arm the handshake");

		// The announcement already happened; the next dispatch is silent.
		const second = await call("external_agent_start", { agent: "claude", task: "second", mode: "readonly", cwd: dir, notify: "off" }, dir);
		assert.equal(noticeCount(second), 0, "no second announcement after a reload");
		assert.equal(setActiveCalls.length, 2, "and no second activation");
	} finally {
		await call("external_agent_stop", { all: true }, dir);
		restorePath();
	}
});

test("lazy activation: an activating compare dispatch carries the line on its own result", async () => {
	const dir = makeFixtureDir();
	const restorePath = withPath(dir);
	resetHost();
	const saved = { get: host.getActiveTools, set: host.setActiveTools };
	delete host.getActiveTools;
	delete host.setActiveTools;
	try {
		startSession();
		assert.equal(setActiveCalls.length, 0, "this host parks nothing, so compare can be the first dispatch");
		const compared = await call(
			"external_agent_compare",
			{ task: "say hello", agents: [{ agent: "claude", mode: "readonly" }, { agent: "claude", mode: "readonly" }], cwd: dir },
			dir,
		);
		assert.equal(compared.details.kind, "external-agent-compare");
		assert.equal(noticeCount(compared), 1);
		const text = compared.content.map((block: any) => block.text ?? "").join("\n");
		assert.ok(text.includes(NOTICE), `activation line missing from:\n${text}`);
	} finally {
		await call("external_agent_stop", { all: true }, dir);
		host.getActiveTools = saved.get;
		host.setActiveTools = saved.set;
		restorePath();
	}
});

test("lazy activation: a later dispatch re-activates nothing and says nothing", async () => {
	const dir = makeFixtureDir();
	const restorePath = withPath(dir);
	resetHost();
	startSession();
	try {
		const first = await call("external_agent_start", { agent: "claude", task: "first", mode: "readonly", cwd: dir, notify: "off" }, dir);
		assert.equal(noticeCount(first), 1);

		const second = await call("external_agent_start", { agent: "claude", task: "second", mode: "readonly", cwd: dir, notify: "off" }, dir);
		assert.equal(noticeCount(second), 0);
		assert.deepEqual(activeList(), [...FIXED_TOOLS, ...LAZY_TOOLS, BYSTANDER].sort());
		assert.equal(setActiveCalls.length, 2, "activation happens exactly once per session");
	} finally {
		await call("external_agent_stop", { all: true }, dir);
		restorePath();
	}
});

test("lazy activation: dispatches racing in one batch activate once and announce once", async () => {
	const dir = makeFixtureDir();
	const restorePath = withPath(dir);
	resetHost();
	startSession();
	try {
		const params = (task: string) => ({ agent: "claude", task, mode: "readonly", cwd: dir, notify: "off" });
		const [left, right] = await Promise.all([
			call("external_agent_start", params("left"), dir),
			call("external_agent_start", params("right"), dir),
		]);

		assert.deepEqual(activeList(), [...FIXED_TOOLS, ...LAZY_TOOLS, BYSTANDER].sort());
		assert.equal(setActiveCalls.length, 2, "two racing dispatches still write one activation");
		const carrying = [left, right].filter((result) => noticeCount(result) === 1);
		assert.equal(carrying.length, 1, "exactly one of the two results announces the four");
	} finally {
		await call("external_agent_stop", { all: true }, dir);
		restorePath();
	}
});
