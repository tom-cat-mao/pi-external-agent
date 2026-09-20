/**
 * External Agent Hub: lets pi dispatch work to other coding agent CLIs installed on
 * this machine and monitor them while they run.
 *
 * This module is the extension entry point and nothing else: it binds the tool
 * surface (hub/tools.ts), the host hooks the registry cannot see on its own
 * (pi.exec), and the session lifecycle (hub/registry.ts).
 *
 * 1. No wall-clock kill. Tasks run in the background until they finish, the model
 *    stops them, or the session ends; the stall watchdog (15m quiet) reports in and
 *    the model decides whether to stop. Waiting is turn-end plus settle/stall
 *    notifications, blocking external_agent_wait, or external_agent_compare
 *    (side by side, no judging). Why: .agents/notes/implemented/2026-08-17-no-wall-clock-timeout.md
 *
 * 2. Permission tiers are enforced mechanically — by the target harness, or by the
 *    session driver answering protocol permission requests (claude's can_use_tool) —
 *    never by a prompt request, and defaults are per-adapter:
 *    codex/pi/kimi/codebuddy/reasonix/qoder/claude
 *    yolo; kimi is yolo-only (headless mode rejects permission flags), so readonly/write are refused;
 *    concurrent write/yolo tasks in the same directory are refused outright. Why: .agents/notes/implemented/2026-09-07-kimi-yolo-only.md
 *
 * 3. One tool surface: `agent` is an enum rather than one tool per CLI, because
 *    tool descriptions cost context in every request.
 *    Why: .agents/notes/implemented/2026-08-17-single-tool-surface.md
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	finalizeHooks,
	formatMeterSnapshot,
	meter,
	scanWatchdogs,
	sessionShutdown,
	sessionStarted,
	stallTestApi,
} from "./hub/registry.ts";
import { stallClock } from "./hub/shared.ts";
import { registerHubTools } from "./hub/tools.ts";

export default function (pi: ExtensionAPI) {
	registerHubTools(pi);

	// Settle-time verify runs through pi.exec; absent in stubbed hosts (tests).
	finalizeHooks.exec = typeof pi.exec === "function" ? pi.exec.bind(pi) : undefined;

	pi.registerCommand?.("external_agent_stats", {
		description: "External-agent usage counters (CLI-reported; not billing).",
		handler: async (_args, ctx) => {
			ctx.ui?.notify?.(formatMeterSnapshot(meter.snapshot()), "info");
		},
	});

	pi.on("session_start", () => sessionStarted(pi));
	pi.on("session_shutdown", (event) => sessionShutdown(event));
}

/**
 * Re-exported for the stall suites, which drive the clock and the scan
 * directly because the thresholds run to minutes.
 */
export { scanWatchdogs, stallClock, stallTestApi };
