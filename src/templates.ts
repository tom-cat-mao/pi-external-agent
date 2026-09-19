/**
 * Task templates: prompt skeletons kept as data files instead of code.
 *
 * A template is a markdown file with an optional `---` frontmatter block and
 * exactly one `{{TASK}}` placeholder. Everything before the placeholder is the
 * header (role and rules), everything after it is the footer (output contract
 * and anchor demands). The contract lives in the footer because it is the last
 * thing the target CLI reads before answering.
 *
 * Lookup order, first hit wins — a project file overrides a user file, which
 * overrides a builtin:
 *   <projectDir>/.pi/external-agent/templates/<name>.md   -> source "project"
 *   <homeDir>/.pi/agent/external-agent/templates/<name>.md -> source "user"
 *   <builtinDir>/<name>.md                                 -> source "builtin"
 *
 * Node builtins only, no pi imports: this module is a leaf the hub pulls in.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Which tier a template came from. */
export type TemplateSource = "project" | "user" | "builtin";

/** A template as loaded from disk: metadata plus the body around `{{TASK}}`. */
export interface LoadedTemplate {
	name: string;
	version: number;
	description: string;
	body: string;
	source: TemplateSource;
}

/** Root overrides, meant for tests and for callers with an unusual home layout. */
export interface TemplateDirs {
	projectDir?: string;
	homeDir?: string;
	builtinDir?: string;
}

/** The single literal a template uses to mark where the task text goes. */
export const TASK_PLACEHOLDER = "{{TASK}}";

/** Names come from a tool parameter, so they are kept to a safe file basename. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const PROJECT_REL = path.join(".pi", "external-agent", "templates");
const USER_REL = path.join(".pi", "agent", "external-agent", "templates");
const BUILTIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");

/** The three candidate paths for a template, in precedence order. */
function candidates(name: string, dirs: TemplateDirs): Array<{ source: TemplateSource; file: string }> {
	const file = `${name}.md`;
	const found: Array<{ source: TemplateSource; file: string }> = [];
	if (dirs.projectDir) {
		found.push({ source: "project", file: path.join(dirs.projectDir, PROJECT_REL, file) });
	}
	found.push({ source: "user", file: path.join(dirs.homeDir ?? homedir(), USER_REL, file) });
	found.push({ source: "builtin", file: path.join(dirs.builtinDir ?? BUILTIN_DIR, file) });
	return found;
}

/** Load a template by name, taking the highest-precedence tier that exists. */
export async function loadTemplate(name: string, dirs: TemplateDirs = {}): Promise<LoadedTemplate> {
	if (!SAFE_NAME.test(name)) {
		throw new Error(`template name must be a plain file basename (letters, digits, dot, dash, underscore): got "${name}"`);
	}
	const tried = candidates(name, dirs);
	const absent: string[] = [];
	for (const { source, file } of tried) {
		let text: string;
		try {
			text = await readFile(file, "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// Anything still missing is another tier's chance; a real filesystem
			// failure (permissions, I/O) is reported rather than hidden.
			if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
				absent.push(file);
				continue;
			}
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`template "${name}" at ${file} could not be read: ${reason}`);
		}
		return { ...parseTemplate(text, name), source };
	}
	const listing = absent.map((file) => `  ${file}`).join("\n");
	throw new Error(`template "${name}" not found. Looked in:\n${listing}`);
}

/**
 * Render a template body around a task text: header, task, footer.
 * Throws when the placeholder is missing (the task would be dropped) or
 * repeated (the task's role in the prompt would be ambiguous).
 */
export function applyTemplate(body: string, taskText: string): string {
	const at = body.indexOf(TASK_PLACEHOLDER);
	if (at === -1) {
		throw new Error(`template body has no ${TASK_PLACEHOLDER} placeholder, so the task text has nowhere to go`);
	}
	if (body.indexOf(TASK_PLACEHOLDER, at + TASK_PLACEHOLDER.length) !== -1) {
		throw new Error(`template body has more than one ${TASK_PLACEHOLDER} placeholder; exactly one is required`);
	}
	return body.slice(0, at) + taskText + body.slice(at + TASK_PLACEHOLDER.length);
}

/** Split frontmatter from body; a file without a leading `---` block is all body. */
function parseTemplate(text: string, name: string): Omit<LoadedTemplate, "source"> {
	const fields = new Map<string, string>();
	let body = text;
	const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
	if (lines[0]?.trim() === "---") {
		let end = -1;
		for (let i = 1; i < lines.length; i++) {
			if (lines[i].trim() === "---") {
				end = i;
				break;
			}
		}
		if (end === -1) {
			throw new Error(`template "${name}" opens a frontmatter block that is never closed by a second --- line`);
		}
		for (const line of lines.slice(1, end)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const sep = trimmed.indexOf(":");
			if (sep === -1) continue;
			fields.set(trimmed.slice(0, sep).trim(), unquote(trimmed.slice(sep + 1).trim()));
		}
		body = lines.slice(end + 1).join("\n").trim();
	}
	return {
		name: fields.get("name") ?? name,
		version: parseVersion(fields.get("version"), name),
		description: fields.get("description") ?? "",
		body,
	};
}

/** Version defaults to 1 and is a positive integer whenever it is written. */
function parseVersion(raw: string | undefined, name: string): number {
	if (raw === undefined || raw === "") return 1;
	if (!/^[1-9]\d*$/.test(raw)) {
		throw new Error(`template "${name}" has version "${raw}"; frontmatter version must be a positive integer`);
	}
	return Number(raw);
}

function unquote(value: string): string {
	const quote = value[0];
	if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
		return value.slice(1, -1);
	}
	return value;
}
