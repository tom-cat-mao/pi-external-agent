/**
 * dsh (DeepSeek harness) foundation, covering the pieces the rest of the dsh
 * work depends on:
 *   - the one-shot adapter: argv, per-mode env, effort tokens, refusals;
 *   - ensureDshHome: lazy, idempotent provisioning with injectable paths;
 *   - the generalized ACP entry argv and the dialect env/effort hooks;
 *   - the per-spawn env plumbing of both transports, and the hub's refusal path.
 *
 * No live dsh run happens here: the ACP and one-shot paths run against mock
 * `dsh`/`kimi` executables placed on PATH, and the pure functions are called
 * directly. The dsh facts asserted below were verified by hand against
 * dsh 0.1.5-rc.2.
 *
 * Run with `node --test test/dsh.test.ts`.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ADAPTERS, EFFORT_LEVELS, dshEffortToken, dshPermissionMode, type Effort } from "../src/adapters.ts";
import { SESSION_DRIVERS } from "../src/drivers/index.ts";
import { DSH_HARNESS_HOME_NAME, ensureDshHome } from "../src/dsh-home.ts";

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

function makeFixtureDir(files: Record<string, string>): string {
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-fixture-"));
	for (const [name, source] of Object.entries(files)) {
		const file = path.join(dir, name);
		writeFileSync(file, source);
		chmodSync(file, 0o755);
	}
	return dir;
}

/** A fake user home; `dsh web`'s output file exists only when asked for. */
function makeHome(withCredentials: boolean): string {
	const home = mkdtempSync(path.join(tmpdir(), "dsh-user-home-"));
	if (withCredentials) {
		mkdirSync(path.join(home, ".dsh"), { recursive: true });
		writeFileSync(path.join(home, ".dsh", ".credentials.yaml"), "token: test\n");
	}
	return home;
}

function mockLog(file: string): any[] {
	if (!existsSync(file)) return [];
	const text = readFileSync(file, "utf8").trim();
	return text ? text.split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

// ---------------------------------------------------------------------------
// The one-shot adapter
// ---------------------------------------------------------------------------

test("dsh adapter: yolo default, every tier enforced, all seven effort levels", () => {
	const adapter = ADAPTERS.dsh;
	assert.equal(adapter.bin, "dsh");
	assert.equal(adapter.defaultMode, "yolo");
	assert.equal(adapter.maxMode, "yolo");
	assert.equal(adapter.minMode, undefined);
	assert.equal(adapter.enforcesReadOnly, true);
	assert.equal(adapter.driverEnforcedReadOnly, undefined);
	assert.deepEqual(adapter.supportedEfforts, EFFORT_LEVELS);
	assert.equal(adapter.session?.steer, true);
	assert.equal(adapter.session?.followUp, true);
	assert.match(adapter.session?.steerNote ?? "", /second session\/prompt/);
	assert.match(adapter.sessionPolicy!("readonly"), /DSH_PERMISSION_MODE=read-only/);
	assert.match(adapter.sessionPolicy!("write"), /DSH_PERMISSION_MODE=workspace-write/);
	assert.match(adapter.sessionPolicy!("yolo"), /DSH_PERMISSION_MODE=danger-full-access/);
});

test("dsh one-shot dispatch: profile argv, dedicated harness home, and the mode's permission env", () => {
	const home = makeHome(true);
	const restoreHome = withEnv({ HOME: home });
	try {
		const readonly = ADAPTERS.dsh.buildDispatch({ task: "audit the repo", cwd: "/tmp", mode: "readonly" });
		assert.deepEqual(readonly.argv, ["--profile", "headless", "audit the repo"]);
		assert.equal(readonly.promptArgIndex, 2);
		assert.equal(readonly.argv[readonly.promptArgIndex], "audit the repo");
		assert.equal(readonly.cwdForwardedToCli, false);
		assert.equal(readonly.refusal, undefined);
		assert.equal(readonly.env?.DSH_HOME, path.join(home, DSH_HARNESS_HOME_NAME));
		assert.equal(readonly.env?.DSH_PERMISSION_MODE, "read-only");
		assert.equal(readonly.readOnlyEnforcement, "harness-enforced");
		assert.match(readonly.effectivePolicy ?? "", /DSH_PERMISSION_MODE=read-only/);
		assert.match(readonly.effectivePolicy ?? "", /shared ~\/\.dsh settings outrank/);

		// Provisioning ran: the harness home exists and its credentials entry is a
		// symlink to the user's own file — never a copy.
		const link = path.join(home, DSH_HARNESS_HOME_NAME, ".credentials.yaml");
		assert.equal(lstatSync(link).isSymbolicLink(), true);
		assert.equal(readlinkSync(link), path.join(home, ".dsh", ".credentials.yaml"));

		const write = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode: "write" });
		assert.equal(write.env?.DSH_PERMISSION_MODE, "workspace-write");
		assert.equal(write.readOnlyEnforcement, "not-applicable");

		const yolo = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode: "yolo" });
		assert.equal(yolo.env?.DSH_PERMISSION_MODE, "danger-full-access");
		assert.equal(yolo.readOnlyEnforcement, "not-applicable");
	} finally {
		restoreHome();
	}
});

test("dsh permission vocabulary is codex's", () => {
	assert.equal(dshPermissionMode("readonly"), "read-only");
	assert.equal(dshPermissionMode("write"), "workspace-write");
	assert.equal(dshPermissionMode("yolo"), "danger-full-access");
});

test("dshEffortToken maps all seven levels onto the ACP vocabulary off|low|high|max", () => {
	const expected: Array<[Effort, string]> = [
		["off", "off"],
		["minimal", "low"],
		["low", "low"],
		["medium", "high"],
		["high", "high"],
		["xhigh", "max"],
		["max", "max"],
	];
	assert.deepEqual(EFFORT_LEVELS.map((level) => [level, dshEffortToken(level)]), expected);
});

test("dsh one-shot refuses an effort request instead of dropping it", () => {
	// No credentials on purpose: the refusal must be about the transport, not about
	// this machine's provisioning state.
	const home = makeHome(false);
	const restoreHome = withEnv({ HOME: home });
	try {
		const dispatch = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode: "yolo", effort: "high" });
		assert.match(dispatch.refusal ?? "", /only inside an ACP session/);
		assert.match(dispatch.refusal ?? "", /one-shot headless profile has no effort knob/);
		assert.equal(dispatch.argv.includes("--effort"), false);
		assert.deepEqual(dispatch.argv, ["--profile", "headless", "t"]);
		assert.equal(dispatch.effort.requested, "high");
		assert.equal(dispatch.effort.forwarded, false);
		assert.match(dispatch.effort.note, /NOT forwarded/);
		assert.equal(dispatch.env, undefined);
	} finally {
		restoreHome();
	}
});

test("dsh one-shot dispatch fails with the sign-in instruction when credentials are missing", () => {
	const home = makeHome(false);
	const restoreHome = withEnv({ HOME: home });
	try {
		const dispatch = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode: "write" });
		assert.match(dispatch.refusal ?? "", /dsh web/);
		assert.match(dispatch.refusal ?? "", /sign in/);
		assert.equal(dispatch.env, undefined);
		// A refusal never invents a home: nothing was provisioned.
		assert.equal(existsSync(path.join(home, DSH_HARNESS_HOME_NAME)), false);
	} finally {
		restoreHome();
	}
});

test("dsh reports a model override as not forwarded rather than claiming it traveled", () => {
	const home = makeHome(true);
	const restoreHome = withEnv({ HOME: home });
	try {
		const dispatch = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode: "yolo", model: "deepseek-chat" });
		assert.equal(dispatch.model.requested, "deepseek-chat");
		assert.equal(dispatch.model.forwarded, false);
		assert.match(dispatch.model.note, /NOT forwarded/);
		assert.deepEqual(dispatch.argv, ["--profile", "headless", "t"]);
	} finally {
		restoreHome();
	}
});

test("dsh parseEvent: plain-text stdout is the answer, reasoning stays reasoning", () => {
	const parse = ADAPTERS.dsh.parseEvent;
	assert.deepEqual(parse("The answer is 42."), { kind: "message", text: "The answer is 42." });
	// No --json exists in this release, so a JSON-looking line is prose like any other.
	assert.deepEqual(parse('{"type":"result","result":"hi"}'), { kind: "message", text: '{"type":"result","result":"hi"}' });
	assert.deepEqual(parse("dsh: reasoning: weighing options"), { kind: "reasoning", text: "weighing options" });
	assert.equal(parse("   "), null);
});

// ---------------------------------------------------------------------------
// ensureDshHome
// ---------------------------------------------------------------------------

test("ensureDshHome creates the harness home and the credentials symlink, idempotently", () => {
	const root = mkdtempSync(path.join(tmpdir(), "dsh-provision-"));
	const homeDir = path.join(root, "harness-home");
	const credentialsSource = path.join(root, "dsh", ".credentials.yaml");
	mkdirSync(path.dirname(credentialsSource), { recursive: true });
	writeFileSync(credentialsSource, "token: test\n");

	const first = ensureDshHome({ homeDir, credentialsSource });
	assert.equal(first.ok, true);
	if (!first.ok) return;
	assert.equal(first.home, homeDir);
	const link = path.join(homeDir, ".credentials.yaml");
	assert.equal(first.credentials, link);
	assert.equal(lstatSync(link).isSymbolicLink(), true);
	assert.equal(readlinkSync(link), credentialsSource);

	// A second call leaves the correct link untouched (same inode, same target).
	const inode = lstatSync(link).ino;
	const second = ensureDshHome({ homeDir, credentialsSource });
	assert.equal(second.ok, true);
	assert.equal(lstatSync(link).ino, inode);
	assert.equal(readlinkSync(link), credentialsSource);
});

test("ensureDshHome replaces a link that points elsewhere and leaves real files alone", () => {
	const root = mkdtempSync(path.join(tmpdir(), "dsh-provision-"));
	const homeDir = path.join(root, "harness-home");
	const credentialsSource = path.join(root, "dsh", ".credentials.yaml");
	mkdirSync(path.dirname(credentialsSource), { recursive: true });
	writeFileSync(credentialsSource, "token: test\n");
	mkdirSync(homeDir, { recursive: true });
	const link = path.join(homeDir, ".credentials.yaml");

	// A stale link target (a home that moved) means dsh reads no credentials: replace it.
	writeFileSync(path.join(root, "stale.yaml"), "old\n");
	symlinkSync(path.join(root, "stale.yaml"), link);
	const replaced = ensureDshHome({ homeDir, credentialsSource });
	assert.equal(replaced.ok, true);
	assert.equal(readlinkSync(link), credentialsSource);

	// A real file at that name is the user's own arrangement: never deleted, and
	// not a failure either.
	unlinkSync(link);
	writeFileSync(link, "hand-managed\n");
	const kept = ensureDshHome({ homeDir, credentialsSource });
	assert.equal(kept.ok, true);
	assert.equal(lstatSync(link).isSymbolicLink(), false);
	assert.equal(readFileSync(link, "utf8"), "hand-managed\n");
});

test("ensureDshHome fails with the sign-in instruction, and creates nothing, without credentials", () => {
	const root = mkdtempSync(path.join(tmpdir(), "dsh-provision-"));
	const homeDir = path.join(root, "harness-home");
	const result = ensureDshHome({ homeDir, credentialsSource: path.join(root, "dsh", ".credentials.yaml") });
	if (result.ok) throw new Error("expected provisioning to fail without a credentials source");
	assert.match(result.reason, /dsh web/);
	assert.match(result.reason, /sign in/);
	assert.equal(existsSync(homeDir), false);
});

// ---------------------------------------------------------------------------
// The ACP dialect: entry argv, env and effort
// ---------------------------------------------------------------------------

test("ACP entry argv is dialect-provided: --acp by default, --profile acp for dsh", () => {
	assert.deepEqual(SESSION_DRIVERS.reasonix!().buildArgv({ task: "t", cwd: "/tmp", mode: "yolo" }), ["--acp"]);
	const codebuddy = SESSION_DRIVERS.codebuddy!().buildArgv({ task: "t", cwd: "/tmp", mode: "readonly" });
	assert.equal(codebuddy[0], "--acp");
	assert.equal(codebuddy[1], "--permission-mode");
	const dsh = SESSION_DRIVERS.dsh!().buildArgv({ task: "t", cwd: "/tmp", mode: "yolo" });
	assert.deepEqual(dsh, ["--profile", "acp"]);
	// The prompt travels over the protocol, never in the startup argv.
	assert.equal(dsh.includes("t"), false);
});

test("ACP dialects with an effort flag are unchanged; dsh never gets one", () => {
	const codebuddy = SESSION_DRIVERS.codebuddy!().buildArgv({ task: "t", cwd: "/tmp", mode: "yolo", effort: "high" });
	assert.equal(codebuddy[codebuddy.indexOf("--effort") + 1], "high");
	const reasonix = SESSION_DRIVERS.reasonix!().buildArgv({ task: "t", cwd: "/tmp", mode: "yolo", effort: "high" });
	assert.equal(reasonix.includes("--effort"), false);
	const dsh = SESSION_DRIVERS.dsh!().buildArgv({ task: "t", cwd: "/tmp", mode: "yolo", effort: "high" });
	assert.equal(dsh.includes("--effort"), false);
});

const DSH_ACP_MOCK = `#!/usr/bin/env node
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
    PATH_INHERITED: Boolean(process.env.PATH),
  },
});
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
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {}, list: {}, resume: {} } } } });
      continue;
    }
    if (msg.method === "session/new") {
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1", configOptions: [
        { id: "model", currentValue: "default" },
        { id: "reasoning_effort", currentValue: "off" },
      ] } });
      continue;
    }
    if (msg.method === "session/set_config_option") {
      record({ kind: "set_config_option", sessionId: msg.params.sessionId, configId: msg.params.configId, value: msg.params.value });
      if (process.env.DSH_MOCK_FAIL_CONFIG === "1") {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unknown config option" } });
      } else {
        send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [{ id: msg.params.configId, currentValue: msg.params.value }] } });
      }
      continue;
    }
    if (msg.method === "session/prompt") {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "DSH_OK" } } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      continue;
    }
  }
});
`;

test("dsh ACP session: --profile acp, the dedicated DSH_HOME, the mode env, and effort via set_config_option", async () => {
	const dir = makeFixtureDir({ dsh: DSH_ACP_MOCK });
	const home = makeHome(true);
	const log = path.join(dir, "dsh-log.jsonl");
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ HOME: home, DSH_MOCK_LOG: log });
	const driver = SESSION_DRIVERS.dsh!();
	try {
		await driver.start({ task: "do the thing", cwd: dir, mode: "write", effort: "high" });

		const [spawned, configured] = mockLog(log);
		assert.deepEqual(spawned.argv, ["--profile", "acp"]);
		assert.equal(spawned.env.DSH_HOME, path.join(home, DSH_HARNESS_HOME_NAME));
		assert.equal(spawned.env.DSH_PERMISSION_MODE, "workspace-write");
		// Merged over process.env, not a replacement: the CLI still has its PATH.
		assert.equal(spawned.env.PATH_INHERITED, true);
		// Provisioning ran before the session start.
		assert.equal(
			readlinkSync(path.join(home, DSH_HARNESS_HOME_NAME, ".credentials.yaml")),
			path.join(home, ".dsh", ".credentials.yaml"),
		);
		// Effort has no flag on this CLI: it goes over the protocol, mapped.
		assert.deepEqual(configured, { kind: "set_config_option", sessionId: "s1", configId: "reasoning_effort", value: "high" });
	} finally {
		driver.kill();
		restoreEnv();
		restorePath();
	}
});

test("dsh ACP session: a rejected set_config_option fails the session start", async () => {
	const dir = makeFixtureDir({ dsh: DSH_ACP_MOCK });
	const home = makeHome(true);
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ HOME: home, DSH_MOCK_LOG: path.join(dir, "dsh-log.jsonl"), DSH_MOCK_FAIL_CONFIG: "1" });
	const driver = SESSION_DRIVERS.dsh!();
	try {
		await assert.rejects(
			() => driver.start({ task: "t", cwd: dir, mode: "yolo", effort: "max" }),
			/session\/set_config_option: unknown config option/,
		);
	} finally {
		driver.kill();
		restoreEnv();
		restorePath();
	}
});

test("dsh ACP session: missing credentials fail the session start with the sign-in instruction", async () => {
	const dir = makeFixtureDir({ dsh: DSH_ACP_MOCK });
	const home = makeHome(false);
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ HOME: home, DSH_MOCK_LOG: path.join(dir, "dsh-log.jsonl") });
	const driver = SESSION_DRIVERS.dsh!();
	try {
		await assert.rejects(() => driver.start({ task: "t", cwd: dir, mode: "yolo" }), /dsh web/);
		// Nothing was spawned: the env hook runs before the process exists.
		assert.deepEqual(mockLog(path.join(dir, "dsh-log.jsonl")), []);
		assert.equal(driver.alive, false);
	} finally {
		driver.kill();
		restoreEnv();
		restorePath();
	}
});

// ---------------------------------------------------------------------------
// The hub's env plumbing and refusal path (one-shot transport)
// ---------------------------------------------------------------------------

const KIMI_ENV_MOCK = `#!/usr/bin/env node
const marker = process.env.DSH_TEST_MARKER || "absent";
const pathInherited = process.env.PATH ? "yes" : "no";
process.stdout.write(JSON.stringify({ role: "assistant", content: "marker=" + marker + ";path=" + pathInherited }) + "\\n");
process.exit(0);
`;

test("hub one-shot: an adapter's env is merged over process.env, never replacing it", async () => {
	const dir = makeFixtureDir({ kimi: KIMI_ENV_MOCK });
	const restorePath = usePath(dir);
	const original = ADAPTERS.kimi.buildDispatch;
	try {
		const plain = await call("external_agent_start", { agent: "kimi", task: "t", mode: "yolo", cwd: dir, notify: "off" });
		const plainWait = await call("external_agent_wait", { taskIds: [plain.details.task.taskId], timeout: 5 });
		assert.match(plainWait.content[0].text, /marker=absent;path=yes/);

		ADAPTERS.kimi.buildDispatch = (input) => ({ ...original(input), env: { DSH_TEST_MARKER: "from-adapter" } });
		const injected = await call("external_agent_start", { agent: "kimi", task: "t", mode: "yolo", cwd: dir, notify: "off" });
		const injectedWait = await call("external_agent_wait", { taskIds: [injected.details.task.taskId], timeout: 5 });
		assert.match(injectedWait.content[0].text, /marker=from-adapter;path=yes/);
	} finally {
		ADAPTERS.kimi.buildDispatch = original;
		await call("external_agent_stop", { all: true });
		restorePath();
	}
});

test("hub one-shot: an adapter refusal fails the dispatch with its reason and spawns nothing", async () => {
	const dir = makeFixtureDir({ kimi: KIMI_ENV_MOCK });
	const restorePath = usePath(dir);
	const original = ADAPTERS.kimi.buildDispatch;
	try {
		ADAPTERS.kimi.buildDispatch = (input) => ({ ...original(input), refusal: "kimi cannot run this request" });
		const started = await call("external_agent_start", { agent: "kimi", task: "t", mode: "yolo", cwd: dir, notify: "off" });
		assert.match(started.content[0].text, /Failed to start kimi: kimi cannot run this request/);
		assert.equal(started.details.task.state, "failed");
		assert.equal(started.details.task.exitCode, null);
	} finally {
		ADAPTERS.kimi.buildDispatch = original;
		await call("external_agent_stop", { all: true });
		restorePath();
	}
});
