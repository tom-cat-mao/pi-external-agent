import { test } from "node:test";
import assert from "node:assert/strict";
import { ADAPTERS, qoderPermissionArgs } from "../adapters.ts";
import { FOLLOWUP_AGENT_IDS, SESSION_DRIVERS, STEER_AGENT_IDS } from "../sessions.ts";

test("qoder adapter basics", () => {
	const a = ADAPTERS.qoder;
	assert.equal(a.bin, "qodercli");
	assert.equal(a.provider, "Qoder (Alibaba)");
	assert.equal(a.defaultMode, "yolo");
	assert.equal(a.maxMode, "yolo");
	assert.equal(a.enforcesReadOnly, true);
	assert.equal(a.session?.steer, false);
	assert.equal(a.session?.followUp, true);
	assert.deepEqual(a.supportedEfforts, ["off", "low", "medium", "high", "xhigh", "max"]);
	assert.equal((a.supportedEfforts as readonly string[]).includes("minimal"), false);
	assert.match(a.sessionPolicy!("readonly"), /dont_ask/);
	assert.match(a.sessionPolicy!("write"), /accept_edits/);
});

test("qoder is follow-up only in the capability lists", () => {
	assert.equal(STEER_AGENT_IDS.includes("qoder"), false);
	assert.equal(FOLLOWUP_AGENT_IDS.includes("qoder"), true);
	assert.equal(STEER_AGENT_IDS.includes("codebuddy"), true);
	assert.equal(FOLLOWUP_AGENT_IDS.includes("codebuddy"), true);
});

test("qoder one-shot dispatch: readonly restricts tools, hooks and MCP", () => {
	const ro = ADAPTERS.qoder.buildDispatch({ task: "audit", cwd: "/tmp", mode: "readonly" });
	assert.deepEqual(ro.argv.slice(0, 3), ["-p", "audit", "--output-format"]);
	assert.equal(ro.argv[3], "stream-json");
	assert.equal(ro.argv[ro.argv.indexOf("--permission-mode") + 1], "dont_ask");
	assert.equal(ro.argv[ro.argv.indexOf("--tools") + 1], "Read,Grep,Glob,WebSearch,WebFetch");
	assert.equal(ro.argv[ro.argv.indexOf("--disallowed-tools") + 1], "mcp__*,Agent");
	assert.equal(ro.argv.includes("--strict-mcp-config"), true);
	assert.deepEqual(JSON.parse(ro.argv[ro.argv.indexOf("--mcp-config") + 1]), { mcpServers: {} });
	assert.deepEqual(JSON.parse(ro.argv[ro.argv.indexOf("--settings") + 1]), { disableAllHooks: true });
	assert.equal(ro.promptArgIndex, 1);
	assert.equal(ro.argv[ro.promptArgIndex], "audit");
	assert.equal(ro.readOnlyEnforcement, "harness-enforced");
	assert.match(ro.effectivePolicy ?? "", /dont_ask/);
	assert.match(ro.effectivePolicy ?? "", /disableAllHooks/);
});

test("qoder one-shot dispatch: write/yolo mapping and no readonly extras", () => {
	const write = ADAPTERS.qoder.buildDispatch({ task: "t", cwd: "/tmp", mode: "write" });
	assert.equal(write.argv[write.argv.indexOf("--permission-mode") + 1], "accept_edits");
	assert.equal(write.argv.includes("--tools"), false);
	assert.equal(write.argv.includes("--strict-mcp-config"), false);
	assert.equal(write.readOnlyEnforcement, "not-applicable");

	const yolo = ADAPTERS.qoder.buildDispatch({ task: "t", cwd: "/tmp", mode: "yolo" });
	assert.equal(yolo.argv[yolo.argv.indexOf("--permission-mode") + 1], "bypass_permissions");
	assert.equal(yolo.readOnlyEnforcement, "not-applicable");
});

test("qoder model and effort receipts", () => {
	const none = ADAPTERS.qoder.buildDispatch({ task: "t", cwd: "/tmp", mode: "write" });
	assert.equal(none.model.forwarded, false);
	assert.equal(none.effort.forwarded, false);

	const set = ADAPTERS.qoder.buildDispatch({ task: "t", cwd: "/tmp", mode: "write", model: "lite", effort: "high" });
	assert.equal(set.argv[set.argv.indexOf("--model") + 1], "lite");
	assert.equal(set.argv[set.argv.indexOf("--reasoning-effort") + 1], "high");
	assert.equal(set.model.forwarded, true);
	assert.equal(set.effort.forwarded, true);
});

test("qoder parser: init noise, assistant text skip, tool_use, result, error", () => {
	const parse = ADAPTERS.qoder.parseEvent;
	assert.equal(parse('{"type":"system","subtype":"init","tools":[]}'), null);
	assert.equal(parse('{"type":"assistant","message":{"content":[{"type":"text","text":"PONG"}]}}'), null);
	const tool = parse('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/x"}}]}}');
	assert.equal(tool?.kind, "tool");
	assert.match(tool?.text ?? "", /Read/);
	assert.deepEqual(parse('{"type":"result","subtype":"success","is_error":false,"result":"PONG"}'), {
		kind: "message",
		text: "PONG",
	});
	const bad = parse('{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["Qoder API error: FORBIDDEN"]}');
	assert.equal(bad?.kind, "error");
	assert.match(bad?.text ?? "", /FORBIDDEN/);
	assert.equal(parse("not json"), null);
});

test("qoder ACP session driver argv", () => {
	const driver = SESSION_DRIVERS.qoder!();
	const ro = driver.buildArgv({ task: "t", cwd: "/tmp", mode: "readonly", model: "lite", effort: "high" });
	assert.equal(ro[0], "--acp");
	assert.equal(ro[ro.indexOf("--permission-mode") + 1], "dont_ask");
	assert.equal(ro[ro.indexOf("--tools") + 1], "Read,Grep,Glob,WebSearch,WebFetch");
	assert.equal(ro[ro.indexOf("--disallowed-tools") + 1], "mcp__*,Agent");
	assert.deepEqual(JSON.parse(ro[ro.indexOf("--settings") + 1]), { disableAllHooks: true });
	assert.equal(ro[ro.indexOf("--model") + 1], "lite");
	assert.equal(ro[ro.indexOf("--reasoning-effort") + 1], "high");

	const yolo = driver.buildArgv({ task: "t", cwd: "/tmp", mode: "yolo" });
	assert.equal(yolo[yolo.indexOf("--permission-mode") + 1], "bypass_permissions");
	assert.equal(yolo.includes("--tools"), false);
	assert.equal(yolo.includes("--strict-mcp-config"), false);
});

test("qoderPermissionArgs mode mapping", () => {
	assert.deepEqual(qoderPermissionArgs("readonly").slice(0, 2), ["--permission-mode", "dont_ask"]);
	assert.equal(qoderPermissionArgs("readonly").includes("--strict-mcp-config"), true);
	assert.deepEqual(JSON.parse(qoderPermissionArgs("readonly")[qoderPermissionArgs("readonly").indexOf("--settings") + 1]), {
		disableAllHooks: true,
	});
	assert.deepEqual(qoderPermissionArgs("write"), ["--permission-mode", "accept_edits"]);
	assert.deepEqual(qoderPermissionArgs("yolo"), ["--permission-mode", "bypass_permissions"]);
});

test("qoder ACP permission requests fail closed for readonly and write", () => {
	const driver = SESSION_DRIVERS.qoder!() as any;
	assert.deepEqual(driver.dialect.failClosedPermissionModes, ["readonly", "write"]);
	const calls: any[] = [];
	driver.respond = (id: number, result: unknown) => calls.push({ id, result });
	driver.respondError = (id: number, message: string) => calls.push({ id, error: message });
	const request = (id: number, options: unknown[]) => {
		driver.autoPermission = "reject";
		driver.handleRequest({ id, method: "session/request_permission", params: { options } });
		return calls[calls.length - 1];
	};

	assert.equal(request(1, [{ optionId: "allow_once", kind: "allow_once" }]).result.outcome.outcome, "cancelled");
	const decoy = request(2, [{ optionId: "never_reject", kind: "allow_once" }]);
	assert.equal(decoy.result.outcome.outcome, "cancelled");
	assert.equal(decoy.result.outcome.optionId, undefined);
	assert.equal(request(3, [{ optionId: "reject_once" }]).result.outcome.outcome, "cancelled");
	assert.equal(request(4, [{ kind: "reject_once" }]).result.outcome.outcome, "cancelled");
	assert.equal(request(5, [{ optionId: "", kind: "reject_once" }]).result.outcome.outcome, "cancelled");
	assert.equal(request(6, [{}]).result.outcome.outcome, "cancelled");
	assert.equal(request(7, [{ optionId: "reject_once", kind: "reject_once" }]).result.outcome.optionId, "reject_once");
	assert.equal(request(8, [{ optionId: "reject_always", kind: "reject_always" }]).result.outcome.optionId, "reject_always");

	driver.autoPermission = "allow";
	driver.handleRequest({
		id: 9,
		method: "session/request_permission",
		params: { options: [{ optionId: "allow_once", kind: "allow_once" }] },
	});
	assert.equal(calls[calls.length - 1].result.outcome.optionId, "allow_once");
});
