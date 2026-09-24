import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// The prompt surface is paid in two layers, and this file budgets each on its
// own terms:
//
//   - Fixed layer — the three always-active tools (external_agent_start,
//     external_agent_status, external_agent_stop). Their names, descriptions,
//     snippets, guidelines and parameter descriptions are injected into every
//     provider request, dispatch or not, so this layer is hard-budgeted below.
//   - Lazy layer — the four tools parked at session_start and activated
//     additively on the first dispatch that runs (external_agent_wait,
//     external_agent_compare, external_agent_steer, external_agent_follow_up).
//     They are paid only by sessions that dispatch, so their total is recorded
//     and soft-checked: a regression past the same 3,500 chars shows up as a
//     diagnostic, and the fix is a deliberate one in the commit, not drift.
//
// Both layers are counted by the same collector: name + description +
// promptSnippet + promptGuidelines + every `description` in the parameter
// schema. Raise a budget only with a note explaining what the extra chars buy.

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
// The split is the design's, so the test reads it from the same constant the
// activation handshake uses instead of spelling the four names again.
const { LAZY_TOOL_NAMES } = (await import("../src/hub/shared.ts")) as { LAZY_TOOL_NAMES: readonly string[] };
moduleHooks.deregister();

const tools = new Map<string, any>();
hub.default({
	registerTool: (tool: any) => tools.set(tool.name, tool),
	registerMessageRenderer: () => {},
	on: () => {},
	sendMessage: () => {},
});

/** Recursively collect every `description` string in a schema object. */
function collectDescriptions(value: unknown, sink: string[]): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) collectDescriptions(item, sink);
		return;
	}
	for (const [key, entry] of Object.entries(value)) {
		if (key === "description" && typeof entry === "string") sink.push(entry);
		else collectDescriptions(entry, sink);
	}
}

function surfaceChars(tool: any): number {
	let total = (tool.name ?? "").length + (tool.description ?? "").length + (tool.promptSnippet ?? "").length;
	for (const guideline of tool.promptGuidelines ?? []) total += guideline.length;
	const descriptions: string[] = [];
	collectDescriptions(tool.parameters, descriptions);
	for (const description of descriptions) total += description.length;
	return total;
}

// Measured 2026-09-24, after the thin-surface wave (slimmed descriptions, the
// external-agent skill, lazy activation): see
// .agents/notes/implemented/2026-09-24-thin-tool-surface-skill-delegation.md and
// 2026-09-24-lazy-tool-activation.md.
const FIXED_SURFACE_BUDGET_CHARS = 3_500;
const LAZY_SURFACE_SOFT_BUDGET_CHARS = 3_500;

test("fixed prompt surface stays within budget; the lazy layer is recorded", (t) => {
	const lazyNames = new Set<string>(LAZY_TOOL_NAMES);
	const entries = [...tools.entries()].sort(([left], [right]) => left.localeCompare(right));
	const fixed = entries.filter(([name]) => !lazyNames.has(name));
	const lazy = entries.filter(([name]) => lazyNames.has(name));
	assert.equal(
		lazy.length,
		LAZY_TOOL_NAMES.length,
		`not all lazy tools are registered: expected ${LAZY_TOOL_NAMES.join(", ")}, found ${lazy.map(([name]) => name).join(", ")}`,
	);

	const rows = (list: Array<[string, any]>): Array<[string, number]> => list.map(([name, tool]) => [name, surfaceChars(tool)]);
	const sum = (list: Array<[string, number]>): number => list.reduce((total, [, chars]) => total + chars, 0);
	const describe = (list: Array<[string, number]>): string => list.map(([name, chars]) => `${name}: ${chars}`).join("\n");

	const fixedRows = rows(fixed);
	const lazyRows = rows(lazy);
	const fixedTotal = sum(fixedRows);
	const lazyTotal = sum(lazyRows);

	t.diagnostic(`fixed layer ${fixedTotal} chars (hard budget ${FIXED_SURFACE_BUDGET_CHARS})\n${describe(fixedRows)}`);
	t.diagnostic(`lazy layer ${lazyTotal} chars (soft budget ${LAZY_SURFACE_SOFT_BUDGET_CHARS})\n${describe(lazyRows)}`);
	if (lazyTotal > LAZY_SURFACE_SOFT_BUDGET_CHARS) {
		// Soft on purpose: only dispatched sessions pay this layer, so a crossing is
		// a judgment call, not a broken invariant. The diagnostic is the gate's
		// warning light — a human sees it in the run output.
		t.diagnostic(
			`SOFT BUDGET CROSSED: the lazy layer is ${lazyTotal - LAZY_SURFACE_SOFT_BUDGET_CHARS} chars past ` +
				`${LAZY_SURFACE_SOFT_BUDGET_CHARS}. Not failing the gate; justify the growth or trim the four descriptions.`,
		);
	}

	assert.ok(
		fixedTotal <= FIXED_SURFACE_BUDGET_CHARS,
		`fixed prompt surface ${fixedTotal} chars exceeds budget ${FIXED_SURFACE_BUDGET_CHARS}\n${describe(fixedRows)}`,
	);
});
