/**
 * The task map survives /reload, so a task created by an older build reaches
 * the new module without the stall fields. The registry must backfill them:
 * `undefined` would crash the scanner on the first tick (a median needs an
 * array) and poison both clocks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

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

// Seeded before the import: getTaskRegistry() repairs the object it finds.
const legacy: any = {
	id: "claude-99",
	agent: "claude",
	state: "running",
	notify: "off",
	startedAt: 1_000,
	lastEventAt: 2_000,
	events: [],
	watchdogMs: 60_000,
	lastWatchdogNoticeAt: 0,
	watchdogNotices: 0,
	eventSeq: 0,
};
(globalThis as any)[Symbol.for("pi.external-agent.task-registry.v1")] = {
	tasks: new Map([["claude-99", legacy]]),
	sequence: 99,
	pendingNotificationIds: new Set(),
};

const moduleHooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (Object.prototype.hasOwnProperty.call(STUBS, specifier)) return { url: `stub:${specifier}`, shortCircuit: true };
		return nextResolve(specifier, context);
	},
	load(url, context, nextLoad) {
		if (url.startsWith("stub:")) return { source: STUBS[url.slice(5)], format: "module", shortCircuit: true };
		return nextLoad(url, context);
	},
});

const hub = (await import("../src/index.ts")) as any;
moduleHooks.deregister();
// The event record reads the stall clock, not Date.now.
hub.stallClock.now = () => 2_000 + 2 * 60_000;

test("stall-reload: a legacy task is repaired instead of crashing the scanner", () => {
	assert.equal(legacy.lastMeaningfulEventAt, 2_000, "the meaningful clock starts at the last event");
	assert.deepEqual(legacy.meaningfulIntervals, []);

	// The production predicates read the repaired fields; before the backfill
	// this threw on `undefined.length`.
	assert.equal(hub.stallTestApi.kind(legacy, 2_000 + 2 * 60_000), "quiet");
	assert.equal(hub.stallTestApi.effectiveMs(legacy), 60_000);

	// And the event record can sample a gap into the repaired ring.
	hub.stallTestApi.record(legacy, { kind: "message", text: "resumed" });
	assert.equal(legacy.meaningfulIntervals.length, 1);
	assert.equal(legacy.meaningfulIntervals[0], 2 * 60_000);
});
