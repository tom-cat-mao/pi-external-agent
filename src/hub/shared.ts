/**
 * Vocabulary shared by every hub module: the task/dispatch types and receipt
 * shapes, the module-level constants that tune the hub, the pure formatting
 * helpers behind every report, and the predicates that guard untrusted input.
 *
 * Nothing here owns state or spawns anything — hub/registry.ts holds the task
 * registry, hub/reporting.ts renders caller-facing text, and hub/tools.ts is
 * the registered tool surface.
 */

import type { ChildProcess } from "node:child_process";
import {
	ADAPTERS,
	AGENT_IDS,
	EFFORT_LEVELS,
	type AdapterDispatch,
	type AgentEvent,
	type AgentId,
	type Effort,
	type Mode,
} from "../adapters.ts";
import type { StoredAnswer } from "../artifacts.ts";
import type { SessionDriver } from "../drivers/index.ts";

export type TaskState = "running" | "done" | "failed" | "stopped";
export type NotifyMode = "steer" | "followUp" | "nextTurn" | "off";
/**
 * oneshot: spawn, read stdout, process exit == completion (the original shape).
 * persistent: a long-lived JSON-RPC session; turn end == completion and the
 * process stays up so the same conversation can be steered or continued.
 */
export type Transport = "oneshot" | "persistent";

/**
 * A git worktree the hub created for one isolated task: a private checkout on
 * branch `ea-<taskId>`, based on the main repository at `base`. The hub only
 * creates these — it never merges and never deletes them — so `diffStat` is the
 * settle-time evidence of what was left behind.
 */
export interface WorktreeRef {
	path: string;
	branch: string;
	base: string;
}

export interface TaskWorktree extends WorktreeRef {
	/** Settle-time overview: `git diff --stat HEAD` tail + uncommitted/untracked count. */
	diffStat?: string;
}

export interface DispatchReceipt {
	version: 1;
	executable: string;
	argv: string[];
	promptArgIndex: number;
	prompt: string;
	cwd: string;
	cwdForwardedToCli: boolean;
	/** oneshot ignores stdin; persistent holds a live protocol channel on it. */
	stdin: "ignored" | "jsonrpc" | "stream-json";
	shell: false;
	agent: AgentId;
	provider: string;
	requestedMode: Mode;
	effectivePolicy: string | null;
	readOnlyEnforcement: AdapterDispatch["readOnlyEnforcement"];
	model: AdapterDispatch["model"];
	effort: AdapterDispatch["effort"];
	notify: NotifyMode;
	watchdogMs: number;
	environment: "inherited from Pi process; values hidden";
	/** Defaults to "oneshot" for receipts produced before persistent sessions existed. */
	transport?: Transport;
	/** Template applied to the task text, as `name@version`; absent when none was used. */
	template?: string;
	/** Present when the task runs in a hub-created worktree; the spawn cwd is its path. */
	worktree?: WorktreeRef;
}

export interface Task {
	id: string;
	agent: AgentId;
	task: string;
	cwd: string;
	mode: Mode;
	dispatch: DispatchReceipt;
	state: TaskState;
	/** oneshot only; persistent tasks own a SessionDriver instead. */
	proc: ChildProcess | null;
	transport: Transport;
	driver?: SessionDriver;
	/**
	 * Index into events where the current turn started. A follow-up reset it, so
	 * answerOf reports the latest turn while status can still show all events.
	 */
	answerStartIndex: number;
	/** False once the session process has been reclaimed (idle reap or kill). */
	sessionAlive: boolean;
	startedAt: number;
	endedAt?: number;
	/** Timestamp of the most recent parsed event; drives staleness reporting. */
	lastEventAt: number;
	/**
	 * Timestamp of the most recent message/reasoning/tool event. Usage/warning/
	 * error events move lastEventAt only: noise can flow while no progress does,
	 * which is the shape stallStruggling reads. Internal, like the samples below.
	 */
	lastMeaningfulEventAt: number;
	/** Ring of the last meaningful-event gaps (ms); their median is the task's own cadence. */
	meaningfulIntervals: number[];
	events: AgentEvent[];
	stderr: string;
	exitCode: number | null;
	spawnError?: string;
	/** How to notify the model when this task settles. */
	notify: NotifyMode;
	/** Guards against double-notifying, since close and error can both fire. */
	notified: boolean;
	/**
	 * Tokens of in-flight external_agent_wait calls watching this task. While the
	 * set is non-empty the settle notice is held back: the waiter's receipt is
	 * the delivery. settled + not notified is a task in this held state.
	 */
	waiters?: Set<symbol>;
	/** Stall watchdog: notify when quiet this long (ms). 0 disables. */
	watchdogMs: number;
	/** Last time a stall notice was sent; compared against lastEventAt to space repeats. */
	lastWatchdogNoticeAt: number;
	/** Consecutive stall notices sent during the current quiet streak. */
	watchdogNotices: number;
	/** Monotonic count of parsed events, so a wait can report activity inside its own window. */
	eventSeq: number;
	/** Per-turn archived answers, appended at each settle; recall pages from the last one. */
	archives?: StoredAnswer[];
	/** Set when archiving failed and the answer stayed inline (fail-open, never silent). */
	archiveError?: string;
	/** Acceptance command: caller-provided (verify param) beats worker-declared. */
	verifyCommand?: string;
	verifyTimeoutSeconds?: number;
	verifyResult?: VerifyResult;
	/** Template label (`name@version`) when a task template was applied. */
	templateLabel?: string;
	/** How far this session sits from the coordinator's own dispatch (relay hops). */
	relayDepth: number;
	/** Relay messages delivered into this session. */
	relaysReceived: number;
	/** Set while settle-time finalize (archive + verify) is in flight; awaited by reporters. */
	finalizePromise?: Promise<void>;
	/** Isolated task's worktree; the hub creates but never merges or deletes it. */
	worktree?: TaskWorktree;
	/** Present when this task's answer is appended to an evidence board at settle. */
	boardFile?: string;
	/** Set once the settle-time board row was appended. */
	boardWritten?: boolean;
	/** Board append failure, surfaced in the compare report (fail-open, never thrown). */
	boardError?: string;
	/** Neutral inventory of worktrees left on disk, captured at settle for the notification. */
	retainedWorktrees?: string;
	/** Idle reap: kills a persistent session that got no follow-up in time. */
	idleReapTimer?: ReturnType<typeof setTimeout>;
}

/** Post-settle acceptance run: mechanical facts only, never a verdict. */
export interface VerifyResult {
	command: string;
	exitCode: number | null;
	outputTail: string;
	durationMs: number;
	/** Present when the command never ran (host without pi.exec, readonly guard, …). */
	skipped?: string;
}

/** Optional dispatch extras: template label for the receipt, verify for settle-time acceptance. */
export interface DispatchExtras {
	templateLabel?: string;
	verifyCommand?: string;
	verifyTimeoutSeconds?: number;
	/**
	 * Id allocated before dispatch. Only isolate needs this: the worktree path is
	 * `<toplevel>/.external-agent/worktrees/<taskId>`, so the id must exist before
	 * the worker's cwd can. createTask still allocates on its own when absent.
	 */
	taskId?: string;
	/** Worktree this task was given (isolate); lands on the task and the receipt. */
	worktree?: TaskWorktree;
}

export interface TaskSnapshot {
	taskId: string;
	agent: AgentId;
	state: TaskState;
	cwd: string;
	notify: NotifyMode;
	startedAt: number;
	endedAt?: number;
	exitCode: number | null;
	spawnError?: string;
	dispatch: DispatchReceipt;
	transport: Transport;
	/** False once the session process is gone; follow-ups are refused then. */
	sessionAlive: boolean;
}

export type ExternalAgentStatusDetails =
	| { kind: "external-agent-status"; task: TaskSnapshot; requestedTail: number }
	| { kind: "external-agent-status-list"; tasks: TaskSnapshot[] }
	| Record<string, never>;

export type ExternalAgentStopDetails = { stopped: string[] } | { taskId: string; state: TaskState } | Record<string, never>;

/** Why a wait returned early: silence, or noise without progress. False when it did not. */
export type StallKind = "quiet" | "struggling";

export type ExternalAgentWaitDetails =
	| {
			kind: "external-agent-wait";
			timedOut: boolean;
			aborted: boolean;
			/** Truthy when the wait returned early because every watched task had stalled. */
			stalled: false | StallKind;
			tasks: TaskSnapshot[];
		}
	| Record<string, never>;

/**
 * One slot of a compare run, in request order. A refused spec never reaches
 * dispatch and therefore has no taskId/state; every other field mirrors what a
 * start receipt would have carried for that agent.
 */
export interface CompareResult {
	/** Position in the requested `agents` array, so results line up with inputs. */
	index: number;
	agent: string;
	refused: boolean;
	/** Refusal reason, or the failure detail of a dispatched task that did not answer. */
	reason?: string;
	taskId?: string;
	state?: TaskState;
	mode?: Mode;
	cwd?: string;
	/** Final answer text, trimmed like external_agent_wait does. */
	answer?: string;
	/** True when `answer` was cut at the preview bound. */
	answerTruncated?: boolean;
	/** The same honest-receipt payload a start call returns, for inspection. */
	dispatch?: DispatchReceipt;
}

export interface ExternalAgentCompareDetails {
	kind: "external-agent-compare";
	timedOut: boolean;
	aborted: boolean;
	results: CompareResult[];
}

export interface ExternalAgentSteerDetails {
	steered: boolean;
	taskId?: string;
	state?: TaskState;
	reason?: string;
	note?: string;
}

export interface ExternalAgentFollowUpDetails {
	continued: boolean;
	taskId?: string;
	state?: TaskState;
	sessionAlive?: boolean;
}

/** Why one worker's answer is being handed to another (the relay-envelope template's purposes). */
export type RelayPurpose = "reproduce" | "combine" | "challenge";

export interface ExternalAgentRelayDetails {
	kind: "external-agent-relay";
	relayed: boolean;
	fromTaskId?: string;
	taskId?: string;
	state?: TaskState;
	/** Why nothing was delivered. */
	reason?: string;
	/** Which channel the message actually went in by. */
	via?: "steer" | "followUp";
	purpose?: RelayPurpose;
	/** UTF-8 bytes of the excerpt that traveled. */
	bytes?: number;
	/** sha256 of that excerpt, lowercase hex. */
	sha256?: string;
	/** `path:line` references found inside the excerpt. */
	anchors?: string[];
	/** The target's hop depth once this message landed. */
	hop?: number;
	/** Archive handle the excerpt was read from, when the source answer was archived. */
	archiveId?: string;
	/** What the target CLI said about how it took the message. */
	note?: string;
}

export interface SharedTaskRegistry {
	tasks: Map<string, Task>;
	sequence: number;
	notifySettled?: (task: Task) => void;
	notifyWatchdog?: (task: Task, stall: StallKind) => void;
	/** Single shared watchdog interval; survives /reload like the task map itself. */
	watchdogTimer?: ReturnType<typeof setInterval>;
	pendingNotificationIds: Set<string>;
}
export const MAX_EVENTS = 400; // ring cap; oldest dropped
/** Answers longer than this are archived at settle and replaced by a handle + summary/excerpt. */
export const ARCHIVE_INLINE_CHARS = 4_000; // matches NOTIFY_PREVIEW_CHARS
export const MODE_RANK: Record<Mode, number> = { readonly: 0, write: 1, yolo: 2 };
export const MAX_ANSWER_CHARS = 50_000; // matches pi's own subagent cap
export const MAX_STDERR_CHARS = 8_000;
export const NOTIFY_PREVIEW_CHARS = 4_000; // completion callbacks stay small on purpose
export const DEFAULT_WATCHDOG_MS = 15 * 60_000; // stall notice after 15m quiet
export const WATCHDOG_SCAN_INTERVAL_MS = 30_000;
export const MAX_WATCHDOG_NOTICES = 3; // per stall streak (quiet or struggling); then it stays silent
/**
 * Adaptive silence threshold: 8× the task's median meaningful-event gap, held
 * between 3m and the user's watchdog. 8 tolerates one unusually long step; the
 * floor keeps a single long tool call from reading as a stall; 5 samples keep a
 * young task on its watchdog until its cadence is actually known.
 */
export const STALL_FACTOR = 8;
export const STALL_FLOOR_MS = 3 * 60_000;
export const STALL_SAMPLE_MIN = 5;
export const MEANINGFUL_INTERVAL_WINDOW = 16;
/**
 * Struggling: no message/reasoning/tool event for this long while warnings or
 * errors are still arriving is the retry-storm shape. Real reconnect loops
 * retry every 60–120s, so 5m tolerates 2–3 attempts before reporting.
 */
export const STRUGGLE_MS = 5 * 60_000;
export const WAIT_DEFAULT_TIMEOUT_S = 600;
export const WAIT_MAX_TIMEOUT_S = 3_600;
export const WAIT_ANSWER_PREVIEW_CHARS = 8_000;
/** Compare bounds: below two there is nothing to compare, and each spec costs a process. */
export const COMPARE_MIN_AGENTS = 2;
export const COMPARE_MAX_AGENTS = 8;
/**
 * Compare blocks inside the turn, so its cost to the caller is pure latency and
 * the scan is tighter than external_agent_wait's 2s one (that one is sized for a
 * 10-minute wait): a batch that settles in 200ms should not report at 2s.
 */
export const COMPARE_POLL_INTERVAL_MS = 500;
/**
 * How long a settled persistent session is kept alive for a follow-up. The
 * process is the conversation: once it is gone, a follow-up would be a cold
 * start with no context, so it is refused rather than silently degraded.
 */
export const IDLE_REAP_MS = 30 * 60_000;
/** Grace period for a protocol-level cancel before escalating to signals. */
export const CANCEL_ESCALATE_MS = 2_000;
/** Upper bound on anchors listed for one relay; the body stays the claim surface. */
export const RELAY_MAX_ANCHORS = 12;
/**
 * The stall clock. Thresholds run to minutes, so time is the one input a suite
 * cannot produce by waiting; tests replace now(), production only reads it.
 */
export const stallClock = { now: (): number => Date.now() };

/** The receipt's environment line: values are shown to exist, never transmitted. */
export const INHERITED_ENVIRONMENT_NOTICE = "inherited from Pi process; values hidden";
export function modeDisplay(mode: Mode): string {
	return mode === "readonly" ? "read-only" : mode.toUpperCase();
}

export function fmtDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

export function truncate(text: string, limit: number): { text: string; truncated: boolean } {
	if (text.length <= limit) return { text, truncated: false };
	return { text: `${text.slice(0, limit)}\n… [truncated ${text.length - limit} chars]`, truncated: true };
}

export function escapeTerminalControls(text: string): string {
	return text
		.replace(/\x1b/g, "\\x1B")
		.replace(/\t/g, "\\t")
		.replace(/\r/g, "\\r")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u0080-\u009f]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase()}`)
		.replace(/[\u202a-\u202e\u2066-\u2069]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}`);
}

export function quoteArg(arg: string): string {
	return JSON.stringify(escapeTerminalControls(arg));
}

export function modelDisplay(receipt: DispatchReceipt): string {
	if (receipt.model.forwarded) return `requested ${escapeTerminalControls(receipt.model.requested ?? "(unknown)")}; forwarded`;
	if (receipt.model.requested) return `requested ${escapeTerminalControls(receipt.model.requested)}; not forwarded`;
	return "not requested; target CLI/config selects it";
}

export function effortDisplay(receipt: DispatchReceipt): string {
	if (receipt.effort.forwarded) return `requested ${escapeTerminalControls(receipt.effort.requested ?? "(unknown)")}; forwarded`;
	if (receipt.effort.requested) return `requested ${escapeTerminalControls(receipt.effort.requested)}; not forwarded`;
	return "not requested; target CLI/config default applies";
}

export function enforcementDisplay(receipt: DispatchReceipt): string {
	switch (receipt.readOnlyEnforcement) {
		case "harness-enforced":
			return "harness-enforced";
		case "driver-enforced":
			return "driver-enforced (can_use_tool deny)";
		case "not-enforced":
			return "NOT enforced by target harness";
		default:
			return "not applicable (write/yolo mode)";
	}
}

/**
 * Readonly enforcement on the persistent path. Drivers that hand the tier to
 * the target harness (sandbox, tool allowlist, settings rules) report
 * harness-enforced; claude's stream-json driver answers can_use_tool with a
 * deny itself, so its receipt says driver-enforced rather than claiming a
 * harness boundary that does not exist.
 */
export function sessionReadOnlyEnforcement(agent: AgentId, mode: Mode): AdapterDispatch["readOnlyEnforcement"] {
	if (mode !== "readonly") return "not-applicable";
	return ADAPTERS[agent].driverEnforcedReadOnly ? "driver-enforced" : "harness-enforced";
}
export function freezeDispatchReceipt(receipt: DispatchReceipt): DispatchReceipt {
	return Object.freeze({
		...receipt,
		argv: Object.freeze([...receipt.argv]) as unknown as string[],
		model: Object.freeze({ ...receipt.model }) as AdapterDispatch["model"],
		effort: Object.freeze({ ...receipt.effort }) as AdapterDispatch["effort"],
	}) as DispatchReceipt;
}

export function copyDispatchReceipt(receipt: DispatchReceipt): DispatchReceipt {
	return {
		...receipt,
		argv: [...receipt.argv],
		model: { ...receipt.model },
		effort: { ...receipt.effort },
	};
}

export function dispatchSummary(receipt: DispatchReceipt, taskId?: string): string[] {
	const persistent = receipt.transport === "persistent";
	const canSteer = ADAPTERS[receipt.agent]?.session?.steer === true;
	const steeringSupport = receipt.agent === "qoder"
		? "follow-up; steering subject to CLI compatibility"
		: canSteer ? "steer + follow-up" : "follow-up only";
	const lines = [
		`provider: ${escapeTerminalControls(receipt.provider)}`,
		`transport: ${persistent ? `persistent session (${steeringSupport})` : "one-shot process"}`,
		`requested mode: ${receipt.requestedMode}`,
		`effective policy: ${receipt.effectivePolicy === null ? "none" : escapeTerminalControls(receipt.effectivePolicy)}`,
		`readonly: ${enforcementDisplay(receipt)}`,
		`spawn cwd: ${escapeTerminalControls(receipt.cwd)}`,
		...(receipt.worktree
			? [`worktree: ${escapeTerminalControls(receipt.worktree.path)} (branch ${escapeTerminalControls(receipt.worktree.branch)}; base ${escapeTerminalControls(receipt.worktree.base)})`]
			: []),
		`model: ${modelDisplay(receipt)}`,
		`effort: ${effortDisplay(receipt)}`,
		`notify: ${receipt.notify} (Pi-only; not sent to the target CLI)`,
		// notify "off" means no stall notice will be delivered — the receipt must not
		// claim otherwise. The quiet clock itself still runs: a blocking wait reads it.
		receipt.notify === "off"
			? "watchdog: not delivered (notify off; a blocking wait still returns early when quiet)"
			: `watchdog: ${receipt.watchdogMs > 0 ? `stall notice after ${fmtDuration(receipt.watchdogMs)} quiet` : "disabled"} (Pi-only)`,
		`environment: ${escapeTerminalControls(receipt.environment)}`,
		persistent
			? `stdio: stdin ${receipt.stdin} (bidirectional session); stdout/stderr piped; prompt sent over the protocol`
			: `stdio: stdin ${receipt.stdin}; stdout/stderr piped; shell ${receipt.shell ? "true" : "false"}`,
	];
	if (taskId) lines.unshift(`task id: ${escapeTerminalControls(taskId)}`);
	return lines;
}

export function taskSnapshot(task: Task): TaskSnapshot {
	return {
		taskId: task.id,
		agent: task.agent,
		state: task.state,
		cwd: task.cwd,
		notify: task.notify,
		startedAt: task.startedAt,
		endedAt: task.endedAt,
		exitCode: task.exitCode,
		spawnError: task.spawnError,
		dispatch: copyDispatchReceipt(task.dispatch),
		transport: task.transport,
		sessionAlive: task.sessionAlive,
	};
}

/** Collected model prose from the current turn, which is what the caller wants back. */
export function answerOf(task: Task): string {
	return task.events
		.slice(task.answerStartIndex)
		.filter((e) => e.kind === "message")
		.map((e) => e.text)
		.join("\n")
		.trim();
}

/** Every answer this task produced, across all of its turns. */
export function allAnswersOf(task: Task): string {
	return task.events
		.filter((e) => e.kind === "message")
		.map((e) => e.text)
		.join("\n")
		.trim();
}

export function errorsOf(task: Task): string {
	return task.events
		.filter((e) => e.kind === "error")
		.map((e) => e.text)
		.join("; ");
}

export function warningsOf(task: Task): string {
	return task.events
		.filter((e) => e.kind === "warning")
		.map((e) => e.text)
		.join("; ");
}

export function usageOf(task: Task): string | undefined {
	const u = task.events.filter((e) => e.kind === "usage");
	return u.length > 0 ? u[u.length - 1].text : undefined;
}

/** One-line status suitable for both TUI streaming and model consumption. */
export function summarize(task: Task): string {
	const now = stallClock.now();
	const elapsed = fmtDuration((task.endedAt ?? now) - task.startedAt);
	const parts = [`[${task.id}] ${task.state} · ${elapsed}`];

	if (task.state === "running") {
		const stale = now - task.lastEventAt;
		// Staleness is the signal the model uses to judge "stuck", so always report it.
		parts.push(`quiet for ${fmtDuration(stale)}`);
	}
	const usage = usageOf(task);
	if (usage) parts.push(usage);
	return parts.join(" · ");
}
export function isMode(value: unknown): value is Mode {
	return value === "readonly" || value === "write" || value === "yolo";
}

export function isNotifyMode(value: unknown): value is NotifyMode {
	return value === "steer" || value === "followUp" || value === "nextTurn" || value === "off";
}

export function isEffort(value: unknown): value is Effort {
	return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

export function isTaskState(value: unknown): value is TaskState {
	return value === "running" || value === "done" || value === "failed" || value === "stopped";
}

export function isTransport(value: unknown): value is Transport {
	return value === "oneshot" || value === "persistent";
}

export function isDispatchReceipt(value: unknown): value is DispatchReceipt {
	if (!value || typeof value !== "object") return false;
	const receipt = value as Partial<DispatchReceipt>;
	// A persistent receipt describes a session startup command: the prompt is
	// delivered over the protocol, so there is no prompt index into argv.
	const persistent = receipt.transport === "persistent";
	if (receipt.transport !== undefined && !isTransport(receipt.transport)) return false;
	return (
		receipt.version === 1 &&
		typeof receipt.executable === "string" &&
		Array.isArray(receipt.argv) &&
		receipt.argv.every((arg) => typeof arg === "string") &&
		typeof receipt.prompt === "string" &&
		typeof receipt.cwd === "string" &&
		typeof receipt.cwdForwardedToCli === "boolean" &&
		(receipt.stdin === "ignored" || receipt.stdin === "jsonrpc" || receipt.stdin === "stream-json") &&
		receipt.shell === false &&
		typeof receipt.provider === "string" &&
		typeof receipt.promptArgIndex === "number" &&
		Number.isInteger(receipt.promptArgIndex) &&
		(persistent
			? receipt.promptArgIndex === -1
			: receipt.promptArgIndex >= 0 &&
				receipt.promptArgIndex < receipt.argv.length &&
				receipt.argv[receipt.promptArgIndex] === receipt.prompt) &&
		AGENT_IDS.includes(receipt.agent as AgentId) &&
		isMode(receipt.requestedMode) &&
		(receipt.effectivePolicy === null || typeof receipt.effectivePolicy === "string") &&
		(receipt.readOnlyEnforcement === "harness-enforced" ||
			receipt.readOnlyEnforcement === "driver-enforced" ||
			receipt.readOnlyEnforcement === "not-enforced" ||
			receipt.readOnlyEnforcement === "not-applicable") &&
		!!receipt.model &&
		typeof receipt.model === "object" &&
		typeof receipt.model.forwarded === "boolean" &&
		typeof receipt.model.note === "string" &&
		(receipt.model.requested === undefined || typeof receipt.model.requested === "string") &&
		isNotifyMode(receipt.notify) &&
		receipt.environment === INHERITED_ENVIRONMENT_NOTICE
	);
}

export function isTaskSnapshot(value: unknown): value is TaskSnapshot {
	if (!value || typeof value !== "object") return false;
	const snapshot = value as Partial<TaskSnapshot>;
	return (
		typeof snapshot.taskId === "string" &&
		typeof snapshot.agent === "string" &&
		isTaskState(snapshot.state) &&
		typeof snapshot.cwd === "string" &&
		isNotifyMode(snapshot.notify) &&
		typeof snapshot.startedAt === "number" &&
		(snapshot.endedAt === undefined || typeof snapshot.endedAt === "number") &&
		(snapshot.exitCode === null || typeof snapshot.exitCode === "number") &&
		(snapshot.spawnError === undefined || typeof snapshot.spawnError === "string") &&
		(snapshot.transport === undefined || isTransport(snapshot.transport)) &&
		(snapshot.sessionAlive === undefined || typeof snapshot.sessionAlive === "boolean") &&
		isDispatchReceipt(snapshot.dispatch)
	);
}

export function taskPromptPreview(prompt: string, limit = 96): string {
	const oneLine = escapeTerminalControls(prompt).replace(/\n/g, " ↵ ").trim();
	return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine || "(empty task)";
}
/** `path:line` and `path:start-end` references inside an excerpt, deduped and capped. */
export function anchorRefs(text: string): string[] {
	const found = text.match(/[\w./-]+\.[A-Za-z0-9]+:\d+(?:-\d+)?/g) ?? [];
	return [...new Set(found)].slice(0, RELAY_MAX_ANCHORS);
}
