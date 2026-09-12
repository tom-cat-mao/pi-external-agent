/**
 * External coding agent adapters.
 *
 * Each adapter knows two things and nothing else:
 *   - buildDispatch: how to spell and describe a headless, structured-output invocation
 *   - parseEvent: how to turn one stdout line into a normalized event
 *
 * Everything else (spawn, monitoring, abort, bookkeeping) is shared in index.ts.
 *
 * Verified by hand on 2026-08-17 against the installed binaries (codex 0.147.0,
 * pi 0.84.2, kimi-code 0.36.1, codebuddy 2.117.1, claude 2.1.165,
 * reasonix 1.21.0 — all dispatched end-to-end with exit 0). Adapter facts below
 * are observations, not assumptions:
 *   codex     -> OpenAI, `--sandbox read-only` enforced by its own harness
 *   kimi      -> Moonshot, yolo-only workhorse: -p rejects all permission
 *                flags (--auto/--yolo/--plan), so headless runs inherit
 *                config.toml's default_permission_mode
 *   codebuddy -> Tencent, Claude-Code-compatible CLI surface incl.
 *                bypassPermissions (headless-verified 2.143.1)
 *   claude    -> shares pi's own configured gateway; HTTP 524 observed 2026-07-27,
 *                verified healthy again 2026-08-17
 *   reasonix  -> DeepSeek-native harness (v1.21.0), prefix-cache tuned
 *
 * zcode was removed on 2026-09-08 (user decision: not needed anymore).
 *
 * Dispatch policy: codex is the workhorse and
 * default to yolo (unsandboxed); claude stays read-only by default and is rarely
 * used. codebuddy joined the yolo-default workhorses on 2026-09-07 (user
 * decision): it still leans toward exploration, but every tier is open — yolo
 * maps to --permission-mode bypassPermissions, verified headless on 2.143.1
 * (Write ran unprompted, permission_denials empty).
 * kimi joined the workhorses on 2026-09-07 as YOLO-ONLY (user decision):
 * kimi-code 0.41.0 rejects every permission flag with -p ("Cannot combine
 * --prompt with --auto/--yolo/--plan"), so a headless run always executes under
 * default_permission_mode in ~/.kimi-code/config.toml (currently "yolo"). A
 * readonly/write tier would be a label with no enforcement behind it, so both
 * are refused at dispatch via minMode.
 *
 * Reasoning-effort flags verified against each binary's --help on 2026-08-03:
 *   pi          -> --thinking <off|minimal|low|medium|high|xhigh|max>
 *   codebuddy   -> --effort <minimal|low|medium|high|xhigh|max>
 *   claude      -> --effort <low|medium|high|xhigh|max>
 *   codex -> -c model_reasoning_effort="<level>" (no dedicated flag; the
 *                  extension's "off" maps to codex's "none"; codex silently
 *                  tolerates unknown values, so the allowlist lives here)
 *   kimi        -> no reasoning-effort control exists; requests are refused
 *   reasonix    -> --effort <LEVEL>; the adapter maps to the configured DeepSeek
 *                    vocabulary itself (off->disabled, minimal->low, medium->high,
 *                    xhigh->max — the same mapping pi's own thinkingLevelMap uses
 *                    for the og/deepseek-v4-flash relay model)
 */

import { fileURLToPath } from "node:url";

export type AgentId = "codex" | "pi" | "kimi" | "codebuddy" | "claude" | "reasonix" | "qoder";

/** Permission mode requested at dispatch; each adapter maps it to real CLI flags. */
export type Mode = "readonly" | "write" | "yolo";

/**
 * Reasoning effort, normalized across CLIs. Not every adapter supports every
 * level (or any level): Adapter.supportedEfforts is the allowlist, index.ts
 * refuses anything outside it. "off" is spelled "none" in the codex family.
 */
export const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/**
 * Wire spellings of the normalized effort scale, exported so the persistent
 * session drivers in sessions.ts can map with the same vocabulary the
 * one-shot buildDispatch paths use instead of re-deriving it.
 *
 * codex: "off" is spelled "none" (both the -c config override and app-server).
 */
export function codexEffortToken(effort: Effort): string {
	return effort === "off" ? "none" : effort;
}

/**
 * reasonix: the configured og relay declares the DeepSeek vocabulary
 * (disabled|low|high|max); requesting anything else is a hard error there.
 * off->disabled  minimal->low  low->low  medium->high  high->high
 * xhigh->max  max->max   (xhigh->max mirrors pi's own thinkingLevelMap for
 * this exact relay model)
 */
const REASONIX_EFFORT_TOKENS: Record<Effort, string> = {
	off: "disabled",
	minimal: "low",
	low: "low",
	medium: "high",
	high: "high",
	xhigh: "max",
	max: "max",
};

export function reasonixEffortToken(effort: Effort): string {
	return REASONIX_EFFORT_TOKENS[effort];
}

/** Normalized event extracted from an agent's stdout stream. */
export interface AgentEvent {
	/** "message" = model prose, "reasoning" = thinking, "tool" = tool activity,
	 *  "usage" = token accounting, "warning" = non-fatal notice, "error" = fatal failure.
	 *
	 *  The warning/error split matters: codex reports benign notices (ignored config
	 *  keys, skill-budget trimming) as `item.type === "error"` while still exiting 0
	 *  and producing a correct answer. Treating those as failures marks good runs bad. */
	kind: "message" | "reasoning" | "tool" | "usage" | "warning" | "error";
	text: string;
}

export interface BuildArgsInput {
	task: string;
	cwd: string;
	/** Requested permission mode; the adapter maps it to real CLI flags. */
	mode: Mode;
	model?: string;
	/** Requested reasoning effort; the adapter maps it to real CLI flags. */
	effort?: Effort;
}

export interface AdapterDispatch {
	argv: string[];
	promptArgIndex: number;
	cwdForwardedToCli: boolean;
	effectivePolicy: string | null;
	readOnlyEnforcement: "harness-enforced" | "not-enforced" | "not-applicable";
	model: {
		requested?: string;
		forwarded: boolean;
		note: string;
	};
	effort: {
		requested?: string;
		forwarded: boolean;
		note: string;
	};
}

export interface Adapter {
	id: AgentId;
	bin: string;
	/** Human-facing note surfaced to the model so it can choose sensibly. */
	provider: string;
	/** What this agent is for; surfaced in the tool description so pi picks the right one. */
	useFor: string;
	/** Mode applied when the caller does not specify one. */
	defaultMode: Mode;
	/** Highest mode this adapter may run; requests above it are refused. */
	maxMode: Mode;
	/** Lowest mode this adapter accepts; requests below it are refused. Default "readonly". */
	minMode?: Mode;
	/** Effort levels this adapter can forward, ascending. Undefined = no control; requests refused. */
	supportedEfforts?: readonly Effort[];
	/** Whether the agent's harness can actually enforce read-only. */
	enforcesReadOnly: boolean;
	/** Known-degraded adapters are still callable but flagged in the tool output. */
	degraded?: string;
	/**
	 * Persistent-session capability. Set only for agents that sessions.ts can
	 * drive over a long-lived JSON-RPC stdio connection (pi/codex/reasonix/
	 * codebuddy). Presence selects the persistent transport in index.ts; the
	 * oneshot buildDispatch/parseEvent pair stays as the fallback path.
	 * steerNote is surfaced verbatim in the tool description so the caller knows
	 * what "steer" means for this agent before it tries one.
	 */
	session?: {
		/** Mid-run guidance is possible for this agent. */
		steer: boolean;
		/** The same session survives turn end, so follow-up keeps its context. */
		followUp: boolean;
		/** How mid-run guidance is delivered; injected at a step boundary, never an immediate interrupt. */
		steerNote: string;
	};
	sessionPolicy?: (mode: Mode) => string;
	buildDispatch(input: BuildArgsInput): AdapterDispatch;
	/** Return null for lines that carry no useful signal. */
	parseEvent(line: string): AgentEvent | null;
	/** Optional final-answer extraction when the stream alone is ambiguous. */
	finalAnswer?(events: AgentEvent[]): string | undefined;
}

// ---------------------------------------------------------------------------
// Codex — JSONL on stdout via `exec --json`
// ---------------------------------------------------------------------------

/** Shared receipt shape for the effort field; the no-request note is uniform. */
function effortReceipt(effort: Effort | undefined, forwarded: boolean, note: string): AdapterDispatch["effort"] {
	return effort
		? { requested: effort, forwarded, note }
		: { forwarded: false, note: "No effort override requested; the target CLI/config default applies." };
}

function parseCodexLine(line: string): AgentEvent | null {
	let obj: any;
	try {
		obj = JSON.parse(line);
	} catch {
		return null;
	}

	if (obj.type === "turn.completed" && obj.usage) {
		const u = obj.usage;
		return {
			kind: "usage",
			text: `in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0} cached=${u.cached_input_tokens ?? 0}`,
		};
	}

	const item = obj.item;
	if (!item) return null;

	switch (item.type) {
		case "agent_message":
			return item.text ? { kind: "message", text: item.text } : null;
		case "reasoning":
			return item.text ? { kind: "reasoning", text: item.text } : null;
		case "error":
			// Non-fatal in this family: exit code is the authority on success.
			return item.message ? { kind: "warning", text: item.message } : null;
		case "command_execution":
			return { kind: "tool", text: `$ ${item.command ?? ""}`.trim() };
		case "file_change":
		case "patch_apply":
			return { kind: "tool", text: `edit ${item.path ?? ""}`.trim() };
		default:
			return null;
	}
}

function codexFamily(
	id: AgentId,
	bin: string,
	provider: string,
	useFor: string,
	// codex is driven over `app-server` (persistent session).
	session?: Adapter["session"],
): Adapter {
	return {
		id,
		bin,
		provider,
		useFor,
		defaultMode: "yolo",
		maxMode: "yolo",
		// The codex protocol tops out at "xhigh"; "max" is a pi/claude-family level.
		supportedEfforts: ["off", "minimal", "low", "medium", "high", "xhigh"],
		session,
	enforcesReadOnly: true,
	buildDispatch({ task, cwd, mode, model, effort }) {
		const argv = ["exec", "--json", "--skip-git-repo-check", "-C", cwd];
			// All three modes are real sandbox policies in this family, not prompt requests.
			const sandbox = mode === "readonly" ? "read-only" : mode === "write" ? "workspace-write" : "danger-full-access";
			argv.push("--sandbox", sandbox);
			if (model) argv.push("--model", model);
		// No dedicated flag exists; -c parses the value as TOML, hence the quotes.
		const token = effort ? codexEffortToken(effort) : undefined;
		if (token) argv.push("-c", `model_reasoning_effort="${token}"`);
		argv.push(task);
		return {
			argv,
			promptArgIndex: argv.length - 1,
			cwdForwardedToCli: true,
			effectivePolicy: `--sandbox ${sandbox}`,
			readOnlyEnforcement: mode === "readonly" ? "harness-enforced" : "not-applicable",
			model: model
				? { requested: model, forwarded: true, note: "Passed to the target CLI as --model." }
				: { forwarded: false, note: "No model override requested; target CLI/config selects the model." },
			effort: effortReceipt(
				effort,
				true,
				`Passed as -c model_reasoning_effort="${token}" (${effort === "off" ? "off is spelled none in this family" : "config override; no dedicated flag exists"}).`,
			),
		};
	},
		parseEvent: parseCodexLine,
	};
}

// ---------------------------------------------------------------------------
// Claude Code family (codebuddy, claude)
// ---------------------------------------------------------------------------

/**
 * Shared trap for this family's result record: an API failure comes back as
 *   { "subtype": "success", "is_error": true, "result": "API Error: 524 ..." }
 * Trusting `subtype` alone would swallow the error as a valid answer.
 */
function claudeResultEvent(rec: any): AgentEvent {
	const text = typeof rec.result === "string" ? rec.result : "";
	const failed = rec.is_error === true || /^API Error/i.test(text) || (Array.isArray(rec.errors) && rec.errors.length > 0);

	if (failed) {
		const detail = Array.isArray(rec.errors) && rec.errors.length > 0 ? rec.errors.join("; ") : text;
		return { kind: "error", text: detail || "agent reported is_error without detail" };
	}
	return { kind: "message", text };
}

/**
 * claude emits its result as ONE compact single-line JSON object (possibly an
 * array of records), so line-framed parsing plus the close-time buffer flush
 * in index.ts works. codebuddy's `--output-format json` is PRETTY-PRINTED
 * multi-line JSON instead (133 lines for a one-word answer, verified on
 * 2.117.1): every line fails JSON.parse individually and the trailing flush
 * sees only the final "]", so the answer never surfaces. codebuddy therefore
 * dispatches with stream-json (NDJSON, realtime) and parses per line below.
 */
function parseClaudeFamilyLine(line: string): AgentEvent | null {
	let obj: any;
	try {
		obj = JSON.parse(line);
	} catch {
		return null;
	}

	const records = Array.isArray(obj) ? obj : [obj];
	for (const rec of records) {
		if (rec?.type !== "result") continue;
		return claudeResultEvent(rec);
	}
	return null;
}

/**
 * NDJSON variant for codebuddy stream-json. Line shapes (verified 2.117.1):
 *   {"type":"system","subtype":"init"|"status"}        -> noise
 *   {"type":"file-history-snapshot"}                     -> noise
 *   {"type":"assistant","message":{"content":[blocks]}} -> tool_use = live signal
 *   {"type":"user","message":{...}}                       -> tool results, noise
 *   {"type":"result",subtype,is_error,result,usage}      -> final answer / error
 * Assistant text blocks are deliberately skipped: the result record carries
 * the same prose, and emitting both would double every answer.
 */
function parseClaudeFamilyStreamLine(line: string): AgentEvent | null {
	let obj: any;
	try {
		obj = JSON.parse(line);
	} catch {
		return null;
	}

	if (obj.type === "result") return claudeResultEvent(obj);

	if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
		const calls = obj.message.content
			.filter((b: any) => b?.type === "tool_use")
			.map((b: any) => `${b.name ?? "tool"} ${JSON.stringify(b.input ?? {})}`.slice(0, 200));
		if (calls.length > 0) return { kind: "tool", text: calls.join("; ") };
	}
	return null;
}

/**
 * Runtime-built `--settings` JSON for the codebuddy readonly tier. Replaces the
 * old plan-mode mapping (verified 2026-09-09 against codebuddy 2.147.0 ACP):
 * settings-injected permissions.allow/deny and hooks.PreToolUse are fully
 * honored under --acp, and a rule-layer deny is a SILENT refusal — no prompt,
 * no request_permission round-trip, the turn continues. plan mode, by contrast,
 * dies wholesale when the driver auto-rejects its permission request.
 * (--disallowedTools is ignored under ACP; everything must go through
 * --settings.) The Bash hook path is resolved from this module's directory at
 * call time, so it stays correct wherever the extension is installed.
 */
export function buildReadonlySettings(): string {
	const hookPath = fileURLToPath(new URL("./hooks/codebuddy-readonly.js", import.meta.url));
	const quotedHookPath = `'${hookPath.replaceAll("'", `'\\''`)}'`;
	return JSON.stringify({
		permissions: {
			allow: ["Read", "Grep", "Glob", "LS", "WebSearch", "WebFetch"],
			deny: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
		},
		hooks: {
			PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `node ${quotedHookPath}` }] }],
		},
	});
}

function claudeFamily(
	id: AgentId,
	bin: string,
	provider: string,
	useFor: string,
	supportedEfforts: readonly Effort[],
	outputFormat: "json" | "stream-json",
	// When set, the yolo tier opens and becomes the default (codebuddy); without
	// it the adapter stays capped at write (claude).
	yoloPermissionMode?: string,
	degraded?: string,
	// Only codebuddy is driven over ACP today; claude stays one-shot.
	session?: Adapter["session"],
	// codebuddy only: when set, the readonly tier runs default mode with this
	// runtime-built --settings JSON (silent allow/deny rules + Bash hook)
	// instead of plan mode — plan's permission requests, once auto-rejected by
	// the ACP driver, cancel the whole turn. claude keeps plan.
	readonlySettings?: () => string,
): Adapter {
	return {
		id,
		bin,
		provider,
		useFor,
		defaultMode: yoloPermissionMode ? "yolo" : "readonly",
		maxMode: yoloPermissionMode ? "yolo" : "write",
		supportedEfforts,
		session,
		enforcesReadOnly: true,
		degraded,
		buildDispatch({ task, mode, model, effort }) {
			const argv = ["-p", task, "--output-format", outputFormat];
			// "plan" mode is enforced by the harness; it cannot write or run commands.
			// "acceptEdits" auto-approves file edits only. bypassPermissions (codebuddy)
			// runs everything — the codex danger-full-access analogue; verified headless
			// on 2.143.1 (Write executed without prompts, permission_denials empty).
			// codebuddy readonly overrides plan (readonlySettings set): default mode +
			// --settings deny rules refuse silently, so a readonly run neither prompts
			// nor dies on a permission request.
			const settingsJson = mode === "readonly" ? readonlySettings?.() : undefined;
			const permissionMode = settingsJson
				? "default"
				: mode === "readonly"
					? "plan"
					: mode === "write"
						? "acceptEdits"
						: (yoloPermissionMode ?? "acceptEdits");
			argv.push("--permission-mode", permissionMode);
			if (settingsJson) argv.push("--settings", settingsJson);
			if (model) argv.push("--model", model);
			if (effort) argv.push("--effort", effort);
			return {
				argv,
				promptArgIndex: 1,
				cwdForwardedToCli: false,
				effectivePolicy: settingsJson
					? "--permission-mode default --settings (allow/deny rules + PreToolUse Bash hook; denies are silent)"
					: `--permission-mode ${permissionMode}`,
				readOnlyEnforcement: mode === "readonly" ? "harness-enforced" : "not-applicable",
				model: model
					? { requested: model, forwarded: true, note: "Passed to the target CLI as --model." }
					: { forwarded: false, note: "No model override requested; target CLI/config selects the model." },
				effort: effortReceipt(effort, true, "Passed to the target CLI as --effort."),
			};
		},
		parseEvent: outputFormat === "stream-json" ? parseClaudeFamilyStreamLine : parseClaudeFamilyLine,
	};
}

// ---------------------------------------------------------------------------
// Kimi — stream-json execution workhorse; no read-only sandbox exists headless
// ---------------------------------------------------------------------------

const kimiAdapter: Adapter = {
	id: "kimi",
	bin: "kimi",
	provider: "Moonshot",
	useFor:
		"Execution workhorse like codex and pi: code writing and task execution. " +
		"yolo only — kimi-code 0.41.0 rejects every permission flag with -p, so a headless run " +
		"always executes under kimi's config permission mode. readonly/write requests are refused.",
	defaultMode: "yolo",
	maxMode: "yolo",
	// yolo-only by design (user decision 2026-09-07): kimi's headless surface has
	// exactly one real behavior — config default_permission_mode ("yolo" in
	// ~/.kimi-code/config.toml) governs everything, since -p rejects
	// --auto/--yolo/--plan outright. Any lower tier would be a label with no
	// enforcement behind it, so readonly/write are refused at dispatch instead.
	minMode: "yolo",
	enforcesReadOnly: false,
	buildDispatch({ task, model, effort }) {
		const argv = ["-p", task, "--output-format", "stream-json"];
		if (model) argv.push("--model", model);
		return {
			argv,
			promptArgIndex: 1,
			cwdForwardedToCli: false,
			effectivePolicy:
				`no permission flag exists for -p in kimi-code 0.41.0; config default_permission_mode ("yolo") applies`,
			readOnlyEnforcement: "not-applicable",
			model: model
				? {
					requested: model,
					forwarded: true,
					note: "Passed to kimi as --model (a model alias from config.toml; the flag exists since kimi-code 0.36.x).",
				}
				: { forwarded: false, note: "No model override requested; kimi's default_model in config.toml applies." },
			effort: effortReceipt(effort, false, "kimi has no reasoning-effort flag; refused upstream, nothing forwarded."),
		};
	},
	// stream-json in kimi-code 0.36.x emits OpenAI-style chat records, one per
	// line — this is NOT the Claude-Code-shaped format an earlier revision
	// parsed ({"type":"assistant","message":{"content":[blocks]}}), and the
	// old parser silently dropped every answer after the format changed:
	//   {"role":"meta","type":"system.version",...}          -> noise
	//   {"role":"assistant","tool_calls":[{"function":{name,arguments}}]} -> tool
	//   {"role":"tool","tool_call_id":...,"content":...}     -> tool result, noise
	//   {"role":"assistant","content":"<string>"}           -> the answer prose
	//   {"role":"meta","type":"session.resume_hint",...}      -> noise
	// Failures go to stderr as bare `error: ...` lines with a non-zero exit, so
	// stdout bare lines are tool-output echoes, never the answer; drop them.
	parseEvent(line) {
		let obj: any;
		try {
			obj = JSON.parse(line);
		} catch {
			const trimmed = line.trim();
			if (/^error:/i.test(trimmed)) return { kind: "error", text: trimmed };
			return null;
		}

		if (obj.role === "assistant") {
			if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
				const calls = obj.tool_calls
					.map((c: any) => `${c?.function?.name ?? "tool"} ${typeof c?.function?.arguments === "string" ? c.function.arguments : ""}`.trim())
					.join("; ");
				return { kind: "tool", text: calls.slice(0, 200) };
			}
			if (typeof obj.content === "string" && obj.content.trim()) {
				return { kind: "message", text: obj.content };
			}
			return null;
		}
		return null;
	},
};

// ---------------------------------------------------------------------------
// Reasonix — DeepSeek-native harness; eventwire JSONL on stdout via
// `run --output-format stream-json`, verified by hand on 2026-08-07 against
// reasonix v1.21.0:
//   reasonix run --output-format stream-json --dir <cwd> \
//     --permission-mode manual --effort low "<task>"
// Each line is one eventwire object ({"kind": ...}); the final line is the
// same result object as `-p --output-format json` ({type:"result", is_error,
// result, usage}). An earlier revision of this adapter used `-p --output-format
// json`, which emits ONLY that final object — the extension's status view had
// nothing to show mid-run. stream-json restores live tool/message/usage events.
//
// Configured provider: the multi-model gateway configured in pi, whose default model is
// og/deepseek-v4-flash; model_overrides in ~/.reasonix/config.toml select the
// per-model wire shape (deepseek for og/deepseek-*, glm for og/glm-5.1,
// vanilla OpenAI for dog/gpt-* and dog/grok-4.5). The adapter maps pi's
// effort scale onto the default model's declared DeepSeek vocabulary
// (disabled|low|high|max), so a request never hits reasonix's "not listed in
// supported_efforts" error:
//   off->disabled  minimal->low  low->low  medium->high  high->high
//   xhigh->max  max->max   (xhigh->max mirrors pi's own thinkingLevelMap for
//   this exact relay model)
//
// Permission mapping (headless approval resolution is documented in CLI.md):
//   readonly -> manual: no prompt exists headless, so writer fallback and
//             explicit ask decisions fail CLOSED; readers still run. That is
//             genuine harness-enforced read-only.
//   write    -> acceptEdits: file-edit tools allowed; other ask decisions
//             (including Bash) still fail closed.
//   yolo     -> bypassPermissions: ordinary calls run despite ask rules, but
//             configured deny rules and the OS sandbox (bash = "enforce" in
//             the default config) still apply — bounded yolo, not raw root.
// ---------------------------------------------------------------------------

const reasonixAdapter: Adapter = {
	id: "reasonix",
	bin: "reasonix",
	provider: "DeepSeek-native (esengine/deepseek-reasonix)",
	useFor:
		"Execution workhorse like codex and pi, running on a DeepSeek-native harness tuned for prefix-cache " +
		"stability. Default model is og/deepseek-v4-flash via the user's own relay; omit the model " +
		"parameter unless a different provider is genuinely needed. " +
		"yolo is bounded: deny rules and the OS bash sandbox still apply.",
	defaultMode: "yolo",
	maxMode: "yolo",
	supportedEfforts: EFFORT_LEVELS,
	// `reasonix --acp` (verified v1.38.1): initialize advertises
	// _meta["reasonix.io"].sessionSteer.method, which is the only supported
	// way to steer — never hardcode it. Note: the ACP entry point accepts
	// --model but neither --permission-mode nor --effort, so permissions are
	// answered over session/request_permission and effort cannot be forwarded.
	session: {
		steer: true,
		followUp: true,
		steerNote: "advertised sessionSteer method; steer_accepted injects at the next step boundary, queued_followup means it missed the turn",
	},
	enforcesReadOnly: true,
	buildDispatch({ task, cwd, mode, model, effort }) {
		const argv = ["run", "--output-format", "stream-json", "--dir", cwd];
		const permissionMode = mode === "readonly" ? "manual" : mode === "write" ? "acceptEdits" : "bypassPermissions";
		argv.push("--permission-mode", permissionMode);
		if (model) argv.push("--model", model);
		const mapped = effort ? reasonixEffortToken(effort) : undefined;
		if (mapped) argv.push("--effort", mapped);
		argv.push(task);
		return {
			argv,
			promptArgIndex: argv.length - 1,
			cwdForwardedToCli: true,
			effectivePolicy:
				`--permission-mode ${permissionMode}` +
				(mode === "yolo" ? " (deny rules and OS bash sandbox still apply)" : ""),
			readOnlyEnforcement: mode === "readonly" ? "harness-enforced" : "not-applicable",
			model: model
				? {
					requested: model,
					forwarded: true,
					note: "Passed as --model; accepts a configured provider name, a bare model id, or a provider/model reference.",
				}
				: { forwarded: false, note: "No model override requested; the configured default_model applies." },
			effort: effortReceipt(
				effort,
				true,
				effort
					? `Passed as --effort ${mapped} (mapped from "${effort}" onto the og relay's declared DeepSeek vocabulary disabled|low|high|max).`
					: "No effort override requested; the provider's default_effort (max) applies.",
			),
		};
	},
	parseEvent(line) {
		let obj: any;
		try {
			obj = JSON.parse(line);
		} catch {
			return null;
		}

		// Final result object — same contract as the claude family.
		if (obj.type === "result") {
			if (obj.is_error) return { kind: "error", text: String(obj.result ?? "unknown error") };
			return obj.result ? { kind: "message", text: String(obj.result) } : null;
		}

		switch (obj.kind) {
			case "message":
				// Finalized assistant turn segment: text is the prose, reasoning the
				// accumulated thinking. The standalone "text"/"reasoning" kinds are
				// per-token deltas of this same content — mapping them too would flood
				// the event log with single-token entries, so both are skipped.
				if (obj.text) return { kind: "message", text: obj.text };
				return obj.reasoning ? { kind: "reasoning", text: obj.reasoning } : null;
			case "tool_dispatch": {
				const t = obj.tool;
				// Each call dispatches twice: a partial stub first, the full args
				// (and diff) later. Only the finalized one carries signal.
				if (!t || t.partial) return null;
				return { kind: "tool", text: `${t.name ?? ""} ${String(t.args ?? "")}`.trim().slice(0, 200) };
			}
			case "tool_result": {
				// Successes are noise; a failed call is worth surfacing.
				const t = obj.tool;
				if (t?.err) return { kind: "warning", text: `${t.name ?? "tool"} failed: ${t.err}` };
				return null;
			}
			case "usage": {
				const u = obj.usage;
				if (!u) return null;
				return {
					kind: "usage",
					text: `in=${u.promptTokens ?? 0} out=${u.completionTokens ?? 0} cached=${u.cacheHitTokens ?? 0}`,
				};
			}
			case "retrying":
				return { kind: "warning", text: `retry ${obj.retryAttempt ?? "?"}/${obj.retryMax ?? "?"}` };
			case "notice":
				return obj.level === "warn" && obj.text ? { kind: "warning", text: obj.text } : null;
			default:
				// text/reasoning (per-token deltas — see "message"), turn_started,
				// stream_attempt, phase, tool_progress, turn_done, compaction_*,
				// approval/ask requests, extension surfaces: no signal.
				return null;
		}
	},
};

export function qoderPermissionArgs(mode: Mode): string[] {
	const permissionMode = mode === "readonly" ? "dont_ask" : mode === "write" ? "accept_edits" : "bypass_permissions";
	const argv = ["--permission-mode", permissionMode];
	if (mode === "readonly") {
		argv.push(
			"--tools",
			"Read,Grep,Glob,WebSearch,WebFetch",
			"--disallowed-tools",
			"mcp__*,Agent",
			"--strict-mcp-config",
			"--mcp-config",
			'{"mcpServers":{}}',
			"--settings",
			'{"disableAllHooks":true}',
		);
	}
	return argv;
}

function qoderEffectivePolicy(mode: Mode): string {
	if (mode === "readonly") {
		return "--permission-mode dont_ask (ask is denied) + --tools Read,Grep,Glob,WebSearch,WebFetch + --settings disableAllHooks; MCP servers disabled; Agent launches denied";
	}
	if (mode === "write") {
		return "--permission-mode accept_edits (in-directory edits auto-approved; every other permission request is refused, never auto-allowed); non-default modes require a trusted startup directory";
	}
	return "--permission-mode bypass_permissions (no sandbox); non-default modes require a trusted startup directory";
}

const qoderAdapter: Adapter = {
	id: "qoder",
	bin: "qodercli",
	provider: "Qoder (Alibaba)",
	useFor:
		"Full coding agent with a Claude-Code-compatible CLI surface. All tiers are open and yolo is the default, like codex; " +
		"readonly is harness-enforced through dont_ask plus a built-in tool allowlist. Reach for it when a third independent " +
		"executor or reviewer is useful, or when the user names Qoder.",
	defaultMode: "yolo",
	maxMode: "yolo",
	supportedEfforts: ["off", "low", "medium", "high", "xhigh", "max"],
	session: {
		steer: false,
		followUp: true,
		steerNote: "no mid-run steering: Qoder advertises promptQueueing, which proves queuing only, so a second prompt cannot be relied on to redirect the active turn",
	},
	sessionPolicy: qoderEffectivePolicy,
	enforcesReadOnly: true,
	buildDispatch({ task, mode, model, effort }) {
		const argv = ["-p", task, "--output-format", "stream-json", ...qoderPermissionArgs(mode)];
		if (model) argv.push("--model", model);
		if (effort) argv.push("--reasoning-effort", effort);
		return {
			argv,
			promptArgIndex: 1,
			cwdForwardedToCli: false,
			effectivePolicy: qoderEffectivePolicy(mode),
			readOnlyEnforcement: mode === "readonly" ? "harness-enforced" : "not-applicable",
			model: model
				? { requested: model, forwarded: true, note: "Passed to the target CLI as --model." }
				: { forwarded: false, note: "No model override requested; target CLI/config selects the model." },
			effort: effortReceipt(
				effort,
				true,
				"Passed to the target CLI as --reasoning-effort; Qoder's documented vocabulary is disabled|off|none|low|medium|high|xhigh|max (the extension's \"minimal\" is not offered).",
			),
		};
	},
	parseEvent: parseClaudeFamilyStreamLine,
};

// ---------------------------------------------------------------------------
// Pi — a child pi process; verified by hand on 2026-07-31 with a real
// `pi --mode json --no-session --no-extensions --tools read,grep,find,ls` run
// ---------------------------------------------------------------------------

/**
 * pi has no OS sandbox, so the permission tiers map onto its tool allowlist:
 *   readonly   -> --tools read,grep,find,ls (edit/write/bash are never registered;
 *                                          this is harness-level enforcement)
 *   write/yolo -> no --tools flag           (full built-in tools; write and yolo
 *                                          are equivalent because bash is unrestricted)
 * `--no-extensions` is not optional hygiene: without it the child loads this very
 * extension and could dispatch grandchildren.
 */
const piAdapter: Adapter = {
	id: "pi",
	bin: "pi",
	provider: "pi itself (child process)",
	useFor:
		"Execution workhorse like codex, with a fully configurable model: the model parameter is passed " +
		"to the child pi as --model (any provider/id from pi's own catalog, e.g. deepseek-v4-flash, with " +
		"optional :<thinking> suffix). Full built-in tools by default; pi has no sandbox, so write and yolo are equivalent.",
	defaultMode: "yolo",
	maxMode: "yolo",
	supportedEfforts: EFFORT_LEVELS,
	// `pi --mode rpc` (verified 0.85.1). The argv prompt is NOT executed in rpc
	// mode — the task must be sent as {"type":"prompt"} on stdin once the
	// process is up, which is also what makes a same-session follow-up possible.
	session: {
		steer: true,
		followUp: true,
		steerNote: "steer command; delivered after the current tool calls finish, before the next model call",
	},
	enforcesReadOnly: true,
	buildDispatch({ task, mode, model, effort }) {
		const argv = ["--mode", "json", "--no-session", "--no-extensions"];
		const readOnly = mode === "readonly";
		if (readOnly) argv.push("--tools", "read,grep,find,ls");
		if (model) argv.push("--model", model);
		if (effort) argv.push("--thinking", effort);
		argv.push(task);
		return {
			argv,
			promptArgIndex: argv.length - 1,
			cwdForwardedToCli: false,
			effectivePolicy: readOnly
				? "--tools read,grep,find,ls (edit/write/bash never registered)"
				: "full built-in tools; pi has no sandbox (write and yolo are equivalent)",
			readOnlyEnforcement: readOnly ? "harness-enforced" : "not-applicable",
			model: model
				? {
					requested: model,
					forwarded: true,
					note: "Passed to the child pi as --model; accepts provider/id patterns and a :<thinking> suffix.",
				}
				: { forwarded: false, note: "No model override requested; the child pi uses its configured default model." },
			effort: effortReceipt(
				effort,
				true,
				"Passed to the child pi as --thinking; if the model parameter also carries a :<thinking> suffix, both are forwarded and pi's CLI resolves precedence.",
			),
		};
	},
	parseEvent(line) {
		let obj: any;
		try {
			obj = JSON.parse(line);
		} catch {
			return null;
		}

		if (obj.type === "message_end" && obj.message?.role === "assistant") {
			const content = obj.message.content;
			if (!Array.isArray(content)) return null;
			const text = content
				.filter((b: any) => b?.type === "text")
				.map((b: any) => b.text)
				.join("\n");
			if (text) return { kind: "message", text };
			const thinking = content
				.filter((b: any) => b?.type === "thinking")
				.map((b: any) => b.thinking)
				.join("\n");
			return thinking ? { kind: "reasoning", text: thinking } : null;
		}
		if (obj.type === "tool_execution_start") {
			return { kind: "tool", text: `${obj.toolName} ${JSON.stringify(obj.args ?? "")}`.slice(0, 200) };
		}
		if (obj.type === "turn_end") {
			const u = obj.message?.usage;
			if (!u) return null;
			const where = obj.message?.provider && obj.message?.model ? ` (${obj.message.provider}/${obj.message.model})` : "";
			return {
				kind: "usage",
				text: `in=${u.input ?? 0} out=${u.output ?? 0} cached=${u.cacheRead ?? 0}${where}`,
			};
		}
		if (obj.type === "auto_retry_start") {
			return { kind: "warning", text: `retry ${obj.attempt}/${obj.maxAttempts}: ${obj.errorMessage ?? ""}`.trim() };
		}
		if (obj.type === "auto_retry_end" && obj.success === false) {
			return { kind: "error", text: obj.finalError ?? "retries exhausted" };
		}
		return null;
	},
};

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

export const ADAPTERS: Record<AgentId, Adapter> = {
	codex: codexFamily(
		"codex",
		"codex",
		"OpenAI",
		"Primary workhorse for code writing and task execution. Runs unsandboxed (yolo) by default, which real implementation work usually requires.",
		// `codex app-server` (experimental; verified 0.153.4) takes the same
		// ReasoningEffort vocabulary and also spells "off" as "none".
		{
			steer: true,
			followUp: true,
			steerNote: "turn/steer on the active turn; injected at the next model step boundary",
		},
	),
	pi: piAdapter,
	kimi: kimiAdapter,
	codebuddy: claudeFamily(
		"codebuddy",
		"codebuddy",
		"Tencent CodeBuddy",
		"Fast repository explorer that leans toward codebase understanding and locating feature modules, " +
			"but is a full execution agent too: all tiers open, yolo (bypassPermissions) by default like codex.",
		["minimal", "low", "medium", "high", "xhigh", "max"],
		// stream-json: the json format is pretty-printed multi-line and defeats
		// line-framed parsing (the lost-answer bug fixed on 2026-08-17).
		"stream-json",
		"bypassPermissions",
		undefined,
		// `codebuddy --acp` (verified 2.147.0): --permission-mode, --model and
		// --effort are all accepted alongside --acp. Steering is a second
		// session/prompt while the turn is active; it lands at the next model
		// step boundary, or becomes a follow-up if the turn is inside one long
		// tool call.
		{
			steer: true,
			followUp: true,
			steerNote: "second session/prompt on the active session; injected at the next model step boundary",
		},
		// Readonly maps to default mode + runtime-built --settings (silent deny
		// rules + Bash hook) instead of plan mode, whose auto-rejected permission
		// requests cancel an ACP turn outright.
		buildReadonlySettings,
	),
	claude: claudeFamily(
		"claude",
		"claude",
		"Anthropic via the gateway pi itself is configured with",
		"Analysis and planning only; shares pi's own gateway, so it offers no model diversity. Rarely useful.",
		["low", "medium", "high", "xhigh", "max"],
		"json",
	),
	reasonix: reasonixAdapter,
	qoder: qoderAdapter,
};

export const AGENT_IDS = Object.keys(ADAPTERS) as AgentId[];
