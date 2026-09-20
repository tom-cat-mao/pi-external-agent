/**
 * Persistent session drivers for external agents, and the registry that names
 * them.
 *
 * The one-shot transport in hub/registry.ts spawns a headless process and
 * treats its exit as completion. That shape cannot steer a run or ask a
 * follow-up: by the time the answer exists, the process — and its conversation
 * — is gone. These drivers keep a long-lived stdio session alive instead, so
 * the completion signal moves from "process exited" to "turn ended" while the
 * process stays up for follow-ups.
 *
 * Five wire protocols, one interface:
 *
 *   PiRpcDriver           pi --mode rpc        — line JSON commands + events
 *   CodexAppServerDriver  codex app-server     — JSON-RPC 2.0, experimental
 *   AcpDriver             reasonix/codebuddy/dsh — JSON-RPC 2.0 ACP over stdio
 *   ClaudeStreamJsonDriver claude              — LF stream-json (anthropic contract)
 *   QoderStreamJsonDriver  qoder               — LF stream-json with version gate
 *
 * Facts verified by hand on 2026-09-08 against the installed binaries
 * (pi 0.85.1, codex 0.153.4, reasonix v1.38.1, codebuddy 2.147.0), including
 * the deviations that only showed up when actually running them:
 *
 *   pi       -> the argv prompt is NOT executed in rpc mode; the task has to go
 *               in as {"type":"prompt"} on stdin after startup. `follow_up` only
 *               drains while the agent is running, so a follow-up on an idle
 *               session must be sent as `prompt` (falling back to `follow_up`
 *               if the agent turns out to be busy). `agent_settled` is the
 *               settle signal.
 *   codex    -> initialize -> `initialized` notification -> thread/start ->
 *               turn/start. Steering requires expectedTurnId to match the active
 *               turn; turn/completed (status completed|interrupted|failed) is the
 *               settle signal and the process stays up.
 *   reasonix -> initialize advertises _meta["reasonix.io"].sessionSteer.method;
 *               read the advertised name, never hardcode it. `--acp` accepts
 *               --model but rejects --permission-mode and --effort (verified by
 *               running it: "flag provided but not defined"), so permissions are
 *               answered over session/request_permission and effort cannot be
 *               forwarded. v1.38.1 implements no cancel method at all (-32601),
 *               so cancelling falls through to the caller's SIGTERM.
 *   codebuddy-> plain ACP: steering is a second session/prompt on the active
 *               session; it lands at the next model step boundary, or becomes a
 *               follow-up if the turn is stuck inside one long tool call.
 *   dsh      -> `--profile acp` (verified 0.1.5-rc.2): standard ACP v1, with
 *               sessionCapabilities close/list/resume and no advertised steer
 *               method, so steering is the codebuddy fallback. session/new
 *               returns configOptions (model, reasoning_effort), and effort is
 *               forwarded with session/set_config_option — the CLI has no
 *               effort flag. DSH_HOME must be the dedicated harness home, and
 *               DSH_PERMISSION_MODE carries the tier.
 *
 * Steering is never an immediate interrupt. All five deliver at a step boundary
 * (between tool calls), so a steer cannot cancel a bash command that is already
 * running — only change what the agent does next.
 */

import { ADAPTERS, buildReadonlySettings, dshEffortToken, dshPermissionMode, type AgentId } from "../adapters.ts";
import { ensureDshHome } from "../dsh-home.ts";
import type { SessionDriver } from "./base.ts";
import { PiRpcDriver } from "./pi-rpc.ts";
import { CodexAppServerDriver } from "./codex-app-server.ts";
import { AcpDriver } from "./acp.ts";
import { ClaudeStreamJsonDriver, QoderStreamJsonDriver } from "./stream-json.ts";

/**
 * Agents that run over a persistent session. Everything else keeps the
 * one-shot spawn path in hub/registry.ts.
 */
export const SESSION_DRIVERS: Partial<Record<AgentId, () => SessionDriver>> = {
	pi: () => new PiRpcDriver(),
	codex: () => new CodexAppServerDriver(),
	reasonix: () =>
		new AcpDriver({
			id: "reasonix",
			// `--acp` rejects --permission-mode and --effort (verified v1.38.1:
			// "flag provided but not defined"), so permissions are answered over
			// the protocol and an effort request cannot be forwarded here.
			baseArgv: (input) => (input.model ? ["--model", input.model] : []),
		}),
	codebuddy: () =>
		new AcpDriver({
			id: "codebuddy",
			baseArgv: (input) => {
				// Readonly is NOT plan mode: a plan-mode permission request, once
				// auto-rejected by this driver, cancels the ENTIRE turn (verified
				// 2026-09-09), making readonly delegation unusable. Instead: default
				// mode + runtime-built --settings whose allow/deny rules and
				// PreToolUse Bash hook deny silently — no request_permission ever
				// reaches the driver. (--disallowedTools is ignored under ACP;
				// everything must go through --settings.)
				const argv =
					input.mode === "readonly"
						? ["--permission-mode", "default", "--settings", buildReadonlySettings()]
						: ["--permission-mode", input.mode === "write" ? "acceptEdits" : "bypassPermissions"];
				if (input.model) argv.push("--model", input.model);
				if (input.effort) argv.push("--effort", input.effort);
				return argv;
			},
		}),
	claude: () => new ClaudeStreamJsonDriver(),
	qoder: () => new QoderStreamJsonDriver(),
	dsh: () =>
		new AcpDriver({
			id: "dsh",
			// dsh spells the ACP entry as a profile rather than a flag (verified
			// 0.1.5-rc.2: standard ACP v1, no advertised steer method, so steering
			// is a second session/prompt on the active session).
			acpArgv: ["--profile", "acp"],
			// The model comes from the profile; no session-start model flag is
			// verified for this CLI, so nothing is appended. The receipt reports a
			// model request as not forwarded rather than claiming it traveled.
			baseArgv: () => [],
			// DSH_HOME must be the dedicated harness home (src/dsh-home.ts): the
			// user's shared ~/.dsh settings outrank DSH_PERMISSION_MODE, so a run
			// under the shared home would not be bounded by the requested tier at
			// all. Provisioning runs before the spawn and is lazy/idempotent; a
			// failure (no credentials yet) fails the session start with the reason,
			// which tells the user to sign in. A home that already holds a local
			// credentials copy still starts, with the warning attached.
			prepare: (input) => {
				const home = ensureDshHome();
				if (!home.ok) throw new Error(home.reason);
				return {
					env: { DSH_HOME: home.home, DSH_PERMISSION_MODE: dshPermissionMode(input.mode) },
					warning: home.warning,
				};
			},
			// No effort flag exists on this CLI: the session sets the config option
			// instead. A rejected set_config_option fails the session start, so the
			// turn never runs at a default the caller did not ask for.
			effort: { configId: "reasoning_effort", token: dshEffortToken },
		}),
};

export const SESSION_AGENT_IDS = Object.keys(SESSION_DRIVERS) as AgentId[];

export const STEER_AGENT_IDS = SESSION_AGENT_IDS.filter((id) => ADAPTERS[id].session?.steer);
export const FOLLOWUP_AGENT_IDS = SESSION_AGENT_IDS.filter((id) => ADAPTERS[id].session?.followUp);

export function hasSessionDriver(agent: AgentId): boolean {
	return SESSION_DRIVERS[agent] !== undefined;
}

export type { SessionDriver, SessionStartInput, SteerResult, TurnOutcome } from "./base.ts";
