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
 *    session driver answering protocol permission requests (dsh's ACP escalation deny) —
 *    never by a prompt request, and defaults are per-adapter:
 *    codex/pi/kimi/codebuddy/reasonix/qoder/claude/dsh
 *    yolo, with every tier open (kimi's readonly is plan mode plus the driver
 *    rejecting permission prompts, and its print spelling stays yolo-only);
 *    concurrent write/yolo tasks in the same directory are refused outright.
 *    Why: .agents/notes/implemented/2026-09-21-kimi-acp-driver.md
 *
 * 3. One tool surface: `agent` is an enum rather than one tool per CLI, because
 *    tool descriptions cost context in every request.
 *    Why: .agents/notes/implemented/2026-08-17-single-tool-surface.md
 */

import { fileURLToPath } from "node:url";
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

/**
 * The capability index shipped beside the extension. Resolved from this module's
 * URL, like the codebuddy readonly hook, so it stays correct wherever the
 * extension is installed.
 */
const SKILL_PATH = fileURLToPath(new URL("../skills/external-agent/SKILL.md", import.meta.url));

export default function (pi: ExtensionAPI) {
	registerHubTools(pi);

	// Advertised through pi's resources_discover hook: only the skill's name and
	// description enter the prompt, and the model reads the file itself when it
	// needs the capability detail that used to sit in the tool descriptions.
	pi.on("resources_discover", () => ({ skillPaths: [SKILL_PATH] }));

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
