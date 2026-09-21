/**
 * kimi (Moonshot) ACP session driver, over a fake `kimi` executable.
 *
 * What the driver owes kimi-code 2.0.2, and what this suite pins down:
 *   - the entry is the `acp` SUBCOMMAND — never `--acp` — with no startup flags
 *     at all and the task travelling on the protocol;
 *   - every spawn carries KIMI_CODE_NO_AUTO_UPDATE=1 (a self-update inside a
 *     live session would swap the binary under it), merged over process.env
 *     rather than replacing it, and an ambient KIMI_MODEL_THINKING_EFFORT is
 *     stripped only when this start sets the effort itself;
 *   - the configure phase sets the tier with session/set_mode before the first
 *     prompt (readonly->plan, write->auto, yolo->yolo), and a rejection fails
 *     the start so no prompt runs under another tier. The one tolerated
 *     rejection is `already in <the requested mode>` — the session IS in the
 *     requested state — and it arrives the way the real harness sends it: a
 *     fixed "Internal error" message with the engine's own words in
 *     error.data.details;
 *   - effort goes as session/set_config_option thinking=<level>, sent verbatim
 *     and only when the session advertises that level: kimi's vocabulary is
 *     read off session/new, and an unadvertised level fails the start instead
 *     of being guessed at. The model's own advertisement wins over the session's
 *     when a model request re-advertises the option;
 *   - a model request goes as session/set_config_option model=<raw id> (not
 *     dsh's [provider, model] pair), never as a startup flag;
 *   - a logged-out session/new failure surfaces the `kimi login` hint, and an
 *     unrelated failure keeps its own text;
 *   - usage_update arrives AFTER the turn settles and is still captured: the
 *     driver-level ordering, and the figure in the task's own status line;
 *   - a replayed history burst (session/load + resume) is not read as this
 *     turn's answer;
 *   - kimi has no steer: a steer attempt is refused and no concurrent
 *     session/prompt is sent;
 *   - readonly answers a permission request with the reject option, write/yolo
 *     allow it;
 *   - a dialect that declares no configureSession sends nothing between
 *     session/new and the prompt: the phase is opt-in.
 *
 * No live kimi run happens here. Run with `node --test test/kimi-driver.test.ts`.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ADAPTERS, type AgentEvent, type Effort, type Mode } from "../src/adapters.ts";
import { AcpDriver } from "../src/drivers/acp.ts";
import { SESSION_DRIVERS, type SessionDriver, type TurnOutcome } from "../src/drivers/index.ts";

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

/**
 * A fake kimi ACP harness. It records every frame it receives and answers the
 * handshake; the env switches drive the scenario (held turn, mode rejection,
 * unadvertised effort vocabulary, late usage, history replay, permission
 * prompt, concurrent-prompt rejection, auth failure). It doubles as a bare
 * dialect's harness — the same fixture answers `--acp` — which is how the
 * configure phase's opt-in no-op is exercised.
 */
const KIMI_MOCK = `#!/usr/bin/env node
const fs = require("node:fs");
const log = process.env.KIMI_MOCK_LOG;
function record(entry) { if (log) fs.appendFileSync(log, JSON.stringify(entry) + "\\n"); }
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }

record({ kind: "spawn", argv: process.argv.slice(2), env: {
  KIMI_CODE_NO_AUTO_UPDATE: process.env.KIMI_CODE_NO_AUTO_UPDATE || null,
  KIMI_MODEL_THINKING_EFFORT: process.env.KIMI_MODEL_THINKING_EFFORT || null,
  INHERITED: process.env.KIMI_MOCK_INHERITED || null,
  PATH_PRESENT: Boolean(process.env.PATH),
} });

const hold = process.env.KIMI_MOCK_HOLD === "1";
const sessionNewError = process.env.KIMI_MOCK_SESSION_NEW_ERROR || null;
const setModeError = process.env.KIMI_MOCK_SET_MODE_ERROR || null;
const modeConflict = process.env.KIMI_MOCK_MODE_CONFLICT || null;
const modeConflictJson = process.env.KIMI_MOCK_MODE_CONFLICT_JSON || null;
const failConfig = process.env.KIMI_MOCK_FAIL_CONFIG === "1";
const lateUsage = process.env.KIMI_MOCK_LATE_USAGE === "1";
const historyBurst = process.env.KIMI_MOCK_HISTORY === "1";
const concurrentReject = process.env.KIMI_MOCK_CONCURRENT_REJECT === "1";
const askOptions = process.env.KIMI_MOCK_ASK;
const answer = process.env.KIMI_MOCK_ANSWER || "KIMI_OK";
const initialThinking = process.env.KIMI_MOCK_THINKING_VALUES
  ? JSON.parse(process.env.KIMI_MOCK_THINKING_VALUES)
  : ["off", "low", "medium", "high", "max"];
const modelThinking = process.env.KIMI_MOCK_MODEL_THINKING_VALUES
  ? JSON.parse(process.env.KIMI_MOCK_MODEL_THINKING_VALUES)
  : null;

let thinking = initialThinking;
let buffer = "";
let promptCount = 0;
let activePrompt = null;
let permissionPrompt = null;
let nextPermissionId = 0;

function usageUpdate() {
  send({ jsonrpc: "2.0", method: "session/update", params: {
    sessionId: "s1",
    update: { sessionUpdate: "usage_update", used: 1234, size: 8192 },
  } });
}

function endTurn(promptId) {
  send({ jsonrpc: "2.0", method: "session/update", params: {
    sessionId: "s1",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } },
  } });
  send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  activePrompt = null;
  if (lateUsage) setTimeout(usageUpdate, 25);
}

function askPermission(promptId) {
  const id = nextPermissionId++;
  permissionPrompt = promptId;
  record({ kind: "ask", id });
  send({ jsonrpc: "2.0", id, method: "session/request_permission", params: {
    sessionId: "s1",
    toolCall: { toolCallId: "tc" + id, title: "run a dangerous command" },
    options: JSON.parse(askOptions),
  } });
}

function handle(msg) {
  if (typeof msg.method !== "string") {
    record({ kind: "client_response", id: msg.id, error: msg.error || null, outcome: msg.result ? msg.result.outcome : null });
    if (permissionPrompt !== null) {
      const promptId = permissionPrompt;
      permissionPrompt = null;
      endTurn(promptId);
    }
    return;
  }
  if (msg.method === "initialize") {
    record({ kind: "initialize" });
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {}, list: {}, resume: {} } } } });
    return;
  }
  if (msg.method === "session/new") {
    record({ kind: "session/new", cwd: msg.params.cwd });
    if (sessionNewError) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: sessionNewError } });
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1", configOptions: [
      { id: "model", currentValue: "kimi-k2" },
      { id: "thinking", currentValue: thinking[0], values: thinking },
    ] } });
    if (historyBurst) {
      // What session/load + resume produce: the conversation so far, replayed as
      // ordinary agent_message_chunk updates before anything is asked.
      for (const text of ["replayed: the user's earlier question", "replayed: the earlier answer", "replayed: an earlier tool call"]) {
        send({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: "s1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        } });
      }
    }
    return;
  }
  if (msg.method === "session/set_mode") {
    record({ kind: "set_mode", sessionId: msg.params.sessionId, modeId: msg.params.modeId });
    if (setModeError) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: setModeError } });
      return;
    }
    if (modeConflict) {
      // The real shape of a plan->plan conflict: the engine's own words are
      // quarantined in data.details behind a fixed message (the ACP server maps
      // a thrown engine error with errorToResult -> internalError({details})).
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error", data: { details: "Already in " + modeConflict + " mode" } } });
      return;
    }
    if (modeConflictJson) {
      // A structured data.details: the plumbing must not drop it either.
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error", data: { details: JSON.parse(modeConflictJson) } } });
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { modeId: msg.params.modeId } });
    return;
  }
  if (msg.method === "session/set_config_option") {
    record({ kind: "set_config_option", sessionId: msg.params.sessionId, configId: msg.params.configId, value: msg.params.value });
    if (failConfig) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unknown config option" } });
      return;
    }
    if (msg.params.configId === "model" && modelThinking) thinking = modelThinking;
    send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [
      { id: "model", currentValue: msg.params.configId === "model" ? msg.params.value : "kimi-k2" },
      { id: "thinking", currentValue: thinking[0], values: thinking },
    ] } });
    return;
  }
  if (msg.method === "session/prompt") {
    promptCount += 1;
    record({ kind: "prompt", n: promptCount, sessionId: msg.params.sessionId, text: msg.params.prompt[0].text });
    if (activePrompt !== null && concurrentReject) {
      record({ kind: "concurrent_prompt" });
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "a turn is already running on this session" } });
      return;
    }
    activePrompt = msg.id;
    if (hold) return;
    if (askOptions) { askPermission(msg.id); return; }
    endTurn(msg.id);
    return;
  }
  if (msg.method === "session/cancel") {
    record({ kind: "cancel" });
    return;
  }
  record({ kind: "other", method: msg.method });
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
    handle(msg);
  }
});
`;

interface MockRecord {
	kind: string;
	[k: string]: any;
}

interface Harness {
	driver: SessionDriver;
	records(): MockRecord[];
	outcomes: TurnOutcome[];
	start(input?: { task?: string; mode?: Mode; effort?: Effort; model?: string }): Promise<void>;
	turnOutcome(): Promise<TurnOutcome>;
	stop(): void;
}

function makeFixtureDir(files: Record<string, string>): string {
	const dir = mkdtempSync(path.join(tmpdir(), "kimi-driver-fixture-"));
	for (const [name, source] of Object.entries(files)) {
		const file = path.join(dir, name);
		writeFileSync(file, source);
		chmodSync(file, 0o755);
	}
	return dir;
}

/** Tolerates a torn trailing line while the fixture is still appending. */
function mockRecords(file: string): MockRecord[] {
	if (!existsSync(file)) return [];
	const records: MockRecord[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			records.push(JSON.parse(line));
		} catch {
			/* mid-write tail */
		}
	}
	return records;
}

async function waitFor<T>(label: string, probe: () => T | undefined, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
			timer.unref?.();
		}),
	]);
}

/** Every record of one kind, in arrival order. */
function ofKind(records: MockRecord[], kind: string): MockRecord[] {
	return records.filter((record) => record.kind === kind);
}

/** env mutations restored by stop(), so no test leaks an env var into the next. */
function envGuard(): { set(key: string, value: string | undefined): void; restore(): void } {
	const previous = new Map<string, string | undefined>();
	return {
		set(key, value) {
			if (!previous.has(key)) previous.set(key, process.env[key]);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		},
		restore() {
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		},
	};
}

function usePath(dir: string): () => void {
	const previous = process.env.PATH;
	process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ""}`;
	return () => {
		process.env.PATH = previous;
	};
}

function makeHarness(agent: "kimi" | "codebuddy" = "kimi", mockEnv: Record<string, string> = {}): Harness {
	const dir = makeFixtureDir({ [ADAPTERS[agent].bin]: KIMI_MOCK });
	const logPath = path.join(dir, "session.jsonl");
	const env = envGuard();
	const restorePath = usePath(dir);
	env.set("KIMI_MOCK_LOG", logPath);
	for (const [key, value] of Object.entries(mockEnv)) env.set(key, value);

	const driver = SESSION_DRIVERS[agent]!();
	const outcomes: TurnOutcome[] = [];
	let settleFirst: (outcome: TurnOutcome) => void = () => {};
	const first = new Promise<TurnOutcome>((resolve) => {
		settleFirst = resolve;
	});
	driver.onTurnEnd((outcome) => {
		outcomes.push(outcome);
		settleFirst(outcome);
	});

	return {
		driver,
		outcomes,
		records: () => mockRecords(logPath),
		start: (input = {}) =>
			driver.start({ task: input.task ?? "do the thing", cwd: dir, mode: input.mode ?? "yolo", effort: input.effort, model: input.model }),
		turnOutcome: () => withTimeout(first, "the turn to settle"),
		stop: () => {
			driver.kill();
			env.restore();
			restorePath();
		},
	};
}

async function call(name: string, params: Record<string, unknown>, cwd = process.cwd()): Promise<any> {
	const tool = tools.get(name);
	assert.ok(tool, `missing tool ${name}`);
	return await tool.execute("call-id", params, undefined, undefined, { cwd });
}

// ---------------------------------------------------------------------------
// Spawn: the `acp` subcommand, self-update off
// ---------------------------------------------------------------------------

test("kimi ACP session spawns the `acp` subcommand — never --acp — with the task on the protocol", async () => {
	const harness = makeHarness();
	try {
		await harness.start({ mode: "yolo", task: "audit the repo" });

		assert.deepEqual(harness.driver.argv, ["acp"]);
		const spawn = harness.records()[0];
		assert.equal(spawn.kind, "spawn");
		assert.deepEqual(spawn.argv, ["acp"]);
		assert.equal(spawn.argv.includes("--acp"), false);
		assert.equal(spawn.argv.includes("audit the repo"), false, "the task leaked into the startup argv");
		assert.equal(spawn.argv.includes("--model"), false);
		assert.equal(spawn.argv.includes("--effort"), false);

		// A self-update inside a live session would swap the binary under it.
		assert.equal(spawn.env.KIMI_CODE_NO_AUTO_UPDATE, "1");
		// Merged over process.env, not a replacement: the CLI keeps the
		// environment it has to run in.
		assert.equal(spawn.env.PATH_PRESENT, true);

		const prompt = await waitFor("the first session/prompt", () => ofKind(harness.records(), "prompt")[0]);
		assert.equal(prompt.text, "audit the repo");
		assert.equal(prompt.sessionId, "s1");
	} finally {
		harness.stop();
	}
});

test("kimi ACP session strips an ambient thinking-effort variable only when it sets the effort itself", async () => {
	const withEffort = makeHarness("kimi", { KIMI_MOCK_INHERITED: "marker", KIMI_MODEL_THINKING_EFFORT: "low" });
	try {
		await withEffort.start({ mode: "yolo", effort: "high" });
		const spawn = await waitFor("the spawn", () => withEffort.records()[0]);
		assert.equal(spawn.env.KIMI_MODEL_THINKING_EFFORT, null, "an ambient level would fight the session's own set");
		assert.equal(spawn.env.INHERITED, "marker", "the rest of the environment was replaced, not merged");
	} finally {
		withEffort.stop();
	}

	// No effort requested: the level in the environment is the one the user's own
	// configuration selected, and the receipt says the CLI/config default applies.
	const withoutEffort = makeHarness("kimi", { KIMI_MODEL_THINKING_EFFORT: "low" });
	try {
		await withoutEffort.start({ mode: "yolo" });
		const spawn = await waitFor("the spawn", () => withoutEffort.records()[0]);
		assert.equal(spawn.env.KIMI_MODEL_THINKING_EFFORT, "low");
	} finally {
		withoutEffort.stop();
	}
});

// ---------------------------------------------------------------------------
// The configure phase: mode, effort, model
// ---------------------------------------------------------------------------

test("kimi ACP session sets the tier with session/set_mode before the first prompt", async () => {
	const expected: Array<[Mode, string]> = [
		["readonly", "plan"],
		["write", "auto"],
		["yolo", "yolo"],
	];
	for (const [mode, modeId] of expected) {
		const harness = makeHarness();
		try {
			await harness.start({ mode });
			await waitFor("the first session/prompt", () => ofKind(harness.records(), "prompt")[0]);

			const records = harness.records();
			const configured = ofKind(records, "set_mode");
			assert.equal(configured.length, 1, `${mode} sent ${configured.length} set_mode frames`);
			assert.deepEqual(configured[0], { kind: "set_mode", sessionId: "s1", modeId });
			// Every session boots in `default`, and the tier must be in force
			// before the turn starts.
			assert.deepEqual(records.slice(0, 4).map((record) => record.kind), ["spawn", "initialize", "session/new", "set_mode"]);
			assert.equal(records[4].kind, "prompt", `the prompt left before ${mode} was applied`);
		} finally {
			harness.stop();
		}
	}
});

test("kimi ACP session: `already in plan mode` is tolerated — the session IS in the requested state", async () => {
	// A session that boots in the mode it was left in, set against a non-idempotent
	// set_mode. The engine's words reach the driver only because the plumbing
	// surfaces error.data.details behind the fixed "Internal error" message.
	const harness = makeHarness("kimi", { KIMI_MOCK_MODE_CONFLICT: "plan" });
	try {
		await harness.start({ mode: "readonly", task: "audit only" });
		const prompt = await waitFor("the first session/prompt", () => ofKind(harness.records(), "prompt")[0]);
		assert.equal(prompt.text, "audit only");
		assert.deepEqual(await harness.turnOutcome(), { status: "done" });
	} finally {
		harness.stop();
	}
});

test("kimi ACP session: a mode conflict that names ANOTHER mode fails the start", async () => {
	// "Already in auto mode" while plan was requested: the session is NOT in the
	// requested state, so the tolerance must not swallow it — the prompt would
	// otherwise run under a tier the caller did not ask for.
	const harness = makeHarness("kimi", { KIMI_MOCK_MODE_CONFLICT: "auto" });
	try {
		await assert.rejects(
			() => harness.start({ mode: "readonly" }),
			(err: Error) => {
				assert.match(err.message, /session\/set_mode: Internal error — Already in auto mode/);
				return true;
			},
		);
		assert.deepEqual(ofKind(harness.records(), "prompt"), [], "the turn ran under a tier the caller did not ask for");
	} finally {
		harness.stop();
	}
});

test("kimi ACP session: a structured error.data.details is surfaced too", async () => {
	const harness = makeHarness("kimi", { KIMI_MOCK_MODE_CONFLICT_JSON: JSON.stringify({ reason: "mode_conflict", modeId: "plan" }) });
	try {
		await assert.rejects(
			() => harness.start({ mode: "readonly" }),
			(err: Error) => {
				assert.match(err.message, /session\/set_mode: Internal error — \{"reason":"mode_conflict","modeId":"plan"\}/);
				return true;
			},
		);
		assert.deepEqual(ofKind(harness.records(), "prompt"), []);
	} finally {
		harness.stop();
	}
});

test("kimi ACP session: any other mode rejection fails the start, and no prompt runs", async () => {
	const harness = makeHarness("kimi", { KIMI_MOCK_SET_MODE_ERROR: "unknown modeId: plan" });
	try {
		await assert.rejects(
			() => harness.start({ mode: "readonly" }),
			(err: Error) => {
				// The CLI's own words, not a generic "session failed to start".
				assert.match(err.message, /session\/set_mode: unknown modeId: plan/);
				return true;
			},
		);
		assert.deepEqual(ofKind(harness.records(), "prompt"), [], "the turn ran under a tier the caller did not ask for");
	} finally {
		harness.stop();
	}
});

test("kimi ACP session sets the effort as session/set_config_option thinking=<level> before the prompt", async () => {
	const harness = makeHarness();
	try {
		await harness.start({ mode: "yolo", effort: "high" });
		await waitFor("the first session/prompt", () => ofKind(harness.records(), "prompt")[0]);

		const records = harness.records();
		assert.deepEqual(ofKind(records, "set_config_option"), [
			{ kind: "set_config_option", sessionId: "s1", configId: "thinking", value: "high" },
		]);
		assert.deepEqual(records.slice(0, 5).map((record) => record.kind), [
			"spawn",
			"initialize",
			"session/new",
			"set_mode",
			"set_config_option",
		]);
		assert.equal(records[5].kind, "prompt", "the prompt left before the effort was applied");
	} finally {
		harness.stop();
	}
});

test("kimi ACP session: no effort requested sends no thinking frame", async () => {
	const harness = makeHarness();
	try {
		await harness.start({ mode: "yolo" });
		await waitFor("the first session/prompt", () => ofKind(harness.records(), "prompt")[0]);
		assert.deepEqual(ofKind(harness.records(), "set_config_option"), []);
	} finally {
		harness.stop();
	}
});

test("kimi ACP session: a level the session does not advertise fails the start with the advertised vocabulary", async () => {
	const harness = makeHarness("kimi", { KIMI_MOCK_THINKING_VALUES: JSON.stringify(["off", "low"]) });
	try {
		await assert.rejects(
			() => harness.start({ mode: "yolo", effort: "xhigh" }),
			(err: Error) => {
				assert.match(err.message, /does not offer thinking effort "xhigh"/);
				assert.match(err.message, /session\/new advertised off, low/);
				return true;
			},
		);
		// Nothing was guessed at, and no turn ran at a level the caller did not ask for.
		assert.deepEqual(ofKind(harness.records(), "set_config_option"), []);
		assert.deepEqual(ofKind(harness.records(), "prompt"), []);
	} finally {
		harness.stop();
	}
});

test("kimi ACP session forwards a model request as the raw id on the `model` config option", async () => {
	const harness = makeHarness();
	try {
		await harness.start({ mode: "write", model: "kimi-k2-thinking", effort: "medium" });
		await waitFor("the first session/prompt", () => ofKind(harness.records(), "prompt")[0]);

		const configured = ofKind(harness.records(), "set_config_option");
		assert.deepEqual(
			configured.map((record) => [record.configId, record.value]),
			[
				["model", "kimi-k2-thinking"],
				["thinking", "medium"],
			],
		);
		// The raw id travels on the protocol: dsh's [provider, model] pair is not
		// what this CLI takes, and no startup flag carries it.
		assert.equal(harness.driver.argv.includes("--model"), false);
	} finally {
		harness.stop();
	}
});

test("kimi ACP session: the thinking vocabulary is re-read from the model's own advertisement", async () => {
	// The option is advertised per session for its model, so a model request may
	// re-advertise it: the level below is absent from session/new's list and
	// present only in the list that came back with the model set.
	const harness = makeHarness("kimi", {
		KIMI_MOCK_THINKING_VALUES: JSON.stringify(["off", "low"]),
		KIMI_MOCK_MODEL_THINKING_VALUES: JSON.stringify(["off", "low", "medium", "high", "xhigh", "max"]),
	});
	try {
		await harness.start({ mode: "yolo", model: "kimi-k2-thinking", effort: "high" });
		await waitFor("the first session/prompt", () => ofKind(harness.records(), "prompt")[0]);
		assert.deepEqual(harness.outcomes, []);
		assert.deepEqual(
			ofKind(harness.records(), "set_config_option").map((record) => [record.configId, record.value]),
			[
				["model", "kimi-k2-thinking"],
				["thinking", "high"],
			],
		);
	} finally {
		harness.stop();
	}
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

test("kimi ACP session: a logged-out session/new surfaces the `kimi login` hint", async () => {
	const harness = makeHarness("kimi", { KIMI_MOCK_SESSION_NEW_ERROR: "authentication required: no credentials for this account" });
	try {
		await assert.rejects(
			() => harness.start({ mode: "yolo" }),
			(err: Error) => {
				assert.match(err.message, /authentication required/);
				assert.match(err.message, /Run `kimi login` and retry/);
				return true;
			},
		);
		// No session existed, so nothing was configured and no turn ran.
		assert.deepEqual(ofKind(harness.records(), "set_mode"), []);
		assert.deepEqual(ofKind(harness.records(), "prompt"), []);
	} finally {
		harness.stop();
	}
});

test("kimi ACP session: an unrelated session/new failure keeps its own text and gains no login hint", async () => {
	const harness = makeHarness("kimi", { KIMI_MOCK_SESSION_NEW_ERROR: "workspace path is not a directory" });
	try {
		await assert.rejects(
			() => harness.start({ mode: "yolo" }),
			(err: Error) => {
				assert.match(err.message, /workspace path is not a directory/);
				assert.doesNotMatch(err.message, /kimi login/);
				return true;
			},
		);
	} finally {
		harness.stop();
	}
});

// ---------------------------------------------------------------------------
// Effort/model sets that the harness rejects
// ---------------------------------------------------------------------------

test("kimi ACP session: a rejected set_config_option fails the start with the server's error, and no turn runs", async () => {
	const harness = makeHarness("kimi", { KIMI_MOCK_FAIL_CONFIG: "1" });
	try {
		await assert.rejects(
			() => harness.start({ mode: "yolo", effort: "max" }),
			(err: Error) => {
				assert.match(err.message, /session\/set_config_option: unknown config option/);
				return true;
			},
		);
		assert.deepEqual(ofKind(harness.records(), "prompt"), [], "the turn ran at a default the caller did not ask for");
	} finally {
		harness.stop();
	}
});

// ---------------------------------------------------------------------------
// Usage after the settle
// ---------------------------------------------------------------------------

test("kimi ACP session: a usage_update arriving after the turn settled is still captured", async () => {
	const harness = makeHarness("kimi", { KIMI_MOCK_LATE_USAGE: "1" });
	const events: AgentEvent[] = [];
	harness.driver.onEvent((event) => events.push(event));
	try {
		await harness.start({ mode: "yolo" });
		assert.deepEqual(await harness.turnOutcome(), { status: "done" });

		// kimi reports the context figure after the answer, so the driver must
		// keep reading the stream once the turn is over.
		const usageEvent = await waitFor("the late usage event", () => events.find((event) => event.kind === "usage"));
		assert.equal(usageEvent.text, "ctx=1234/8192");
		assert.equal(harness.outcomes.length, 1, "the usage event arrived before the turn had settled");
		const answerIndex = events.findIndex((event) => event.kind === "message");
		assert.ok(events.indexOf(usageEvent) > answerIndex, "the usage event arrived before the answer");
		assert.equal(harness.driver.alive, true);
	} finally {
		harness.stop();
	}
});

test("kimi ACP session: the late context figure reaches the task's own status line", async () => {
	const dir = makeFixtureDir({ kimi: KIMI_MOCK });
	const restorePath = usePath(dir);
	const env = envGuard();
	env.set("KIMI_MOCK_LOG", path.join(dir, "session.jsonl"));
	env.set("KIMI_MOCK_LATE_USAGE", "1");
	try {
		const started = await call("external_agent_start", { agent: "kimi", task: "answer, then report context", mode: "yolo", cwd: dir, notify: "off" });
		const taskId = started.details.task.taskId;
		assert.equal(started.details.task.transport, "persistent");

		// kimi reports the context figure after the turn has settled, so the poll
		// has to outlast the settle itself: the figure is only lost if it never
		// reaches the task at all.
		let status = "";
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline && !/ctx=1234\/8192/.test(status)) {
			const result = await call("external_agent_status", { taskId });
			status = result.content.map((block: any) => block.text ?? "").join("\n");
			if (!/ctx=1234\/8192/.test(status)) await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.match(status, /ctx=1234\/8192/);
	} finally {
		env.restore();
		restorePath();
	}
});

// ---------------------------------------------------------------------------
// History replay, steering, permissions
// ---------------------------------------------------------------------------

test("kimi ACP session: a replayed history burst is not read as this turn's answer", async () => {
	const harness = makeHarness("kimi", { KIMI_MOCK_HISTORY: "1" });
	const events: AgentEvent[] = [];
	harness.driver.onEvent((event) => events.push(event));
	try {
		await harness.start({ mode: "yolo", task: "answer only this" });
		assert.deepEqual(await harness.turnOutcome(), { status: "done" });
		const messages = events.filter((event) => event.kind === "message");
		assert.deepEqual(messages.map((event) => event.text), ["KIMI_OK"]);
	} finally {
		harness.stop();
	}
});

test("kimi ACP session: a steer attempt is refused and no concurrent prompt is sent", async () => {
	// kimi rejects a concurrent session/prompt with -32600, so the codebuddy
	// fallback would report guidance that never landed.
	const harness = makeHarness("kimi", { KIMI_MOCK_HOLD: "1", KIMI_MOCK_CONCURRENT_REJECT: "1" });
	try {
		await harness.start({ mode: "yolo", task: "hold the turn" });
		await waitFor("the first session/prompt", () => ofKind(harness.records(), "prompt")[0]);

		const result = await harness.driver.steer("change of plan");
		assert.equal(result.accepted, false);
		assert.match(result.reason, /no mid-run steering/);

		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(ofKind(harness.records(), "prompt").length, 1, "a concurrent prompt was sent anyway");
		assert.deepEqual(ofKind(harness.records(), "concurrent_prompt"), []);
	} finally {
		harness.stop();
	}
});

const PERMISSION_WITH_REJECT = JSON.stringify([
	{ optionId: "allow-once-1", name: "Allow once", kind: "allow_once" },
	{ optionId: "reject-once-1", name: "Reject once", kind: "reject_once" },
]);

const PERMISSION_ALLOW_ONLY = JSON.stringify([
	{ optionId: "allow-once-1", name: "Allow once", kind: "allow_once" },
	{ optionId: "allow-always-1", name: "Always allow", kind: "allow_always" },
]);

/** Start a session whose fixture raises one permission request inside the turn. */
async function answerPermission(mode: Mode, options: string): Promise<MockRecord> {
	const harness = makeHarness("kimi", { KIMI_MOCK_ASK: options });
	try {
		await harness.start({ mode });
		return await waitFor("the permission answer", () => ofKind(harness.records(), "client_response")[0]);
	} finally {
		harness.stop();
	}
}

test("kimi ACP session readonly: a permission request is answered by selecting the reject option", async () => {
	const response = await answerPermission("readonly", PERMISSION_WITH_REJECT);
	assert.equal(response.error, null);
	assert.deepEqual(response.outcome, { outcome: "selected", optionId: "reject-once-1" });
});

test("kimi ACP session readonly: with no reject option offered, the request answers cancelled", async () => {
	const response = await answerPermission("readonly", PERMISSION_ALLOW_ONLY);
	assert.equal(response.error, null);
	assert.deepEqual(response.outcome, { outcome: "cancelled" });
});

test("kimi ACP session write and yolo: a permission request is allowed, as those tiers permit it", async () => {
	for (const mode of ["write", "yolo"] as Mode[]) {
		const response = await answerPermission(mode, PERMISSION_WITH_REJECT);
		assert.equal(response.error, null, `${mode} did not answer the permission request`);
		assert.deepEqual(response.outcome, { outcome: "selected", optionId: "allow-once-1" }, `${mode} did not allow the request`);
	}
});

// ---------------------------------------------------------------------------
// The configure phase is opt-in and runs once
// ---------------------------------------------------------------------------

test("configureSession: a dialect that declares none sends nothing between session/new and the prompt", async () => {
	// reasonix and codebuddy declare no configureSession, so their start path is
	// unchanged: spawn → initialize → session/new → prompt. The bare dialect here
	// keeps the default ACP entry flag, which is what makes it their stand-in.
	const dir = makeFixtureDir({ codebuddy: KIMI_MOCK });
	const logPath = path.join(dir, "session.jsonl");
	const restorePath = usePath(dir);
	const env = envGuard();
	env.set("KIMI_MOCK_LOG", logPath);
	const driver = new AcpDriver({ id: "codebuddy", baseArgv: () => [] });
	try {
		await driver.start({ task: "just answer", cwd: dir, mode: "yolo" });
		await waitFor("the first session/prompt", () => ofKind(mockRecords(logPath), "prompt")[0]);
		assert.deepEqual(driver.argv, ["--acp"]);
		const kinds = mockRecords(logPath).map((record) => record.kind);
		assert.deepEqual(kinds.slice(0, 4), ["spawn", "initialize", "session/new", "prompt"]);
	} finally {
		driver.kill();
		env.restore();
		restorePath();
	}
});

test("configureSession: the phase runs once per session, and a follow-up turn does not repeat it", async () => {
	const harness = makeHarness();
	try {
		await harness.start({ mode: "write", model: "kimi-k2-thinking", effort: "low", task: "first" });
		assert.deepEqual(await harness.turnOutcome(), { status: "done" });

		await harness.driver.followUp("second");
		await waitFor("the second turn to settle", () => (harness.outcomes.length >= 2 ? harness.outcomes[1] : undefined));
		assert.deepEqual(harness.outcomes, [
			{ status: "done" },
			{ status: "done" },
		]);

		const records = harness.records();
		assert.deepEqual(records.filter((record) => record.kind === "prompt").map((record) => record.text), ["first", "second"]);
		assert.equal(ofKind(records, "set_mode").length, 1, "the mode was set again for the second turn");
		assert.equal(ofKind(records, "set_config_option").length, 2, "the model/effort were set again for the second turn");
	} finally {
		harness.stop();
	}
});
