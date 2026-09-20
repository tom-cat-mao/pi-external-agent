import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS } from "../src/adapters.ts";
import { SESSION_DRIVERS, type TurnOutcome } from "../src/drivers/index.ts";

const CLOSED_STDIN_MOCK = `#!/usr/bin/env node
const fs = require("node:fs");
fs.closeSync(0);
process.stdout.write(JSON.stringify({type:"system",subtype:"init",qodercli_version:"1.1.49"}) + "\\n");
setInterval(() => {}, 1000);
`;

test("persistent stdin failure fails the task and reaps the otherwise-live process", { timeout: 10_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-external-stdin-"));
	const executable = join(dir, "mock-qoder.cjs");
	writeFileSync(executable, CLOSED_STDIN_MOCK, { mode: 0o755 });
	const originalBin = ADAPTERS.qoder.bin;
	ADAPTERS.qoder.bin = executable;
	const driver = SESSION_DRIVERS.qoder!();
	const turns: TurnOutcome[] = [];
	driver.onTurnEnd((outcome) => turns.push(outcome));
	const exit = new Promise<void>((resolve) => driver.onExit(() => resolve()));
	const timeout = setTimeout(() => driver.kill(), 6_000);
	try {
		await driver.start({ task: "mock input only", cwd: dir, mode: "readonly" }).catch(() => undefined);
		await exit;
		assert.equal(driver.alive, false);
		assert.match((driver as any).spawnError ?? "", /stdin:.*(?:EPIPE|closed|destroyed)/i);
		assert.equal(turns.every((turn) => turn.status === "failed"), true);
		await assert.rejects(driver.followUp("cannot be sent"), /gone|exited/i);
		assert.equal((await driver.steer("cannot be sent")).accepted, false);
	} finally {
		clearTimeout(timeout);
		driver.kill();
		ADAPTERS.qoder.bin = originalBin;
	}
});
