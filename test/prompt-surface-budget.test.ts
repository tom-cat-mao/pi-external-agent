import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// The tool surface (descriptions, snippets, guidelines, parameter descriptions)
// is injected into every provider request, so its size is a standing cost. This
// budget exists for the same reason docs-budget does: growth must be a decision,
// not drift. Raise it only with a note explaining what the extra chars buy.

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

// Measured 2026-09-19 after the archive/verify/template wave: see
// .agents/notes/implemented/2026-09-19-answer-archive-verify-templates.md.
const PROMPT_SURFACE_BUDGET_CHARS = 8_900;

test("prompt surface stays within budget", () => {
	let total = 0;
	const lines: string[] = [];
	for (const [name, tool] of [...tools.entries()].sort()) {
		const chars = surfaceChars(tool);
		total += chars;
		lines.push(`${name}: ${chars}`);
	}
	assert.ok(
		total <= PROMPT_SURFACE_BUDGET_CHARS,
		`prompt surface ${total} chars exceeds budget ${PROMPT_SURFACE_BUDGET_CHARS}\n${lines.join("\n")}`,
	);
});
