/**
 * Adaptive stall detection: two clocks (any event vs meaningful event), the
 * struggle verdict for warning/error streams that never turn into progress, and
 * the cadence-derived silence threshold. The module's stall clock is injected,
 * so thresholds of minutes are exercised without waiting for them; the event
 * record is driven through the production pushEvent path, since no target CLI
 * emits warning/error streams on stdout (kimi writes them to stderr).
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

const hub = (await import("../index.ts")) as any;
moduleHooks.deregister();

const MIN = 60_000;
/** Fake clock: every stall timestamp in the module reads stallClock.now. */
let fakeNow = 1_000_000_000_000;
hub.stallClock.now = () => fakeNow;
const at = () => fakeNow;
const advance = (ms: number) => {
	fakeNow += ms;
};

const tools = new Map<string, any>();
const lifecycle = new Map<string, (event?: unknown) => void>();
const pushes: any[] = [];
hub.default({
	registerTool: (tool: any) => tools.set(tool.name, tool),
	registerMessageRenderer: () => {},
	on: (event: string, handler: (event?: unknown) => void) => lifecycle.set(event, handler),
	sendMessage: (message: any) => pushes.push(message),
	exec: async () => ({ stdout: "VERIFY_OK", stderr: "", code: 0 }),
});

afterEach(async () => {
	await call("external_agent_stop", { all: true });
	lifecycle.get("session_shutdown")!({ reason: "quit" });
	pushes.length = 0;
});

function armNotifications(): void {
	lifecycle.get("session_start")?.({});
}

function makeFixtureDir(files: Record<string, string>): string {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "sa-fixture-")));
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

/** Blocks until a file named by the task text exists, so the test owns the settle. */
const GATED_CLAUDE_MOCK = `#!/usr/bin/env node
const fs = require("node:fs");
const at = process.argv.indexOf("-p");
const gate = at === -1 ? "" : (process.argv[at + 1] || "");
if (gate) {
  const started = Date.now();
  while (!fs.existsSync(gate)) {
    if (Date.now() - started > 60000) process.exit(3);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false,
  result: process.env.WAIT_MOCK_ANSWER || "WAIT_OK", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");
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

async function startGated(gate: string, extra: Record<string, unknown> = {}): Promise<string> {
	const start = await call("external_agent_start", { agent: "claude", task: gate, mode: "readonly", ...extra });
	return start.details.task.taskId;
}

/** The registered task behind an id, so the suite can drive its clocks and events. */
const liveTask = (id: string) => hub.stallTestApi.task(id);
const record = (task: any, event: Record<string, unknown>) => hub.stallTestApi.record(task, { text: "", ...event });

/** A predicate-level task: the detectors only read these fields. */
function fakeTask(overrides: Record<string, unknown> = {}): any {
	return {
		watchdogMs: 15 * MIN,
		lastEventAt: at(),
		lastMeaningfulEventAt: at(),
		meaningfulIntervals: [],
		events: [],
		...overrides,
	};
}

// --------------------------------------------------------------------------
// The threshold
// --------------------------------------------------------------------------

test("stall-adaptive: the threshold follows the task's own cadence", () => {
	const chatty = fakeTask({ meaningfulIntervals: Array(5).fill(20_000) });
	// 8 × 20s = 2m40s falls under the floor: a chatty task is not judged silent
	// before a single long tool call could plausibly run.
	assert.equal(hub.stallTestApi.effectiveMs(chatty), 3 * MIN);

	const steady = fakeTask({ meaningfulIntervals: Array(5).fill(60_000) });
	assert.equal(hub.stallTestApi.effectiveMs(steady), 8 * MIN);

	const sparse = fakeTask({ meaningfulIntervals: Array(5).fill(5 * MIN) });
	// 8 × 5m = 40m exceeds the watchdog: the explicit setting is the ceiling.
	assert.equal(hub.stallTestApi.effectiveMs(sparse), 15 * MIN);

	const young = fakeTask({ meaningfulIntervals: Array(4).fill(20_000) });
	// Four samples are not a cadence yet: the watchdog decides.
	assert.equal(hub.stallTestApi.effectiveMs(young), 15 * MIN);

	const even = fakeTask({ meaningfulIntervals: [30_000, 90_000, 30_000, 90_000, 30_000, 90_000] });
	// Even count: the median averages the two middles (60s) → 8m.
	assert.equal(hub.stallTestApi.effectiveMs(even), 8 * MIN);
});

test("stall-adaptive: the interval window keeps only the last 16 gaps", async () => {
	const dir = makeFixtureDir({ claude: GATED_CLAUDE_MOCK });
	const gate = path.join(dir, "gate");
	const restorePath = usePath(dir);
	armNotifications();
	try {
		const taskId = await startGated(gate, { cwd: dir });
		const task = liveTask(taskId);
		// 17 meaningful events with widening gaps, 1m..17m in order.
		for (let minute = 1; minute <= 17; minute += 1) {
			advance(minute * MIN);
			record(task, { kind: "tool", text: `step ${minute}` });
		}
		assert.equal(task.meaningfulIntervals.length, 16);
		assert.equal(task.meaningfulIntervals[0], 2 * MIN, "the oldest gap must be dropped");
		assert.equal(task.meaningfulIntervals[15], 17 * MIN);
	} finally {
		restorePath();
	}
});

// --------------------------------------------------------------------------
// The two clocks and the struggle verdict
// --------------------------------------------------------------------------

test("stall-adaptive: only warnings/errors for 5m reads as struggling", () => {
	const task = fakeTask();
	advance(1 * MIN);
	task.lastEventAt = at(); // an error landed, progress never did
	assert.equal(hub.stallTestApi.struggling(task, at() + 4 * MIN - 1), false, "under 5m is tolerated retries");
	assert.equal(hub.stallTestApi.struggling(task, at() + 5 * MIN), true);
});

test("stall-adaptive: a message resets both clocks and clears the struggle", () => {
	const task = fakeTask();
	advance(6 * MIN);
	task.lastEventAt = at(); // errors kept arriving, progress did not
	assert.equal(hub.stallTestApi.struggling(task, at()), true);

	advance(1 * MIN);
	// The production record path: a message moves both clocks and samples the gap.
	record(task, { kind: "message", text: "found it, patching now" });
	assert.equal(task.lastEventAt, at());
	assert.equal(task.lastMeaningfulEventAt, at());
	assert.equal(task.meaningfulIntervals.length, 1);
	assert.equal(task.meaningfulIntervals[0], 7 * MIN);
	assert.equal(hub.stallTestApi.kind(task, at()), null);

	// Five more minutes pass with no event at all: nothing is arriving, so this
	// is silence — the watchdog's call — not a warning/error struggle.
	advance(5 * MIN + 1_000);
	assert.equal(hub.stallTestApi.struggling(task, at()), false);
	assert.equal(hub.stallTestApi.kind(task, at()), null);
});

test("stall-adaptive: quiet outranks struggling when both are true", () => {
	const task = fakeTask({ watchdogMs: 15 * MIN });
	advance(1 * MIN);
	task.lastEventAt = at(); // a lone error, then nothing
	advance(19 * MIN);
	assert.equal(hub.stallTestApi.quiet(task, at()), true);
	assert.equal(hub.stallTestApi.struggling(task, at()), true);
	assert.equal(hub.stallTestApi.kind(task, at()), "quiet");
});

test("stall-adaptive: watchdog 0 disables both detectors", () => {
	const task = fakeTask({ watchdogMs: 0 });
	advance(1 * MIN);
	task.lastEventAt = at();
	advance(60 * MIN);
	assert.equal(hub.stallTestApi.quiet(task, at()), false);
	assert.equal(hub.stallTestApi.struggling(task, at()), false);
	assert.equal(hub.stallTestApi.kind(task, at()), null);
});

// --------------------------------------------------------------------------
// The wait's early return
// --------------------------------------------------------------------------

test("stall-adaptive: an error stream turns the wait back early as struggling", async () => {
	const dir = makeFixtureDir({ claude: GATED_CLAUDE_MOCK });
	const gate = path.join(dir, "gate");
	const restorePath = usePath(dir);
	armNotifications();
	const controller = new AbortController();
	try {
		const taskId = await startGated(gate, { cwd: dir, watchdog: 30 });
		const task = liveTask(taskId);
		advance(1 * MIN);
		record(task, { kind: "error", text: "API Error: 524 retry 1/5" });
		advance(1 * MIN);
		record(task, { kind: "error", text: "API Error: 524 retry 2/5" });
		advance(3 * MIN + 30_000); // 5m30s since the last meaningful event

		const waited = await call("external_agent_wait", { taskIds: [taskId], timeout: 60 }, controller.signal);
		assert.equal(waited.details.stalled, "struggling");
		assert.equal(waited.details.timedOut, false);
		assert.equal(waited.details.aborted, false);
		const text = resultText(waited);
		assert.match(text, new RegExp(`\\[${taskId}\\] running`));
		assert.match(text, /only warnings\/errors for 5m30s; last meaningful: \(none yet\)/);
		// The early return claimed the streak's first slot: the scan has nothing to add.
		hub.scanWatchdogs();
		assert.equal(pushes.length, 0, `the claimed streak was also pushed: ${pushes.map((p) => p.content).join(" | ")}`);
	} finally {
		controller.abort();
		restorePath();
	}
});

test("stall-adaptive: a quiet task still reports as quiet, not struggling", async () => {
	const dir = makeFixtureDir({ claude: GATED_CLAUDE_MOCK });
	const gate = path.join(dir, "gate");
	const restorePath = usePath(dir);
	armNotifications();
	const controller = new AbortController();
	try {
		const taskId = await startGated(gate, { cwd: dir, watchdog: 30 });
		advance(31 * MIN); // no event at all: pure silence, the watchdog's call
		const waited = await call("external_agent_wait", { taskIds: [taskId], timeout: 60 }, controller.signal);
		assert.equal(waited.details.stalled, "quiet");
		const text = resultText(waited);
		assert.match(text, /quiet for 31m00s/);
		assert.doesNotMatch(text, /only warnings\/errors/);
	} finally {
		controller.abort();
		restorePath();
	}
});

test("stall-adaptive: a mixed batch reports the worse of the two kinds", async () => {
	const dir = makeFixtureDir({ claude: GATED_CLAUDE_MOCK });
	const gateA = path.join(dir, "gate-a");
	const gateB = path.join(dir, "gate-b");
	const restorePath = usePath(dir);
	armNotifications();
	const controller = new AbortController();
	try {
		const silent = await startGated(gateA, { cwd: dir, watchdog: 15 });
		const noisy = await startGated(gateB, { cwd: dir, watchdog: 30 });
		const task = liveTask(noisy);
		advance(10_000);
		record(task, { kind: "message", text: "starting analysis" });
		advance(29 * MIN); // errors keep the quiet clock fresh while progress stalls
		record(task, { kind: "error", text: "API Error: 524 retry 4/5" });
		advance(1 * MIN);

		const waited = await call("external_agent_wait", { taskIds: [silent, noisy], timeout: 60 }, controller.signal);
		assert.equal(waited.details.stalled, "struggling");
		const text = resultText(waited);
		assert.match(text, new RegExp(`${silent} quiet for 30m10s`));
		assert.match(text, new RegExp(`${noisy} only warnings/errors for 30m00s; last meaningful: starting analysis`));
	} finally {
		controller.abort();
		restorePath();
	}
});

test("stall-adaptive: watchdog 0 blocks both early returns", async () => {
	const dir = makeFixtureDir({ claude: GATED_CLAUDE_MOCK });
	const gate = path.join(dir, "gate");
	const restorePath = usePath(dir);
	armNotifications();
	const controller = new AbortController();
	try {
		const taskId = await startGated(gate, { cwd: dir, watchdog: 0 });
		const task = liveTask(taskId);
		advance(1 * MIN);
		record(task, { kind: "error", text: "API Error: 524 retry 1/5" });
		advance(60 * MIN);
		assert.equal(hub.stallTestApi.kind(task, at()), null);
		hub.scanWatchdogs();
		assert.equal(pushes.length, 0);

		const waiting = call("external_agent_wait", { taskIds: [taskId], timeout: 60 }, controller.signal);
		assert.equal(await stillPending(waiting, 500), true, "watchdog 0 means no threshold exists at all");
		controller.abort();
		assert.equal((await waiting).details.aborted, true);
	} finally {
		controller.abort();
		restorePath();
	}
});

// --------------------------------------------------------------------------
// The watchdog push
// --------------------------------------------------------------------------

test("stall-adaptive: the push words a struggle by its last meaningful event", async () => {
	const dir = makeFixtureDir({ claude: GATED_CLAUDE_MOCK });
	const gate = path.join(dir, "gate");
	const restorePath = usePath(dir);
	armNotifications();
	try {
		const taskId = await startGated(gate, { cwd: dir, watchdog: 30 });
		const task = liveTask(taskId);
		advance(10_000);
		record(task, { kind: "message", text: "starting analysis\nof the failing build" });
		advance(50_000);
		record(task, { kind: "error", text: "API Error: 524 retry 1/5" });
		advance(1 * MIN);
		record(task, { kind: "error", text: "API Error: 524 retry 2/5" });
		advance(3 * MIN + 20_000);
		hub.scanWatchdogs();
		assert.equal(pushes.length, 1, "the 5m meaningful gap must push once");
		const push = pushes[0];
		assert.equal(push.details.stall, "struggling");
		assert.equal(push.details.stalledForMs, 5 * MIN + 10_000);
		assert.match(push.content, /is still running but has shown only warnings\/errors for 5m10s/);
		assert.match(push.content, /last meaningful: starting analysis of the failing build/);
		assert.match(push.content, /if the retries are expected/);
	} finally {
		restorePath();
	}
});

test("stall-adaptive: a chatty task is pushed at the 3m floor, a quiet one at its watchdog", async () => {
	const dir = makeFixtureDir({ claude: GATED_CLAUDE_MOCK });
	const gateA = path.join(dir, "gate-a");
	const gateB = path.join(dir, "gate-b");
	const restorePath = usePath(dir);
	armNotifications();
	try {
		const chatty = await startGated(gateA, { cwd: dir, watchdog: 30 });
		const quiet = await startGated(gateB, { cwd: dir, watchdog: 30 });
		const task = liveTask(chatty);
		for (let step = 0; step < 6; step += 1) {
			advance(20_000);
			record(task, { kind: "tool", text: `bash step ${step}` });
		}
		assert.equal(hub.stallTestApi.effectiveMs(task), 3 * MIN);

		advance(2 * MIN + 50_000); // just under the floor
		hub.scanWatchdogs();
		assert.equal(pushes.length, 0, "neither task may be pushed before its threshold");

		advance(20_000); // past the floor for the chatty task, well under 30m for the quiet one
		hub.scanWatchdogs();
		assert.equal(pushes.length, 1, `only the chatty task is due: ${pushes.map((p) => p.content).join(" | ")}`);
		assert.equal(pushes[0].details.taskId, chatty);
		assert.equal(pushes[0].details.stall, "quiet");
		assert.equal(pushes[0].details.stalledForMs, 3 * MIN + 10_000);
		assert.match(pushes[0].content, /has been quiet for 3m10s/);

		advance(25 * MIN); // 30m10s of silence for the quiet task, 28m10s for the chatty one
		hub.scanWatchdogs();
		assert.equal(pushes.length, 3, "the quiet task's own watchdog is 30m, and the chatty one re-fires spaced by its floor");
		const quietPush = pushes.find((push) => push.details.taskId === quiet);
		assert.equal(quietPush.details.stall, "quiet");
		assert.match(quietPush.content, /has been quiet for 30m10s/);
	} finally {
		restorePath();
	}
});

// --------------------------------------------------------------------------
// The shared notice budget
// --------------------------------------------------------------------------

test("stall-adaptive: the wait and the scan share one notice budget per streak", async () => {
	const dir = makeFixtureDir({ claude: GATED_CLAUDE_MOCK });
	const gate = path.join(dir, "gate");
	const restorePath = usePath(dir);
	armNotifications();
	const controller = new AbortController();
	try {
		const taskId = await startGated(gate, { cwd: dir, watchdog: 30 });
		const task = liveTask(taskId);
		advance(10_000);
		record(task, { kind: "message", text: "starting analysis" });
		advance(1 * MIN);
		record(task, { kind: "error", text: "API Error: 524 retry 1/5" });
		advance(1 * MIN);
		record(task, { kind: "error", text: "API Error: 524 retry 2/5" });
		advance(3 * MIN + 30_000);

		// Notice 1: the wait claims it.
		const waited = await call("external_agent_wait", { taskIds: [taskId], timeout: 60 }, controller.signal);
		assert.equal(waited.details.stalled, "struggling");
		hub.scanWatchdogs();
		assert.equal(pushes.length, 0, "the same streak must not be pushed right after the wait claimed it");

		// Notices 2 and 3: spaced by the 5m struggle gap.
		advance(5 * MIN + 1_000);
		hub.scanWatchdogs();
		assert.equal(pushes.length, 1);
		assert.equal(pushes[0].details.stall, "struggling");
		advance(5 * MIN + 1_000);
		hub.scanWatchdogs();
		assert.equal(pushes.length, 2);
		assert.match(pushes[1].content, /stall notice 3; further notices for this stall streak are suppressed/);

		// Capped: error traffic alone must not re-arm the streak.
		advance(5 * MIN + 1_000);
		record(task, { kind: "error", text: "API Error: 524 retry 6/5" });
		hub.scanWatchdogs();
		assert.equal(pushes.length, 2, "errors are noise, not progress: the cap holds");

		// A meaningful event is progress: the streak resets, and a new one can report.
		record(task, { kind: "message", text: "recovered" });
		advance(1 * MIN);
		record(task, { kind: "error", text: "API Error: 524 retry 1/5" });
		advance(5 * MIN + 1_000);
		hub.scanWatchdogs();
		assert.equal(pushes.length, 3, "a message must reset the stall streak");
		assert.doesNotMatch(pushes[2].content, /further notices/);
	} finally {
		controller.abort();
		restorePath();
	}
});
