/**
 * The stall handoff: steer/followUp pushes cannot pierce a running tool call, so
 * the stall notice a blocking wait is supposed to bring is unreachable while it
 * blocks. The wait therefore reads the same quiet predicate the watchdog scan
 * does, returns early once every watched task is quiet past its watchdog, and
 * claims one notice slot per quiet streak so the push channel and the early
 * return cannot double-report the same silence.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
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

// scanWatchdogs is interval-driven at 30s in production: too slow to exercise
// live, so the module exports it for exactly this suite.
const hub = (await import("../src/index.ts")) as {
	default: (pi: unknown) => void;
	scanWatchdogs: () => void;
};
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

/** Wires the settle/watchdog callbacks, exactly like a real session start does. */
function armNotifications(): void {
	lifecycle.get("session_start")?.({});
}

function makeFixtureDir(files: Record<string, string>): string {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ws-fixture-")));
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

/**
 * True when the promise is still unsettled after ms. The race timer is always
 * cleared, so a resolved wait leaves no handle behind.
 */
async function stillPending<T>(promise: Promise<T>, ms: number): Promise<boolean> {
	let pending = true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		promise.then(
			() => {
				pending = false;
			},
			() => {
				pending = false;
			},
		),
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, ms);
		}),
	]);
	if (timer) clearTimeout(timer);
	return pending;
}

/**
 * The gate is the task text: the mock holds the turn open until a file of that
 * name exists, so the test — not the scheduler — decides when the task settles.
 * claude is driven over the stream-json session channel, so the fixture answers
 * the initialize control request and takes the gate out of the user message.
 */
const GATED_CLAUDE_MOCK = `#!/usr/bin/env node
const fs = require("node:fs");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
send({ type: "system", subtype: "init", session_id: "sess-1", model: "mock", permissionMode: "bypassPermissions", tools: [] });
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
		if (msg.type !== "user" || msg.shouldQuery === false) continue;
		const gate = (msg.message && Array.isArray(msg.message.content) ? msg.message.content : [])
			.map(function (block) { return block.text || ""; }).join("");
		const started = Date.now();
		while (gate && !fs.existsSync(gate)) {
			if (Date.now() - started > 60000) process.exit(3);
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
		}
		send({ type: "result", subtype: "success", is_error: false,
			result: process.env.WAIT_MOCK_ANSWER || "WAIT_OK", usage: { input_tokens: 1, output_tokens: 1 } });
	}
});
`;

/**
 * Kimi speaks in-flight records (claude's json output surfaces only the final
 * result), so the activity-profile test uses it: STALL_MOCK_PRE_EVENTS tool
 * calls spaced before the gate, then the answer prose.
 */
const GATED_KIMI_MOCK = `#!/usr/bin/env node
const fs = require("node:fs");
const at = process.argv.indexOf("-p");
const gate = at === -1 ? "" : (process.argv[at + 1] || "");
const pre = Number(process.env.STALL_MOCK_PRE_EVENTS || "0");
if (pre > 0) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  for (let i = 0; i < pre; i += 1) {
    process.stdout.write(JSON.stringify({ role: "assistant", tool_calls: [{ function: { name: "bash", arguments: JSON.stringify({ command: "retry-" + i }) } }] }) + "\\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  }
}
if (gate) {
  const started = Date.now();
  while (!fs.existsSync(gate)) {
    if (Date.now() - started > 60000) process.exit(3);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}
process.stdout.write(JSON.stringify({ role: "assistant", content: process.env.WAIT_MOCK_ANSWER || "WAIT_OK" }) + "\\n");
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

/** The smallest watchdog the tool accepts that still means "quiet for a while". */
const QUICK_WATCHDOG = 0.01; // 600ms

test("wait-stall: a quiet task ends the wait early, and the claim silences the scan", async () => {
	const dir = makeFixtureDir({ claude: GATED_CLAUDE_MOCK });
	const gate = path.join(dir, "gate");
	const restorePath = usePath(dir);
	armNotifications();
	const controller = new AbortController();
	try {
		const taskId = await startGated(gate, { cwd: dir, watchdog: QUICK_WATCHDOG });
		const waiting = call("external_agent_wait", { taskIds: [taskId], timeout: 60 }, controller.signal);
		assert.equal(await stillPending(waiting, 8_000), false, "a quiet task must end the wait early, not hold it for the full timeout");
		const result = await waiting;
		assert.equal(result.details.stalled, "quiet");
		assert.equal(result.details.timedOut, false);
		assert.equal(result.details.aborted, false);
		const text = resultText(result);
		assert.match(text, new RegExp(`\\[${taskId}\\] running`));
		assert.match(text, /quiet for/);
		assert.match(text, /no stall notice can reach you while this call blocks/);
		assert.match(text, /events during wait: \d+ \(/);
		// The early return claimed the notice slot: the scan has nothing to add.
		hub.scanWatchdogs();
		assert.equal(pushes.length, 0, `the claimed streak was also pushed: ${pushes.join(" | ")}`);
	} finally {
		controller.abort();
		restorePath();
	}
});

test("wait-stall: an immediate second wait is throttled for the same streak", async () => {
	const dir = makeFixtureDir({ claude: GATED_CLAUDE_MOCK });
	const gate = path.join(dir, "gate");
	const restorePath = usePath(dir);
	armNotifications();
	const firstController = new AbortController();
	const secondController = new AbortController();
	try {
		const taskId = await startGated(gate, { cwd: dir, watchdog: QUICK_WATCHDOG });
		const first = call("external_agent_wait", { taskIds: [taskId], timeout: 60 }, firstController.signal);
		assert.equal(await stillPending(first, 8_000), false);
		assert.equal((await first).details.stalled, "quiet");
		// Same silence, fresh call: the claimed streak spaces the next report out.
		// The initial check runs synchronously, so without the claim this returns
		// at once with stalled: quiet — the pending assertion is the discriminator.
		const second = call("external_agent_wait", { taskIds: [taskId], timeout: 60 }, secondController.signal);
		assert.equal(await stillPending(second, 400), true, "the same quiet streak must not be re-reported immediately");
		secondController.abort();
		const aborted = await second;
		assert.equal(aborted.details.aborted, true);
		assert.equal(aborted.details.stalled, false);
	} finally {
		firstController.abort();
		secondController.abort();
		restorePath();
	}
});

test("wait-stall: after the per-streak cap the wait blocks again", async () => {
	const dir = makeFixtureDir({ claude: GATED_CLAUDE_MOCK });
	const gate = path.join(dir, "gate");
	const restorePath = usePath(dir);
	armNotifications();
	const controllers: AbortController[] = [];
	try {
		const taskId = await startGated(gate, { cwd: dir, watchdog: QUICK_WATCHDOG });
		const earlyReturn = async () => {
			const controller = new AbortController();
			controllers.push(controller);
			const waiting = call("external_agent_wait", { taskIds: [taskId], timeout: 60 }, controller.signal);
			assert.equal(await stillPending(waiting, 8_000), false, "the streak's first notices must each return early");
			return await waiting;
		};
		// Three notices per quiet streak; after that the model has been told and
		// blocking again is its informed choice, not the hub's silence.
		assert.equal((await earlyReturn()).details.stalled, "quiet");
		assert.equal((await earlyReturn()).details.stalled, "quiet");
		assert.equal((await earlyReturn()).details.stalled, "quiet");
		const fourthController = new AbortController();
		controllers.push(fourthController);
		const fourth = call("external_agent_wait", { taskIds: [taskId], timeout: 60 }, fourthController.signal);
		assert.equal(await stillPending(fourth, 2_600), true, "the cap must stop the fourth early return");
		fourthController.abort();
		assert.equal((await fourth).details.aborted, true);
	} finally {
		for (const controller of controllers) controller.abort();
		restorePath();
	}
});

test("wait-stall: watchdog 0 disables the early return", async () => {
	const dir = makeFixtureDir({ claude: GATED_CLAUDE_MOCK });
	const gate = path.join(dir, "gate");
	const restorePath = usePath(dir);
	armNotifications();
	const controller = new AbortController();
	try {
		const taskId = await startGated(gate, { cwd: dir, watchdog: 0 });
		const waiting = call("external_agent_wait", { taskIds: [taskId], timeout: 60 }, controller.signal);
		assert.equal(await stillPending(waiting, 500), true, "an explicit 0 means no quiet threshold exists");
		controller.abort();
		assert.equal((await waiting).details.aborted, true);
	} finally {
		controller.abort();
		restorePath();
	}
});

test("wait-stall: mode any needs every watched task quiet, not just one", async () => {
	const dir = makeFixtureDir({ claude: GATED_CLAUDE_MOCK });
	const gateA = path.join(dir, "gate-a");
	const gateB = path.join(dir, "gate-b");
	const restorePath = usePath(dir);
	armNotifications();
	const controller = new AbortController();
	try {
		const quiet = await startGated(gateA, { cwd: dir, watchdog: QUICK_WATCHDOG });
		const active = await startGated(gateB, { cwd: dir, watchdog: 0 });
		const waiting = call("external_agent_wait", { taskIds: [quiet, active], mode: "any", timeout: 60 }, controller.signal);
		assert.equal(await stillPending(waiting, 2_600), true, "one quiet task must not end an any-mode batch");
		controller.abort();
		const aborted = await waiting;
		assert.equal(aborted.details.aborted, true);
	} finally {
		controller.abort();
		restorePath();
	}
});

test("wait-stall: notify off suppresses delivery, never the early return", async () => {
	const dir = makeFixtureDir({ claude: GATED_CLAUDE_MOCK });
	const gate = path.join(dir, "gate");
	const restorePath = usePath(dir);
	armNotifications();
	const controller = new AbortController();
	try {
		const taskId = await startGated(gate, { cwd: dir, watchdog: QUICK_WATCHDOG, notify: "off" });
		const waiting = call("external_agent_wait", { taskIds: [taskId], timeout: 60 }, controller.signal);
		assert.equal(await stillPending(waiting, 8_000), false, "an off task still goes quiet, so the wait still returns");
		const result = await waiting;
		assert.equal(result.details.stalled, "quiet");
		const text = resultText(result);
		assert.match(text, /notify is off, so no stall notice will be delivered/);
		assert.doesNotMatch(text, /rely on the watchdog/);
		hub.scanWatchdogs();
		assert.equal(pushes.length, 0, `notify off must never push: ${pushes.join(" | ")}`);
	} finally {
		controller.abort();
		restorePath();
	}
});

test("wait-stall: a timed-out off batch promises no notifications", async () => {
	const dir = makeFixtureDir({ claude: GATED_CLAUDE_MOCK });
	const gate = path.join(dir, "gate");
	const restorePath = usePath(dir);
	armNotifications();
	try {
		const taskId = await startGated(gate, { cwd: dir, watchdog: 0, notify: "off" });
		const waited = await call("external_agent_wait", { taskIds: [taskId], timeout: 5 });
		assert.equal(waited.details.timedOut, true);
		assert.equal(waited.details.stalled, false);
		const text = resultText(waited);
		assert.match(text, /Notifications are off for every watched task/);
		assert.doesNotMatch(text, /rely on completion\/stall notifications/);
	} finally {
		restorePath();
	}
});

test("wait-stall: the report profiles the events that arrived during the wait", async () => {
	const dir = makeFixtureDir({ kimi: GATED_KIMI_MOCK });
	const gate = path.join(dir, "gate");
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ STALL_MOCK_PRE_EVENTS: "3", WAIT_MOCK_ANSWER: "SETTLE_OK" });
	armNotifications();
	const controller = new AbortController();
	try {
		// A slow watchdog, so the settle below — not a stall — is what ends the wait.
		const taskId = await startGated(gate, { agent: "kimi", mode: "yolo", cwd: dir, watchdog: 0.05 });
		const waiting = call("external_agent_wait", { taskIds: [taskId], timeout: 20 }, controller.signal);
		await sleep(1_000); // the mock's tool activity lands inside this window
		writeFileSync(gate, "go");
		const result = await waiting;
		assert.equal(result.details.stalled, false);
		const text = resultText(result);
		assert.match(text, /SETTLE_OK/);
		assert.match(text, /events during wait: 4 \(tool×3, message×1; last: SETTLE_OK\)/);
	} finally {
		controller.abort();
		restoreEnv();
		restorePath();
	}
});

test("wait-stall: a settle always beats the stall exit", async () => {
	const dir = makeFixtureDir({ claude: GATED_CLAUDE_MOCK });
	const gateA = path.join(dir, "gate-a");
	const gateB = path.join(dir, "gate-b");
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ WAIT_MOCK_ANSWER: "ANY_SETTLE_OK" });
	armNotifications();
	const controller = new AbortController();
	try {
		const settling = await startGated(gateA, { cwd: dir, watchdog: QUICK_WATCHDOG });
		const quiet = await startGated(gateB, { cwd: dir, watchdog: QUICK_WATCHDOG });
		const waiting = call("external_agent_wait", { taskIds: [settling, quiet], mode: "any", timeout: 60 }, controller.signal);
		await sleep(300);
		writeFileSync(gateA, "go");
		assert.equal(await stillPending(waiting, 8_000), false, "the settled task must end the batch");
		const result = await waiting;
		// Both tasks are quiet by the time the poll runs, but a settle outranks a
		// stall: the answer is here, so there is nothing to hand back to the model.
		assert.equal(result.details.stalled, false);
		assert.match(resultText(result), /ANY_SETTLE_OK/);
	} finally {
		controller.abort();
		restoreEnv();
		restorePath();
	}
});

test("wait-stall: the scan skips a watched task, then resumes once the waiter releases", async () => {
	const dir = makeFixtureDir({ claude: GATED_CLAUDE_MOCK });
	const gate = path.join(dir, "gate");
	const restorePath = usePath(dir);
	armNotifications();
	const controller = new AbortController();
	try {
		const taskId = await startGated(gate, { cwd: dir, watchdog: QUICK_WATCHDOG });
		const waiting = call("external_agent_wait", { taskIds: [taskId], timeout: 60 }, controller.signal);
		await sleep(800); // quiet past its watchdog, with the waiter registered
		hub.scanWatchdogs();
		assert.equal(pushes.length, 0, `a watched task must not also be pushed: ${pushes.join(" | ")}`);
		controller.abort();
		await waiting;
		hub.scanWatchdogs();
		assert.equal(pushes.length, 1, "the released quiet task must be pushed by the next scan");
		assert.match(pushes[0], new RegExp(taskId));
		assert.match(pushes[0], /stall warning/);
	} finally {
		controller.abort();
		restorePath();
	}
});

test("wait-stall: receipts stop advertising a watchdog that cannot fire", async () => {
	const dir = makeFixtureDir({ claude: GATED_CLAUDE_MOCK });
	const gate = path.join(dir, "gate");
	const restorePath = usePath(dir);
	armNotifications();
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const renderedReceipt = (start: any): string =>
		tools.get("external_agent_start").renderResult(start, { expanded: true }, theme, {}).text as string;
	try {
		const off = await call("external_agent_start", { agent: "claude", task: gate, mode: "readonly", cwd: dir, notify: "off", watchdog: 30 });
		assert.match(renderedReceipt(off), /watchdog: not delivered \(notify off/);
		assert.doesNotMatch(renderedReceipt(off), /stall notice after/);
		assert.doesNotMatch(resultText(off), /stall watchdog/);

		const zero = await call("external_agent_start", { agent: "claude", task: gate, mode: "readonly", cwd: dir, watchdog: 0 });
		assert.doesNotMatch(resultText(zero), /stall watchdog/);

		// Negative control: an armed watchdog is still advertised as one.
		const armed = await call("external_agent_start", { agent: "claude", task: gate, mode: "readonly", cwd: dir, watchdog: 30 });
		assert.match(renderedReceipt(armed), /watchdog: stall notice after 30m00s quiet \(Pi-only\)/);
		assert.match(resultText(armed), /stall watchdog \(30m\) will notify you/);
	} finally {
		restorePath();
	}
});
