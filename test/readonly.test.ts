/**
 * Regression tests for the codebuddy readonly mapping (default mode +
 * runtime-built --settings allow/deny rules + PreToolUse Bash hook) and the
 * claude plan-mode mapping.
 *
 * Run with `node --test test/readonly.test.ts` on Node 22.18+ / 26 (native
 * TypeScript type stripping) or any TS loader.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { ADAPTERS, buildReadonlySettings } from "../adapters.ts";
import { SESSION_DRIVERS } from "../sessions.ts";

const HOOK_PATH = fileURLToPath(new URL("../hooks/codebuddy-readonly.js", import.meta.url));
const ADAPTERS_PATH = fileURLToPath(new URL("../adapters.ts", import.meta.url));

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

test("one-shot claude: readonly still plan, no --settings", () => {
	const ro = ADAPTERS.claude.buildDispatch({ task: "t", cwd: "/tmp", mode: "readonly" });
	assert.equal(ro.argv[ro.argv.indexOf("--permission-mode") + 1], "plan");
	assert.equal(ro.argv.includes("--settings"), false);
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
	const sub = path.join(dir, "sub dir");
	mkdirSync(sub);
	copyFileSync(ADAPTERS_PATH, path.join(sub, "adapters.ts"));
	mkdirSync(path.join(sub, "hooks"));
	copyFileSync(HOOK_PATH, path.join(sub, "hooks", "codebuddy-readonly.js"));
	try {
		const mod = await import(pathToFileURL(path.join(sub, "adapters.ts")).href);
		const command = JSON.parse(mod.buildReadonlySettings()).hooks.PreToolUse[0].hooks[0].command;
		const out = execFileSync("sh", ["-c", command], {
			input: JSON.stringify({ tool_name: "Read", tool_input: {} }),
			encoding: "utf8",
		});
		assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "allow");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
