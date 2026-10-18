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
 *   AcpDriver             reasonix/codebuddy/dsh/kimi — JSON-RPC 2.0 ACP over stdio
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
 *   dsh      -> `--profile acp` (verified 0.2.1-rc.2): standard ACP v1, with
 *               sessionCapabilities close/list/resume and no advertised steer
 *               method. One prompt may be in flight, so steering is explicitly
 *               unsupported while follow-up works. session/new returns model
 *               and reasoning_effort configOptions; both travel through
 *               session/set_config_option. DSH_PERMISSION_MODE carries the tier,
 *               and the last `--patch` overlay replaces the permission row so a
 *               profile default cannot outrank it.
 *   kimi     -> `kimi acp` (a SUBCOMMAND, not `--acp`; verified against
 *               MoonshotAI/kimi-code @2.0.2): ACP v1, sessions persist, four
 *               modes (default/plan/auto/yolo) under a non-idempotent
 *               session/set_mode, fail-closed request_permission, a `thinking`
 *               config option whose vocabulary session/new advertises, a raw
 *               model id on the `model` config option, and no steer at all (a
 *               concurrent session/prompt is rejected with -32600).
 *
 * Steering is never an immediate interrupt. Every dialect delivers at a step
 * boundary (between tool calls), so a steer cannot cancel a bash command that is
 * already running — only change what the agent does next.
 */

import { ADAPTERS, buildReadonlySettings, dshEffortToken, dshPermissionMode, type AgentId, type Effort, type Mode } from "../adapters.ts";
import { dshOverlayPath, prepareDshLaunch, type DshProfile } from "../dsh-launch.ts";
import type { SessionDriver } from "./base.ts";
import { PiRpcDriver } from "./pi-rpc.ts";
import { CodexAppServerDriver } from "./codex-app-server.ts";
import { ACP_METHODS, AcpDriver, type AcpConfigOption } from "./acp.ts";
import { ClaudeStreamJsonDriver, QoderStreamJsonDriver } from "./stream-json.ts";

/**
 * The dsh profile a persistent session boots. One constant, because the spawn's
 * argv and the anchor probe have to name the same composition.
 */
const DSH_ACP_PROFILE: DshProfile = "acp";

// ---------------------------------------------------------------------------
// kimi session vocabulary
// ---------------------------------------------------------------------------

/**
 * kimi's tier names (packages/acp-server/src/modes.ts, kimi-code 2.0.2). Every
 * session boots in `default`, and only the three tiers below are ever requested,
 * so `default` is never set explicitly. plan is what confines a readonly run:
 * its guard vetoes Write/Edit, which is the only thing standing between a
 * readonly label and `git-cwd-write-approve` silently approving an in-workspace
 * edit in every other mode.
 */
const KIMI_MODE_IDS: Record<Mode, string> = { readonly: "plan", write: "auto", yolo: "yolo" };

function kimiModeId(mode: Mode): string {
	return KIMI_MODE_IDS[mode];
}

/**
 * The one session/set_mode rejection kimi's configure phase tolerates: the
 * session is ALREADY in the mode that was requested, so there is nothing left
 * to set (set_mode is not idempotent, and a session can boot in a mode of its
 * own). kimi does not put that text in the JSON-RPC error message — a plan→plan
 * conflict arrives as message "Internal error" with "Already in plan mode" in
 * data.details, which the plumbing surfaces alongside the message.
 *
 * The requested mode id has to be named by the rejection. "already in" some
 * OTHER mode means the session is somewhere else than what was asked for, which
 * is precisely the case the fail-closed policy must not swallow.
 */
function kimiBenignModeRejection(message: string, modeId: string): boolean {
	const requested = modeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`\\balready\\b[\\s\\S]*\\bin\\b[\\s\\S]*\\b${requested}\\b`, "i").test(message);
}

/** Find one config option by its ACP id. */
function configOptionOf(configOptions: AcpConfigOption[], configId: string): AcpConfigOption | undefined {
	return configOptions.find((entry) => entry && typeof entry === "object" && (entry.id === configId || entry.configId === configId));
}

/** Flatten simple option lists and ACP's grouped option lists into values. */
function optionValues(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const values: string[] = [];
	for (const entry of raw) {
		if (typeof entry === "string") {
			if (entry) values.push(entry);
			continue;
		}
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (Array.isArray(record.options)) {
			values.push(...optionValues(record.options));
			continue;
		}
		const value = record.value ?? record.id ?? record.name;
		if (typeof value === "string" && value) values.push(value);
	}
	return values;
}

/**
 * The values one config option advertises, read from whichever shape the
 * session describes them in (simple `values`, ACP's `options`, or grouped
 * model option lists). An unadvertised option yields [].
 */
function advertisedConfigValues(configOptions: AcpConfigOption[], configId: string): string[] {
	const option = configOptionOf(configOptions, configId);
	return optionValues(option?.values ?? option?.options);
}

interface AcpModelChoice {
	value: string;
	name: string;
	provider?: string;
}

/** Flatten the model selector, retaining each choice's provider group. */
function modelChoices(configOptions: AcpConfigOption[]): AcpModelChoice[] {
	const option = configOptionOf(configOptions, "model");
	const raw = option?.options ?? option?.values;
	if (!Array.isArray(raw)) return [];
	const choices: AcpModelChoice[] = [];
	const visit = (entries: unknown[], provider?: string): void => {
		for (const entry of entries) {
			if (!entry || typeof entry !== "object") continue;
			const record = entry as Record<string, unknown>;
			const group = typeof record.group === "string" ? record.group : provider;
			if (Array.isArray(record.options)) {
				visit(record.options, group);
				continue;
			}
			if (typeof record.value !== "string" || typeof record.name !== "string") continue;
			choices.push({ value: record.value, name: record.name, ...(group === undefined ? {} : { provider: group }) });
		}
	};
	visit(raw);
	return choices;
}

function modelChoiceLabel(choice: AcpModelChoice): string {
	return choice.provider ? `${choice.provider}/${choice.name}` : choice.name;
}

/**
 * Resolve the public model string against what session/new advertised. The
 * opaque selector value is accepted exactly; otherwise a unique model name, or
 * a unique provider/model name, is accepted. Raw ids are never forwarded.
 */
function resolveModelChoice(configOptions: AcpConfigOption[], requested: string): AcpModelChoice {
	const choices = modelChoices(configOptions);
	if (choices.length === 0) {
		throw new Error(`dsh session/new advertised no model choices; cannot forward model "${requested}"`);
	}
	const exact = choices.find((choice) => choice.value === requested);
	if (exact) return exact;

	const byName = choices.filter((choice) => choice.name === requested);
	if (byName.length === 1) return byName[0];
	if (byName.length > 1) {
		throw new Error(
			`dsh model "${requested}" is ambiguous across providers (${byName.map(modelChoiceLabel).join(", ")}); ` +
				"pass provider/model or the exact advertised selector value",
		);
	}

	const slash = requested.indexOf("/");
	if (slash > 0 && slash < requested.length - 1) {
		const provider = requested.slice(0, slash);
		const model = requested.slice(slash + 1);
		const qualified = choices.filter((choice) => choice.provider === provider && choice.name === model);
		if (qualified.length === 1) return qualified[0];
	}

	throw new Error(`dsh does not advertise model "${requested}" for this session; available: ${choices.map(modelChoiceLabel).join(", ")}`);
}

function kimiEffortRefusal(token: string, offered: string[]): string {
	return (
		`kimi does not offer thinking effort "${token}" on this session: ` +
		(offered.length > 0 ? `session/new advertised ${offered.join(", ")}.` : "session/new advertised no thinking vocabulary.") +
		" The request is refused rather than sent, and the session was not started."
	);
}

/**
 * The `thinking` value for a requested level. Deliberately the level's own name:
 * kimi's scale is unverified against a live session, so re-spelling it here
 * would silently ask for a different level than the caller named — the driver
 * sends what was asked and refuses when the session does not advertise it.
 */
export function kimiThinkingToken(effort: Effort): string {
	return effort;
}

/**
 * A logged-out kimi answers session/new with -32000, whose message is an auth
 * complaint; the JSON-RPC plumbing carries the message but not the code, so the
 * hint is matched on the text. Anything else keeps its original failure — a
 * wrong "run kimi login" on an unrelated error would send the caller in circles.
 */
function kimiLoginHint(err: Error): string | undefined {
	if (!/\blog ?in\b|\bsign ?in\b|logged out|unauthori?zed|credential|api[- ]?key/i.test(err.message)) return undefined;
	return `${err.message} — kimi is not signed in. Run \`kimi login\` and retry.`;
}

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
			// dsh spells the ACP entry as a profile rather than a flag, and --patch is
			// a LAUNCHER flag, so both belong in the entry argv. The overlay pins the
			// permission row before any session can be created.
			acpArgv: ["--profile", DSH_ACP_PROFILE, "--patch", dshOverlayPath()],
			// ACP config options carry the model and effort per session; there is no
			// startup model or effort flag on this CLI.
			baseArgv: () => [],
			// Provisioning runs before the spawn and is lazy/idempotent. readonly and
			// write refuse if the composition anchor cannot prove the permission row
			// and env hooks; yolo warns because it promises no confinement.
			prepare: (input) => {
				const launch = prepareDshLaunch(DSH_ACP_PROFILE, input.mode);
				if (!launch.ok) throw new Error(launch.reason);
				return {
					// DSH_HOME is deleted, not set: an ambient value would point the
					// child at a home that was neither provisioned nor anchored.
					env: { DSH_PERMISSION_MODE: dshPermissionMode(input.mode), DSH_HOME: undefined },
					...(launch.warning ? { warning: launch.warning } : {}),
				};
			},
			// readonly and write deny every permission escalation. write's guarantee
			// is workspace-write, not "workspace-write unless the model asks for
			// full access"; yolo is the only mode that may allow the escalation.
			failClosedPermissionModes: ["readonly", "write"],
			// One in-flight prompt is all ACP allows and dsh advertises no steer
			// method. Never pretend a second prompt is mid-run guidance.
			steerViaConcurrentPrompt: false,
			configureSession: async ({ sessionId, model, effort, configOptions, call }) => {
				let advertised = configOptions;
				if (model) {
					const choice = resolveModelChoice(configOptions, model);
					const updated = await call(ACP_METHODS.sessionSetConfigOption, {
						sessionId,
						configId: "model",
						value: choice.value,
					});
					if (!Array.isArray(updated?.configOptions)) {
						throw new Error("dsh session/set_config_option model returned no configOptions");
					}
					advertised = updated.configOptions as AcpConfigOption[];
				}
				if (effort) {
					const token = dshEffortToken(effort);
					const offered = advertisedConfigValues(advertised, "reasoning_effort");
					if (!offered.includes(token)) {
						throw new Error(
							`dsh does not offer reasoning effort "${token}" for this session: ` +
								(offered.length > 0 ? `session/new advertised ${offered.join(", ")}.` : "session/new advertised no reasoning_effort option.") +
								" The request is refused rather than downgraded, and the session was not started.",
						);
					}
					await call(ACP_METHODS.sessionSetConfigOption, {
						sessionId,
						configId: "reasoning_effort",
						value: token,
					});
				}
			},
		}),
	kimi: () =>
		new AcpDriver({
			id: "kimi",
			// `kimi acp` is a SUBCOMMAND (verified against kimi-code 2.0.2); the
			// `--acp` flag every other dialect but dsh uses does not exist here.
			acpArgv: ["acp"],
			// No startup flags at all: the model and the effort level travel per
			// session in the configure phase below.
			baseArgv: () => [],
			prepare: (input) => ({
				env: {
					// A self-update inside a spawned session would swap the binary
					// under a live process; the run must never trigger one.
					KIMI_CODE_NO_AUTO_UPDATE: "1",
					// Effort travels per session, so an ambient value must not be
					// the one in force. Only stripped when this start sets effort
					// itself: a request that named no level asked for no override,
					// and keeps the environment it was given.
					...(input.effort ? { KIMI_MODEL_THINKING_EFFORT: undefined } : {}),
				},
			}),
			// readonly is plan mode plus this driver refusing every permission
			// request; write/yolo let the harness's own asks through, because
			// those tiers permit them.
			failClosedPermissionModes: ["readonly"],
			// kimi's set_mode is not idempotent (plan while in plan throws) and a
			// session can boot in a mode of its own. Only a rejection that names
			// the requested mode as already in force is benign; any other mode,
			// effort or model rejection fails the start.
			benignModeRejection: kimiBenignModeRejection,
			sessionNewHint: kimiLoginHint,
			// A concurrent session/prompt during an active turn is rejected with
			// -32600 and no steer method is advertised, so kimi has no steer.
			steerViaConcurrentPrompt: false,
			configureSession: async ({ sessionId, mode, effort, model, configOptions, setMode, call }) => {
				// The tier first: every session boots in `default`, and the mode
				// has to be set before the first prompt.
				await setMode(kimiModeId(mode));
				// The model next, because the thinking vocabulary is advertised
				// per session for its model: an updated list from this response is
				// the one the effort token below is checked against. kimi takes a
				// RAW model id here, not dsh's [provider, model] pair.
				let advertised = configOptions;
				if (model) {
					const updated = await call(ACP_METHODS.sessionSetConfigOption, { sessionId, configId: "model", value: model });
					if (Array.isArray(updated?.configOptions)) advertised = updated.configOptions as AcpConfigOption[];
				}
				if (effort) {
					const token = kimiThinkingToken(effort);
					const offered = advertisedConfigValues(advertised, "thinking");
					if (!offered.includes(token)) throw new Error(kimiEffortRefusal(token, offered));
					await call(ACP_METHODS.sessionSetConfigOption, { sessionId, configId: "thinking", value: token });
				}
			},
		}),
};

export const SESSION_AGENT_IDS = Object.keys(SESSION_DRIVERS) as AgentId[];

export const STEER_AGENT_IDS = SESSION_AGENT_IDS.filter((id) => ADAPTERS[id].session?.steer);
export const FOLLOWUP_AGENT_IDS = SESSION_AGENT_IDS.filter((id) => ADAPTERS[id].session?.followUp);

export function hasSessionDriver(agent: AgentId): boolean {
	return SESSION_DRIVERS[agent] !== undefined;
}

export type { SessionDriver, SessionStartInput, SteerResult, TurnOutcome } from "./base.ts";
