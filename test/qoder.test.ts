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
	assert.equal(a.session?.steer, true);
	assert.equal(a.session?.followUp, true);
	assert.match(a.session?.steerNote ?? "", /priority "next"/);
	assert.deepEqual(a.supportedEfforts, ["off", "low", "medium", "high", "xhigh", "max"]);
	assert.equal((a.supportedEfforts as readonly string[]).includes("minimal"), false);
	assert.match(a.sessionPolicy!("readonly"), /dont_ask/);
	assert.match(a.sessionPolicy!("write"), /accept_edits/);
});

test("qoder is steerable and follow-up capable in the capability lists", () => {
	assert.equal(STEER_AGENT_IDS.includes("qoder"), true);
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

test("qoder session driver argv is the documented stream-json channel, not ACP", () => {
	const driver = SESSION_DRIVERS.qoder!();
	assert.equal(driver.stdinFormat, "stream-json");
	const ro = driver.buildArgv({ task: "t", cwd: "/tmp", mode: "readonly", model: "lite", effort: "high" });
	assert.deepEqual(ro.slice(0, 5), ["-p", "--output-format", "stream-json", "--input-format", "stream-json"]);
	assert.equal(ro.includes("--acp"), false);
	assert.equal(ro.includes("t"), false);
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

test("qoder steer message: priority next with shouldQuery false, never now; follow-up is a plain new turn", async () => {
	const driver = SESSION_DRIVERS.qoder!() as any;
	const sent: any[] = [];
	driver.writeLine = (obj: unknown) => sent.push(obj);
	driver.active = true;
	driver.proc = { stdin: {} };
	driver.initVersion = "1.1.49";

	const steered = await driver.steer("focus on the failing tests");
	assert.equal(steered.accepted, true);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].type, "user");
	assert.equal(sent[0].priority, "next");
	assert.equal(sent[0].shouldQuery, false);
	assert.notEqual(sent[0].priority, "now");
	assert.equal(sent[0].parent_tool_use_id, null);
	assert.equal(sent[0].message.role, "user");
	assert.equal(sent[0].message.content[0].text, "focus on the failing tests");
	assert.equal(typeof sent[0].uuid, "string");

	driver.active = false;
	await driver.followUp("plain follow-up");
	assert.equal(sent.length, 2);
	assert.equal(sent[1].priority, undefined);
	assert.equal(sent[1].shouldQuery, undefined);
	assert.equal(sent[1].message.content[0].text, "plain follow-up");
});

test("qoder steer delivery warnings do not leak into a later user turn", async () => {
	const driver = SESSION_DRIVERS.qoder!() as any;
	const sent: any[] = [];
	const events: any[] = [];
	driver.writeLine = (obj: unknown) => sent.push(obj);
	driver.onEvent((event: unknown) => events.push(event));
	driver.proc = { stdin: {} };
	driver.initVersion = "1.1.49";
	driver.active = true;
	await driver.steer("first steer");
	await driver.steer("second steer");
	assert.equal(driver.steers.size, 2);
	driver.settle({ status: "done" });
	driver.handleLine(JSON.stringify({ type: "command_lifecycle", command_uuid: sent[0].uuid, state: "discarded" }));
	assert.equal(events.length, 1);
	assert.equal(events[0].kind, "warning");
	assert.equal(driver.steers.size, 1);
	await driver.followUp("new user turn");
	assert.equal(driver.steers.size, 0);
	driver.handleLine(JSON.stringify({ type: "command_lifecycle", command_uuid: sent[1].uuid, state: "discarded" }));
	assert.equal(events.length, 1);
});

test("qoder child assistant errors and truncation do not settle the main turn", () => {
	const driver = SESSION_DRIVERS.qoder!() as any;
	const turns: Array<{ status: string }> = [];
	driver.onTurnEnd((turn: { status: string }) => turns.push(turn));
	driver.active = true;
	driver.turnStarted = true;
	driver.handleLine(JSON.stringify({
		type: "assistant", parent_tool_use_id: "child-tool", aborted: true, isApiErrorMessage: true,
		message: { model: "<synthetic>", content: [{ type: "text", text: "child failed" }] },
	}));
	assert.equal(turns.length, 0);
	driver.handleLine(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "main completed" }));
	assert.deepEqual(turns, [{ status: "done" }]);
});

test("qoder a later complete main assistant message clears earlier truncation", () => {
	const driver = SESSION_DRIVERS.qoder!() as any;
	const turns: Array<{ status: string }> = [];
	driver.onTurnEnd((turn: { status: string }) => turns.push(turn));
	driver.active = true;
	driver.turnStarted = true;
	driver.handleLine(JSON.stringify({ type: "assistant", parent_tool_use_id: null, aborted: true }));
	driver.handleLine(JSON.stringify({
		type: "assistant", parent_tool_use_id: null,
		message: { content: [{ type: "text", text: "recovered" }] },
	}));
	driver.handleLine(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "recovered" }));
	assert.deepEqual(turns, [{ status: "done" }]);
});
