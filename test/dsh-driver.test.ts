/**
 * dsh (DeepSeek harness) ACP session driver, over a fake `dsh` executable.
 *
 * What the driver owes dsh 0.1.5-rc.2, and what this suite pins down:
 *   - the entry is a profile, `--profile acp`, never a bare `--acp`, followed by
 *     the `--patch` overlay that keeps dsh's settings row off the user's own
 *     settings document, and the task travels on the protocol rather than in the
 *     startup argv;
 *   - every spawn carries the tier as DSH_PERMISSION_MODE and DELETES an
 *     inherited DSH_HOME (the home is the shared ~/.dsh the overlay was written
 *     into), merged over process.env (never replacing it);
 *   - effort has no flag on this CLI, so it is set on the session as
 *     reasoning_effort AFTER session/new, mapped off|low|high|max — and no
 *     frame at all is sent when the caller requested no effort;
 *   - a rejected set_config_option fails the start with the server's own error,
 *     so a turn never runs at a default the caller did not ask for;
 *   - a settings document or overlay that cannot be created fails the start
 *     before anything is spawned: without them the requested tier stops binding;
 *   - permission requests are answered mechanically: readonly selects the
 *     reject option (or cancels when the server offers none), write/yolo allow
 *     — and an escalation is answered even when the harness, numbering its own
 *     requests independently, happens to use an id the client is still waiting
 *     on (a request is never a response);
 *   - a harness that advertises no steer method steers by sending a second
 *     session/prompt on the active session (a harness that DOES advertise one
 *     keeps using it — the reasonix regression at the end).
 *
 * No live dsh run happens here: the protocol client talks to the fixture, and
 * provisioning is exercised against a temporary HOME. The composition anchor's
 * probe is memoized per process and would otherwise let whichever fixture `dsh`
 * happens to be first on PATH answer for every test after it, so the suite arms
 * it with a clean composition (see armedAnchor) and leaves the anchor's own
 * behaviour to test/dsh.test.ts.
 *
 * Run with `node --test test/dsh-driver.test.ts`.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ADAPTERS, EFFORT_LEVELS, type Effort, type Mode } from "../src/adapters.ts";
import {
	DSH_OVERLAY_NAME,
	DSH_SETTINGS_DOC_NAME,
	dshCompositionWarnings,
	dshSettingsDocPath,
	resetDshCompositionGuard,
} from "../src/dsh-launch.ts";
import { SESSION_DRIVERS, type SessionDriver, type TurnOutcome } from "../src/drivers/index.ts";

/**
 * A fake ACP harness for both dsh and reasonix. It records every frame it
 * receives and answers the standard handshake; the env switches drive the
 * scenario (held turn, permission prompt, rejected config option, advertised
 * steer method).
 */
const ACP_MOCK = `#!/usr/bin/env node
const fs = require("node:fs");
const log = process.env.DSH_MOCK_LOG;
function record(entry) { if (log) fs.appendFileSync(log, JSON.stringify(entry) + "\\n"); }
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }

record({
  kind: "spawn",
  argv: process.argv.slice(2),
  env: {
    DSH_HOME: process.env.DSH_HOME || null,
    DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE || null,
    INHERITED: process.env.DSH_MOCK_INHERITED || null,
    PATH_PRESENT: Boolean(process.env.PATH),
  },
});

const hold = Number(process.env.DSH_MOCK_HOLD || "0");
const permissionOptions = process.env.DSH_MOCK_PERMISSION_OPTIONS;
const escalations = Number(process.env.DSH_MOCK_ESCALATIONS || "0");
const failConfig = process.env.DSH_MOCK_FAIL_CONFIG === "1";
const steerMethod = process.env.DSH_MOCK_STEER_METHOD;

const heldPrompts = [];
const permissionTurns = new Map();
// The harness numbers its OWN requests from its own counter, the way an ACP
// agent does; the client's ids are a separate space.
let nextPermissionId = 0;
let escalationsLeft = 0;
let promptCount = 0;
let buffer = "";

function endTurn(promptId) {
  send({ jsonrpc: "2.0", method: "session/update", params: {
    sessionId: "s1",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "DSH_OK" } },
  } });
  send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
}

function askPermission(promptId) {
  const id = nextPermissionId++;
  permissionTurns.set(id, promptId);
  record({ kind: "ask", id });
  send({ jsonrpc: "2.0", id, method: "session/request_permission", params: {
    sessionId: "s1",
    toolCall: { toolCallId: "tc" + id, title: "escalate: write outside the workspace" },
    options: JSON.parse(permissionOptions),
  } });
}

function handle(msg) {
  if (typeof msg.method !== "string") {
    // A response to a request the fixture sent (a permission request).
    record({ kind: "client_response", id: msg.id, error: msg.error || null, outcome: msg.result ? msg.result.outcome : null });
    if (permissionTurns.has(msg.id)) {
      const promptId = permissionTurns.get(msg.id);
      permissionTurns.delete(msg.id);
      // A harness walks its escalations one at a time: the next request goes
      // out only once the previous one is answered.
      if (escalationsLeft > 0) {
        escalationsLeft -= 1;
        askPermission(promptId);
      } else {
        endTurn(promptId);
      }
    }
    return;
  }
  if (msg.method === "initialize") {
    const capabilities = { sessionCapabilities: { close: {}, list: {}, resume: {} } };
    if (steerMethod) capabilities._meta = { "test.io": { sessionSteer: { method: steerMethod } } };
    record({ kind: "initialize", advertisedSteerMethod: steerMethod || null });
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: capabilities } });
    return;
  }
  if (msg.method === "session/new") {
    record({ kind: "session/new", cwd: msg.params.cwd, mcpServers: msg.params.mcpServers });
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1", configOptions: [
      { id: "model", currentValue: "default" },
      { id: "reasoning_effort", currentValue: "off" },
    ] } });
    return;
  }
  if (msg.method === "session/set_config_option") {
    record({ kind: "set_config_option", sessionId: msg.params.sessionId, configId: msg.params.configId, value: msg.params.value });
    if (failConfig) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unknown config option" } });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [{ id: msg.params.configId, currentValue: msg.params.value }] } });
    }
    return;
  }
  if (msg.method === "session/prompt") {
    promptCount += 1;
    record({ kind: "prompt", n: promptCount, sessionId: msg.params.sessionId, text: msg.params.prompt[0].text });
    if (promptCount <= hold) { heldPrompts.push(msg.id); return; }
    const held = heldPrompts.shift();
    if (held !== undefined) {
      // The held turn resolves when a later prompt (the steer) arrives; the
      // steer itself is the next turn, which this fixture never runs.
      endTurn(held);
      return;
    }
    if (escalations > 0) {
      escalationsLeft = escalations - 1;
      askPermission(msg.id);
      return;
    }
    if (permissionOptions) askPermission(msg.id);
    else endTurn(msg.id);
    return;
  }
  // Anything else (reasonix's vendor steer method): record it and accept.
  record({ kind: "steer_method", method: msg.method, sessionId: msg.params && msg.params.sessionId, text: msg.params && msg.params.prompt ? msg.params.prompt[0].text : null });
  send({ jsonrpc: "2.0", id: msg.id, result: { disposition: "queued" } });
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
	start(input?: { task?: string; mode?: Mode; effort?: Effort }): Promise<void>;
	turnOutcome(): Promise<TurnOutcome>;
	stop(): void;
}

function makeFixtureDir(files: Record<string, string>): string {
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-driver-fixture-"));
	for (const [name, source] of Object.entries(files)) {
		const file = path.join(dir, name);
		writeFileSync(file, source);
		chmodSync(file, 0o755);
	}
	return dir;
}

/** A fake user home. Nothing is pre-created: provisioning makes the shared home. */
function makeHome(): string {
	return mkdtempSync(path.join(tmpdir(), "dsh-driver-home-"));
}

/** The shared home under a fake user home, and the two files provisioning puts in it. */
function sharedHome(home: string): string {
	return path.join(home, ".dsh");
}

function settingsDocIn(home: string): string {
	return dshSettingsDocPath(sharedHome(home));
}

function overlayIn(home: string): string {
	return path.join(sharedHome(home), DSH_OVERLAY_NAME);
}

/**
 * A composed config that satisfies every anchor check, as the probe would print
 * it for these fixture files. The anchor itself is test/dsh.test.ts's subject;
 * this suite needs it silent so that the fixture `dsh` — which answers the ACP
 * handshake, not `--dump-config` — is never asked to compose anything.
 */
function armedAnchor(home: string): void {
	const settingsDoc = settingsDocIn(home);
	resetDshCompositionGuard();
	dshCompositionWarnings({
		overlay: overlayIn(home),
		settingsDoc,
		run: () =>
			[
				`# == @deepseek-ai/dsh-base, patched by ${overlayIn(home)}`,
				"- id: settings",
				"  name: '@deepseek-ai/dsh-settings-file'",
				"  config:",
				`    path: ${settingsDoc}`,
				"- id: sandbox-policy",
				"  config:",
				"    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'",
				"- id: approval",
				"  config:",
				"    policy: !!js process.env.DSH_PERMISSION_MODE === 'danger-full-access' ? 'never' : 'ask'",
				"",
			].join("\n"),
	});
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

function makeHarness(agent: "dsh" | "reasonix", options: { home?: string; mockEnv?: Record<string, string> } = {}): Harness {
	const bin = ADAPTERS[agent].bin;
	const dir = makeFixtureDir({ [bin]: ACP_MOCK });
	const logPath = path.join(dir, "session.jsonl");
	const previous = new Map<string, string | undefined>();
	const setEnv = (key: string, value: string | undefined) => {
		if (!previous.has(key)) previous.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	};
	setEnv("PATH", `${dir}${path.delimiter}${process.env.PATH ?? ""}`);
	setEnv("DSH_MOCK_LOG", logPath);
	if (options.home) setEnv("HOME", options.home);
	for (const [key, value] of Object.entries(options.mockEnv ?? {})) setEnv(key, value);
	// The anchor's probe is memoized for the whole process: arm it for this
	// fixture home so the fixture `dsh` is never asked to compose a config.
	if (agent === "dsh" && options.home) armedAnchor(options.home);

	const driver = SESSION_DRIVERS[agent]!();
	const settled = new Promise<TurnOutcome>((resolve) => driver.onTurnEnd(resolve));

	return {
		driver,
		records: () => mockRecords(logPath),
		start: (input = {}) =>
			driver.start({ task: input.task ?? "do the thing", cwd: dir, mode: input.mode ?? "yolo", effort: input.effort }),
		turnOutcome: () => withTimeout(settled, "the turn to settle"),
		stop: () => {
			driver.kill();
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		},
	};
}

/** Every record of one kind, in arrival order. */
function ofKind(records: MockRecord[], kind: string): MockRecord[] {
	return records.filter((record) => record.kind === kind);
}

/** The env the suite inherited; a harness that leaks a variable fails the next test. */
const INHERITED_MOCK_LOG = process.env.DSH_MOCK_LOG;

afterEach(() => {
	assert.equal(process.env.DSH_MOCK_LOG, INHERITED_MOCK_LOG, "a harness leaked DSH_MOCK_LOG");
});

// ---------------------------------------------------------------------------
// argv and environment
// ---------------------------------------------------------------------------

test("dsh ACP session spawns `--profile acp --patch <overlay>` — never --acp — with the task on the protocol", async () => {
	const home = makeHome();
	const harness = makeHarness("dsh", { home });
	try {
		await harness.start({ mode: "yolo", task: "audit the repo" });

		// The receipt's argv (what the caller is told) and the argv the process
		// actually got are the same profile entry, with the overlay that keeps
		// dsh's settings row off the user's own settings document.
		const expected = ["--profile", "acp", "--patch", overlayIn(home)];
		assert.deepEqual(harness.driver.argv, expected);
		const spawn = harness.records()[0];
		assert.equal(spawn.kind, "spawn");
		assert.deepEqual(spawn.argv, expected);
		assert.equal(spawn.argv.includes("--acp"), false);

		// The overlay is provisioned, and dsh's settings row is pinned to an
		// empty document rather than to the user's settings.yaml.
		assert.equal(readFileSync(settingsDocIn(home), "utf8"), "");
		assert.match(readFileSync(overlayIn(home), "utf8"), new RegExp(`path: ${settingsDocIn(home)}`));

		// No prompt, model or effort flag in the startup argv: the task is a
		// protocol frame, and this CLI has no effort flag at all.
		assert.equal(spawn.argv.includes("audit the repo"), false);
		assert.equal(spawn.argv.includes("--effort"), false);

		const prompts = await waitFor("the first session/prompt", () => ofKind(harness.records(), "prompt")[0]);
		assert.equal(prompts.text, "audit the repo");
	} finally {
		harness.stop();
	}
});

test("dsh ACP session env: the mode's DSH_PERMISSION_MODE, no inherited DSH_HOME, merged over process.env", async () => {
	const home = makeHome();
	const modes: Array<[Mode, string]> = [
		["readonly", "read-only"],
		["write", "workspace-write"],
		["yolo", "danger-full-access"],
	];
	for (const [mode, permission] of modes) {
		// DSH_HOME comes from the environment on purpose: it must not survive
		// into the child, where it would resolve a home nothing provisioned.
		const harness = makeHarness("dsh", {
			home,
			mockEnv: { DSH_MOCK_INHERITED: `marker-${mode}`, DSH_HOME: "/somewhere/else/.dsh" },
		});
		try {
			await harness.start({ mode });
			const spawn = await waitFor(`the ${mode} spawn`, () => harness.records()[0]);
			assert.equal(spawn.env.DSH_HOME, null, `${mode} carried an inherited DSH_HOME`);
			assert.equal(spawn.env.DSH_PERMISSION_MODE, permission, `${mode} did not get its tier`);
			// Merged over process.env, not a replacement: the CLI keeps the
			// environment it has to run in.
			assert.equal(spawn.env.PATH_PRESENT, true, `${mode} lost PATH`);
			assert.equal(spawn.env.INHERITED, `marker-${mode}`, `${mode} lost an inherited variable`);
		} finally {
			harness.stop();
		}
	}
});

test("dsh ACP session: an unusable shared home refuses the session start instead of running under the user's settings", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "dsh-driver-blocked-"));
	// A file where the shared home would have to be: neither of provisioning's
	// two files can exist, and without them dsh would read the user's own
	// settings document, whose permission.defaultPreset outranks the tier.
	const blocked = sharedHome(root);
	writeFileSync(blocked, "in the way\n");
	const harness = makeHarness("dsh", { home: root });
	// No clean anchor here: this start must reach provisioning and fail there,
	// before anything consults the composition.
	resetDshCompositionGuard();
	try {
		await assert.rejects(
			() => harness.start({ mode: "yolo" }),
			(err: Error) => {
				assert.match(err.message, /could not create dsh's shared home/);
				assert.ok(err.message.includes(blocked), "the refusal names the path it could not use");
				return true;
			},
		);
		// Nothing was spawned, and the file it could not replace is untouched.
		assert.deepEqual(ofKind(harness.records(), "spawn"), []);
		assert.equal(readFileSync(blocked, "utf8"), "in the way\n");
	} finally {
		harness.stop();
	}
});

// ---------------------------------------------------------------------------
// Effort over session/set_config_option
// ---------------------------------------------------------------------------

test("dsh ACP session sets reasoning_effort after session/new, mapped for every level", async () => {
	const home = makeHome();
	const expected: Array<[Effort, string]> = [
		["off", "off"],
		["minimal", "low"],
		["low", "low"],
		["medium", "high"],
		["high", "high"],
		["xhigh", "max"],
		["max", "max"],
	];
	assert.deepEqual(EFFORT_LEVELS, expected.map(([effort]) => effort));
	for (const [effort, token] of expected) {
		const harness = makeHarness("dsh", { home });
		try {
			await harness.start({ mode: "yolo", effort });
			await waitFor(`the turn for effort ${effort} to start`, () => ofKind(harness.records(), "prompt")[0]);

			const records = harness.records();
			const configured = ofKind(records, "set_config_option");
			assert.equal(configured.length, 1, `${effort} sent ${configured.length} set_config_option frames`);
			assert.deepEqual(configured[0], {
				kind: "set_config_option",
				sessionId: "s1",
				configId: "reasoning_effort",
				value: token,
			});

			// The CLI only accepts the config once the session exists, and the
			// turn must not start before the level is set.
			assert.deepEqual(records.slice(0, 4).map((record) => record.kind), [
				"spawn",
				"initialize",
				"session/new",
				"set_config_option",
			]);
			assert.equal(records[4].kind, "prompt", "the prompt left before the effort was applied");
			// Never an effort flag on this CLI.
			assert.equal(harness.driver.argv.includes("--effort"), false);
		} finally {
			harness.stop();
		}
	}
});

test("dsh ACP session: no effort requested sends no set_config_option frame", async () => {
	const home = makeHome();
	const harness = makeHarness("dsh", { home });
	try {
		await harness.start({ mode: "yolo" });
		await waitFor("the first session/prompt", () => ofKind(harness.records(), "prompt")[0]);
		assert.deepEqual(ofKind(harness.records(), "set_config_option"), []);
		assert.equal(harness.driver.argv.includes("--effort"), false);
	} finally {
		harness.stop();
	}
});

test("dsh ACP session: a rejected set_config_option fails the start with the server's error, and no turn runs", async () => {
	const home = makeHome();
	const harness = makeHarness("dsh", { home, mockEnv: { DSH_MOCK_FAIL_CONFIG: "1" } });
	try {
		await assert.rejects(
			async () => await harness.start({ mode: "yolo", effort: "max" }),
			(err: Error) => {
				// The CLI's own words, not a generic "session failed to start".
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
// Permissions
// ---------------------------------------------------------------------------

const PERMISSION_WITH_REJECT = JSON.stringify([
	{ optionId: "allow-once-1", name: "Allow once", kind: "allow_once" },
	{ optionId: "reject-once-1", name: "Reject once", kind: "reject_once" },
]);

const PERMISSION_ALLOW_ONLY = JSON.stringify([
	{ optionId: "allow-once-1", name: "Allow once", kind: "allow_once" },
	{ optionId: "allow-always-1", name: "Always allow", kind: "allow_always" },
]);

/** Start a session whose fixture raises one sandbox-escalation permission request. */
async function answerPermission(mode: Mode, options: string): Promise<MockRecord> {
	const home = makeHome();
	const harness = makeHarness("dsh", { home, mockEnv: { DSH_MOCK_PERMISSION_OPTIONS: options } });
	try {
		await harness.start({ mode });
		return await waitFor("the permission answer", () => ofKind(harness.records(), "client_response")[0]);
	} finally {
		harness.stop();
	}
}

test("dsh ACP session readonly: a sandbox escalation is answered by selecting the reject option", async () => {
	const response = await answerPermission("readonly", PERMISSION_WITH_REJECT);
	assert.equal(response.error, null);
	assert.deepEqual(response.outcome, { outcome: "selected", optionId: "reject-once-1" });
});

test("dsh ACP session readonly: with no reject option offered, the escalation answers cancelled", async () => {
	const response = await answerPermission("readonly", PERMISSION_ALLOW_ONLY);
	assert.equal(response.error, null);
	assert.deepEqual(response.outcome, { outcome: "cancelled" });
});

test("dsh ACP session write and yolo: a sandbox escalation is allowed", async () => {
	for (const mode of ["write", "yolo"] as Mode[]) {
		const response = await answerPermission(mode, PERMISSION_WITH_REJECT);
		assert.equal(response.error, null, `${mode} did not answer the permission request`);
		assert.deepEqual(response.outcome, { outcome: "selected", optionId: "allow-once-1" }, `${mode} did not allow the escalation`);
	}
});

test("dsh ACP session: repeated escalations are all answered, and none is read as the prompt's reply", async () => {
	// The harness numbers its own requests from its own counter, so while the
	// client holds session/prompt as its own 3rd request, the harness's 4th
	// escalation carries an id the client is still waiting on. A message with a
	// method is never a reply: all four escalations must be answered, and the
	// turn must end on the harness's own end_turn rather than on the approval
	// request that shares the prompt's id.
	const home = makeHome();
	const harness = makeHarness("dsh", {
		home,
		mockEnv: { DSH_MOCK_PERMISSION_OPTIONS: PERMISSION_WITH_REJECT, DSH_MOCK_ESCALATIONS: "4" },
	});
	try {
		await harness.start({ mode: "readonly" });
		await waitFor("the first escalation", () => ofKind(harness.records(), "ask")[0]);

		const outcome = await harness.turnOutcome();
		const records = harness.records();
		assert.deepEqual(ofKind(records, "ask").map((ask) => ask.id), [0, 1, 2, 3]);
		const answers = ofKind(records, "client_response");
		assert.equal(answers.length, 4, "the turn settled before every escalation had been answered");
		for (const answer of answers) {
			assert.equal(answer.error, null);
			assert.deepEqual(answer.outcome, { outcome: "selected", optionId: "reject-once-1" });
		}
		assert.deepEqual(outcome, { status: "done" });
	} finally {
		harness.stop();
	}
});

// ---------------------------------------------------------------------------
// Steering
// ---------------------------------------------------------------------------

test("dsh ACP session: a steer with no advertised method lands as a second session/prompt", async () => {
	const home = makeHome();
	const harness = makeHarness("dsh", { home, mockEnv: { DSH_MOCK_HOLD: "1" } });
	try {
		await harness.start({ mode: "yolo", task: "audit the parser" });
		await waitFor("the first session/prompt", () => ofKind(harness.records(), "prompt")[0]);

		const result = await harness.driver.steer("focus on the lexer");
		assert.equal(result.accepted, true);
		assert.match(result.note ?? "", /extra prompt/);

		const prompts = await waitFor("the steer to land as a second session/prompt", () => {
			const list = ofKind(harness.records(), "prompt");
			return list.length >= 2 ? list : undefined;
		});
		assert.deepEqual(prompts.map((prompt) => prompt.text), ["audit the parser", "focus on the lexer"]);
		assert.equal(prompts[1].sessionId, "s1");
		// No vendor steer method was invented for a harness that advertises none.
		assert.deepEqual(ofKind(harness.records(), "steer_method"), []);
		assert.deepEqual(ofKind(harness.records(), "initialize")[0].advertisedSteerMethod, null);

		// The held turn resolves once the steer arrives, and the session stays up
		// for a follow-up.
		assert.deepEqual(await harness.turnOutcome(), { status: "done" });
		assert.equal(harness.driver.alive, true);
	} finally {
		harness.stop();
	}
});

test("reasonix ACP session keeps steering through its advertised vendor method", async () => {
	// Regression guard: the codebuddy/dsh fallback must not swallow a harness
	// that advertises a steer method of its own.
	const harness = makeHarness("reasonix", {
		mockEnv: { DSH_MOCK_HOLD: "1", DSH_MOCK_STEER_METHOD: "reasonix/session/steer" },
	});
	try {
		await harness.start({ mode: "yolo", task: "audit the parser" });
		await waitFor("the first session/prompt", () => ofKind(harness.records(), "prompt")[0]);

		const result = await harness.driver.steer("focus on the lexer");
		assert.equal(result.accepted, true);
		assert.match(result.note ?? "", /disposition: queued/);

		const steer = await waitFor("the vendor steer call", () => ofKind(harness.records(), "steer_method")[0]);
		assert.equal(steer.method, "reasonix/session/steer");
		assert.equal(steer.text, "focus on the lexer");
		assert.equal(steer.sessionId, "s1");
		assert.equal(ofKind(harness.records(), "prompt").length, 1, "the vendor method was replaced by a second prompt");
	} finally {
		harness.stop();
	}
});
