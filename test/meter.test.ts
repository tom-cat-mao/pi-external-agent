/**
 * Meter contract: per-task accumulation of CLI self-reported usage, absent
 * fields staying absent, dispatch/refusal counters, copy semantics.
 *
 * Also covers the claude-family adapter fields that feed the meter, since that
 * is the only production source of samples today (adapters.ts imports no pi
 * packages, so no stubs are needed).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMeter } from "../src/meter.ts";
import { ADAPTERS } from "../src/adapters.ts";

test("meter: samples for one task accumulate field by field", () => {
	const meter = createMeter();
	meter.record("task-1", { in: 100, out: 20, cached: 5, source: "codex" });
	meter.record("task-1", { in: 50, out: 7, cached: 1, source: "codex" });
	meter.record("task-2", { in: 1, source: "claude" });

	const snap = meter.snapshot();
	assert.deepEqual(snap.tasks["task-1"], { in: 150, out: 27, cached: 6, sources: ["codex"], samples: 2 });
	assert.deepEqual(snap.tasks["task-2"], { in: 1, sources: ["claude"], samples: 1 });
	assert.deepEqual(snap.totals, { in: 151, out: 27, cached: 6, sources: ["codex", "claude"], samples: 3 });
});

test("meter: an untouched meter reports empty totals", () => {
	assert.deepEqual(createMeter().snapshot(), {
		tasks: {},
		totals: { sources: [], samples: 0 },
		dispatchTotal: 0,
		refusedTotal: {},
	});
});

test("meter: absent fields stay absent instead of becoming zero", () => {
	const meter = createMeter();
	meter.record("t", { source: "kimi" });

	const bare = meter.snapshot().totals;
	assert.deepEqual(bare, { sources: ["kimi"], samples: 1 });
	assert.equal("in" in bare, false);
	assert.equal("out" in bare, false);
	assert.equal("costUsd" in bare, false);

	// A later sample that carries only some fields sums just those, without
	// retroactively inventing the fields the earlier sample lacked.
	meter.record("t", { in: 10, source: "kimi" });
	const mixed = meter.snapshot().totals;
	assert.deepEqual(mixed, { in: 10, sources: ["kimi"], samples: 2 });
	assert.equal("out" in mixed, false);
});

test("meter: costUsd appears only when a CLI self-reported one", () => {
	const meter = createMeter();
	meter.record("a", { in: 1, source: "claude" });
	assert.equal("costUsd" in meter.snapshot().totals, false);

	meter.record("a", { costUsd: 0.25, source: "claude" });
	meter.record("a", { costUsd: 0.5, source: "claude" });
	assert.equal(meter.snapshot().totals.costUsd, 0.75);

	// A reported zero is a reported value, not an unknown.
	meter.record("b", { costUsd: 0, source: "claude" });
	assert.deepEqual(meter.snapshot().tasks["b"], { costUsd: 0, sources: ["claude"], samples: 1 });
});

test("meter: a task bucket can carry samples from more than one CLI", () => {
	const meter = createMeter();
	meter.record("relay", { in: 3, source: "codex" });
	meter.record("relay", { costUsd: 0.01, source: "claude" });
	assert.deepEqual(meter.snapshot().tasks["relay"], {
		in: 3,
		costUsd: 0.01,
		sources: ["codex", "claude"],
		samples: 2,
	});
});

test("meter: dispatch is counted once per task, refusals once per reason", () => {
	const meter = createMeter();
	meter.recordDispatch("t1");
	meter.recordDispatch("t2");
	meter.recordDispatch("t1");
	meter.recordRefused("mode above maxMode");
	meter.recordRefused("mode above maxMode");
	meter.recordRefused("agent cannot steer");

	const snap = meter.snapshot();
	assert.equal(snap.dispatchTotal, 2);
	assert.deepEqual(snap.refusedTotal, { "mode above maxMode": 2, "agent cannot steer": 1 });
});

test("meter: snapshots are copies, not views into the accumulator", () => {
	const meter = createMeter();
	meter.record("t", { in: 1, source: "pi" });
	meter.recordRefused("busy");

	const first = meter.snapshot();
	first.totals.in = 999;
	first.tasks["t"].in = 999;
	first.tasks["t"].sources.push("mutant");
	first.refusedTotal["busy"] = 99;

	const second = meter.snapshot();
	assert.equal(second.totals.in, 1);
	assert.equal(second.tasks["t"].in, 1);
	assert.deepEqual(second.tasks["t"].sources, ["pi"]);
	assert.deepEqual(second.refusedTotal, { busy: 1 });
});

test("claude-family result events expose CLI-reported usage and cost (the meter's input)", () => {
	const record = JSON.stringify({
		type: "result",
		subtype: "success",
		is_error: false,
		result: "PONG",
		total_cost_usd: 0.0042,
		usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 400, cache_creation_input_tokens: 999 },
	});
	const event = ADAPTERS.claude.parseEvent(record);
	assert.equal(event?.kind, "message");
	assert.deepEqual(event?.usage, { in: 12, out: 3, cached: 400 });
	assert.equal(event?.costUsd, 0.0042);

	// What the adapter emits is directly recordable: the seam the meter consumes.
	const meter = createMeter();
	meter.record("t", { ...event!.usage, costUsd: event!.costUsd, source: "claude" });
	assert.deepEqual(meter.snapshot().totals, {
		in: 12,
		out: 3,
		cached: 400,
		costUsd: 0.0042,
		sources: ["claude"],
		samples: 1,
	});

	// A record without accounting keeps the old shape exactly: nothing invented.
	const bare = ADAPTERS.claude.parseEvent('{"type":"result","subtype":"success","is_error":false,"result":"PONG"}');
	assert.deepEqual(bare, { kind: "message", text: "PONG" });
	assert.equal(bare?.usage, undefined);
	assert.equal(bare?.costUsd, undefined);

	// Partial usage reports only the fields the CLI actually sent.
	const partial = ADAPTERS.claude.parseEvent('{"type":"result","is_error":false,"result":"x","usage":{"output_tokens":7}}');
	assert.deepEqual(partial?.usage, { out: 7 });
	assert.equal(partial?.costUsd, undefined);

	// A placeholder total_cost_usd of 0 is not surfaced: it adds nothing to a
	// sum, and attaching it would change the event shape for every record that
	// carries the Claude-Code-shaped default (the qoder session mocks do),
	// which the rest of the suite deep-compares.
	const zero = ADAPTERS.claude.parseEvent('{"type":"result","is_error":false,"result":"x","total_cost_usd":0}');
	assert.deepEqual(zero, { kind: "message", text: "x" });
	assert.equal(zero?.costUsd, undefined);

	// A failed run still burned what it burned, so its accounting rides along.
	const failed = ADAPTERS.qoder.parseEvent(
		'{"type":"result","is_error":true,"errors":["boom"],"total_cost_usd":0.5,"usage":{"input_tokens":9}}',
	);
	assert.equal(failed?.kind, "error");
	assert.deepEqual(failed?.usage, { in: 9 });
	assert.equal(failed?.costUsd, 0.5);
});
