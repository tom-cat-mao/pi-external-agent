/**
 * Regression tests for the codebuddy readonly mapping (default mode +
 * runtime-built --settings allow/deny rules + PreToolUse Bash hook), the
 * claude stream-json readonly mapping, and the enforcement label every
 * readonly receipt carries — the enforcer differs per CLI, so the label has to
 * name the real one.
 *
 * Run with `node --test test/readonly.test.ts` on Node 22.18+ / 26 (native
 * TypeScript type stripping) or any TS loader.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { ADAPTERS, AGENT_IDS, buildReadonlySettings, type Mode } from "../src/adapters.ts";
import { SESSION_DRIVERS } from "../src/drivers/index.ts";
import { enforcementDisplay, sessionReadOnlyEnforcement } from "../src/hub/shared.ts";
import { receiptFromStartArgs } from "../src/hub/reporting.ts";
import { validateDispatch } from "../src/hub/registry.ts";

const HOOK_PATH = fileURLToPath(new URL("../hooks/codebuddy-readonly.js", import.meta.url));
const ADAPTERS_PATH = fileURLToPath(new URL("../src/adapters.ts", import.meta.url));
const DSH_LAUNCH_PATH = fileURLToPath(new URL("../src/dsh-launch.ts", import.meta.url));

function runHook(input: string): any {
	const out = execFileSync("node", [HOOK_PATH], { input, encoding: "utf8" });
	return JSON.parse(out).hookSpecificOutput.permissionDecision;
}

function runBashHook(command: string): any {
	return runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
}

test("buildReadonlySettings: allow/deny rules + Bash hook path", () => {
	const settings = JSON.parse(buildReadonlySettings());
	assert.deepEqual(settings.permissions.allow, ["Read", "Grep", "Glob", "LS", "WebSearch", "WebFetch"]);
	assert.deepEqual(settings.permissions.deny, ["Edit", "Write", "MultiEdit", "NotebookEdit"]);
	const hook = settings.hooks.PreToolUse[0];
	assert.equal(hook.matcher, "Bash");
	assert.match(hook.hooks[0].command, /^node '/);
	const hookPath = hook.hooks[0].command.slice(`node '`.length, -1).replace(/'\\''/g, "'");
	assert.equal(existsSync(hookPath), true);
	assert.equal(path.basename(hookPath), "codebuddy-readonly.js");
});

test("one-shot codebuddy: readonly -> default + --settings; write/yolo unchanged", () => {
	const ro = ADAPTERS.codebuddy.buildDispatch({ task: "t", cwd: "/tmp", mode: "readonly" });
	const i = ro.argv.indexOf("--permission-mode");
	assert.notEqual(i, -1);
	assert.equal(ro.argv[i + 1], "default");
	const s = ro.argv.indexOf("--settings");
	assert.notEqual(s, -1);
	assert.equal(JSON.parse(ro.argv[s + 1]).permissions.deny.length > 0, true);
	assert.match(ro.effectivePolicy ?? "", /--settings/);

	const write = ADAPTERS.codebuddy.buildDispatch({ task: "t", cwd: "/tmp", mode: "write" });
	assert.equal(write.argv[write.argv.indexOf("--permission-mode") + 1], "acceptEdits");
	assert.equal(write.argv.includes("--settings"), false);

	const yolo = ADAPTERS.codebuddy.buildDispatch({ task: "t", cwd: "/tmp", mode: "yolo" });
	assert.equal(yolo.argv[yolo.argv.indexOf("--permission-mode") + 1], "bypassPermissions");
	assert.equal(yolo.argv.includes("--settings"), false);
});


test("claude persistent session: readonly -> dontAsk with stream-json", () => {
	// claude upgraded to yolo default with stream-json persistence like codebuddy
	const ro = ADAPTERS.claude.buildDispatch({ task: "t", cwd: "/tmp", mode: "readonly" });
	assert.equal(ro.argv[ro.argv.indexOf("--permission-mode") + 1], "dontAsk");
});

test("readonly enforcement labels name the real enforcer", () => {
	// Not every CLI hands the tier to its own permission layer, so rounding
	// everything to "harness-enforced" would claim a boundary that is not there:
	// claude's dontAsk mode denies inside the CLI (no can_use_tool is raised),
	// reasonix's ACP session pins no tier at all — the driver rejecting
	// permission prompts is all that is left — and kimi's readonly stands on two
	// named layers, its plan-mode guard and the same driver backstop.
	assert.equal(sessionReadOnlyEnforcement("claude", "readonly"), "cli-mode");
	assert.equal(sessionReadOnlyEnforcement("reasonix", "readonly"), "driver-rejected-prompts");
	assert.equal(sessionReadOnlyEnforcement("kimi", "readonly"), "plan-mode-guard");
	for (const agent of ["codex", "pi", "codebuddy", "qoder", "dsh"] as const) {
		assert.equal(sessionReadOnlyEnforcement(agent, "readonly"), "harness-enforced", agent);
	}
	for (const agent of AGENT_IDS) {
		for (const mode of ["write", "yolo"] as const) {
			assert.equal(sessionReadOnlyEnforcement(agent, mode), "not-applicable", `${agent}/${mode}`);
		}
	}
});

test("enforcement labels reach the receipt and expand to what the caller reads", () => {
	const claude = receiptFromStartArgs({ agent: "claude", task: "audit", mode: "readonly", cwd: "/tmp" }, "/tmp");
	assert.equal(claude?.readOnlyEnforcement, "cli-mode");
	assert.match(enforcementDisplay(claude!), /cli-mode \(dontAsk denies everything not pre-approved\)/);

	const reasonix = receiptFromStartArgs({ agent: "reasonix", task: "audit", mode: "readonly", cwd: "/tmp" }, "/tmp");
	assert.equal(reasonix?.readOnlyEnforcement, "driver-rejected-prompts");
	assert.match(enforcementDisplay(reasonix!), /confines only ≤1\.38\.7; fail-open from 1\.38\.8/);

	const kimi = receiptFromStartArgs({ agent: "kimi", task: "audit", mode: "readonly", cwd: "/tmp" }, "/tmp");
	assert.equal(kimi?.readOnlyEnforcement, "plan-mode-guard");
	assert.match(enforcementDisplay(kimi!), /plan-mode guard \(Write\/Edit vetoed\) \+ driver-rejected prompts/);
});

test("kimi: the one-shot spelling is yolo-only, and the ACP session carries the real tiers", () => {
	// kimi-code 2.0.2: -p rejects --yolo/--auto/--plan (options.ts:79-87) and the
	// print path forces Never Ask (run-v2-print.ts:481), so config.toml's
	// default_permission_mode never governs a one-shot run, and the requested yolo
	// is not the mode that runs (Never Ask is more permissive than Ask When Needed).
	const dispatch = ADAPTERS.kimi.buildDispatch({ task: "t", cwd: "/tmp", mode: "yolo" });
	assert.match(dispatch.effectivePolicy ?? "", /-p forces Never Ask \(auto\)/);
	assert.match(dispatch.effectivePolicy ?? "", /default_permission_mode is not consulted/);
	assert.match(dispatch.effectivePolicy ?? "", /static deny rules still apply/);
	assert.equal(dispatch.refusal, undefined, "yolo is the one tier this spelling can be labelled with");
	assert.doesNotMatch(ADAPTERS.kimi.useFor, /0\.41\.0|config permission mode/);

	// Below yolo the print spelling can select no tier at all, so it refuses the
	// request rather than putting a label on it — while the ACP session, the path
	// every dispatch takes, serves readonly and write too.
	assert.equal(ADAPTERS.kimi.minMode, undefined);
	for (const mode of ["readonly", "write"] as Mode[]) {
		const refusal = ADAPTERS.kimi.buildDispatch({ task: "t", cwd: "/tmp", mode }).refusal ?? "";
		assert.match(refusal, /one-shot print spelling is yolo-only/);
		const check = validateDispatch("kimi", mode, `/tmp/kimi-${mode}`, undefined);
		if (!check.ok) throw new Error(`kimi ${mode} must be dispatchable: ${check.reason}`);
	}
	const effort = validateDispatch("kimi", "yolo", "/tmp/kimi-effort", "high");
	if (!effort.ok) throw new Error(`kimi must accept an effort request: ${effort.reason}`);
	// Effort is the session's, so the print spelling refuses it rather than drop it.
	assert.match(
		ADAPTERS.kimi.buildDispatch({ task: "t", cwd: "/tmp", mode: "yolo", effort: "high" }).refusal ?? "",
		/only inside its ACP session/,
	);

	// Failures arrive on stderr, which never reaches parseEvent (hub/registry.ts
	// reads it separately), so a bare stdout line is noise, not an error event.
	assert.equal(ADAPTERS.kimi.parseEvent("error: something went wrong"), null);
	assert.equal(ADAPTERS.kimi.parseEvent("plain tool echo"), null);
});

test("ACP codebuddy driver: readonly -> default + --settings; write/yolo unchanged", () => {
	const driver = SESSION_DRIVERS.codebuddy!();
	const base = (mode: any) => (driver as any).buildArgv({ task: "t", cwd: "/tmp", mode });
	const ro = base("readonly");
	assert.equal(ro[0], "--acp");
	assert.equal(ro[1], "--permission-mode");
	assert.equal(ro[2], "default");
	assert.equal(ro[3], "--settings");
	assert.equal(JSON.parse(ro[4]).hooks.PreToolUse.length, 1);

	const write = base("write");
	assert.deepEqual(write.slice(1, 3), ["--permission-mode", "acceptEdits"]);
	assert.equal(write.includes("--settings"), false);

	const yolo = base("yolo");
	assert.deepEqual(yolo.slice(1, 3), ["--permission-mode", "bypassPermissions"]);
});

test("hook: read tools allowed, write tools denied", () => {
	assert.equal(runHook(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/x" } })), "allow");
	assert.equal(runHook(JSON.stringify({ tool_name: "Grep", tool_input: {} })), "allow");
	assert.equal(runHook(JSON.stringify({ tool_name: "Edit", tool_input: {} })), "deny");
	assert.equal(runHook(JSON.stringify({ tool_name: "Write", tool_input: {} })), "deny");
	assert.equal(runHook(JSON.stringify({ tool_name: "MultiEdit", tool_input: {} })), "deny");
	assert.equal(runHook(JSON.stringify({ tool_name: "NotebookEdit", tool_input: {} })), "deny");
});

test("hook: bash allow-list", () => {
	assert.equal(runBashHook("ls -la"), "allow");
	assert.equal(runBashHook("grep -rn foo ."), "allow");
	assert.equal(runBashHook("git status"), "allow");
	assert.equal(runBashHook("git log --oneline -5"), "allow");
	assert.equal(runBashHook("node script.js --flag"), "allow");
	assert.equal(runBashHook("cat a.txt && head b.txt"), "allow");
});

test("hook: bash denies writes, redirects, substitution, inline code", () => {
	assert.equal(runBashHook("rm -rf /tmp/x"), "deny");
	assert.equal(runBashHook("git push origin main"), "deny");
	assert.equal(runBashHook("git commit -m x"), "deny");
	assert.equal(runBashHook("git add ."), "deny");
	assert.equal(runBashHook("echo hi > /tmp/x"), "deny");
	assert.equal(runBashHook("echo hi >> /tmp/x"), "deny");
	assert.equal(runBashHook("echo $(rm -rf x)"), "deny");
	assert.equal(runBashHook("echo `rm -rf x`"), "deny");
	assert.equal(runBashHook("node -e \"require('fs').writeFileSync('x','')\""), "deny");
	assert.equal(runBashHook("python3 -c 'open(\"x\",\"w\")'"), "deny");
	assert.equal(runBashHook("sed -i s/a/b/ file"), "deny");
	assert.equal(runBashHook("find . -name x -delete"), "deny");
	assert.equal(runBashHook("curl http://example.com"), "deny");
});

test("hook: invalid JSON fails closed", () => {
	assert.equal(runHook("not json at all"), "deny");
	assert.equal(runHook(""), "deny");
});

test("settings hook command works from an install path with spaces and quotes", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ext 'a$gent sync-"));
	// Mirrors the installed layout: adapters.ts sits in src/ next to the modules
	// it imports (dsh-launch.ts), and the hook in the sibling hooks/ directory it
	// resolves against.
	const root = path.join(dir, "install dir");
	const src = path.join(root, "src");
	mkdirSync(root);
	mkdirSync(src);
	mkdirSync(path.join(root, "hooks"));
	copyFileSync(ADAPTERS_PATH, path.join(src, "adapters.ts"));
	copyFileSync(DSH_LAUNCH_PATH, path.join(src, "dsh-launch.ts"));
	copyFileSync(HOOK_PATH, path.join(root, "hooks", "codebuddy-readonly.js"));
	try {
		const mod = await import(pathToFileURL(path.join(src, "adapters.ts")).href);
		const command = JSON.parse(mod.buildReadonlySettings()).hooks.PreToolUse[0].hooks[0].command;
		const out = execFileSync("sh", ["-c", command], {
			input: JSON.stringify({ tool_name: "Read", tool_input: {} }),
			encoding: "utf8",
		});
		assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "allow");
	} finally {
		unlinkSync(path.join(src, "adapters.ts"));
		unlinkSync(path.join(src, "dsh-launch.ts"));
		unlinkSync(path.join(root, "hooks", "codebuddy-readonly.js"));
		rmdirSync(path.join(root, "hooks"));
		rmdirSync(src);
		rmdirSync(root);
		rmdirSync(dir);
	}
});
