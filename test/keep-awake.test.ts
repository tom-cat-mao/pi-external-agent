/**
 * keep-awake: the macOS idle-sleep assertion that rides a dispatched task.
 *
 * The mechanism is a real `caffeinate -i -w <pid>` child, so the tests observe
 * it the way the system does: pgrep reports which pids a live caffeinate is
 * watching. The darwin-only cases cannot run on the ubuntu CI runner, so they
 * skip there; the platform-guard case runs everywhere.
 *
 * Run with `node --test test/keep-awake.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { keepAwakeWhileRunning } from "../src/keep-awake.ts";

const DARWIN = process.platform === "darwin";

/** The pids a live `caffeinate -i -w <pid>` is currently watching. */
function watchedPids(): number[] {
	try {
		return execFileSync("pgrep", ["-fl", "caffeinate"], { encoding: "utf8" })
			.split("\n")
			.map((line) => line.match(/-i -w (\d+)\s*$/)?.[1])
			.filter((pid) => pid !== undefined)
			.map(Number);
	} catch {
		return []; // pgrep exits 1 when nothing matches
	}
}

/** Poll, so pgrep's view can catch up with the spawn it is being asked about. */
async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) return false;
		await delay(25);
	}
	return true;
}

/** A live process to bind the assertion to; its exit is what must release it. */
function startSleeper(): ChildProcess {
	return spawn("sleep", ["30"], { stdio: "ignore" });
}

test("keep-awake: off darwin nothing is spawned", async () => {
	const sleeper = startSleeper();
	const pid = sleeper.pid!;
	try {
		keepAwakeWhileRunning(pid, "linux");
		await delay(300);
		assert.ok(!watchedPids().includes(pid), `no caffeinate may watch pid ${pid} off darwin`);
	} finally {
		sleeper.kill("SIGKILL");
	}
});

test("keep-awake: darwin binds the assertion to the pid, whose exit releases it", { skip: !DARWIN }, async () => {
	const sleeper = startSleeper();
	const pid = sleeper.pid!;
	try {
		keepAwakeWhileRunning(pid);
		assert.ok(await until(() => watchedPids().includes(pid)), `caffeinate must watch pid ${pid}`);
		// Nobody releases the assertion: the watched process exiting is what ends
		// it, and caffeinate exits by itself at that moment.
		sleeper.kill("SIGTERM");
		await new Promise((resolve) => sleeper.once("exit", resolve));
		assert.ok(await until(() => !watchedPids().includes(pid)), `caffeinate watching ${pid} must exit with it`);
	} finally {
		sleeper.kill("SIGKILL");
	}
});

test("keep-awake: a caffeinate that cannot spawn is silent", { skip: !DARWIN }, async () => {
	const empty = mkdtempSync(join(tmpdir(), "keep-awake-"));
	const savedPath = process.env.PATH;
	process.env.PATH = empty;
	try {
		// The assertion is the absence of a crash: a caffeinate that cannot be
		// found, with no "error" listener, is an uncaught exception.
		keepAwakeWhileRunning(process.pid);
		await delay(250);
	} finally {
		if (savedPath === undefined) delete process.env.PATH;
		else process.env.PATH = savedPath;
		rmSync(empty, { recursive: true, force: true });
	}
});
