/**
 * dsh (DeepSeek harness) foundation, covering the pieces the rest of the dsh
 * work depends on:
 *   - the one-shot adapter: argv, per-mode env, effort tokens, refusals;
 *   - ensureDshLaunch: the shared ~/.dsh home, our empty settings document and
 *     the overlay that pins dsh to it, with injectable paths;
 *   - the composition anchor: the memoized `--dump-config` probe and the three
 *     ways the composed config can disagree with what provisioning wrote;
 *   - the generalized ACP entry argv and the dialect env/effort hooks;
 *   - the per-spawn env plumbing of both transports (including the DSH_HOME
 *     deletion), and the hub's refusal path.
 *
 * The hardening pass below drives the same ground adversarially: per-mode argv
 * and env exactness, a refusal that precedes every filesystem dependency, the
 * arrangements that must not be touched, answer extraction from stdout/stderr
 * fixtures, and the tier at the ACP permission request.
 *
 * No live dsh run happens here: the ACP and one-shot paths run against mock
 * `dsh`/`kimi` executables placed on PATH, and the pure functions are called
 * directly. The dsh facts asserted below were verified by hand against
 * dsh 0.1.5-rc.2, including the live run that pins the design: with the real
 * ~/.dsh holding `defaultPreset: danger-full-access`, `DSH_PERMISSION_MODE=
 * read-only dsh --profile headless --patch <overlay> "create a file"` had the
 * write denied by dsh's sandbox and left settings.yaml untouched.
 *
 * Run with `node --test test/dsh.test.ts`.
 */
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	ADAPTERS,
	DSH_ONESHOT_EFFORT_REFUSAL,
	EFFORT_LEVELS,
	dshEffortToken,
	dshPermissionMode,
	mergeSpawnEnv,
	type Effort,
	type Mode,
} from "../src/adapters.ts";
import {
	DSH_HOME_DIR_NAME,
	DSH_OVERLAY_NAME,
	DSH_SETTINGS_DOC_NAME,
	dshCompositionWarnings,
	dshOverlayContent,
	dshOverlayPath,
	dshSettingsDocPath,
	dshSharedHome,
	ensureDshLaunch,
	resetDshCompositionGuard,
	type DshProfile,
} from "../src/dsh-launch.ts";
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

/** A fake user home. Nothing is pre-created: provisioning makes the shared home. */
function makeHome(): string {
	return mkdtempSync(path.join(tmpdir(), "dsh-user-home-"));
}

/** The shared home under a fake user home — the one path every default hangs off. */
function sharedHome(home: string): string {
	return path.join(home, DSH_HOME_DIR_NAME);
}

function overlayIn(home: string): string {
	return dshOverlayPath(sharedHome(home));
}

function settingsDocIn(home: string): string {
	return dshSettingsDocPath(sharedHome(home));
}

/** A fixture home provisioned exactly the way a dispatch provisions the real one. */
function launchFixture(): { home: string; overlay: string; settingsDoc: string } {
	const home = makeHome();
	const result = ensureDshLaunch({ homeDir: sharedHome(home) });
	if (!result.ok) throw new Error(result.reason);
	return { home, overlay: result.overlay, settingsDoc: result.settingsDoc };
}

function mockLog(file: string): any[] {
	if (!existsSync(file)) return [];
	const text = readFileSync(file, "utf8").trim();
	return text ? text.split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

// ---------------------------------------------------------------------------
// The composition anchor: one probe per process, warnings only
// ---------------------------------------------------------------------------

/**
 * A `--dump-config` dump in the shape dsh 0.1.5-rc.2 prints: `- id:` rows with
 * their own lines, a `# ... patched by <file>` comment above a patched row, and
 * the row bodies carrying `!!js` expressions the launcher never evaluates.
 */
function dump(rows: Array<{ id: string; name?: string; patchedBy?: string; lines: string[] }>): string {
	const out = ["# == @deepseek-ai/dsh-base"];
	for (const row of rows) {
		if (row.patchedBy) out.push(`# == @deepseek-ai/dsh-base, patched by ${row.patchedBy}`);
		out.push(`- id: ${row.id}`, `  name: '${row.name ?? `@deepseek-ai/dsh-${row.id}`}'`, ...row.lines);
	}
	return `${out.join("\n")}\n`;
}

const settingsRow = (settingsDoc: string, patchedBy?: string) => ({
	id: "settings",
	name: "@deepseek-ai/dsh-settings-file",
	patchedBy,
	lines: ["  config:", `    path: ${settingsDoc}`],
});

const sandboxRow = (patchedBy?: string) => ({
	id: "sandbox-policy",
	name: "@deepseek-ai/dsh-sandbox-policy",
	patchedBy,
	lines: ["  config:", "    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'"],
});

const approvalRow = () => ({
	id: "approval",
	name: "@deepseek-ai/dsh-user-approval",
	lines: ["  config:", "    policy: !!js (process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'"],
});

/** The two profiles the extension boots, and the two the anchor has to answer for. */
const ANCHOR_PROFILES: readonly DshProfile[] = ["headless", "acp"];

/** Probe one fixture home under one profile with a given dump; the memo is reset first, as a fresh process would. */
function anchor(
	fixture: { overlay: string; settingsDoc: string },
	dumpText: string,
	profile: DshProfile = "headless",
): string[] {
	resetDshCompositionGuard();
	return dshCompositionWarnings({
		overlay: fixture.overlay,
		settingsDoc: fixture.settingsDoc,
		profile,
		run: () => ({ ok: true, dump: dumpText }),
	});
}

/**
 * A fixture home's composed config, as an injected probe returns it. `run` is
 * the seam the production path fills with a real `dsh --dump-config` spawn, and
 * the clean shape here is the one provisioning is supposed to produce.
 */
const CLEAN_OVERLAY = "/fixtures/overlay.yml";
const CLEAN_SETTINGS_DOC = "/fixtures/settings.pi-external-agent.yaml";

function cleanAnchor(): void {
	resetDshCompositionGuard();
	// EVERY profile: the memo is per profile, so arming one would leave a later
	// test's spawn to probe this machine through whichever fixture `dsh` is
	// first on PATH.
	for (const profile of ANCHOR_PROFILES) {
		dshCompositionWarnings({
			overlay: CLEAN_OVERLAY,
			settingsDoc: CLEAN_SETTINGS_DOC,
			profile,
			run: () => ({ ok: true, dump: dump([settingsRow(CLEAN_SETTINGS_DOC, CLEAN_OVERLAY), sandboxRow(), approvalRow()]) }),
		});
	}
}

/**
 * Every test starts with the anchor already satisfied, for every profile. The
 * guard's own tests below reset the memo themselves.
 */
beforeEach(cleanAnchor);

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
	// dsh's own sandbox is the enforcer, so no override label is declared
	assert.equal(adapter.readonlyEnforcement, undefined);
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

test("dsh one-shot dispatch: profile argv with the overlay before the task, and the mode's permission env", () => {
	const home = makeHome();
	const restoreHome = withEnv({ HOME: home });
	try {
		const readonly = ADAPTERS.dsh.buildDispatch({ task: "audit the repo", cwd: "/tmp", mode: "readonly" });
		assert.deepEqual(readonly.argv, ["--profile", "headless", "--patch", overlayIn(home), "audit the repo"]);
		assert.equal(readonly.promptArgIndex, 4);
		assert.equal(readonly.argv[readonly.promptArgIndex], "audit the repo");
		assert.equal(readonly.cwdForwardedToCli, false);
		assert.equal(readonly.refusal, undefined);
		assert.deepEqual(readonly.env, { DSH_PERMISSION_MODE: "read-only", DSH_HOME: undefined });
		assert.equal(readonly.readOnlyEnforcement, "harness-enforced");
		assert.match(readonly.effectivePolicy ?? "", /DSH_PERMISSION_MODE=read-only/);
		assert.match(readonly.effectivePolicy ?? "", /re-pointing dsh's settings row/);

		// Provisioning ran, in the SHARED home: an empty settings document and the
		// overlay that points dsh's settings row at it.
		const settingsDoc = settingsDocIn(home);
		assert.equal(readFileSync(settingsDoc, "utf8"), "");
		assert.equal(readFileSync(overlayIn(home), "utf8"), dshOverlayContent(settingsDoc));

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
	const home = makeHome();
	const restoreHome = withEnv({ HOME: home });
	try {
		const dispatch = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode: "yolo", effort: "high" });
		assert.match(dispatch.refusal ?? "", /only inside an ACP session/);
		assert.match(dispatch.refusal ?? "", /one-shot headless profile has no effort knob/);
		assert.equal(dispatch.argv.includes("--effort"), false);
		// The refusal is about the transport, but the command it reports is still
		// the real one: the overlay path is a pure function of the home.
		assert.deepEqual(dispatch.argv, ["--profile", "headless", "--patch", overlayIn(home), "t"]);
		assert.equal(dispatch.effort.requested, "high");
		assert.equal(dispatch.effort.forwarded, false);
		assert.match(dispatch.effort.note, /NOT forwarded/);
		assert.equal(dispatch.env, undefined);
	} finally {
		restoreHome();
	}
});

test("dsh reports a model override as not forwarded rather than claiming it traveled", () => {
	const home = makeHome();
	const restoreHome = withEnv({ HOME: home });
	try {
		const dispatch = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode: "yolo", model: "deepseek-chat" });
		assert.equal(dispatch.model.requested, "deepseek-chat");
		assert.equal(dispatch.model.forwarded, false);
		assert.match(dispatch.model.note, /NOT forwarded/);
		assert.equal(dispatch.argv.includes("--model"), false);
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
// ensureDshLaunch: the shared home's two files
// ---------------------------------------------------------------------------

test("ensureDshLaunch creates the empty settings document and our overlay, idempotently", () => {
	const home = makeHome();
	const homeDir = sharedHome(home);
	const settingsDoc = settingsDocIn(home);
	const overlay = overlayIn(home);

	const first = ensureDshLaunch({ homeDir });
	assert.equal(first.ok, true);
	if (!first.ok) return;
	assert.equal(first.overlay, overlay);
	assert.equal(first.settingsDoc, settingsDoc);
	// EMPTY, and exactly the documented patch entry naming the absolute doc path.
	assert.equal(readFileSync(settingsDoc, "utf8"), "");
	assert.equal(readFileSync(overlay, "utf8"), dshOverlayContent(settingsDoc));
	assert.match(readFileSync(overlay, "utf8"), /# Written by pi-external-agent/);
	assert.match(readFileSync(overlay, "utf8"), new RegExp(`^- id: settings\\n  config:\\n    path: ${settingsDoc}$`, "m"));

	// Provisioning is idempotent: the second call is a no-op, not a rewrite (the
	// document is only ever CREATED, so an existing one is never truncated, and
	// the overlay is left alone while its content already matches). A read-only
	// file is how that is observable: a write would fail, and a write that is
	// not needed cannot.
	chmodSync(overlay, 0o444);
	const second = ensureDshLaunch({ homeDir });
	assert.equal(second.ok, true);
	assert.equal(readFileSync(settingsDoc, "utf8"), "");
	assert.equal(readFileSync(overlay, "utf8"), dshOverlayContent(settingsDoc));
});

test("ensureDshLaunch never clobbers an existing settings document", () => {
	const fixture = launchFixture();
	const { settingsDoc, overlay } = fixture;
	// A user (or an earlier build) wrote something into it. It is not ours to
	// erase — the anchor reports a preset in it as a warning instead.
	writeFileSync(settingsDoc, "permission:\n  defaultPreset: danger-full-access\n");

	const result = ensureDshLaunch({ homeDir: sharedHome(fixture.home) });
	assert.equal(result.ok, true);
	assert.equal(readFileSync(settingsDoc, "utf8"), "permission:\n  defaultPreset: danger-full-access\n");
	assert.equal(readFileSync(overlay, "utf8"), dshOverlayContent(settingsDoc));
});

test("ensureDshLaunch rewrites a stale overlay and leaves a current one alone", () => {
	const home = makeHome();
	const homeDir = sharedHome(home);
	const overlay = overlayIn(home);
	ensureDshLaunch({ homeDir });
	// A stale overlay from an earlier build: it points at a document nothing
	// maintains, so the settings row would read the wrong file.
	writeFileSync(overlay, "- id: settings\n  config:\n    path: /somewhere/else.yaml\n");
	const rewritten = ensureDshLaunch({ homeDir });
	assert.equal(rewritten.ok, true);
	assert.equal(readFileSync(overlay, "utf8"), dshOverlayContent(settingsDocIn(home)));

	// With the content matching, the file is not touched again: a read-only
	// overlay is still a successful provisioning run.
	chmodSync(overlay, 0o444);
	const second = ensureDshLaunch({ homeDir });
	assert.equal(second.ok, true);
	assert.equal(readFileSync(overlay, "utf8"), dshOverlayContent(settingsDocIn(home)));
});

test("ensureDshLaunch replaces a symlinked settings document instead of carrying its target into the run", () => {
	const fixture = launchFixture();
	const { settingsDoc } = fixture;
	// The reserved name pointed at a document we did not write — the one thing
	// the whole module exists to keep dsh from reading.
	const target = path.join(fixture.home, "user-settings.yaml");
	writeFileSync(target, "permission:\n  defaultPreset: danger-full-access\n");
	unlinkSync(settingsDoc);
	symlinkSync(target, settingsDoc);

	const result = ensureDshLaunch({ homeDir: sharedHome(fixture.home) });
	assert.equal(result.ok, true);
	assert.equal(lstatSync(settingsDoc).isSymbolicLink(), false, "the symlink must be replaced by a regular file");
	assert.equal(readFileSync(settingsDoc, "utf8"), "");
	// The link's TARGET is the user's own file: replaced, never touched.
	assert.equal(readFileSync(target, "utf8"), "permission:\n  defaultPreset: danger-full-access\n");
});

test("ensureDshLaunch replaces a symlinked overlay with the real thing", () => {
	const fixture = launchFixture();
	const overlay = overlayIn(fixture.home);
	const elsewhere = path.join(fixture.home, "elsewhere.yml");
	writeFileSync(elsewhere, "hand-written\n");
	unlinkSync(overlay);
	symlinkSync(elsewhere, overlay);

	const result = ensureDshLaunch({ homeDir: sharedHome(fixture.home) });
	assert.equal(result.ok, true);
	assert.equal(lstatSync(overlay).isSymbolicLink(), false, "the symlink must be replaced by a regular file");
	assert.equal(readFileSync(overlay, "utf8"), dshOverlayContent(settingsDocIn(fixture.home)));
	assert.equal(readFileSync(elsewhere, "utf8"), "hand-written\n", "the link's target is untouched");
});

test("ensureDshLaunch: an unusable home path is a refusal that names it", () => {
	const root = mkdtempSync(path.join(tmpdir(), "dsh-provision-"));
	const homeDir = path.join(root, "not-a-directory");
	writeFileSync(homeDir, "a real file where the shared home should be\n");

	const result = ensureDshLaunch({ homeDir });
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.match(result.reason, /could not create dsh's shared home/);
	assert.ok(result.reason.includes(homeDir));
	// The file it could not replace is reported, never deleted.
	assert.equal(readFileSync(homeDir, "utf8"), "a real file where the shared home should be\n");
});

test("ensureDshLaunch: a settings document that cannot be created is a refusal that names it", () => {
	const home = makeHome();
	const homeDir = sharedHome(home);
	mkdirSync(homeDir, { recursive: true });
	// A file where the document's parent directory would have to be: the path
	// cannot hold a file at all, which is the one failure that must refuse.
	const blocked = path.join(homeDir, "blocked");
	writeFileSync(blocked, "in the way\n");
	const settingsDoc = path.join(blocked, DSH_SETTINGS_DOC_NAME);

	const result = ensureDshLaunch({ homeDir, settingsDoc });
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.match(result.reason, /could not create the empty dsh settings document/);
	assert.ok(result.reason.includes(settingsDoc));
	assert.equal(readFileSync(blocked, "utf8"), "in the way\n");
});

test("ensureDshLaunch: an overlay that cannot be written is a refusal that names it", () => {
	const home = makeHome();
	const homeDir = sharedHome(home);
	mkdirSync(homeDir, { recursive: true });
	// A directory at the overlay's name: reading it fails, and the write that
	// follows cannot produce the file dsh needs.
	const overlay = path.join(homeDir, DSH_OVERLAY_NAME);
	mkdirSync(overlay);

	const result = ensureDshLaunch({ homeDir, overlay });
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.match(result.reason, /could not write the dsh overlay/);
	assert.ok(result.reason.includes(overlay));
	// The empty document was still created: it is provisioned first, and it is
	// not the failure.
	assert.equal(readFileSync(settingsDocIn(home), "utf8"), "");
	assert.equal(lstatSync(overlay).isDirectory(), true);
});

test("ensureDshLaunch: the default paths hang off HOME, and name the shared home's files", () => {
	const home = makeHome();
	const restoreHome = withEnv({ HOME: home });
	try {
		assert.equal(dshSharedHome(), sharedHome(home));
		assert.equal(settingsDocIn(home), path.join(home, DSH_HOME_DIR_NAME, DSH_SETTINGS_DOC_NAME));
		assert.equal(overlayIn(home), path.join(home, DSH_HOME_DIR_NAME, DSH_OVERLAY_NAME));

		const result = ensureDshLaunch();
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.settingsDoc, settingsDocIn(home));
		assert.equal(result.overlay, overlayIn(home));
		assert.equal(readFileSync(settingsDocIn(home), "utf8"), "");
	} finally {
		restoreHome();
	}
});

// ---------------------------------------------------------------------------
// The composition anchor
// ---------------------------------------------------------------------------

test("the composition anchor probes each profile as itself, and a clean composition stays silent", () => {
	const fixture = launchFixture();
	const probes: string[][] = [];
	const run = (argv: string[]) => {
		probes.push(argv);
		return { ok: true, dump: dump([settingsRow(fixture.settingsDoc, fixture.overlay), sandboxRow(), approvalRow()]) };
	};
	for (const profile of ANCHOR_PROFILES) {
		resetDshCompositionGuard();
		const warnings = dshCompositionWarnings({ overlay: fixture.overlay, settingsDoc: fixture.settingsDoc, profile, run });
		assert.deepEqual(warnings, [], `a clean composition must stay silent, got ${JSON.stringify(warnings)}`);
	}
	// Offline and unambiguous: each probe composes THE PROFILE THE SPAWN BOOTS —
	// dsh composes base → profile → home → `--patch`, so a probe under the wrong
	// profile reports on a composition nobody runs.
	assert.deepEqual(probes, [
		["--profile", "headless", "--patch", fixture.overlay, "--dump-config"],
		["--profile", "acp", "--patch", fixture.overlay, "--dump-config"],
	]);
});

test("anchor (a): a settings row left reading another file warns with the offending patch", () => {
	const fixture = launchFixture();
	const warnings = anchor(
		fixture,
		dump([settingsRow("/etc/company/dsh-settings.yaml", "/etc/company/dsh.patch.yml"), sandboxRow(), approvalRow()]),
	);
	assert.equal(warnings.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
	const warning = warnings[0];
	assert.ok(warning.includes("/etc/company/dsh.patch.yml"), "the warning names the patch that won");
	assert.ok(warning.includes("/etc/company/dsh-settings.yaml"), "and the document dsh would read instead");
	assert.ok(warning.includes(fixture.settingsDoc), "and the document we wrote");
	assert.match(warning, /outranks DSH_PERMISSION_MODE/);
	assert.match(warning, /may not be the one in force/);
});

test("anchor (a): a settings row with no path at all names our overlay as the patch that lost", () => {
	const fixture = launchFixture();
	const warnings = anchor(fixture, dump([{ id: "settings", lines: [] }, sandboxRow(), approvalRow()]));
	assert.equal(warnings.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
	assert.ok(warnings[0].includes(fixture.overlay), "our overlay is the file that did not take effect");
	assert.match(warnings[0], /reading no path instead of/);
});

test("anchor (b): a sandbox-policy row replaced with a literal warns with the patch that did it", () => {
	const fixture = launchFixture();
	const warnings = anchor(
		fixture,
		dump([
			settingsRow(fixture.settingsDoc, fixture.overlay),
			{ id: "sandbox-policy", patchedBy: "/etc/company/dsh.patch.yml", lines: ["  config:", "    mode: read-only"] },
			approvalRow(),
		]),
	);
	assert.equal(warnings.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
	assert.ok(warnings[0].includes("/etc/company/dsh.patch.yml"), "the warning names the offending patch");
	assert.match(warnings[0], /sandbox-policy row with config that no longer reads DSH_PERMISSION_MODE/);
	assert.match(warnings[0], /not what governs the run/);
});

test("anchor (b): a missing approval row warns that nothing reads the variable", () => {
	const fixture = launchFixture();
	const warnings = anchor(fixture, dump([settingsRow(fixture.settingsDoc, fixture.overlay), sandboxRow()]));
	assert.equal(warnings.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
	assert.match(warnings[0], /dsh's approval row is missing from the composed config/);
	assert.match(warnings[0], /nothing reads DSH_PERMISSION_MODE/);
});

test("anchor (b): a decoy comment cannot stand in for a row that no longer reads the variable", () => {
	const fixture = launchFixture();
	// The live shape of the spoof: the config pins one literal mode and a
	// comment mentions the variable, which a substring scan reads as a hook.
	const warnings = anchor(
		fixture,
		dump([
			settingsRow(fixture.settingsDoc, fixture.overlay),
			{
				id: "sandbox-policy",
				patchedBy: "/etc/company/dsh.patch.yml",
				lines: ["  config:", "    mode: read-only", "    # pinned: DSH_PERMISSION_MODE is not read here any more"],
			},
			approvalRow(),
		]),
	);
	assert.equal(warnings.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
	assert.ok(warnings[0].includes("/etc/company/dsh.patch.yml"), "the warning names the offending patch");
	assert.match(warnings[0], /sandbox-policy row with config that no longer reads DSH_PERMISSION_MODE/);

	// A `#` inside a quoted scalar is not a comment, so a row whose live config
	// carries the variable alongside a trailing comment still passes.
	assert.deepEqual(
		anchor(
			fixture,
			dump([
				settingsRow(fixture.settingsDoc, fixture.overlay),
				sandboxRow(),
				{ id: "approval", lines: ["  config:", "    policy: !!js process.env.DSH_PERMISSION_MODE === 'danger-full-access' ? 'never' : 'ask' # tuned"] },
			]),
		),
		[],
	);
});

test("anchor: a settings document that is not a regular file warns and skips the probe", () => {
	const fixture = launchFixture();
	resetDshCompositionGuard();
	unlinkSync(fixture.settingsDoc);
	mkdirSync(fixture.settingsDoc);
	let probes = 0;
	const warnings = dshCompositionWarnings({
		overlay: fixture.overlay,
		settingsDoc: fixture.settingsDoc,
		profile: "headless",
		run: () => {
			probes += 1;
			return { ok: true, dump: "" };
		},
	});
	assert.equal(warnings.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
	assert.ok(warnings[0].includes(fixture.settingsDoc), "the warning names the path");
	assert.match(warnings[0], /not a regular file/);
	assert.match(warnings[0], /composition anchor is skipped/);
	assert.equal(probes, 0, "the probe must not run when the document cannot be read as settings");
});

test("anchor (a): the path is read from the row's config block, and the last patch that wrote it is named", () => {
	const fixture = launchFixture();
	// A sibling `path:` outside `config:` is not what dsh composes: the patch
	// entry replaces the block wholesale, so only the block counts.
	assert.deepEqual(
		anchor(
			fixture,
			dump([
				{
					id: "settings",
					patchedBy: fixture.overlay,
					lines: ["  options:", "    path: /somewhere/else.yaml", "  config:", `    path: ${fixture.settingsDoc}`],
				},
				sandboxRow(),
				approvalRow(),
			]),
		),
		[],
	);

	// Several patches wrote the row; dsh lists them in composition order, so the
	// one that won — the file a warning has to name — is the last.
	const warnings = anchor(
		fixture,
		dump([
			settingsRow("/etc/company/dsh-settings.yaml", "/etc/first.patch.yml, patched by /etc/last.patch.yml"),
			sandboxRow(),
			approvalRow(),
		]),
	);
	assert.equal(warnings.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
	assert.ok(warnings[0].includes("/etc/last.patch.yml"), `the winning patch is named: ${warnings[0]}`);
	assert.equal(warnings[0].includes("/etc/first.patch.yml"), false, "the patch that lost is not named");
});

test("anchor (c): a permission section written into our document warns and names it", () => {
	const fixture = launchFixture();
	writeFileSync(fixture.settingsDoc, "permission:\n  defaultPreset: danger-full-access\n");
	const warnings = anchor(fixture, dump([settingsRow(fixture.settingsDoc, fixture.overlay), sandboxRow(), approvalRow()]));
	assert.equal(warnings.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
	assert.ok(warnings[0].includes(fixture.settingsDoc), "the warning names the document");
	assert.match(warnings[0], /permission: section/);
	assert.match(warnings[0], /outranks DSH_PERMISSION_MODE/);
	assert.match(warnings[0], /exists only to be empty/);

	// Doing exactly what the warning says is the whole fix.
	writeFileSync(fixture.settingsDoc, "");
	assert.deepEqual(anchor(fixture, dump([settingsRow(fixture.settingsDoc, fixture.overlay), sandboxRow(), approvalRow()])), []);
});

test("the anchor is memoized per profile: one probe each, and neither profile answers for the other", () => {
	const fixture = launchFixture();
	resetDshCompositionGuard();
	const probes: string[] = [];
	// The two profiles compose DIFFERENTLY: `acp` carries a company patch that
	// re-points its settings row, `headless` is clean. One shared memo would
	// report whichever probed first for both of them.
	const run = (argv: string[]) => {
		const profile = argv[argv.indexOf("--profile") + 1];
		probes.push(profile);
		return profile === "acp"
			? {
					ok: true,
					dump: dump([settingsRow("/etc/company/dsh-settings.yaml", "/etc/company/dsh.patch.yml"), sandboxRow(), approvalRow()]),
				}
			: { ok: true, dump: dump([settingsRow(fixture.settingsDoc, fixture.overlay), sandboxRow(), approvalRow()]) };
	};
	const call = (profile: DshProfile) =>
		dshCompositionWarnings({ overlay: fixture.overlay, settingsDoc: fixture.settingsDoc, profile, run });

	assert.deepEqual(call("headless"), []);
	const acp = call("acp");
	assert.equal(acp.length, 1, `expected one warning, got ${JSON.stringify(acp)}`);
	assert.ok(acp[0].includes("/etc/company/dsh.patch.yml"), "the acp composition is reported as itself");
	// A second dispatch — another mode, another task — must not spawn the probe
	// again: the answer is about this machine and this profile, not one dispatch.
	assert.deepEqual(call("headless"), []);
	assert.deepEqual(call("acp"), acp);
	assert.deepEqual(probes, ["headless", "acp"], "the probe ran more than once per profile");
});

test("an anchor probe that cannot run warns, and is retried on the next dispatch", () => {
	const fixture = launchFixture();
	resetDshCompositionGuard();
	let probes = 0;
	const run = () => {
		probes += 1;
		return { ok: false, reason: "spawnSync dsh ENOENT" };
	};
	const call = (profile: DshProfile) =>
		dshCompositionWarnings({ overlay: fixture.overlay, settingsDoc: fixture.settingsDoc, profile, run });

	const warnings = call("headless");
	assert.equal(warnings.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
	assert.match(warnings[0], /^dsh composition anchor unavailable: /);
	assert.ok(warnings[0].includes("spawnSync dsh ENOENT"), "the warning carries the probe's own reason");
	assert.match(warnings[0], /may not be the one in force/);
	// Not memoized as silence: an unavailable anchor says nothing about the
	// composition dsh will use, so the next dispatch probes again — and an
	// unavailable `headless` probe says nothing about `acp` either.
	assert.equal(call("headless").length, 1);
	assert.equal(call("acp").length, 1);
	assert.equal(probes, 3, "a failed probe must not be memoized");
});

test("dsh one-shot: an anchor warning rides AdapterDispatch.warning, and never refuses the dispatch", () => {
	// The real probe against a fixture `dsh` whose composition points its
	// settings row at a company file: the adapter must report the disagreement
	// and still spell out a runnable dispatch.
	const dir = makeFixtureDir({ dsh: DSH_ONESHOT_MOCK });
	const home = makeHome();
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ HOME: home, DSH_MOCK_LOG: path.join(dir, "dsh-log.jsonl"), DSH_MOCK_DUMP: "foreign" });
	resetDshCompositionGuard();
	try {
		const dispatch = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode: "readonly" });
		assert.equal(dispatch.refusal, undefined, "an anchor warning must never refuse a dispatch");
		assert.deepEqual(dispatch.argv, ["--profile", "headless", "--patch", overlayIn(home), "t"]);
		assert.deepEqual(dispatch.env, { DSH_PERMISSION_MODE: "read-only", DSH_HOME: undefined });
		const warning = dispatch.warning ?? "";
		assert.ok(warning.includes("/etc/company/dsh.patch.yml"), `the warning names the offending patch: ${warning}`);
		assert.match(warning, /may not be the one in force/);
		// The probe is a launcher invocation, not a task: nothing recorded it as one.
		assert.deepEqual(mockLog(path.join(dir, "dsh-log.jsonl")), []);
	} finally {
		restoreEnv();
		restorePath();
		cleanAnchor();
	}
});

test("dsh one-shot: the real probe over a fixture home composes clean and warns about nothing", () => {
	// The other half of the anchor's contract: a dsh whose dump reflects what
	// provisioning wrote (the overlay's own path, both env-hooked rows) produces
	// no warning at all, so a healthy machine never sees one.
	const dir = makeFixtureDir({ dsh: DSH_ONESHOT_MOCK });
	const home = makeHome();
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ HOME: home, DSH_MOCK_LOG: path.join(dir, "dsh-log.jsonl") });
	resetDshCompositionGuard();
	try {
		const dispatch = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode: "yolo" });
		assert.equal(dispatch.warning, undefined);
		assert.equal(dispatch.refusal, undefined);
		assert.deepEqual(dispatch.env, { DSH_PERMISSION_MODE: "danger-full-access", DSH_HOME: undefined });
	} finally {
		restoreEnv();
		restorePath();
		cleanAnchor();
	}
});

test("no dsh launch surface references the retired harness home", () => {
	// The dedicated home is gone from the design; the directory may still sit in
	// a user's home as data, but nothing here may reach for it again.
	const sources = ["../src/adapters.ts", "../src/dsh-launch.ts", "../src/drivers/index.ts", "../src/drivers/acp.ts", "../src/drivers/base.ts"];
	for (const source of sources) {
		const text = readFileSync(new URL(source, import.meta.url), "utf8");
		assert.doesNotMatch(text, /\.dsh-external-agent|DSH_HARNESS_HOME|\.credentials\.yaml/, `${source} still references the retired harness home`);
	}
	for (const mode of ["readonly", "write", "yolo"] as Mode[]) {
		const dispatch = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode });
		const surface = [dispatch.argv.join(" "), JSON.stringify(dispatch.env), dispatch.effectivePolicy ?? "", dispatch.warning ?? ""].join("\n");
		assert.doesNotMatch(surface, /dsh-external-agent/, `${mode}: the dispatch surface still references the retired home`);
	}
});

// ---------------------------------------------------------------------------
// The ACP dialect: entry argv, env and effort
// ---------------------------------------------------------------------------

test("ACP entry argv is dialect-provided: --acp by default, --profile acp --patch <overlay> for dsh", () => {
	assert.deepEqual(SESSION_DRIVERS.reasonix!().buildArgv({ task: "t", cwd: "/tmp", mode: "yolo" }), ["--acp"]);
	const codebuddy = SESSION_DRIVERS.codebuddy!().buildArgv({ task: "t", cwd: "/tmp", mode: "readonly" });
	assert.equal(codebuddy[0], "--acp");
	assert.equal(codebuddy[1], "--permission-mode");
	const home = makeHome();
	const restoreHome = withEnv({ HOME: home });
	try {
		const dsh = SESSION_DRIVERS.dsh!().buildArgv({ task: "t", cwd: "/tmp", mode: "yolo" });
		assert.deepEqual(dsh, ["--profile", "acp", "--patch", overlayIn(home)]);
		// The prompt travels over the protocol, never in the startup argv.
		assert.equal(dsh.includes("t"), false);
	} finally {
		restoreHome();
	}
});

test("ACP dialects with an effort flag are unchanged; dsh never gets one", () => {
	const codebuddy = SESSION_DRIVERS.codebuddy!().buildArgv({ task: "t", cwd: "/tmp", mode: "yolo", effort: "high" });
	assert.equal(codebuddy[codebuddy.indexOf("--effort") + 1], "high");
	const reasonix = SESSION_DRIVERS.reasonix!().buildArgv({ task: "t", cwd: "/tmp", mode: "yolo", effort: "high" });
	assert.equal(reasonix.includes("--effort"), false);
	const home = makeHome();
	const restoreHome = withEnv({ HOME: home });
	try {
		const dsh = SESSION_DRIVERS.dsh!().buildArgv({ task: "t", cwd: "/tmp", mode: "yolo", effort: "high" });
		assert.equal(dsh.includes("--effort"), false);
	} finally {
		restoreHome();
	}
});

test("dsh ACP session: the anchor probes the acp profile, so a clean acp composition stays silent", async () => {
	// The fixture's composition is clean ONLY under `--profile acp`: a probe that
	// composed the one-shot profile would read a settings row someone else wrote
	// and warn here, which is what makes this a test of the wiring rather than of
	// the mock.
	const dir = makeFixtureDir({ dsh: DSH_ACP_MOCK });
	const home = makeHome();
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ HOME: home, DSH_MOCK_LOG: path.join(dir, "dsh-log.jsonl") });
	resetDshCompositionGuard();
	try {
		const driver = SESSION_DRIVERS.dsh!();
		const warnings: string[] = [];
		driver.onEvent((event) => {
			if (event.kind === "warning") warnings.push(event.text);
		});
		await driver.start({ task: "t", cwd: dir, mode: "yolo" });
		driver.kill();
		assert.deepEqual(warnings, [], "the session's composition was probed under the wrong profile");
	} finally {
		restorePath();
		restoreEnv();
		cleanAnchor();
	}
});

const DSH_ACP_MOCK = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const log = process.env.DSH_MOCK_LOG;
function record(entry) { if (log) fs.appendFileSync(log, JSON.stringify(entry) + "\\n"); }
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
if (argv.includes("--dump-config")) {
  // A stand-in for the real composition dump the anchor reads: the settings row
  // copied out of the overlay we were handed, plus the two rows that read the
  // tier from the environment. The probe is not a task run, so nothing is
  // recorded for it.
  // dsh composes PER PROFILE, so this composition is only clean when it is
  // read under the profile this fixture stands for: a probe under any other
  // profile reports a settings row somebody else wrote.
  const mode = process.env.DSH_MOCK_DUMP || "clean";
  const profile = argv[argv.indexOf("--profile") + 1];
  const docPath = /^\\s*path:\\s*(.+)$/m.exec(fs.readFileSync(argv[argv.indexOf("--patch") + 1], "utf8"))[1];
  const rows = mode === "foreign" || profile !== "acp"
    ? "# == base, patched by /etc/company/dsh.patch.yml\\n- id: settings\\n  name: '@deepseek-ai/dsh-settings-file'\\n  config:\\n    path: /etc/company/dsh-settings.yaml\\n"
    : "- id: settings\\n  name: '@deepseek-ai/dsh-settings-file'\\n  config:\\n    path: " + docPath + "\\n";
  process.stdout.write(
    rows +
    "- id: sandbox-policy\\n  name: '@deepseek-ai/dsh-sandbox-policy'\\n  config:\\n    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'\\n" +
    "- id: approval\\n  name: '@deepseek-ai/dsh-user-approval'\\n  config:\\n    policy: !!js (process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'\\n",
  );
  process.exit(0);
}
record({
  kind: "spawn",
  argv: argv,
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

test("dsh ACP session: --patch overlay, the shared home provisioned, the mode env, and effort via set_config_option", async () => {
	const dir = makeFixtureDir({ dsh: DSH_ACP_MOCK });
	const home = makeHome();
	const log = path.join(dir, "dsh-log.jsonl");
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ HOME: home, DSH_MOCK_LOG: log });
	const driver = SESSION_DRIVERS.dsh!();
	try {
		await driver.start({ task: "do the thing", cwd: dir, mode: "write", effort: "high" });

		const [spawned, configured] = mockLog(log);
		assert.deepEqual(spawned.argv, ["--profile", "acp", "--patch", overlayIn(home)]);
		assert.equal(spawned.env.DSH_HOME, null, "an inherited DSH_HOME must never reach the session");
		assert.equal(spawned.env.DSH_PERMISSION_MODE, "workspace-write");
		// Merged over process.env, not a replacement: the CLI still has its PATH.
		assert.equal(spawned.env.PATH_INHERITED, true);
		// Provisioning ran before the session start: the empty document and the
		// overlay that points dsh's settings row at it.
		assert.equal(readFileSync(settingsDocIn(home), "utf8"), "");
		assert.equal(readFileSync(overlayIn(home), "utf8"), dshOverlayContent(settingsDocIn(home)));
		// Effort has no flag on this CLI: it goes over the protocol, mapped.
		assert.deepEqual(configured, { kind: "set_config_option", sessionId: "s1", configId: "reasoning_effort", value: "high" });
	} finally {
		driver.kill();
		restoreEnv();
		restorePath();
	}
});

test("dsh ACP session: an ambient DSH_HOME is deleted from the child's environment", async () => {
	const dir = makeFixtureDir({ dsh: DSH_ACP_MOCK });
	const home = makeHome();
	const log = path.join(dir, "dsh-log.jsonl");
	const restorePath = usePath(dir);
	// A user who exported DSH_HOME (the retired design, or their own harness
	// home) must not be able to point this session at another home.
	const restoreEnv = withEnv({ HOME: home, DSH_MOCK_LOG: log, DSH_HOME: "/tmp/some-other-dsh-home", DSH_PERMISSION_MODE: "danger-full-access" });
	const driver = SESSION_DRIVERS.dsh!();
	try {
		await driver.start({ task: "t", cwd: dir, mode: "readonly" });
		const [spawned] = mockLog(log);
		assert.equal(spawned.env.DSH_HOME, null);
		assert.equal(spawned.env.DSH_PERMISSION_MODE, "read-only", "the requested tier must win over an inherited one");
		// The overlay it was handed is the one provisioning wrote, in the shared home.
		assert.equal(spawned.argv[spawned.argv.indexOf("--patch") + 1], overlayIn(home));
	} finally {
		driver.kill();
		restoreEnv();
		restorePath();
	}
});

test("dsh ACP session: a provisioning failure refuses the session start, spawning nothing", async () => {
	const dir = makeFixtureDir({ dsh: DSH_ACP_MOCK });
	const log = path.join(dir, "dsh-log.jsonl");
	const root = mkdtempSync(path.join(tmpdir(), "dsh-blocked-"));
	// A file where the shared home would have to be: neither of provisioning's
	// two files can exist, and without them dsh would read the user's own
	// settings document — so the session must not start at all.
	const blocked = path.join(root, ".dsh");
	writeFileSync(blocked, "in the way\n");
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ HOME: root, DSH_MOCK_LOG: log });
	const driver = SESSION_DRIVERS.dsh!();
	try {
		await assert.rejects(
			() => driver.start({ task: "t", cwd: dir, mode: "yolo" }),
			(err: Error) => {
				assert.match(err.message, /could not create dsh's shared home/);
				assert.ok(err.message.includes(blocked));
				return true;
			},
		);
		assert.deepEqual(mockLog(log), [], "a refused session start must not spawn dsh");
		assert.equal(readFileSync(blocked, "utf8"), "in the way\n");
	} finally {
		driver.kill();
		restoreEnv();
		restorePath();
	}
});

test("dsh ACP session: a rejected set_config_option fails the session start", async () => {
	const dir = makeFixtureDir({ dsh: DSH_ACP_MOCK });
	const home = makeHome();
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

// ---------------------------------------------------------------------------
// The hub's env plumbing and refusal path (one-shot transport)
// ---------------------------------------------------------------------------

/**
 * kimi runs over its ACP session in the hub, so the one-shot adapter is
 * reachable only when kimi has no session driver: the registry picks the
 * persistent transport for exactly the agents in SESSION_DRIVERS. Removing the
 * entry is the only way to drive that path through the registry; the returned
 * function puts it back, so no other test sees a different transport table.
 */
function withoutKimiDriver(): () => void {
	const saved = SESSION_DRIVERS.kimi;
	delete SESSION_DRIVERS.kimi;
	return () => {
		SESSION_DRIVERS.kimi = saved;
	};
}

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
	const restoreDriver = withoutKimiDriver();
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
		restoreDriver();
		restorePath();
	}
});

test("hub one-shot: an adapter's undefined env value deletes an inherited variable", async () => {
	// The sentinel dsh uses to strip an ambient DSH_HOME: `undefined` must mean
	// DELETED from the child's environment, not passed through as a string or
	// silently dropped by Node after being merged as a value.
	const dir = makeFixtureDir({ kimi: KIMI_ENV_MOCK });
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ DSH_TEST_MARKER: "from-the-shell" });
	const original = ADAPTERS.kimi.buildDispatch;
	const restoreDriver = withoutKimiDriver();
	try {
		const kept = await call("external_agent_start", { agent: "kimi", task: "t", mode: "yolo", cwd: dir, notify: "off" });
		const keptWait = await call("external_agent_wait", { taskIds: [kept.details.task.taskId], timeout: 5 });
		assert.match(keptWait.content[0].text, /marker=from-the-shell;path=yes/);

		ADAPTERS.kimi.buildDispatch = (input) => ({ ...original(input), env: { DSH_TEST_MARKER: undefined } });
		const stripped = await call("external_agent_start", { agent: "kimi", task: "t", mode: "yolo", cwd: dir, notify: "off" });
		const strippedWait = await call("external_agent_wait", { taskIds: [stripped.details.task.taskId], timeout: 5 });
		assert.match(strippedWait.content[0].text, /marker=absent;path=yes/);
	} finally {
		ADAPTERS.kimi.buildDispatch = original;
		await call("external_agent_stop", { all: true });
		restoreDriver();
		restoreEnv();
		restorePath();
	}
});

test("mergeSpawnEnv: values are merged over the base, and undefined deletes", () => {
	const merged = mergeSpawnEnv({ KEEP: "base", DROP: "base", OVERRIDE: "base" }, { DROP: undefined, OVERRIDE: "adapter", ADDED: "adapter" });
	assert.deepEqual(merged, { KEEP: "base", OVERRIDE: "adapter", ADDED: "adapter" });
	assert.equal("DROP" in merged, false);
});

test("mergeSpawnEnv: an override and a deletion find the key whatever case the environment reports", () => {
	// Windows hands process.env whatever casing the OS stores, so a delete that
	// only matched `DSH_HOME` exactly would leave `Dsh_Home` behind — pointing
	// the child at a home nothing provisioned.
	const merged = mergeSpawnEnv({ Dsh_Home: "/somewhere/else/.dsh", Path: "base" }, { DSH_HOME: undefined, PATH: "/usr/bin" });
	assert.deepEqual(merged, { PATH: "/usr/bin" });
	assert.equal("Dsh_Home" in merged, false);
	assert.equal("Path" in merged, false);
});

test("hub one-shot: an adapter refusal fails the dispatch with its reason and spawns nothing", async () => {
	const dir = makeFixtureDir({ kimi: KIMI_ENV_MOCK });
	const restorePath = usePath(dir);
	const original = ADAPTERS.kimi.buildDispatch;
	const restoreDriver = withoutKimiDriver();
	try {
		ADAPTERS.kimi.buildDispatch = (input) => ({ ...original(input), refusal: "kimi cannot run this request" });
		const started = await call("external_agent_start", { agent: "kimi", task: "t", mode: "yolo", cwd: dir, notify: "off" });
		assert.match(started.content[0].text, /Failed to start kimi: kimi cannot run this request/);
		assert.equal(started.details.task.state, "failed");
		assert.equal(started.details.task.exitCode, null);
	} finally {
		ADAPTERS.kimi.buildDispatch = original;
		await call("external_agent_stop", { all: true });
		restoreDriver();
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

test("dsh one-shot: every mode's argv is the profile, our overlay and the task, and its env exactly the tier plus the DSH_HOME deletion", () => {
	for (const [mode, permissionMode] of DSH_MODES) {
		const home = makeHome();
		const restoreHome = withEnv({ HOME: home });
		try {
			const task = "audit the repo\nsecond line";
			const dispatch = ADAPTERS.dsh.buildDispatch({ task, cwd: "/tmp/dsh-cwd-not-forwarded", mode });
			assert.deepEqual(dispatch.argv, ["--profile", "headless", "--patch", overlayIn(home), task], `${mode}: argv`);
			assert.equal(dispatch.promptArgIndex, 4);
			assert.equal(dispatch.argv[dispatch.promptArgIndex], task);
			// --patch is a LAUNCHER flag: it must precede the task positional.
			assert.ok(dispatch.argv.indexOf("--patch") < dispatch.promptArgIndex, `${mode}: --patch must come before the task`);
			assert.equal(dispatch.refusal, undefined);
			assert.equal(dispatch.cwdForwardedToCli, false);
			assert.equal(dispatch.argv.includes("/tmp/dsh-cwd-not-forwarded"), false, `${mode}: the cwd has no flag`);
			for (const flag of DSH_UNVERIFIED_FLAGS) {
				assert.equal(dispatch.argv.includes(flag), false, `${mode}: ${flag} does not exist in this release`);
			}
			// Exactly two keys, and DSH_HOME carries the deletion: an extra value
			// would widen the contract silently, and a missing deletion would let an
			// ambient DSH_HOME through.
			assert.deepEqual(Object.keys(dispatch.env ?? {}).sort(), ["DSH_HOME", "DSH_PERMISSION_MODE"]);
			assert.equal(dispatch.env?.DSH_HOME, undefined);
			assert.equal(dispatch.env?.DSH_PERMISSION_MODE, permissionMode);
			assert.equal("DSH_HOME" in (dispatch.env ?? {}), true, "the deletion must be explicit, not absent");
			assert.equal(dispatch.readOnlyEnforcement, mode === "readonly" ? "harness-enforced" : "not-applicable");
			assert.match(dispatch.effectivePolicy ?? "", new RegExp(`DSH_PERMISSION_MODE=${permissionMode}`));
			assert.match(dispatch.effectivePolicy ?? "", /re-pointing dsh's settings row/);
			// Provisioning ran for this mode: the empty document, and the overlay
			// that keeps dsh's settings row off the user's own settings.yaml.
			assert.equal(readFileSync(settingsDocIn(home), "utf8"), "");
			assert.equal(readFileSync(overlayIn(home), "utf8"), dshOverlayContent(settingsDocIn(home)));
			// The adapter contributes env for the child; it must never touch the hub's own.
			assert.equal(process.env.DSH_HOME, undefined);
			assert.equal(process.env.DSH_PERMISSION_MODE, undefined);
		} finally {
			restoreHome();
		}
	}
});

test("dsh one-shot: one overlay serves every mode, and the tier is never memoized across dispatches", () => {
	const home = makeHome();
	const restoreHome = withEnv({ HOME: home });
	try {
		const readonly = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode: "readonly" });
		// Read-only now: a later dispatch that rewrote it (or re-created the
		// document) would fail provisioning instead of quietly returning a
		// refusal, so this also pins that provisioning is not repeated work.
		chmodSync(overlayIn(home), 0o444);
		const write = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode: "write" });
		const yolo = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode: "yolo" });
		assert.deepEqual(
			[readonly.env?.DSH_PERMISSION_MODE, write.env?.DSH_PERMISSION_MODE, yolo.env?.DSH_PERMISSION_MODE],
			["read-only", "workspace-write", "danger-full-access"],
		);
		assert.equal(new Set([readonly.argv[3], write.argv[3], yolo.argv[3]]).size, 1, "every mode gets the same overlay");
		assert.deepEqual([write.refusal, yolo.refusal], [undefined, undefined]);
	} finally {
		restoreHome();
	}
});

test("dsh one-shot: an inherited DSH_HOME cannot reach the child, and cannot point the shared home elsewhere", () => {
	// A user who exported DSH_HOME (the retired design, or their own harness
	// home) must not be able to redirect a hub dispatch: the overlay is written
	// into the shared home, so a different home would compose a different config.
	const home = makeHome();
	const restoreHome = withEnv({ HOME: home, DSH_HOME: "/tmp/some-other-dsh-home" });
	try {
		const dispatch = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode: "yolo" });
		assert.equal(dispatch.env?.DSH_HOME, undefined);
		assert.equal(dispatch.argv[dispatch.argv.indexOf("--patch") + 1], overlayIn(home), "the overlay is the shared home's");
		assert.equal(mergeSpawnEnv(process.env, dispatch.env ?? {}).DSH_HOME, undefined);
	} finally {
		restoreHome();
	}
});

test("dsh one-shot: an effort request is refused before any provisioning, for every level and mode", () => {
	// HOME points at a path that does not exist: the refusal must be about the
	// transport, not about this machine, and it must not touch the filesystem on
	// the way to saying so.
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
				assert.equal(dispatch.argv.length, 5, `${mode}/${level}: argv`);
				assert.equal(dispatch.effort.requested, level);
				assert.equal(dispatch.effort.forwarded, false);
				assert.match(dispatch.effort.note, /NOT forwarded/);
			}
		}
		assert.equal(existsSync(home), false);
		assert.equal(existsSync(sharedHome(home)), false);
	} finally {
		restoreHome();
	}
});

test("dsh one-shot: an effort request is refused even when the shared home exists, and nothing is provisioned", () => {
	const fixture = launchFixture();
	// Read-only: a dispatch that ran provisioning anyway would fail on the write
	// and report a provisioning refusal instead of the transport one.
	chmodSync(fixture.settingsDoc, 0o444);
	chmodSync(fixture.overlay, 0o444);
	const restoreHome = withEnv({ HOME: fixture.home });
	try {
		const dispatch = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode: "yolo", effort: "max" });
		assert.equal(dispatch.refusal, DSH_ONESHOT_EFFORT_REFUSAL);
		assert.equal(dispatch.env, undefined);
	} finally {
		restoreHome();
	}
});

test("dsh one-shot: a provisioning refusal fails the dispatch instead of running under the user's settings", () => {
	const root = mkdtempSync(path.join(tmpdir(), "dsh-blocked-"));
	const blocked = path.join(root, ".dsh");
	writeFileSync(blocked, "in the way\n");
	const restoreHome = withEnv({ HOME: root });
	try {
		const dispatch = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode: "readonly" });
		assert.match(dispatch.refusal ?? "", /could not create dsh's shared home/);
		assert.ok((dispatch.refusal ?? "").includes(blocked), "the refusal names the path it could not use");
		assert.equal(dispatch.env, undefined);
		// The dispatch is still spelled out, so the reason has a command to attach to.
		assert.deepEqual(dispatch.argv, ["--profile", "headless", "--patch", overlayIn(root), "t"]);
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
	const home = makeHome();
	const restoreHome = withEnv({ HOME: home });
	try {
		// The registry spawns with shell: false and this argv array, so the task
		// can never be split, globbed or word-split on the way to dsh.
		for (const task of ["--help", "-x --y", "line one\nline two", "unicode ✓ and 'quotes'", "  leading and trailing  "]) {
			const dispatch = ADAPTERS.dsh.buildDispatch({ task, cwd: "/tmp", mode: "yolo" });
			assert.deepEqual(dispatch.argv, ["--profile", "headless", "--patch", overlayIn(home), task]);
			assert.equal(dispatch.argv.length, 5, "the task must never become extra arguments");
			assert.equal(dispatch.argv[4], task, "the task must arrive verbatim, not trimmed or quoted");
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
 * newline (the close-time buffer flush). `--dump-config` is answered from the
 * overlay it was given, so the anchor's probe is not recorded as a task run.
 */
const DSH_ONESHOT_MOCK = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const log = process.env.DSH_MOCK_LOG;
if (argv.includes("--dump-config")) {
  // The composition the anchor reads, in the shape the real launcher prints.
  // Clean only under the profile this fixture stands for: dsh composes per
  // profile, so a probe under the wrong one must not look healthy.
  const mode = process.env.DSH_MOCK_DUMP || "clean";
  const profile = argv[argv.indexOf("--profile") + 1];
  const docPath = /^\\s*path:\\s*(.+)$/m.exec(fs.readFileSync(argv[argv.indexOf("--patch") + 1], "utf8"))[1];
  process.stdout.write(
    (mode === "foreign" || profile !== "headless"
      ? "# == base, patched by /etc/company/dsh.patch.yml\\n- id: settings\\n  name: '@deepseek-ai/dsh-settings-file'\\n  config:\\n    path: /etc/company/dsh-settings.yaml\\n"
      : "- id: settings\\n  name: '@deepseek-ai/dsh-settings-file'\\n  config:\\n    path: " + docPath + "\\n") +
    "- id: sandbox-policy\\n  name: '@deepseek-ai/dsh-sandbox-policy'\\n  config:\\n    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'\\n" +
    "- id: approval\\n  name: '@deepseek-ai/dsh-user-approval'\\n  config:\\n    policy: !!js (process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'\\n",
  );
  process.exit(0);
}
if (log) fs.appendFileSync(log, JSON.stringify({
  kind: "spawn",
  argv: argv,
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
	const home = makeHome();
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
		// A refusal is not a spawn that failed: no process, no record, no files.
		assert.equal(tasks.get(started.details.task.taskId)?.proc, null);
		assert.deepEqual(mockLog(log), []);
		assert.equal(existsSync(sharedHome(home)), false);
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
	const home = makeHome();
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
		assert.deepEqual(spawned.argv, ["--profile", "headless", "--patch", overlayIn(home), "do the thing"]);
		assert.equal(spawned.env.DSH_HOME, null, "the shared home is the one resolved, so DSH_HOME must be gone");
		assert.equal(spawned.env.DSH_PERMISSION_MODE, "read-only");
		// Merged over the hub's own environment, never a replacement.
		assert.equal(spawned.env.PATH_PRESENT, true);
		assert.equal(spawned.env.INHERITED, "from-pi");
		// Provisioning ran before the spawn: the empty document plus our overlay.
		assert.equal(readFileSync(settingsDocIn(home), "utf8"), "");
		assert.equal(readFileSync(overlayIn(home), "utf8"), dshOverlayContent(settingsDocIn(home)));
		// The receipt carries what the process actually got.
		assert.deepEqual(task.dispatch.argv, ["--profile", "headless", "--patch", overlayIn(home), "do the thing"]);
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
	const home = makeHome();
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
	const home = makeHome();
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
	const home = makeHome();
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

test("hub one-shot dsh: a dispatch provisions the shared home, is counted, and carries no warning", async () => {
	const dir = makeFixtureDir({ dsh: DSH_ONESHOT_MOCK });
	const home = makeHome();
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ HOME: home, DSH_MOCK_LOG: path.join(dir, "dsh-log.jsonl") });
	const restoreDrivers = withoutDshDriver();
	const before = meter.snapshot();
	try {
		// An id no earlier test can have used: dispatchTotal counts distinct task
		// ids, and registry ids restart with each session.
		const task = startTask("dsh", "t", dir, "readonly", "off", 0, undefined, undefined, { taskId: "dsh-shared-home" });
		await settle(task);

		assert.equal(task.state, "done");
		assert.equal(task.exitCode, 0);
		// A clean composition is silent: no warnings, and specifically nothing
		// about credentials — the shared home is the user's own.
		assert.equal(warningsOf(task), "");
		assert.equal(readFileSync(settingsDocIn(home), "utf8"), "");
		assert.equal(readFileSync(overlayIn(home), "utf8"), dshOverlayContent(settingsDocIn(home)));
		// A dispatch with nothing to warn about is filed as a dispatch, and never
		// as a refusal.
		const after = meter.snapshot();
		assert.equal(after.dispatchTotal, before.dispatchTotal + 1, "a clean dispatch must be counted as a dispatch");
		assert.deepEqual(after.refusedTotal, before.refusedTotal);
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
	const home = makeHome();
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
		// No session ever inherits a home override: the overlay names the home.
		assert.deepEqual(spawns.map((spawn) => spawn.env.DSH_HOME), [null, null, null]);
	} finally {
		restorePath();
		restoreEnv();
	}
});

test("dsh ACP: a readonly session rejects a permission escalation; yolo allows it", async () => {
	const dir = makeFixtureDir({ dsh: DSH_ACP_MOCK });
	const home = makeHome();
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
// A composition warning rides the warning channel, and the session stays up
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

test("dsh ACP session: a composition warning reaches status, the settle notice and the wait report", async () => {
	const dir = makeFixtureDir({ dsh: DSH_ACP_MOCK });
	const home = makeHome();
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ HOME: home, DSH_MOCK_LOG: path.join(dir, "dsh-log.jsonl"), DSH_MOCK_DUMP: "foreign" });
	// The anchor is memoized for the whole process, so this test has to un-arm
	// the clean composition every other test starts from.
	resetDshCompositionGuard();
	// Arm the settle push the way a session start does, then forget anything
	// earlier tests left queued in the registry.
	lifecycle.get("session_start")!({ reason: "" });
	pushes.length = 0;
	try {
		const task = startTask("dsh", "do the thing", dir, "yolo", "steer", 0);
		await waitForEvent(task, (event) => String(event.kind) === "warning");
		// The existing warning surface — what external_agent_status prints as
		// "non-fatal warnings" — carries the notice and the file that caused it.
		const warnings = warningsOf(task);
		assert.ok(warnings.includes("/etc/company/dsh.patch.yml"), `the warning names the offending patch: ${warnings}`);
		assert.match(warnings, /outranks DSH_PERMISSION_MODE/);
		// The session was not failed or blocked over it: the caller gets a run,
		// plus the notice that the tier it asked for may not be the tier in force.
		assert.notEqual(task.state, "failed");
		assert.equal(task.events.some((event) => event.kind === "error"), false);

		// A caller that ends its turn instead of polling gets the same line on the
		// settle notice...
		await waitFor(() => pushes.length > 0, "the settle notification");
		assert.match(pushes.join("\n"), /non-fatal warnings: .*outranks DSH_PERMISSION_MODE/);
		// ...and one that blocks in external_agent_wait gets it in the report that
		// replaces that notice.
		const report = await call("external_agent_wait", { taskIds: [task.id], mode: "any", timeout: 5 });
		assert.match(report.content[0].text, /non-fatal warnings: .*outranks DSH_PERMISSION_MODE/);
		assert.ok(report.content[0].text.includes("/etc/company/dsh.patch.yml"), "the report names the offending patch");
		task.driver?.kill();
	} finally {
		restorePath();
		restoreEnv();
		cleanAnchor();
	}
});
