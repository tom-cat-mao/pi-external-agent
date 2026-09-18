import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

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

const hub = (await import("../index.ts")) as { default: (pi: unknown) => void };
moduleHooks.deregister();

const tools = new Map<string, any>();
const commands = new Map<string, any>();
const lifecycle = new Map<string, (event: { reason: string }) => void>();
const execCalls: Array<{ command: string; args: string[]; options: unknown }> = [];
let execResult = { stdout: "VERIFY_OK", stderr: "", code: 0 };
hub.default({
	registerTool: (tool: any) => tools.set(tool.name, tool),
	registerMessageRenderer: () => {},
	registerCommand: (name: string, def: unknown) => commands.set(name, def),
	on: (event: string, handler: (event: { reason: string }) => void) => lifecycle.set(event, handler),
	sendMessage: () => {},
	exec: async (command: string, args: string[], options: unknown) => {
		execCalls.push({ command, args, options });
		return execResult;
	},
});
afterEach(() => lifecycle.get("session_shutdown")!({ reason: "quit" }));

const CLAUDE_MOCK = `#!/usr/bin/env node
const fs = require("node:fs");
const answer = process.env.CLAUDE_MOCK_ANSWER_FILE ? fs.readFileSync(process.env.CLAUDE_MOCK_ANSWER_FILE, "utf8") : "CLAUDE_OK";
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: answer,
  usage: { input_tokens: 12, output_tokens: 5 }, total_cost_usd: 0.01 }) + "\\n");
`;

function makeFixtureDir(files: Record<string, string>): string {
	const dir = mkdtempSync(path.join(tmpdir(), "w2-fixture-"));
	for (const [name, source] of Object.entries(files)) {
		const file = path.join(dir, name);
		writeFileSync(file, source);
		chmodSync(file, 0o755);
	}
	return dir;
}

function withEnv(values: Record<string, string>): () => void {
	const previous = new Map<string, string | undefined>();
	for (const key of Object.keys(values)) {
		previous.set(key, process.env[key]);
		process.env[key] = values[key];
	}
	return () => {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

const sessionDir = mkdtempSync(path.join(tmpdir(), "w2-session-"));

async function call(name: string, params: Record<string, unknown>): Promise<any> {
	const tool = tools.get(name);
	assert.ok(tool, `missing tool ${name}`);
	return await tool.execute("call-id", params, undefined, undefined, {
		cwd: process.cwd(),
		sessionManager: { getSessionDir: () => sessionDir },
	});
}

function resultText(result: any): string {
	return (result.content as Array<{ text: string }>).map((block) => block.text).join("\n");
}

function longAnswer(): string {
	const line = "the quick brown fox jumps over the lazy dog 0123456789\n";
	return `## Summary\nshort conclusion\n\n## Details\n${line.repeat(120)}`;
}

test("w2: long answer is archived; status shows the handle; offset pages reconstruct it", async () => {
	const answer = longAnswer();
	const dir = makeFixtureDir({ claude: CLAUDE_MOCK });
	const answerFile = path.join(dir, "answer.txt");
	writeFileSync(answerFile, answer);
	const restore = withEnv({
		PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
		CLAUDE_MOCK_ANSWER_FILE: answerFile,
	});
	try {
		const start = await call("external_agent_start", { agent: "claude", task: "research it", mode: "readonly", cwd: dir, notify: "off" });
		const taskId = start.details.task.taskId;
		const waited = await call("external_agent_wait", { taskIds: [taskId], timeout: 20 });
		const text = resultText(waited);
		assert.match(text, /\[answer archived: ans_[a-f0-9]{12} \| \d+ bytes \| \d+ lines \| sha256:[a-f0-9]{8}/);
		assert.match(text, /short conclusion/);
		assert.ok(!text.includes("lazy dog 0123456789".repeat(10)), "placeholder must not inline the body");

		// Page the archive back through status offset and rebuild the original.
		let offset = 0;
		let rebuilt = "";
		for (let i = 0; i < 20; i++) {
			const page = await call("external_agent_status", { taskId, offset });
			const pageText = resultText(page);
			const header = /^\[recall ans_[a-f0-9]{12} offset=\d+ next_offset=(\d+) eof=(true|false)\]/.exec(pageText);
			assert.ok(header, `recall header missing in: ${pageText.slice(0, 120)}`);
			rebuilt += pageText.slice(pageText.indexOf("\n") + 1);
			if (header[2] === "true") break;
			offset = Number(header[1]);
			assert.ok(offset > 0);
		}
		assert.equal(createHash("sha256").update(rebuilt).digest("hex"), createHash("sha256").update(answer.trim()).digest("hex"));
	} finally {
		restore();
	}
});

test("w2: short answer stays inline (no archive handle)", async () => {
	const dir = makeFixtureDir({ claude: CLAUDE_MOCK });
	const restore = withEnv({ PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` });
	try {
		const start = await call("external_agent_start", { agent: "claude", task: "tiny", mode: "readonly", cwd: dir, notify: "off" });
		const waited = await call("external_agent_wait", { taskIds: [start.details.task.taskId], timeout: 20 });
		const text = resultText(waited);
		assert.match(text, /CLAUDE_OK/);
		assert.ok(!text.includes("[answer archived:"));
	} finally {
		restore();
	}
});

test("w2: caller verify command runs through pi.exec and lands in status", async () => {
	execCalls.length = 0;
	const dir = makeFixtureDir({ claude: CLAUDE_MOCK });
	const restore = withEnv({ PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` });
	try {
		const start = await call("external_agent_start", {
			agent: "claude",
			task: "change it",
			mode: "readonly",
			cwd: dir,
			notify: "off",
			verify: { command: "npm test", timeoutSeconds: 30 },
		});
		const taskId = start.details.task.taskId;
		await call("external_agent_wait", { taskIds: [taskId], timeout: 20 });
		const status = await call("external_agent_status", { taskId });
		assert.match(resultText(status), /verify: `npm test` — exit 0/);
		assert.equal(execCalls.length, 1);
		assert.equal(execCalls[0].command, "bash");
		assert.deepEqual(execCalls[0].args, ["-lc", "npm test"]);
	} finally {
		restore();
	}
});

test("w2: worker-declared verify command is not executed for readonly tasks", async () => {
	execCalls.length = 0;
	const answer = `## Summary\ndone\n\n## Suggested verify command\n\`\`\`bash\nnpm test\n\`\`\`\n`;
	const dir = makeFixtureDir({ claude: CLAUDE_MOCK });
	const answerFile = path.join(dir, "answer.txt");
	writeFileSync(answerFile, answer);
	const restore = withEnv({
		PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
		CLAUDE_MOCK_ANSWER_FILE: answerFile,
	});
	try {
		const start = await call("external_agent_start", { agent: "claude", task: "look", mode: "readonly", cwd: dir, notify: "off" });
		const taskId = start.details.task.taskId;
		await call("external_agent_wait", { taskIds: [taskId], timeout: 20 });
		const status = await call("external_agent_status", { taskId });
		assert.match(resultText(status), /verify: `npm test` — skipped \(worker-declared commands are not executed for readonly tasks\)/);
		assert.equal(execCalls.length, 0);
	} finally {
		restore();
	}
});

test("w2: template param wraps the task and lands on the dispatch receipt", async () => {
	const dir = makeFixtureDir({ claude: CLAUDE_MOCK });
	const restore = withEnv({ PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` });
	try {
		const start = await call("external_agent_start", {
			agent: "claude",
			task: "MY_TASK_BODY",
			mode: "readonly",
			cwd: dir,
			notify: "off",
			template: "verify-report",
		});
		const receipt = start.details.task.dispatch;
		assert.equal(receipt.template, "verify-report@1");
		assert.match(receipt.prompt, /MY_TASK_BODY/);
		assert.ok(!receipt.prompt.includes("{{TASK}}"), "placeholder must be substituted");
		assert.match(receipt.prompt, /Suggested verify command/);
	} finally {
		restore();
	}
});

test("w2: unknown template refuses the dispatch", async () => {
	const dir = makeFixtureDir({ claude: CLAUDE_MOCK });
	const restore = withEnv({ PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` });
	try {
		const result = await call("external_agent_start", {
			agent: "claude",
			task: "x",
			mode: "readonly",
			cwd: dir,
			notify: "off",
			template: "no-such-template",
		});
		assert.match(resultText(result), /^Refused: /);
		assert.equal(result.details.refused, true);
	} finally {
		restore();
	}
});

test("w2: /external_agent_stats dumps meter counters", async () => {
	const dir = makeFixtureDir({ claude: CLAUDE_MOCK });
	const restore = withEnv({ PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` });
	try {
		await call("external_agent_start", { agent: "claude", task: "meter me", mode: "readonly", cwd: dir, notify: "off" });
		const command = commands.get("external_agent_stats");
		assert.ok(command, "external_agent_stats command registered");
		let shown = "";
		await command.handler("", { ui: { notify: (text: string) => (shown = text) } });
		assert.match(shown, /dispatches: [1-9]/);
		assert.match(shown, /not billing/);
		assert.match(shown, /cost \$\d+\.\d{4}/);
	} finally {
		restore();
	}
});

test("w2: compare honors a per-slot task override", async () => {
	const dir = makeFixtureDir({ claude: CLAUDE_MOCK });
	const restore = withEnv({ PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` });
	try {
		const result = await call("external_agent_compare", {
			task: "SHARED_TASK",
			agents: [
				{ agent: "claude", cwd: dir, mode: "readonly" },
				{ agent: "claude", cwd: dir, mode: "readonly", task: "SLOT_TASK" },
			],
			timeout: 30,
		});
		const results = result.details.results;
		assert.equal(results[0].dispatch.prompt.includes("SHARED_TASK"), true);
		assert.equal(results[1].dispatch.prompt.includes("SLOT_TASK"), true);
	} finally {
		restore();
	}
});
