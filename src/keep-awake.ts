/**
 * Idle-sleep prevention for the duration of a dispatched task (macOS).
 *
 * `caffeinate -i -w <pid>` ties a no-idle-sleep assertion to the task process:
 * the assertion is released when that process exits, and caffeinate then exits
 * on its own. That is the whole cleanup story — no counter, no kill, no exit
 * handler — so a pi that dies mid-task cannot strand an assertion, and a task
 * that is stopped early releases it just the same. `-i` blocks idle *system*
 * sleep only, so the display can still turn off.
 *
 * Both spawn sites that hand a task to an external CLI call this: the one-shot
 * process in hub/registry.ts and the persistent session process in
 * drivers/base.ts (whose process outlives the turn that started it). The helper
 * is best-effort by construction: no caffeinate, a failed spawn or another
 * platform must never fail a dispatch or print anything, so the child's
 * "error" is absorbed, the call is wrapped, and the child is unref'd so
 * keep-awake can never be the reason pi stays alive.
 */

import { spawn } from "node:child_process";

/**
 * Hold off idle system sleep while `pid` lives. A missing/unknown pid has
 * nothing to bind the assertion to, so it is a no-op; `platform` is a seam for
 * the tests, and defaults to the real one.
 */
export function keepAwakeWhileRunning(pid: number | undefined, platform: NodeJS.Platform = process.platform): void {
	if (platform !== "darwin" || !pid) return;
	try {
		const child = spawn("caffeinate", ["-i", "-w", String(pid)], { stdio: "ignore" });
		// Unhandled, a spawn failure (a caffeinate that is not on PATH) is an
		// uncaught exception; the dispatch must not inherit that.
		child.on("error", () => {});
		child.unref();
	} catch {
		/* keep-awake is best effort: a task never fails because of it */
	}
}
