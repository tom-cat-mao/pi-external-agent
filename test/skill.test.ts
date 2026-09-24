/**
 * Offline tests for the capability index shipped with the extension:
 *   - `skills/external-agent/SKILL.md` carries the frontmatter pi indexes by
 *     (name + description, the only fields that enter the prompt)
 *   - the extension's `resources_discover` handler advertises that file, which is
 *     what makes pi load it as a skill at all
 *
 * The host pi modules are stubbed via registerHooks, exactly like the other
 * suites: the extension module must import without a live pi host.
 *
 * Run with `node --test test/skill.test.ts` on Node 22.18+ / 26.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_PATH = join(ROOT, "skills", "external-agent", "SKILL.md");

/**
 * pi's Agent Skills spec: a skill whose description is missing or blank is
 * dropped, and one over this length is accepted with a diagnostic. Both are
 * silent-failure shapes for the caller, so the suite pins them.
 */
const MAX_DESCRIPTION_CHARS = 1024;

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

/** Every hook the extension binds, keyed by event name. */
const handlers = new Map<string, (event: unknown) => unknown>();
hub.default({
	registerTool: () => {},
	registerMessageRenderer: () => {},
	on: (event: string, handler: (event: unknown) => unknown) => handlers.set(event, handler),
	sendMessage: () => {},
});

/** The `---` block pi reads with its frontmatter parser; flat scalars suffice here. */
function frontmatter(text: string): Map<string, string> {
	const block = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	assert.ok(block, "SKILL.md must open with a --- frontmatter block");
	const fields = new Map<string, string>();
	for (const line of block[1].split(/\r?\n/)) {
		// Values keep everything after the first colon: the description contains colons.
		const entry = /^([A-Za-z0-9_-]+):[ \t]?(.*)$/.exec(line);
		if (!entry) continue;
		const [, key] = entry;
		let value = entry[2].trim();
		const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
		if (quoted) value = quoted[1];
		else {
			// pi parses this block as YAML, where ": " inside an unquoted scalar
			// starts a nested mapping and the whole skill is dropped as unparseable.
			assert.ok(
				!value.includes(": "),
				`${key} is an unquoted YAML scalar containing ": "; pi's frontmatter parser rejects the file`,
			);
		}
		fields.set(key, value);
	}
	return fields;
}

test("skill: SKILL.md exists with the name and description pi indexes by", () => {
	assert.ok(existsSync(SKILL_PATH), `missing ${SKILL_PATH}`);
	const text = readFileSync(SKILL_PATH, "utf8");
	const fields = frontmatter(text);

	assert.equal(fields.get("name"), "external-agent");
	const description = fields.get("description");
	assert.ok(description, "the frontmatter description is missing or blank");
	assert.ok(
		description.length <= MAX_DESCRIPTION_CHARS,
		`description is ${description.length} chars, over the ${MAX_DESCRIPTION_CHARS}-char skill budget`,
	);

	// The body is what the read tool gets, so an empty one is an empty skill.
	const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
	assert.ok(body.trim().length > 0, "SKILL.md has no body");
});

test("skill: resources_discover advertises the skill file to pi", async () => {
	const handler = handlers.get("resources_discover");
	assert.ok(handler, "the extension registers no resources_discover handler");

	const result = (await handler({ type: "resources_discover", cwd: ROOT, reason: "startup" })) as {
		skillPaths?: unknown;
	};
	assert.ok(Array.isArray(result?.skillPaths), "resources_discover must return a skillPaths array");
	const paths = result.skillPaths.filter((entry): entry is string => typeof entry === "string");
	assert.ok(paths.length > 0, "resources_discover returned no skillPaths entry");
	assert.ok(
		paths.some((entry) => isAbsolute(entry) && resolve(entry) === SKILL_PATH),
		`no skillPaths entry resolves to ${SKILL_PATH} (got ${paths.join(", ")})`,
	);
	assert.ok(existsSync(resolve(paths[0])), `the advertised skill path does not exist: ${paths[0]}`);
});
