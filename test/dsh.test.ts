/**
 * dsh (DeepSeek harness) foundation, covering the pieces the rest of the dsh
 * work depends on:
 *   - the one-shot adapter: argv, per-mode env, effort tokens, refusals;
 *   - ensureDshHome: lazy, idempotent provisioning with injectable paths;
 *   - the generalized ACP entry argv and the dialect env/effort hooks;
 *   - the per-spawn env plumbing of both transports, and the hub's refusal path.
 *
 * The hardening pass below drives the same ground adversarially: per-mode argv
 * and env exactness, a refusal that precedes every filesystem dependency, the
 * provisioning arrangements that must not be touched, answer extraction from
 * stdout/stderr fixtures, and the tier at the ACP permission request.
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
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	ADAPTERS,
	DSH_ONESHOT_EFFORT_REFUSAL,
	EFFORT_LEVELS,
	dshEffortToken,
	dshPermissionMode,
	type Effort,
	type Mode,
} from "../src/adapters.ts";
import { SESSION_DRIVERS } from "../src/drivers/index.ts";
import { answerOf, warningsOf, type Task } from "../src/hub/shared.ts";
import {
	startTask,
	tasks,
	validateDispatch,
	effortForwardedOnSession,
	effortSessionNote,
	meter,
	modelForwardedOnSession,
	modelSessionNote,
} from "../src/hub/registry.ts";
import {
	DSH_CREDENTIALS_LINK_NAME,
	DSH_HARNESS_HOME_NAME,
	dshCredentialsSource,
	dshHomeDir,
	ensureDshHome,
	linkDshCredentials,
} from "../src/dsh-home.ts";

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
/** Text of every settle/watchdog push; the surfaces a caller sees without polling. */
const pushes: string[] = [];
hub.default({
	registerTool: (tool: any) => tools.set(tool.name, tool),
	registerMessageRenderer: () => {},
	on: (event: string, handler: (event: { reason: string }) => void) => lifecycle.set(event, handler),
	sendMessage: (message: any) => pushes.push(String(message?.content ?? "")),
});
afterEach(() => {
	pushes.length = 0;
	lifecycle.get("session_shutdown")!({ reason: "quit" });
});

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

test("dsh session policy: fail-closed is a readonly fact, not a claim for write/yolo", () => {
	// The ACP driver auto-denies session/request_permission for readonly and
	// auto-allows it for write/yolo, so the receipt may only promise
	// fail-closed escalation where that is what the driver does.
	const policy = ADAPTERS.dsh.sessionPolicy!;
	assert.match(policy("readonly"), /denies session\/request_permission escalations, so readonly fails closed/);
	assert.doesNotMatch(policy("write"), /fails closed|denies session\/request_permission/);
	assert.doesNotMatch(policy("yolo"), /fails closed|denies session\/request_permission/);
	assert.match(policy("write"), /allowed by the driver/);
	assert.match(policy("yolo"), /allowed by the driver/);
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

test("dsh one-shot dispatch proceeds without a credentials link, warning with the remedy", () => {
	// A user with no ~/.dsh/.credentials.yaml is not a user who cannot run: an
	// empty harness home completes a headless run on the default provider route
	// (verified 0.1.5-rc.2), and dsh reads project/user `.env` fallbacks too.
	const home = makeHome(false);
	const restoreHome = withEnv({ HOME: home });
	try {
		const dispatch = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode: "write" });
		assert.equal(dispatch.refusal, undefined);
		assert.equal(dispatch.env?.DSH_HOME, path.join(home, DSH_HARNESS_HOME_NAME));
		assert.equal(dispatch.env?.DSH_PERMISSION_MODE, "workspace-write");
		const warning = dispatch.warning ?? "";
		assert.match(warning, /no .*\.credentials\.yaml to link/);
		assert.ok(warning.includes(path.join(home, ".dsh", ".credentials.yaml")), "the warning names the file that is missing");
		assert.match(warning, /default provider route or \.env must carry auth/);
		assert.match(warning, /run `dsh web` once to manage credentials/);
		// The home is still provisioned — the requested tier needs it — but there
		// is no credentials entry at all, which is the state a credential-less dsh
		// run works in: never a dangling link for dsh to read.
		assert.equal(lstatSync(path.join(home, DSH_HARNESS_HOME_NAME)).isDirectory(), true);
		assert.throws(() => lstatSync(path.join(home, DSH_HARNESS_HOME_NAME, DSH_CREDENTIALS_LINK_NAME)), /ENOENT/);
	} finally {
		restoreHome();
	}
});

test("dsh one-shot dispatch: a forked credentials copy is a warning, not a refusal", () => {
	const home = makeHome(true);
	// dsh's atomic credential write leaves a real file where the link was.
	mkdirSync(path.join(home, DSH_HARNESS_HOME_NAME), { recursive: true });
	const fork = path.join(home, DSH_HARNESS_HOME_NAME, DSH_CREDENTIALS_LINK_NAME);
	writeFileSync(fork, "token: older\n");
	const restoreHome = withEnv({ HOME: home });
	try {
		const dispatch = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode: "write" });
		// The run is still spelled out and still gets its home: the copy works,
		// it may just be stale.
		assert.equal(dispatch.refusal, undefined);
		assert.equal(dispatch.env?.DSH_HOME, path.join(home, DSH_HARNESS_HOME_NAME));
		assert.match(dispatch.warning ?? "", /local credentials copy/);
		assert.match(dispatch.warning ?? "", /Delete .*\.credentials\.yaml to re-link it/);
		assert.equal(readFileSync(fork, "utf8"), "token: older\n");
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

test("ensureDshHome: a local credentials copy is kept and warned about, with the one-line fix", () => {
	const root = mkdtempSync(path.join(tmpdir(), "dsh-provision-"));
	const homeDir = path.join(root, "harness-home");
	const credentialsSource = path.join(root, "dsh", ".credentials.yaml");
	mkdirSync(path.dirname(credentialsSource), { recursive: true });
	writeFileSync(credentialsSource, "token: user\n");
	mkdirSync(homeDir, { recursive: true });
	const link = path.join(homeDir, ".credentials.yaml");
	// What a dsh-side credentials write leaves behind: a real file where the
	// symlink used to be, holding a copy that drifts as the user's file rotates.
	writeFileSync(link, "token: older\n");

	const result = ensureDshHome({ homeDir, credentialsSource });
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.credentials, link);
	// Provisioning succeeds and never clobbers the copy: it may be the only
	// credentials that still work.
	assert.equal(lstatSync(link).isSymbolicLink(), false);
	assert.equal(readFileSync(link, "utf8"), "token: older\n");
	assert.ok(result.warning, "a local copy must be reported, not silently accepted");
	assert.match(result.warning, /local credentials copy/);
	assert.ok(result.warning.includes(link), "the warning names the file to delete");
	assert.ok(result.warning.includes(credentialsSource), "and the file it should be linked to");

	// Doing exactly what the warning says is the whole fix.
	unlinkSync(link);
	const relinked = ensureDshHome({ homeDir, credentialsSource });
	assert.equal(relinked.ok, true);
	if (!relinked.ok) return;
	assert.equal(relinked.warning, undefined, "a correct link carries no warning");
	assert.equal(readlinkSync(link), credentialsSource);
});

test("linkDshCredentials: losing the provisioning race to a correct link is not a failure", () => {
	const root = mkdtempSync(path.join(tmpdir(), "dsh-race-"));
	const homeDir = path.join(root, "harness-home");
	mkdirSync(homeDir, { recursive: true });
	const credentialsSource = path.join(root, "dsh", ".credentials.yaml");
	mkdirSync(path.dirname(credentialsSource), { recursive: true });
	writeFileSync(credentialsSource, "token: test\n");
	const link = path.join(homeDir, ".credentials.yaml");

	// A second pi process provisioned the same home between our check and our
	// symlinkSync: EEXIST, with the correct link now present. That is the race.
	symlinkSync(credentialsSource, link);
	assert.deepEqual(linkDshCredentials(credentialsSource, link), { ok: true });
	assert.equal(readlinkSync(link), credentialsSource);

	// A link to somewhere else is not a peer's success: report it, touch nothing.
	const other = path.join(root, "other.yaml");
	writeFileSync(other, "token: other\n");
	unlinkSync(link);
	symlinkSync(other, link);
	const wrong = linkDshCredentials(credentialsSource, link);
	assert.equal(wrong.ok, false);
	if (wrong.ok) return;
	assert.match(wrong.reason, /could not link/);
	assert.ok(wrong.reason.includes(link));
	assert.equal(readlinkSync(link), other);

	// A real file cannot be displaced by a link either.
	unlinkSync(link);
	writeFileSync(link, "hand-managed\n");
	const realFile = linkDshCredentials(credentialsSource, link);
	assert.equal(realFile.ok, false);
	assert.equal(readFileSync(link, "utf8"), "hand-managed\n");
});

test("ensureDshHome: no credentials to link succeeds with the remedy, and links nothing", () => {
	const root = mkdtempSync(path.join(tmpdir(), "dsh-provision-"));
	const homeDir = path.join(root, "harness-home");
	const credentialsSource = path.join(root, "dsh", ".credentials.yaml");
	const result = ensureDshHome({ homeDir, credentialsSource });
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.home, homeDir);
	assert.equal(result.credentials, path.join(homeDir, DSH_CREDENTIALS_LINK_NAME));
	const warning = result.warning ?? "";
	assert.match(warning, /no .*\.credentials\.yaml to link/);
	assert.ok(warning.includes(credentialsSource), "the warning names the missing source");
	assert.match(warning, /default provider route or \.env must carry auth/);
	assert.match(warning, /run `dsh web` once to manage credentials/);
	// The home exists — the requested tier needs it — and holds no credentials
	// entry, so dsh reads no broken link.
	assert.equal(lstatSync(homeDir).isDirectory(), true);
	assert.throws(() => lstatSync(path.join(homeDir, DSH_CREDENTIALS_LINK_NAME)), /ENOENT/);
	assert.equal(existsSync(credentialsSource), false, "provisioning never invents the user's file");

	// The next run links by itself once the file exists: the source is the switch.
	mkdirSync(path.dirname(credentialsSource), { recursive: true });
	writeFileSync(credentialsSource, "token: test\n");
	const linked = ensureDshHome({ homeDir, credentialsSource });
	assert.equal(linked.ok, true);
	if (!linked.ok) return;
	assert.equal(linked.warning, undefined);
	assert.equal(readlinkSync(path.join(homeDir, DSH_CREDENTIALS_LINK_NAME)), credentialsSource);
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
    if (!msg.method) {
      // The client's answer to a request we sent (session/request_permission).
      record({ kind: "client-response", id: msg.id, result: msg.result, error: msg.error });
      continue;
    }
    if (msg.method === "session/prompt") {
      if (process.env.DSH_MOCK_PERMISSION === "1") {
        // An escalation with no approval answerer: the driver's answer is the
        // only thing that decides it, so this is where the tier is enforced.
        send({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: { sessionId: "s1", options: [
          { optionId: "allow-once", kind: "allow_once" },
          { optionId: "reject-once", kind: "reject_once" },
        ] } });
      }
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

test("dsh ACP session: a home without credentials starts unlinked, with the remedy as a warning", async () => {
	const dir = makeFixtureDir({ dsh: DSH_ACP_MOCK });
	const home = makeHome(false);
	const log = path.join(dir, "dsh-log.jsonl");
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ HOME: home, DSH_MOCK_LOG: log });
	const driver = SESSION_DRIVERS.dsh!();
	const warnings: string[] = [];
	driver.onEvent((event) => {
		if (event.kind === "warning") warnings.push(event.text);
	});
	try {
		// Never refused: dsh's default provider route needs no credentials, so the
		// session starts in the dedicated home and the notice travels alongside it.
		await driver.start({ task: "t", cwd: dir, mode: "yolo" });

		const [spawned] = mockLog(log);
		assert.deepEqual(spawned.argv, ["--profile", "acp"]);
		assert.equal(spawned.env.DSH_HOME, path.join(home, DSH_HARNESS_HOME_NAME));
		assert.equal(spawned.env.DSH_PERMISSION_MODE, "danger-full-access");
		assert.throws(() => lstatSync(path.join(home, DSH_HARNESS_HOME_NAME, DSH_CREDENTIALS_LINK_NAME)), /ENOENT/);
		assert.equal(warnings.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
		assert.match(warnings[0], /no .*\.credentials\.yaml to link/);
		assert.match(warnings[0], /default provider route or \.env must carry auth/);
		assert.match(warnings[0], /run `dsh web` once to manage credentials/);
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

// ---------------------------------------------------------------------------
// One-shot: per-mode argv/env exactness, and a refusal that precedes everything
// ---------------------------------------------------------------------------

/** The three hub modes and the dsh permission mode each must carry. */
const DSH_MODES: ReadonlyArray<readonly [Mode, string]> = [
	["readonly", "read-only"],
	["write", "workspace-write"],
	["yolo", "danger-full-access"],
];

/** Flags a later edit might reach for; none of them exists in dsh 0.1.5-rc.2. */
const DSH_UNVERIFIED_FLAGS = ["--json", "--session-id", "--model", "--effort", "--permission-mode", "--sandbox", "-c", "-C", "--dir", "--acp"];

test("dsh one-shot: every mode's argv is exactly the profile plus the task, and its env exactly home plus tier", () => {
	for (const [mode, permissionMode] of DSH_MODES) {
		const home = makeHome(true);
		const restoreHome = withEnv({ HOME: home });
		try {
			const task = "audit the repo\nsecond line";
			const dispatch = ADAPTERS.dsh.buildDispatch({ task, cwd: "/tmp/dsh-cwd-not-forwarded", mode });
			assert.deepEqual(dispatch.argv, ["--profile", "headless", task], `${mode}: argv`);
			assert.equal(dispatch.promptArgIndex, 2);
			assert.equal(dispatch.argv[dispatch.promptArgIndex], task);
			assert.equal(dispatch.refusal, undefined);
			assert.equal(dispatch.cwdForwardedToCli, false);
			assert.equal(dispatch.argv.includes("/tmp/dsh-cwd-not-forwarded"), false, `${mode}: the cwd has no flag`);
			for (const flag of DSH_UNVERIFIED_FLAGS) {
				assert.equal(dispatch.argv.includes(flag), false, `${mode}: ${flag} does not exist in this release`);
			}
			// Exactly two keys: an extra one would widen the contract silently.
			assert.deepEqual(Object.keys(dispatch.env ?? {}).sort(), ["DSH_HOME", "DSH_PERMISSION_MODE"]);
			assert.equal(dispatch.env?.DSH_HOME, path.join(home, DSH_HARNESS_HOME_NAME));
			assert.equal(dispatch.env?.DSH_PERMISSION_MODE, permissionMode);
			assert.equal(dispatch.readOnlyEnforcement, mode === "readonly" ? "harness-enforced" : "not-applicable");
			assert.match(dispatch.effectivePolicy ?? "", new RegExp(`DSH_PERMISSION_MODE=${permissionMode}`));
			assert.match(dispatch.effectivePolicy ?? "", /shared ~\/\.dsh settings outrank/);
			// Provisioning ran for this mode, as a link to the user's own file.
			assert.equal(
				readlinkSync(path.join(home, DSH_HARNESS_HOME_NAME, ".credentials.yaml")),
				path.join(home, ".dsh", ".credentials.yaml"),
			);
			// The adapter contributes env for the child; it must never touch the hub's own.
			assert.equal(process.env.DSH_HOME, undefined);
			assert.equal(process.env.DSH_PERMISSION_MODE, undefined);
		} finally {
			restoreHome();
		}
	}
});

test("dsh one-shot: one home serves every mode, and the tier is never memoized across dispatches", () => {
	const home = makeHome(true);
	const restoreHome = withEnv({ HOME: home });
	try {
		const readonly = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode: "readonly" });
		const link = path.join(home, DSH_HARNESS_HOME_NAME, ".credentials.yaml");
		const inode = lstatSync(link).ino;
		const write = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode: "write" });
		const yolo = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode: "yolo" });
		assert.deepEqual(
			[readonly.env?.DSH_PERMISSION_MODE, write.env?.DSH_PERMISSION_MODE, yolo.env?.DSH_PERMISSION_MODE],
			["read-only", "workspace-write", "danger-full-access"],
		);
		assert.equal(new Set([readonly.env?.DSH_HOME, write.env?.DSH_HOME, yolo.env?.DSH_HOME]).size, 1);
		// Provisioning is idempotent: the same link, untouched (same inode).
		assert.equal(lstatSync(link).ino, inode);
	} finally {
		restoreHome();
	}
});

test("dsh one-shot: an ambient DSH_HOME or DSH_PERMISSION_MODE cannot override the dispatch's own", () => {
	// A user who exported either variable must not be able to widen a task's
	// tier (or point it at the shared home) from their shell profile.
	const home = makeHome(true);
	const restoreHome = withEnv({ HOME: home, DSH_HOME: "/tmp/some-shared-dsh-home", DSH_PERMISSION_MODE: "danger-full-access" });
	try {
		const dispatch = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode: "readonly" });
		assert.equal(dispatch.env?.DSH_HOME, path.join(home, DSH_HARNESS_HOME_NAME));
		assert.equal(dispatch.env?.DSH_PERMISSION_MODE, "read-only");
	} finally {
		restoreHome();
	}
});

test("dsh one-shot: an effort request is refused before any provisioning, for every level and mode", () => {
	// HOME points at a path that does not exist and has no ~/.dsh: the refusal
	// must be about the transport, not about this machine, and it must not touch
	// the filesystem on the way to saying so.
	const root = mkdtempSync(path.join(tmpdir(), "dsh-no-home-"));
	const home = path.join(root, "does-not-exist");
	const restoreHome = withEnv({ HOME: home });
	try {
		for (const [mode] of DSH_MODES) {
			for (const level of EFFORT_LEVELS) {
				const dispatch = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode, effort: level });
				assert.equal(dispatch.refusal, DSH_ONESHOT_EFFORT_REFUSAL, `${mode}/${level}: refusal`);
				// A refusal never hands out an env: there is nothing to merge.
				assert.equal(dispatch.env, undefined, `${mode}/${level}: env`);
				assert.deepEqual(dispatch.argv, ["--profile", "headless", "t"], `${mode}/${level}: argv`);
				assert.equal(dispatch.effort.requested, level);
				assert.equal(dispatch.effort.forwarded, false);
				assert.match(dispatch.effort.note, /NOT forwarded/);
			}
		}
		assert.equal(existsSync(home), false);
		assert.equal(existsSync(path.join(home, DSH_HARNESS_HOME_NAME)), false);
	} finally {
		restoreHome();
	}
});

test("dsh one-shot: an effort request is refused even when credentials exist, and nothing is provisioned", () => {
	const home = makeHome(true);
	const restoreHome = withEnv({ HOME: home });
	try {
		const dispatch = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode: "yolo", effort: "max" });
		assert.equal(dispatch.refusal, DSH_ONESHOT_EFFORT_REFUSAL);
		assert.equal(dispatch.env, undefined);
		// Provisioning would have succeeded here. It must not have run at all:
		// the transport split is decided before the machine's state is consulted.
		assert.equal(existsSync(path.join(home, DSH_HARNESS_HOME_NAME)), false);
	} finally {
		restoreHome();
	}
});

test("dsh one-shot: the refusal names the transport, the reason and both ways out", () => {
	assert.match(DSH_ONESHOT_EFFORT_REFUSAL, /only inside an ACP session/);
	assert.match(DSH_ONESHOT_EFFORT_REFUSAL, /session\/set_config_option reasoning_effort/);
	assert.match(DSH_ONESHOT_EFFORT_REFUSAL, /one-shot headless profile has no effort knob/);
	assert.match(DSH_ONESHOT_EFFORT_REFUSAL, /refused rather than dropped/);
	assert.match(DSH_ONESHOT_EFFORT_REFUSAL, /Drop the effort parameter, or run dsh over its persistent session\./);
});

test("dshEffortToken: every level lands in the four tokens dsh's config option accepts", () => {
	// The ACP config option is a closed vocabulary (verified 0.1.5-rc.2). A token
	// outside it would be rejected at session start, so the mapping must stay
	// inside it for every level the hub offers.
	const accepted = new Set(["off", "low", "high", "max"]);
	for (const level of EFFORT_LEVELS) {
		const token = dshEffortToken(level);
		assert.ok(accepted.has(token), `${level} -> ${token} is outside dsh's vocabulary`);
	}
	// Non-identity spot checks: a passthrough would be a silent contract change.
	assert.equal(dshEffortToken("minimal"), "low");
	assert.equal(dshEffortToken("medium"), "high");
	assert.equal(dshEffortToken("xhigh"), "max");
});

test("hub validation: dsh passes every mode and every effort level on to the adapter", () => {
	// The hub's own effort check is adapter-level and cannot see dsh's
	// one-shot/ACP split, so nothing may be refused here — the adapter refuses.
	for (const [mode] of DSH_MODES) {
		for (const level of EFFORT_LEVELS) {
			assert.deepEqual(validateDispatch("dsh", mode, "/tmp/dsh-validation-cwd", level), { ok: true }, `${mode}/${level}`);
		}
		assert.deepEqual(validateDispatch("dsh", mode, "/tmp/dsh-validation-cwd", undefined), { ok: true }, mode);
	}
});

test("dsh one-shot: the task travels as one argv element, flag-shaped or multi-line", () => {
	const home = makeHome(true);
	const restoreHome = withEnv({ HOME: home });
	try {
		// The registry spawns with shell: false and this argv array, so the task
		// can never be split, globbed or word-split on the way to dsh.
		for (const task of ["--help", "-x --y", "line one\nline two", "unicode ✓ and 'quotes'", "  leading and trailing  "]) {
			const dispatch = ADAPTERS.dsh.buildDispatch({ task, cwd: "/tmp", mode: "yolo" });
			assert.deepEqual(dispatch.argv, ["--profile", "headless", task]);
			assert.equal(dispatch.argv.length, 3, "the task must never become extra arguments");
			assert.equal(dispatch.argv[2], task, "the task must arrive verbatim, not trimmed or quoted");
		}
	} finally {
		restoreHome();
	}
});

test("dsh receipts: a session model request is not claimed as forwarded, and effort names its protocol route", () => {
	// The persistent receipt is built in hub/registry.ts, not by the adapter, so
	// its honesty about dsh's split is asserted here rather than trusted.
	assert.equal(modelForwardedOnSession("dsh"), false);
	assert.match(modelSessionNote("dsh", "deepseek-chat"), /NOT forwarded/);
	assert.equal(effortForwardedOnSession("dsh"), true);
	const note = effortSessionNote("dsh", "xhigh");
	assert.match(note, /session\/set_config_option reasoning_effort=max/);
	assert.match(note, /never on its one-shot path/);
	// Both paths agree on one mapping, whatever it is.
	assert.ok(note.includes(`reasoning_effort=${dshEffortToken("xhigh")}`));
});

// ---------------------------------------------------------------------------
// ensureDshHome: the arrangements it must not touch, and the failures it must explain
// ---------------------------------------------------------------------------

test("ensureDshHome: a directory at the credentials name is the user's own arrangement, left alone", () => {
	const root = mkdtempSync(path.join(tmpdir(), "dsh-provision-"));
	const homeDir = path.join(root, "harness-home");
	const credentialsSource = path.join(root, "dsh", ".credentials.yaml");
	mkdirSync(path.dirname(credentialsSource), { recursive: true });
	writeFileSync(credentialsSource, "token: test\n");
	const link = path.join(homeDir, ".credentials.yaml");
	mkdirSync(link, { recursive: true });

	const result = ensureDshHome({ homeDir, credentialsSource });
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.credentials, link);
	assert.equal(lstatSync(link).isDirectory(), true);
	assert.equal(readdirSync(link).length, 0);
});

test("ensureDshHome: an unusable home path fails with a reason instead of throwing", () => {
	const root = mkdtempSync(path.join(tmpdir(), "dsh-provision-"));
	const homeDir = path.join(root, "not-a-directory");
	const credentialsSource = path.join(root, "dsh", ".credentials.yaml");
	mkdirSync(path.dirname(credentialsSource), { recursive: true });
	writeFileSync(credentialsSource, "token: test\n");
	writeFileSync(homeDir, "a real file where the home should be\n");

	const result = ensureDshHome({ homeDir, credentialsSource });
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.match(result.reason, /could not create the dsh harness home/);
	assert.ok(result.reason.includes(homeDir));
	// The file it could not replace is reported, never deleted.
	assert.equal(readFileSync(homeDir, "utf8"), "a real file where the home should be\n");
});

test("ensureDshHome: a dangling credentials source is as good as missing, and clears a link of ours", () => {
	const root = mkdtempSync(path.join(tmpdir(), "dsh-provision-"));
	const homeDir = path.join(root, "harness-home");
	const credentialsSource = path.join(root, "credentials.yaml");
	symlinkSync(path.join(root, "gone.yaml"), credentialsSource);

	const result = ensureDshHome({ homeDir, credentialsSource });
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.match(result.warning ?? "", /no .*credentials\.yaml to link/);
	const link = path.join(homeDir, DSH_CREDENTIALS_LINK_NAME);
	assert.throws(() => lstatSync(link), /ENOENT/);

	// A home that had linked the source before it went away does not keep a
	// dangling entry: dsh gets either a working credentials file or none.
	symlinkSync(credentialsSource, link);
	const relinked = ensureDshHome({ homeDir, credentialsSource });
	assert.equal(relinked.ok, true);
	assert.throws(() => lstatSync(link), /ENOENT/);

	// And a link of the user's own, pointing at a file that does exist, is not
	// ours to clear while the source is missing.
	const other = path.join(root, "other.yaml");
	writeFileSync(other, "token: other\n");
	symlinkSync(other, link);
	const kept = ensureDshHome({ homeDir, credentialsSource });
	assert.equal(kept.ok, true);
	assert.equal(readlinkSync(link), other);
});

test("ensureDshHome: the harness home is created 0o700", () => {
	const root = mkdtempSync(path.join(tmpdir(), "dsh-provision-"));
	const homeDir = path.join(root, "harness-home");
	const credentialsSource = path.join(root, "dsh", ".credentials.yaml");
	mkdirSync(path.dirname(credentialsSource), { recursive: true });
	writeFileSync(credentialsSource, "token: test\n");

	const result = ensureDshHome({ homeDir, credentialsSource });
	assert.equal(result.ok, true);
	// The home holds dsh's settings and a credentials entry, so nobody else gets
	// to read or write it. mkdir's mode is masked by the umask, so assert the
	// property that matters: owner rwx, nothing for group/other.
	const mode = lstatSync(homeDir).mode & 0o777;
	assert.equal(mode & 0o700, 0o700, `owner needs full access (mode ${mode.toString(8)})`);
	assert.equal(mode & 0o077, 0, `group/other must have no access (mode ${mode.toString(8)})`);
});

test("ensureDshHome: a home left world-readable by an earlier build is tightened to 0o700", () => {
	const root = mkdtempSync(path.join(tmpdir(), "dsh-provision-"));
	const homeDir = path.join(root, "harness-home");
	const credentialsSource = path.join(root, "dsh", ".credentials.yaml");
	mkdirSync(path.dirname(credentialsSource), { recursive: true });
	writeFileSync(credentialsSource, "token: test\n");
	// The previous dev build created the home without a mode (0o755 under a
	// typical umask); mkdir's mode never revisits an existing directory.
	mkdirSync(homeDir, { recursive: true });
	chmodSync(homeDir, 0o755);

	const result = ensureDshHome({ homeDir, credentialsSource });
	assert.equal(result.ok, true);
	const mode = lstatSync(homeDir).mode & 0o777;
	assert.equal(mode & 0o700, 0o700, `owner needs full access (mode ${mode.toString(8)})`);
	assert.equal(mode & 0o077, 0, `group/other must have no access (mode ${mode.toString(8)})`);
});

test("ensureDshHome: a symlinked home path is provisioned through the link, not refused", () => {
	// dsh's own home resolution canonicalizes paths (realpath) and its SAFETY.md
	// claims no symlink hardening, so `~/dotfiles -> another volume` is a
	// legitimate layout: the link stays a link and the home is provisioned where
	// it points.
	const root = mkdtempSync(path.join(tmpdir(), "dsh-provision-"));
	const elsewhere = path.join(root, "elsewhere");
	mkdirSync(elsewhere, { recursive: true });
	writeFileSync(path.join(elsewhere, "existing.txt"), "user data\n");
	const homeDir = path.join(root, "harness-home");
	symlinkSync(elsewhere, homeDir);
	const credentialsSource = path.join(root, "dsh", ".credentials.yaml");
	mkdirSync(path.dirname(credentialsSource), { recursive: true });
	writeFileSync(credentialsSource, "token: test\n");

	const first = ensureDshHome({ homeDir, credentialsSource });
	assert.equal(first.ok, true);
	if (!first.ok) return;
	assert.equal(first.home, homeDir);
	assert.equal(lstatSync(homeDir).isSymbolicLink(), true, "the link is ours to follow, not to replace");
	assert.equal(readlinkSync(homeDir), elsewhere);
	const link = path.join(elsewhere, DSH_CREDENTIALS_LINK_NAME);
	assert.equal(readlinkSync(link), credentialsSource);
	assert.deepEqual(readdirSync(elsewhere).sort(), [DSH_CREDENTIALS_LINK_NAME, "existing.txt"], "pre-existing data untouched");

	// Idempotent through the link, and the mode fix reaches the target directory
	// dsh actually uses without breaking the link.
	const second = ensureDshHome({ homeDir, credentialsSource });
	assert.equal(second.ok, true);
	assert.equal(lstatSync(homeDir).isSymbolicLink(), true);
	assert.equal(readlinkSync(link), credentialsSource);
	const mode = lstatSync(elsewhere).mode & 0o777;
	assert.equal(mode & 0o077, 0, `the linked directory is not owner-only (mode ${mode.toString(8)})`);
});

test("ensureDshHome: the default paths hang off HOME, and the warning names the file and the fix", () => {
	const home = mkdtempSync(path.join(tmpdir(), "dsh-user-home-"));
	const restoreHome = withEnv({ HOME: home });
	try {
		assert.equal(dshHomeDir(), path.join(home, DSH_HARNESS_HOME_NAME));
		assert.equal(dshCredentialsSource(), path.join(home, ".dsh", DSH_CREDENTIALS_LINK_NAME));

		const missing = ensureDshHome();
		assert.equal(missing.ok, true);
		if (!missing.ok) return;
		assert.equal(missing.home, dshHomeDir());
		assert.ok((missing.warning ?? "").includes(dshCredentialsSource()), "the warning must name the file, not just the directory");
		assert.match(missing.warning ?? "", /run `dsh web` once to manage credentials/);

		// Doing exactly what the warning says is the whole fix.
		mkdirSync(path.join(home, ".dsh"), { recursive: true });
		writeFileSync(dshCredentialsSource(), "token: test\n");
		const provisioned = ensureDshHome();
		assert.equal(provisioned.ok, true);
		if (!provisioned.ok) return;
		assert.equal(provisioned.warning, undefined, "a correct link carries no warning");
		assert.equal(
			readlinkSync(path.join(provisioned.home, DSH_CREDENTIALS_LINK_NAME)),
			dshCredentialsSource(),
		);
	} finally {
		restoreHome();
	}
});

// ---------------------------------------------------------------------------
// parseEvent: the answer channel's exact fixtures
// ---------------------------------------------------------------------------

test("dsh parseEvent: a misrouted reasoning line is reasoning, never answer prose", () => {
	const parse = ADAPTERS.dsh.parseEvent;
	assert.deepEqual(parse("dsh: reasoning: this belongs on stderr"), { kind: "reasoning", text: "this belongs on stderr" });
	assert.deepEqual(parse("dsh:reasoning:no space after the colon"), { kind: "reasoning", text: "no space after the colon" });
	assert.deepEqual(parse("   dsh: reasoning: indented"), { kind: "reasoning", text: "indented" });
	// No payload is no signal: an empty event would still count as progress.
	assert.equal(parse("dsh: reasoning:"), null);
	assert.equal(parse("dsh: reasoning:    "), null);
});

test("dsh parseEvent: stdout is prose verbatim, including JSON-looking lines", () => {
	const parse = ADAPTERS.dsh.parseEvent;
	assert.deepEqual(parse("  indented prose keeps its leading spaces"), { kind: "message", text: "  indented prose keeps its leading spaces" });
	assert.deepEqual(parse('{"type":"result","result":"hi"}'), { kind: "message", text: '{"type":"result","result":"hi"}' });
	assert.deepEqual(parse("dsh: warning: not a structured record"), { kind: "message", text: "dsh: warning: not a structured record" });
	assert.deepEqual(parse("dsh: "), { kind: "message", text: "dsh: " });
	assert.equal(parse(""), null);
	assert.equal(parse("\t"), null);
});

// ---------------------------------------------------------------------------
// The hub's one-shot transport for dsh (the path the refusal guards)
// ---------------------------------------------------------------------------

/**
 * dsh runs over its ACP session in the hub, so the one-shot adapter is reachable
 * only when dsh has no session driver: the registry picks the persistent
 * transport for exactly the agents in SESSION_DRIVERS. Removing the entry is the
 * only way to drive that path through the registry; the returned function puts
 * it back, so no other test sees a different transport table.
 */
function withoutDshDriver(): () => void {
	const saved = SESSION_DRIVERS.dsh;
	delete SESSION_DRIVERS.dsh;
	return () => {
		SESSION_DRIVERS.dsh = saved;
	};
}

/** Wait for a spawned task to settle, then for its settle-time finalize to finish. */
async function settle(task: Task, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (task.state === "running" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.notEqual(task.state, "running", `task ${task.id} did not settle in ${timeoutMs}ms (stderr: ${task.stderr})`);
	await task.finalizePromise;
}

/**
 * One-shot `dsh` stand-in: plain text on stdout, `dsh: reasoning:` on stderr,
 * and an env/argv record so the spawn's contract can be read back. The happy
 * path opens with CRLF (the reader's framing tolerance) and closes without a
 * newline (the close-time buffer flush).
 */
const DSH_ONESHOT_MOCK = `#!/usr/bin/env node
const fs = require("node:fs");
const log = process.env.DSH_MOCK_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({
  kind: "spawn",
  argv: process.argv.slice(2),
  env: {
    DSH_HOME: process.env.DSH_HOME || null,
    DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE || null,
    INHERITED: process.env.DSH_TEST_INHERITED || null,
    PATH_PRESENT: Boolean(process.env.PATH),
  },
}) + "\\n");
process.stderr.write("dsh: reasoning: weighing the two options\\n");
const mode = process.env.DSH_MOCK_MODE || "success";
if (mode === "empty") process.exit(0);
if (mode === "fail") {
  process.stdout.write("partial thought before the failure\\n");
  process.stderr.write("dsh: authentication failed\\n");
  process.exit(3);
}
if (mode === "misrouted-reasoning") process.stdout.write("dsh: reasoning: this belongs on stderr\\n");
process.stdout.write("First line of the answer.\\r\\n");
process.stdout.write("Second line with no trailing newline.");
process.exit(0);
`;

test("hub one-shot dsh: an effort request fails the dispatch with the transport reason, spawning and provisioning nothing", async () => {
	const dir = makeFixtureDir({ dsh: DSH_ONESHOT_MOCK });
	const log = path.join(dir, "dsh-log.jsonl");
	// Credentials are present on purpose: the refusal must not be a provisioning
	// failure wearing the transport's words.
	const home = makeHome(true);
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ HOME: home, DSH_MOCK_LOG: log });
	const restoreDrivers = withoutDshDriver();
	const before = meter.snapshot();
	try {
		const started = await call("external_agent_start", {
			agent: "dsh",
			task: "t",
			mode: "yolo",
			effort: "high",
			cwd: dir,
			notify: "off",
		});
		assert.match(started.content[0].text, /^Failed to start dsh: /);
		assert.ok(started.content[0].text.includes(DSH_ONESHOT_EFFORT_REFUSAL), "the dispatch must carry the adapter's own reason");
		assert.equal(started.details.task.state, "failed");
		assert.equal(started.details.task.exitCode, null);
		// A refusal is not a spawn that failed: no process, no record, no home.
		assert.equal(tasks.get(started.details.task.taskId)?.proc, null);
		assert.deepEqual(mockLog(log), []);
		assert.equal(existsSync(path.join(home, DSH_HARNESS_HOME_NAME)), false);
		// ...and it is not a dispatch the meter counts: the refusal is reported
		// under its own label, so /external_agent_stats never claims a run that
		// was refused before it existed.
		const after = meter.snapshot();
		assert.equal(after.dispatchTotal, before.dispatchTotal, "a refused dispatch must not raise dispatchTotal");
		assert.equal(
			after.refusedTotal["adapter refusal"] ?? 0,
			(before.refusedTotal["adapter refusal"] ?? 0) + 1,
			"the refusal is counted as a refusal",
		);

		// A caller that waits on the dispatch anyway gets the reason back at once
		// instead of a timeout: the refusal settled the task synchronously.
		const waited = await call("external_agent_wait", { taskIds: [started.details.task.taskId], timeout: 5 });
		assert.match(waited.content[0].text, /failed/);
		assert.ok(waited.content[0].text.includes(DSH_ONESHOT_EFFORT_REFUSAL));
	} finally {
		restoreDrivers();
		restorePath();
		restoreEnv();
		await call("external_agent_stop", { all: true });
	}
});

test("hub one-shot dsh: stdout lines become the answer, stderr reasoning never does", async () => {
	const dir = makeFixtureDir({ dsh: DSH_ONESHOT_MOCK });
	const log = path.join(dir, "dsh-log.jsonl");
	const home = makeHome(true);
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ HOME: home, DSH_MOCK_LOG: log, DSH_TEST_INHERITED: "from-pi", DSH_MOCK_MODE: "success" });
	const restoreDrivers = withoutDshDriver();
	try {
		const task = startTask("dsh", "do the thing", dir, "readonly", "off", 0);
		await settle(task);

		assert.equal(task.state, "done");
		assert.equal(task.exitCode, 0);
		assert.equal(task.transport, "oneshot");
		// The CRLF line is framed by the reader, the unterminated one flushed at
		// close, and the reasoning never joins either.
		assert.equal(answerOf(task), "First line of the answer.\nSecond line with no trailing newline.");
		assert.equal(task.events.filter((event) => event.kind === "message").length, 2);
		assert.equal(task.events.some((event) => event.kind === "reasoning"), false);
		assert.match(task.stderr, /^dsh: reasoning: weighing the two options$/m);
		assert.doesNotMatch(answerOf(task), /weighing the two options/);

		const [spawned] = mockLog(log);
		assert.deepEqual(spawned.argv, ["--profile", "headless", "do the thing"]);
		assert.equal(spawned.env.DSH_HOME, path.join(home, DSH_HARNESS_HOME_NAME));
		assert.equal(spawned.env.DSH_PERMISSION_MODE, "read-only");
		// Merged over the hub's own environment, never a replacement.
		assert.equal(spawned.env.PATH_PRESENT, true);
		assert.equal(spawned.env.INHERITED, "from-pi");
		assert.equal(
			readlinkSync(path.join(home, DSH_HARNESS_HOME_NAME, ".credentials.yaml")),
			path.join(home, ".dsh", ".credentials.yaml"),
		);
		// The receipt carries what the process actually got.
		assert.deepEqual(task.dispatch.argv, ["--profile", "headless", "do the thing"]);
		assert.equal(task.dispatch.executable, "dsh");
		assert.match(task.dispatch.effectivePolicy, /DSH_PERMISSION_MODE=read-only/);
		assert.match(task.dispatch.effort.note, /no effort override requested/i);
	} finally {
		restoreDrivers();
		restorePath();
		restoreEnv();
	}
});

test("hub one-shot dsh: a non-zero exit is the failure, and its stderr stays out of the answer", async () => {
	const dir = makeFixtureDir({ dsh: DSH_ONESHOT_MOCK });
	const log = path.join(dir, "dsh-log.jsonl");
	const home = makeHome(true);
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ HOME: home, DSH_MOCK_LOG: log, DSH_MOCK_MODE: "fail" });
	const restoreDrivers = withoutDshDriver();
	try {
		const task = startTask("dsh", "t", dir, "write", "off", 0);
		await settle(task);

		// Exit code is the authority: prose on stdout does not make it a success.
		assert.equal(task.state, "failed");
		assert.equal(task.exitCode, 3);
		assert.equal(answerOf(task), "partial thought before the failure");
		assert.doesNotMatch(answerOf(task), /authentication failed/);
		assert.match(task.stderr, /dsh: authentication failed/);
		// The tier traveled even though the run failed.
		assert.equal(mockLog(log)[0].env.DSH_PERMISSION_MODE, "workspace-write");
	} finally {
		restoreDrivers();
		restorePath();
		restoreEnv();
	}
});

test("hub one-shot dsh: exit 0 with no output settles done, with no answer and no invented events", async () => {
	const dir = makeFixtureDir({ dsh: DSH_ONESHOT_MOCK });
	const home = makeHome(true);
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ HOME: home, DSH_MOCK_LOG: path.join(dir, "dsh-log.jsonl"), DSH_MOCK_MODE: "empty" });
	const restoreDrivers = withoutDshDriver();
	try {
		const task = startTask("dsh", "t", dir, "yolo", "off", 0);
		await settle(task);

		assert.equal(task.state, "done");
		assert.equal(task.exitCode, 0);
		assert.deepEqual(task.events, []);
		assert.equal(answerOf(task), "");
		// The stderr reasoning line is still captured for inspection.
		assert.match(task.stderr, /weighing the two options/);
	} finally {
		restoreDrivers();
		restorePath();
		restoreEnv();
	}
});

test("hub one-shot dsh: a reasoning line misrouted to stdout is kept out of the answer", async () => {
	const dir = makeFixtureDir({ dsh: DSH_ONESHOT_MOCK });
	const home = makeHome(true);
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ HOME: home, DSH_MOCK_LOG: path.join(dir, "dsh-log.jsonl"), DSH_MOCK_MODE: "misrouted-reasoning" });
	const restoreDrivers = withoutDshDriver();
	try {
		const task = startTask("dsh", "t", dir, "yolo", "off", 0);
		await settle(task);

		assert.equal(task.state, "done");
		assert.deepEqual(
			task.events.map((event) => event.kind),
			["reasoning", "message", "message"],
		);
		assert.equal(answerOf(task), "First line of the answer.\nSecond line with no trailing newline.");
	} finally {
		restoreDrivers();
		restorePath();
		restoreEnv();
	}
});

test("hub one-shot dsh: a home without credentials dispatches, warned and counted, never refused", async () => {
	const dir = makeFixtureDir({ dsh: DSH_ONESHOT_MOCK });
	const home = makeHome(false);
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ HOME: home, DSH_MOCK_LOG: path.join(dir, "dsh-log.jsonl") });
	const restoreDrivers = withoutDshDriver();
	const before = meter.snapshot();
	try {
		// An id no earlier test can have used: dispatchTotal counts distinct task
		// ids, and registry ids restart with each session.
		const task = startTask("dsh", "t", dir, "readonly", "off", 0, undefined, undefined, { taskId: "dsh-no-credentials" });
		await settle(task);

		// No credentials file, and the run still happened.
		assert.equal(task.state, "done");
		assert.equal(task.exitCode, 0);
		assert.match(warningsOf(task), /no .*\.credentials\.yaml to link/);
		assert.match(warningsOf(task), /default provider route or \.env must carry auth/);
		assert.equal(existsSync(path.join(home, DSH_HARNESS_HOME_NAME, DSH_CREDENTIALS_LINK_NAME)), false);
		// A warned dispatch is a dispatch: the meter files it as one and leaves the
		// refusals alone, which is what this path did before the link went
		// best-effort.
		const after = meter.snapshot();
		assert.equal(after.dispatchTotal, before.dispatchTotal + 1, "a warned dispatch must be counted as a dispatch");
		assert.deepEqual(after.refusedTotal, before.refusedTotal, "absent credentials are not a refusal");
	} finally {
		restoreDrivers();
		restorePath();
		restoreEnv();
	}
});

test("hub one-shot dsh: a forked credentials copy rides the task's warning stream", async () => {
	const dir = makeFixtureDir({ dsh: DSH_ONESHOT_MOCK });
	const home = makeHome(true);
	mkdirSync(path.join(home, DSH_HARNESS_HOME_NAME), { recursive: true });
	const fork = path.join(home, DSH_HARNESS_HOME_NAME, DSH_CREDENTIALS_LINK_NAME);
	writeFileSync(fork, "token: older\n");
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ HOME: home, DSH_MOCK_LOG: path.join(dir, "dsh-log.jsonl") });
	const restoreDrivers = withoutDshDriver();
	try {
		const task = startTask("dsh", "t", dir, "readonly", "off", 0);
		await settle(task);

		// The run happened; the warning is a notice on it, not a failure of it.
		assert.equal(task.state, "done");
		assert.match(warningsOf(task), /local credentials copy/);
		assert.ok(warningsOf(task).includes(fork));
		assert.equal(readFileSync(fork, "utf8"), "token: older\n");
	} finally {
		restoreDrivers();
		restorePath();
		restoreEnv();
	}
});

// ---------------------------------------------------------------------------
// ACP: effort over the protocol, and the tier at the permission request
// ---------------------------------------------------------------------------

/** Poll the mock's log until it satisfies the predicate (the driver answers async). */
async function waitForLog(file: string, predicate: (records: any[]) => boolean, timeoutMs = 5_000): Promise<any[]> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const records = mockLog(file);
		if (predicate(records)) return records;
		if (Date.now() > deadline) throw new Error(`timed out waiting on ${file}: ${JSON.stringify(records)}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test("dsh ACP: each effort request is one set_config_option — \"off\" included, and none when unasked", async () => {
	const dir = makeFixtureDir({ dsh: DSH_ACP_MOCK });
	const home = makeHome(true);
	const log = path.join(dir, "dsh-log.jsonl");
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ HOME: home, DSH_MOCK_LOG: log });
	try {
		const asked = SESSION_DRIVERS.dsh!();
		await asked.start({ task: "t", cwd: dir, mode: "readonly", effort: "off" });
		asked.kill();
		const unasked = SESSION_DRIVERS.dsh!();
		await unasked.start({ task: "t", cwd: dir, mode: "write" });
		unasked.kill();
		const mapped = SESSION_DRIVERS.dsh!();
		await mapped.start({ task: "t", cwd: dir, mode: "yolo", effort: "medium" });
		mapped.kill();

		const records = mockLog(log);
		// "off" is an explicit level, not an omission: it is sent, while the
		// middle start — which asked for nothing — sends no config option at all.
		assert.deepEqual(
			records.filter((record) => record.kind === "set_config_option"),
			[
				{ kind: "set_config_option", sessionId: "s1", configId: "reasoning_effort", value: "off" },
				{ kind: "set_config_option", sessionId: "s1", configId: "reasoning_effort", value: "high" },
			],
		);
		const spawns = records.filter((record) => record.kind === "spawn");
		assert.equal(spawns.length, 3);
		// ...and the tier traveled as env on every one of them.
		assert.deepEqual(
			spawns.map((spawn) => spawn.env.DSH_PERMISSION_MODE),
			["read-only", "workspace-write", "danger-full-access"],
		);
	} finally {
		restorePath();
		restoreEnv();
	}
});

test("dsh ACP: a readonly session rejects a permission escalation; yolo allows it", async () => {
	const dir = makeFixtureDir({ dsh: DSH_ACP_MOCK });
	const home = makeHome(true);
	const log = path.join(dir, "dsh-log.jsonl");
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ HOME: home, DSH_MOCK_LOG: log, DSH_MOCK_PERMISSION: "1" });
	const isResponse = (record: any) => record.kind === "client-response" && record.id === 99;
	try {
		const readonly = SESSION_DRIVERS.dsh!();
		await readonly.start({ task: "t", cwd: dir, mode: "readonly" });
		const rejected = await waitForLog(log, (records) => records.some(isResponse));
		assert.deepEqual(rejected.find(isResponse).result, { outcome: { outcome: "selected", optionId: "reject-once" } });
		readonly.kill();

		const yolo = SESSION_DRIVERS.dsh!();
		await yolo.start({ task: "t", cwd: dir, mode: "yolo" });
		const both = await waitForLog(log, (records) => records.filter(isResponse).length === 2);
		assert.deepEqual(both.filter(isResponse)[1].result, { outcome: { outcome: "selected", optionId: "allow-once" } });
		yolo.kill();
	} finally {
		restorePath();
		restoreEnv();
	}
});

// ---------------------------------------------------------------------------
// A session start is told about its forked credentials, and stays running
// ---------------------------------------------------------------------------

/** Poll until the predicate holds (driver start, settle finalize and pushes are async). */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** Poll a task's event stream until the predicate holds (the warning lands async). */
function waitForEvent(task: Task, predicate: (event: { kind: string; text: string }) => boolean, timeoutMs = 5_000): Promise<void> {
	return waitFor(() => task.events.some(predicate), `the task's warning event (stderr: ${task.stderr})`, timeoutMs);
}

test("dsh ACP session: a forked credentials copy reaches status, the settle notice and the wait report", async () => {
	const dir = makeFixtureDir({ dsh: DSH_ACP_MOCK });
	const home = makeHome(true);
	// What dsh's atomic credential write leaves behind in the harness home.
	const harnessHome = path.join(home, DSH_HARNESS_HOME_NAME);
	mkdirSync(harnessHome, { recursive: true });
	const fork = path.join(harnessHome, DSH_CREDENTIALS_LINK_NAME);
	writeFileSync(fork, "token: older\n");
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ HOME: home, DSH_MOCK_LOG: path.join(dir, "dsh-log.jsonl") });
	// Arm the settle push the way a session start does, then forget anything
	// earlier tests left queued in the registry.
	lifecycle.get("session_start")!({ reason: "" });
	pushes.length = 0;
	try {
		const task = startTask("dsh", "do the thing", dir, "yolo", "steer", 0);
		await waitForEvent(task, (event) => String(event.kind) === "warning");
		// The existing warning surface — what external_agent_status prints as
		// "non-fatal warnings" — carries the notice and the fix.
		const warnings = warningsOf(task);
		assert.match(warnings, /local credentials copy/);
		assert.ok(warnings.includes(fork), "the warning names the file to delete");
		assert.match(warnings, /Delete .*\.credentials\.yaml to re-link it/);
		// The session was not failed or blocked over it, and the copy is intact.
		assert.equal(readFileSync(fork, "utf8"), "token: older\n");
		assert.notEqual(task.state, "failed");

		// A caller that ends its turn instead of polling gets the same line on the
		// settle notice...
		await waitFor(() => pushes.length > 0, "the settle notification");
		assert.match(pushes.join("\n"), /non-fatal warnings: .*local credentials copy/);
		// ...and one that blocks in external_agent_wait gets it in the report that
		// replaces that notice. Both surfaces truncate the line like the status
		// report does, so the head is what a caller reads here; the untruncated
		// text above already names the fix.
		const report = await call("external_agent_wait", { taskIds: [task.id], mode: "any", timeout: 5 });
		assert.match(report.content[0].text, /non-fatal warnings: .*local credentials copy/);
		assert.ok(report.content[0].text.includes(fork), "the report names the file to delete");
		task.driver?.kill();
	} finally {
		restorePath();
		restoreEnv();
	}
});
