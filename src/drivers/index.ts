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
 *               effort flag. DSH_PERMISSION_MODE carries the tier, and a
 *               `--patch` overlay keeps dsh's settings row pointed at pi's own
 *               empty settings document in the SHARED ~/.dsh.
 *
 * Steering is never an immediate interrupt. All five deliver at a step boundary
 * (between tool calls), so a steer cannot cancel a bash command that is already
 * running — only change what the agent does next.
 */

import { ADAPTERS, buildReadonlySettings, DSH_TELEMETRY_OPT_OUT, dshEffortToken, dshPermissionMode, type AgentId } from "../adapters.ts";
import { dshOverlayPath, prepareDshLaunch, type DshProfile } from "../dsh-launch.ts";
import type { SessionDriver } from "./base.ts";
import { PiRpcDriver } from "./pi-rpc.ts";
import { CodexAppServerDriver } from "./codex-app-server.ts";
import { AcpDriver } from "./acp.ts";
import { ClaudeStreamJsonDriver, QoderStreamJsonDriver } from "./stream-json.ts";

/**
 * The dsh profile a persistent session boots. One constant, because the spawn's
 * argv and the anchor probe have to name the same composition.
 */
const DSH_ACP_PROFILE: DshProfile = "acp";

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
			// is a second session/prompt on the active session), and --patch is a
			// LAUNCHER flag, so it belongs in the entry argv with its overlay —
			// it is what makes the requested tier bind (src/dsh-launch.ts).
			acpArgv: ["--profile", DSH_ACP_PROFILE, "--patch", dshOverlayPath()],
			// The model comes from the profile; no session-start model flag is
			// verified for this CLI, so nothing is appended. The receipt reports a
			// model request as not forwarded rather than claiming it traveled.
			baseArgv: () => [],
			// Provisioning runs before the spawn and is lazy/idempotent: the empty
			// settings document plus the overlay that points dsh's settings row at
			// it. It fails the session start only when one of those files cannot
			// exist at all — without them dsh reads the user's own settings
			// document, whose permission.defaultPreset outranks the variable, and
			// the requested tier stops binding silently. Anything the composition
			// anchor finds is a warning instead: the session still starts.
			prepare: (input) => {
				// The profile is passed, not assumed: dsh composes per profile, so
				// this session's composition is anchored under `acp` — a user's
				// `~/.dsh/profiles/acp/cordis.patch.yml` cannot hide behind a clean
				// `headless` probe.
				const launch = prepareDshLaunch(DSH_ACP_PROFILE);
				if (!launch.ok) throw new Error(launch.reason);
				return {
					// DSH_HOME is deleted, not set: an ambient value would point the
					// child at a home that was neither provisioned nor anchored. The
					// telemetry opt-out rides with the session spawn for the same
					// reason it rides with the one-shot one: this run is the
					// extension's, not the user's own dsh.
					env: {
						DSH_PERMISSION_MODE: dshPermissionMode(input.mode),
						DSH_HOME: undefined,
						DSH_TELEMETRY_DISABLED: DSH_TELEMETRY_OPT_OUT,
					},
					...(launch.warning ? { warning: launch.warning } : {}),
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
