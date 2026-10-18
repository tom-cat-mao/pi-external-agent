/**
 * dsh launch, permission safety, and one-shot adapter contract.
 *
 * Production dsh tasks run over ACP; test/dsh-driver.test.ts owns that protocol
 * suite. This file pins the launch overlay, the mode-aware composition guard,
 * the adapter metadata/receipts, and the legacy one-shot spelling that remains
 * behind the uniform Adapter interface.
 *
 * Run with `node --test test/dsh.test.ts`.
 */
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ADAPTERS, DSH_ONESHOT_EFFORT_REFUSAL, EFFORT_LEVELS, dshEffortToken, dshPermissionMode, type Effort, type Mode } from "../src/adapters.ts";
import {
	DSH_HOME_DIR_NAME,
	DSH_OVERLAY_NAME,
	dshCompositionWarnings,
	dshOverlayContent,
	dshOverlayPath,
	dshSharedHome,
	ensureDshLaunch,
	resetDshCompositionGuard,
	type DshProfile,
} from "../src/dsh-launch.ts";
import { SESSION_DRIVERS, STEER_AGENT_IDS } from "../src/drivers/index.ts";

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
const registry = (await import("../src/hub/registry.ts")) as {
	effortForwardedOnSession: (agent: string) => boolean;
	effortSessionNote: (agent: string, effort: Effort) => string;
	modelForwardedOnSession: (agent: string) => boolean;
	modelSessionNote: (agent: string, model: string) => string;
};
moduleHooks.deregister();

afterEach(() => {
	resetDshCompositionGuard();
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

function makeFixtureDir(files: Record<string, string>): string {
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-fixture-"));
	for (const [name, source] of Object.entries(files)) {
		const file = path.join(dir, name);
		writeFileSync(file, source);
		chmodSync(file, 0o755);
	}
	return dir;
}

function makeHome(): string {
	return mkdtempSync(path.join(tmpdir(), "dsh-user-home-"));
}

function sharedHome(home: string): string {
	return path.join(home, DSH_HOME_DIR_NAME);
}

function overlayIn(home: string): string {
	return dshOverlayPath(sharedHome(home));
}

function launchFixture(): { home: string; overlay: string } {
	const home = makeHome();
	const result = ensureDshLaunch({ homeDir: sharedHome(home) });
	if (result.ok === false) throw new Error(result.reason);
	return { home, overlay: result.overlay };
}

const BB_JS = "!!js";

function dump(rows: Array<{ id: string; name?: string; patchedBy?: string; lines: string[] }>): string {
	const out = ["# == @deepseek-ai/dsh-base"];
	for (const row of rows) {
		if (row.patchedBy) out.push(`# == @deepseek-ai/dsh-base, patched by ${row.patchedBy}`);
		out.push(`- id: ${row.id}`, `  name: '${row.name ?? `@deepseek-ai/dsh-${row.id}`}'`, ...row.lines);
	}
	return `${out.join("\n")}\n`;
}

function permissionRow(patchedBy?: string) {
	return {
		id: "permission",
		name: "@deepseek-ai/dsh-permission-presets",
		patchedBy,
		lines: [
			"  config:",
			"    presets:",
			"      read-only:",
			"        sandbox: read-only",
			"        approval: ask",
			"      workspace-write:",
			"        sandbox: workspace-write",
			"        approval: ask",
			"      danger-full-access:",
			"        sandbox: danger-full-access",
			"        approval: never",
			`    defaultPreset: ${BB_JS} process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`,
		],
	};
}

const sandboxRow = (patchedBy?: string) => ({
	id: "sandbox-policy",
	name: "@deepseek-ai/dsh-sandbox-policy",
	patchedBy,
	lines: ["  config:", `    mode: ${BB_JS} process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`],
});

const approvalRow = () => ({
	id: "approval",
	name: "@deepseek-ai/dsh-user-approval",
	lines: ["  config:", `    policy: ${BB_JS} (process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'`],
});

const ANCHOR_PROFILES: readonly DshProfile[] = ["headless", "acp"];

function anchor(fixture: { overlay: string }, dumpText: string, profile: DshProfile = "headless"): string[] {
	resetDshCompositionGuard();
	return dshCompositionWarnings({
		overlay: fixture.overlay,
		profile,
		run: () => ({ ok: true, dump: dumpText }),
	});
}

function cleanAnchor(): void {
	resetDshCompositionGuard();
	for (const profile of ANCHOR_PROFILES) {
		dshCompositionWarnings({
			overlay: "/fixtures/overlay.yml",
			profile,
			run: () => ({ ok: true, dump: dump([permissionRow("/fixtures/overlay.yml"), sandboxRow(), approvalRow()]) }),
		});
	}
}

beforeEach(cleanAnchor);

// ---------------------------------------------------------------------------
// Adapter metadata and the legacy one-shot spelling
// ---------------------------------------------------------------------------

test("dsh adapter: yolo default, all tiers enforced, ACP follow-up only", () => {
	const adapter = ADAPTERS.dsh;
	assert.equal(adapter.bin, "dsh");
	assert.equal(adapter.defaultMode, "yolo");
	assert.equal(adapter.maxMode, "yolo");
	assert.equal(adapter.enforcesReadOnly, true);
	assert.equal(adapter.readonlyEnforcement, undefined);
	assert.deepEqual(adapter.supportedEfforts, EFFORT_LEVELS);
	assert.equal(adapter.session?.steer, false);
	assert.equal(adapter.session?.followUp, true);
	assert.match(adapter.session?.steerNote ?? "", /no steer method/);
	assert.equal(STEER_AGENT_IDS.includes("dsh"), false);
	assert.match(adapter.sessionPolicy?.("readonly") ?? "", /fails closed/);
	assert.match(adapter.sessionPolicy?.("write") ?? "", /fails closed/);
	assert.match(adapter.sessionPolicy?.("yolo") ?? "", /allows permission escalations/);
});

test("dsh permission vocabulary maps the three extension modes", () => {
	assert.equal(dshPermissionMode("readonly"), "read-only");
	assert.equal(dshPermissionMode("write"), "workspace-write");
	assert.equal(dshPermissionMode("yolo"), "danger-full-access");
});

test("dshEffortToken maps normalized effort onto dsh's target vocabulary", () => {
	const expected: Array<[Effort, string]> = [
		["off", "off"],
		["minimal", "low"],
		["low", "low"],
		["medium", "high"],
		["high", "high"],
		["xhigh", "max"],
		["max", "max"],
	];
	assert.deepEqual(
		EFFORT_LEVELS.map((level) => [level, dshEffortToken(level)]),
		expected,
	);
});

test("dsh one-shot dispatch spells the profile, overlay and task with the mode env", () => {
	const home = makeHome();
	const restoreHome = withEnv({ HOME: home });
	try {
		const task = "audit the repo\nsecond line";
		for (const [mode, permission] of [
			["readonly", "read-only"],
			["write", "workspace-write"],
			["yolo", "danger-full-access"],
		] as Array<[Mode, string]>) {
			const dispatch = ADAPTERS.dsh.buildDispatch({ task, cwd: "/tmp/ignored", mode });
			assert.deepEqual(dispatch.argv, ["--profile", "headless", "--patch", overlayIn(home), task]);
			assert.equal(dispatch.promptArgIndex, 4);
			assert.equal(dispatch.cwdForwardedToCli, false);
			assert.equal(dispatch.refusal, undefined);
			assert.deepEqual(dispatch.env, { DSH_PERMISSION_MODE: permission, DSH_HOME: undefined });
			assert.match(dispatch.effectivePolicy ?? "", /replacing dsh's permission row/);
			assert.equal(dispatch.readOnlyEnforcement, mode === "readonly" ? "harness-enforced" : "not-applicable");
		}
		assert.equal(readFileSync(overlayIn(home), "utf8"), dshOverlayContent());
		assert.match(readFileSync(overlayIn(home), "utf8"), /^- id: permission$/m);
		assert.doesNotMatch(readFileSync(overlayIn(home), "utf8"), /^- id: settings$/m);
	} finally {
		restoreHome();
	}
});

test("dsh one-shot refuses effort instead of dropping it", () => {
	const home = makeHome();
	const restoreHome = withEnv({ HOME: home });
	try {
		const dispatch = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode: "yolo", effort: "high" });
		assert.equal(dispatch.refusal, DSH_ONESHOT_EFFORT_REFUSAL);
		assert.equal(dispatch.env, undefined);
		assert.equal(dispatch.effort.forwarded, false);
		assert.match(dispatch.effort.note, /NOT forwarded/);
	} finally {
		restoreHome();
	}
});

test("dsh one-shot still reports a model override as not forwarded", () => {
	const home = makeHome();
	const restoreHome = withEnv({ HOME: home });
	try {
		const dispatch = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode: "yolo", model: "alpha" });
		assert.equal(dispatch.model.requested, "alpha");
		assert.equal(dispatch.model.forwarded, false);
		assert.match(dispatch.model.note, /legacy one-shot path/);
	} finally {
		restoreHome();
	}
});

test("dsh one-shot parseEvent keeps reasoning out of prose", () => {
	const parse = ADAPTERS.dsh.parseEvent;
	assert.deepEqual(parse("The answer is 42."), { kind: "message", text: "The answer is 42." });
	assert.deepEqual(parse("dsh: reasoning: weighing options"), { kind: "reasoning", text: "weighing options" });
	assert.equal(parse("dsh: reasoning:"), null);
	assert.equal(parse("   "), null);
});

// ---------------------------------------------------------------------------
// ensureDshLaunch: one permission overlay in the shared home
// ---------------------------------------------------------------------------

test("ensureDshLaunch creates the permission overlay idempotently and never creates a settings document", () => {
	const home = makeHome();
	const homeDir = sharedHome(home);
	const overlay = overlayIn(home);

	const first = ensureDshLaunch({ homeDir });
	assert.equal(first.ok, true);
	if (first.ok === false) return;
	assert.equal(first.overlay, overlay);
	assert.equal(readFileSync(overlay, "utf8"), dshOverlayContent());
	assert.match(readFileSync(overlay, "utf8"), /# Written by pi-external-agent/);
	assert.match(readFileSync(overlay, "utf8"), /^- id: permission$/m);
	assert.match(readFileSync(overlay, "utf8"), /defaultPreset: .*DSH_PERMISSION_MODE/);
	assert.equal(existsSync(path.join(homeDir, "settings.pi-external-agent.yaml")), false);

	chmodSync(overlay, 0o444);
	const second = ensureDshLaunch({ homeDir });
	assert.equal(second.ok, true);
	assert.equal(readFileSync(overlay, "utf8"), dshOverlayContent());
});

test("ensureDshLaunch rewrites a stale overlay", () => {
	const home = makeHome();
	const homeDir = sharedHome(home);
	const overlay = overlayIn(home);
	ensureDshLaunch({ homeDir });
	writeFileSync(overlay, "- id: settings\n  config:\n    path: /somewhere/else.yaml\n");
	const rewritten = ensureDshLaunch({ homeDir });
	assert.equal(rewritten.ok, true);
	assert.equal(readFileSync(overlay, "utf8"), dshOverlayContent());
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
	assert.equal(lstatSync(overlay).isSymbolicLink(), false);
	assert.equal(readFileSync(overlay, "utf8"), dshOverlayContent());
	assert.equal(readFileSync(elsewhere, "utf8"), "hand-written\n");
});

test("ensureDshLaunch refuses an unusable home or overlay", () => {
	const root = mkdtempSync(path.join(tmpdir(), "dsh-provision-"));
	const blockedHome = path.join(root, "not-a-directory");
	writeFileSync(blockedHome, "a real file where the shared home should be\n");
	const homeFailure = ensureDshLaunch({ homeDir: blockedHome });
	assert.equal(homeFailure.ok, false);
	if (homeFailure.ok) return;
	assert.match(homeFailure.reason, /could not create dsh's shared home/);

	const home = makeHome();
	const homeDir = sharedHome(home);
	mkdirSync(homeDir, { recursive: true });
	const blockedOverlay = path.join(homeDir, DSH_OVERLAY_NAME);
	mkdirSync(blockedOverlay);
	const overlayFailure = ensureDshLaunch({ homeDir, overlay: blockedOverlay });
	assert.equal(overlayFailure.ok, false);
	if (overlayFailure.ok) return;
	assert.match(overlayFailure.reason, /could not write the dsh overlay/);
});

test("ensureDshLaunch defaults the overlay under HOME", () => {
	const home = makeHome();
	const restoreHome = withEnv({ HOME: home });
	try {
		assert.equal(dshSharedHome(), sharedHome(home));
		assert.equal(overlayIn(home), path.join(home, DSH_HOME_DIR_NAME, DSH_OVERLAY_NAME));
		const result = ensureDshLaunch();
		assert.equal(result.ok, true);
		if (result.ok === false) return;
		assert.equal(result.overlay, overlayIn(home));
	} finally {
		restoreHome();
	}
});

// ---------------------------------------------------------------------------
// The composition anchor: permission row and env hooks
// ---------------------------------------------------------------------------

test("the composition anchor probes each profile as itself and stays silent when clean", () => {
	const fixture = launchFixture();
	const probes: string[][] = [];
	const run = (argv: string[]) => {
		probes.push(argv);
		return { ok: true as const, dump: dump([permissionRow(fixture.overlay), sandboxRow(), approvalRow()]) };
	};
	for (const profile of ANCHOR_PROFILES) {
		resetDshCompositionGuard();
		assert.deepEqual(dshCompositionWarnings({ overlay: fixture.overlay, profile, run }), []);
	}
	assert.deepEqual(probes, [
		["--profile", "headless", "--patch", fixture.overlay, "--dump-config"],
		["--profile", "acp", "--patch", fixture.overlay, "--dump-config"],
	]);
});

test("anchor: a missing permission row warns that no session preset is pinned", () => {
	const fixture = launchFixture();
	const warnings = anchor(fixture, dump([sandboxRow(), approvalRow()]));
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /permission row is missing/);
});

test("anchor: a literal defaultPreset names the offending patch", () => {
	const fixture = launchFixture();
	const offending = "/etc/company/dsh.patch.yml";
	const literal = {
		...permissionRow(offending),
		lines: [
			"  config:",
			"    presets:",
			"      read-only:",
			"        sandbox: read-only",
			"        approval: ask",
			"      workspace-write:",
			"        sandbox: workspace-write",
			"        approval: ask",
			"      danger-full-access:",
			"        sandbox: danger-full-access",
			"        approval: never",
			"    defaultPreset: danger-full-access",
		],
	};
	const warnings = anchor(fixture, dump([literal, sandboxRow(), approvalRow()]));
	assert.equal(warnings.length, 1);
	assert.ok(warnings[0].includes(offending));
	assert.match(warnings[0], /without a defaultPreset that reads DSH_PERMISSION_MODE/);
});

test("anchor: a permission row missing an extension preset warns", () => {
	const fixture = launchFixture();
	const partial = {
		...permissionRow(fixture.overlay),
		lines: [
			"  config:",
			"    presets:",
			"      read-only:",
			"        sandbox: read-only",
			"        approval: ask",
			`    defaultPreset: ${BB_JS} process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`,
		],
	};
	const warnings = anchor(fixture, dump([partial, sandboxRow(), approvalRow()]));
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /without the workspace-write, danger-full-access preset/);
});

test("anchor: replaced env-hook rows are reported", () => {
	const fixture = launchFixture();
	const sandboxWarnings = anchor(
		fixture,
		dump([
			permissionRow(fixture.overlay),
			{ id: "sandbox-policy", patchedBy: "/etc/company/dsh.patch.yml", lines: ["  config:", "    mode: read-only"] },
			approvalRow(),
		]),
	);
	assert.equal(sandboxWarnings.length, 1);
	assert.match(sandboxWarnings[0], /sandbox-policy row with config that no longer reads DSH_PERMISSION_MODE/);

	const approvalWarnings = anchor(fixture, dump([permissionRow(fixture.overlay), sandboxRow()]));
	assert.equal(approvalWarnings.length, 1);
	assert.match(approvalWarnings[0], /dsh's approval row is missing/);
});

test("anchor: a decoy comment cannot stand in for a live env hook", () => {
	const fixture = launchFixture();
	const warnings = anchor(
		fixture,
		dump([
			permissionRow(fixture.overlay),
			{
				id: "sandbox-policy",
				patchedBy: "/etc/company/dsh.patch.yml",
				lines: ["  config:", "    mode: read-only", "    # pinned: DSH_PERMISSION_MODE is not read here any more"],
			},
			approvalRow(),
		]),
	);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /no longer reads DSH_PERMISSION_MODE/);
});

test("the anchor memoizes per profile and retries an unavailable probe", () => {
	const fixture = launchFixture();
	resetDshCompositionGuard();
	const probes: string[] = [];
	const call = (profile: DshProfile, run: (argv: string[]) => { ok: true; dump: string } | { ok: false; reason: string }) =>
		dshCompositionWarnings({ overlay: fixture.overlay, profile, run });
	const cleanRun = (argv: string[]) => {
		probes.push(argv[argv.indexOf("--profile") + 1]);
		return { ok: true as const, dump: dump([permissionRow(fixture.overlay), sandboxRow(), approvalRow()]) };
	};
	assert.deepEqual(call("headless", cleanRun), []);
	assert.deepEqual(call("headless", cleanRun), []);
	assert.deepEqual(probes, ["headless"]);

	resetDshCompositionGuard();
	let failures = 0;
	const failedRun = () => {
		failures += 1;
		return { ok: false as const, reason: "spawnSync dsh ENOENT" };
	};
	assert.match(call("acp", failedRun)[0], /composition anchor unavailable/);
	assert.match(call("acp", failedRun)[0], /composition anchor unavailable/);
	assert.equal(failures, 2);
});

// ---------------------------------------------------------------------------
// Fail-closed mode guard at the adapter boundary
// ---------------------------------------------------------------------------

const DSH_ONESHOT_MOCK = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const log = process.env.DSH_MOCK_LOG;
if (argv.includes("--dump-config")) {
  const mode = process.env.DSH_MOCK_DUMP || "clean";
  const overlay = argv[argv.indexOf("--patch") + 1];
  const envRows =
    "- id: sandbox-policy\\n  config:\\n    mode: ${BB_JS} process.env.DSH_PERMISSION_MODE ?? 'workspace-write'\\n" +
    "- id: approval\\n  config:\\n    policy: ${BB_JS} process.env.DSH_PERMISSION_MODE === 'danger-full-access' ? 'never' : 'ask'\\n";
  if (mode === "foreign") {
    process.stdout.write("# == base, patched by /etc/company/dsh.patch.yml\\n- id: permission\\n  config:\\n    defaultPreset: danger-full-access\\n" + envRows);
  } else {
    process.stdout.write(
      "# == base, patched by " + overlay + "\\n" +
      "- id: permission\\n  config:\\n    presets:\\n      read-only:\\n        sandbox: read-only\\n        approval: ask\\n      workspace-write:\\n        sandbox: workspace-write\\n        approval: ask\\n      danger-full-access:\\n        sandbox: danger-full-access\\n        approval: never\\n" +
      "    defaultPreset: ${BB_JS} process.env.DSH_PERMISSION_MODE ?? 'workspace-write'\\n" +
      envRows,
    );
  }
  process.exit(0);
}
if (log) fs.appendFileSync(log, JSON.stringify({ kind: "spawn", argv }) + "\\n");
process.stdout.write("mock answer");
process.exit(0);
`;

test("dsh readonly and write refuse when the composition cannot prove the tier", () => {
	const dir = makeFixtureDir({ dsh: DSH_ONESHOT_MOCK });
	const home = makeHome();
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ HOME: home, DSH_MOCK_DUMP: "foreign" });
	resetDshCompositionGuard();
	try {
		for (const mode of ["readonly", "write"] as Mode[]) {
			const dispatch = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: dir, mode });
			assert.match(dispatch.refusal ?? "", new RegExp(`did not prove the requested ${mode} permission tier`));
			assert.equal(dispatch.env, undefined);
			assert.equal(dispatch.warning, undefined);
		}
		const yolo = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: dir, mode: "yolo" });
		assert.equal(yolo.refusal, undefined);
		assert.match(yolo.warning ?? "", /defaultPreset|permission row/);
		assert.deepEqual(yolo.env, { DSH_PERMISSION_MODE: "danger-full-access", DSH_HOME: undefined });
	} finally {
		restoreEnv();
		restorePath();
	}
});

test("dsh readonly starts when the composition probe is clean", () => {
	const dir = makeFixtureDir({ dsh: DSH_ONESHOT_MOCK });
	const home = makeHome();
	const restorePath = usePath(dir);
	const restoreEnv = withEnv({ HOME: home });
	resetDshCompositionGuard();
	try {
		const dispatch = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: dir, mode: "readonly" });
		assert.equal(dispatch.refusal, undefined);
		assert.equal(dispatch.warning, undefined);
		assert.equal(dispatch.env?.DSH_PERMISSION_MODE, "read-only");
		assert.equal(readFileSync(overlayIn(home), "utf8"), dshOverlayContent());
	} finally {
		restoreEnv();
		restorePath();
	}
});

test("dsh provisioning failure refuses before the spawn", () => {
	const root = mkdtempSync(path.join(tmpdir(), "dsh-blocked-"));
	const blocked = path.join(root, ".dsh");
	writeFileSync(blocked, "in the way\n");
	const restoreHome = withEnv({ HOME: root });
	try {
		const dispatch = ADAPTERS.dsh.buildDispatch({ task: "t", cwd: "/tmp", mode: "readonly" });
		assert.match(dispatch.refusal ?? "", /could not create dsh's shared home/);
		assert.equal(dispatch.env, undefined);
	} finally {
		restoreHome();
	}
});

// ---------------------------------------------------------------------------
// Persistent-session receipts
// ---------------------------------------------------------------------------

test("dsh ACP receipts claim model and effort forwarding", () => {
	assert.equal(registry.modelForwardedOnSession("dsh"), true);
	const modelNote = registry.modelSessionNote("dsh", "alpha");
	assert.match(modelNote, /session\/set_config_option model/);
	assert.match(modelNote, /advertised selector/);
	assert.match(modelNote, /start is refused/);

	assert.equal(registry.effortForwardedOnSession("dsh"), true);
	const effortNote = registry.effortSessionNote("dsh", "xhigh");
	assert.match(effortNote, /reasoning_effort=max/);
	assert.match(effortNote, /advertised configOptions/);
	assert.match(effortNote, /start is refused/);
});

test("dsh is registered as a persistent ACP agent", () => {
	assert.ok(SESSION_DRIVERS.dsh);
	const argv = SESSION_DRIVERS.dsh?.().buildArgv({ task: "t", cwd: "/tmp", mode: "yolo" });
	assert.deepEqual(argv?.slice(0, 2), ["--profile", "acp"]);
	assert.ok(argv?.includes("--patch"));
});
