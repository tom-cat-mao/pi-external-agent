/**
 * External Agent Hub: lets pi dispatch work to other coding agent CLIs installed on
 * this machine and monitor them while they run.
 *
 * 1. No wall-clock kill. Tasks run in the background until they finish, the model
 *    stops them, or the session ends; the stall watchdog (15m quiet) reports in and
 *    the model decides whether to stop. Waiting is turn-end plus settle/stall
 *    notifications, blocking external_agent_wait, or external_agent_compare
 *    (side by side, no judging). Why: .agents/notes/implemented/2026-08-17-no-wall-clock-timeout.md
 *
 * 2. Permission tiers are enforced by the target harness, never by a prompt
 *    request, and defaults are per-adapter: codex/pi/kimi/codebuddy/reasonix/qoder
 *    yolo, claude readonly. kimi is yolo-only (headless mode rejects permission
 *    flags), so readonly/write are refused; concurrent write/yolo tasks in the same
 *    directory are refused outright. Why: .agents/notes/implemented/2026-09-07-kimi-yolo-only.md
 *
 * 3. One tool surface: `agent` is an enum rather than one tool per CLI, because
 *    tool descriptions cost context in every request.
 *    Why: .agents/notes/implemented/2026-08-17-single-tool-surface.md
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { type AgentToolResult, type ExtensionAPI, keyHint } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	ADAPTERS,
	AGENT_IDS,
	EFFORT_LEVELS,
	type AdapterDispatch,
	type AgentEvent,
	type AgentId,
	type Effort,
	type Mode,
} from "./adapters.ts";
import {
	FOLLOWUP_AGENT_IDS,
	SESSION_DRIVERS,
	STEER_AGENT_IDS,
	hasSessionDriver,
	type SessionDriver,
	type SteerResult,
} from "./sessions.ts";
import { ensureStored, extractSummary, placeholderFor, readChunk, type StoredAnswer } from "./artifacts.ts";
import { createMeter, type MeterSnapshot, type UsageSample } from "./meter.ts";
import { applyTemplate, loadTemplate } from "./templates.ts";

// ---------------------------------------------------------------------------
// Task registry
// ---------------------------------------------------------------------------

type TaskState = "running" | "done" | "failed" | "stopped";
type NotifyMode = "steer" | "followUp" | "nextTurn" | "off";
/**
 * oneshot: spawn, read stdout, process exit == completion (the original shape).
 * persistent: a long-lived JSON-RPC session; turn end == completion and the
 * process stays up so the same conversation can be steered or continued.
 */
type Transport = "oneshot" | "persistent";

/**
 * A git worktree the hub created for one isolated task: a private checkout on
 * branch `ea-<taskId>`, based on the main repository at `base`. The hub only
 * creates these — it never merges and never deletes them — so `diffStat` is the
 * settle-time evidence of what was left behind.
 */
interface WorktreeRef {
	path: string;
	branch: string;
	base: string;
}

interface TaskWorktree extends WorktreeRef {
	/** Settle-time overview: `git diff --stat HEAD` tail + uncommitted/untracked count. */
	diffStat?: string;
}

interface DispatchReceipt {
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

interface Task {
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
interface VerifyResult {
	command: string;
	exitCode: number | null;
	outputTail: string;
	durationMs: number;
	/** Present when the command never ran (host without pi.exec, readonly guard, …). */
	skipped?: string;
}

/** Optional dispatch extras: template label for the receipt, verify for settle-time acceptance. */
interface DispatchExtras {
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

interface TaskSnapshot {
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

type ExternalAgentStatusDetails =
	| { kind: "external-agent-status"; task: TaskSnapshot; requestedTail: number }
	| { kind: "external-agent-status-list"; tasks: TaskSnapshot[] }
	| Record<string, never>;

type ExternalAgentStopDetails = { stopped: string[] } | { taskId: string; state: TaskState } | Record<string, never>;

/** Why a wait returned early: silence, or noise without progress. False when it did not. */
type StallKind = "quiet" | "struggling";

type ExternalAgentWaitDetails =
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
interface CompareResult {
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

interface ExternalAgentCompareDetails {
	kind: "external-agent-compare";
	timedOut: boolean;
	aborted: boolean;
	results: CompareResult[];
}

interface ExternalAgentSteerDetails {
	steered: boolean;
	taskId?: string;
	state?: TaskState;
	reason?: string;
	note?: string;
}

interface ExternalAgentFollowUpDetails {
	continued: boolean;
	taskId?: string;
	state?: TaskState;
	sessionAlive?: boolean;
}

/** Why one worker's answer is being handed to another (the relay-envelope template's purposes). */
type RelayPurpose = "reproduce" | "combine" | "challenge";

interface ExternalAgentRelayDetails {
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

interface SharedTaskRegistry {
	tasks: Map<string, Task>;
	sequence: number;
	notifySettled?: (task: Task) => void;
	notifyWatchdog?: (task: Task, stall: StallKind) => void;
	/** Single shared watchdog interval; survives /reload like the task map itself. */
	watchdogTimer?: ReturnType<typeof setInterval>;
	pendingNotificationIds: Set<string>;
}

const TASK_REGISTRY_KEY = Symbol.for("pi.external-agent.task-registry.v1");
const INHERITED_ENVIRONMENT_NOTICE = "inherited from Pi process; values hidden";

function getTaskRegistry(): SharedTaskRegistry {
	const existing = Reflect.get(globalThis, TASK_REGISTRY_KEY) as Partial<SharedTaskRegistry> | undefined;
	if (existing) {
		if (!(existing.tasks instanceof Map)) existing.tasks = new Map();
		if (!Number.isInteger(existing.sequence) || (existing.sequence ?? 0) < 0) existing.sequence = 0;
		if (!(existing.pendingNotificationIds instanceof Set)) existing.pendingNotificationIds = new Set();
		// /reload carries live tasks across module instances, so a task created by
		// an older build lacks the stall fields; undefined would crash the scanner
		// (a median needs an array) on the first tick after a reload.
		for (const task of existing.tasks.values()) {
			if (typeof task.lastMeaningfulEventAt !== "number") task.lastMeaningfulEventAt = task.lastEventAt;
			if (!Array.isArray(task.meaningfulIntervals)) task.meaningfulIntervals = [];
		}
		return existing as SharedTaskRegistry;
	}
	const created: SharedTaskRegistry = { tasks: new Map(), sequence: 0, pendingNotificationIds: new Set() };
	Reflect.set(globalThis, TASK_REGISTRY_KEY, created);
	return created;
}

const taskRegistry = getTaskRegistry();
const tasks = taskRegistry.tasks;

/** CLI-reported usage/cost accounting; "as reported by the target CLI", never billing. */
const meter = createMeter();

/**
 * Host capabilities the module-level settle paths cannot see on their own: the
 * session directory (archive root) and pi.exec (verify runs). Captured by the
 * factory from tool ctx / the pi object; absent in tests and ephemeral sessions,
 * where both mechanisms stay off (fail-open).
 */
const finalizeHooks: {
	sessionDir?: string;
	exec?: (command: string, args: string[], options: { cwd: string; timeout: number }) => Promise<{ stdout: string; stderr: string; code: number }>;
} = {};

/** Feed every parsed usage/cost event into the meter, regardless of event kind. */
function meterUsageEvent(taskId: string, event: AgentEvent): void {
	const sample: UsageSample = { source: "cli-reported" };
	if (event.usage) {
		sample.in = event.usage.in;
		sample.out = event.usage.out;
		sample.cached = event.usage.cached;
	}
	if (typeof event.costUsd === "number") sample.costUsd = event.costUsd;
	if (sample.in === undefined && sample.out === undefined && sample.cached === undefined && sample.costUsd === undefined) return;
	meter.record(taskId, sample);
}

const MAX_EVENTS = 400; // ring cap; oldest dropped
/** Answers longer than this are archived at settle and replaced by a handle + summary/excerpt. */
const ARCHIVE_INLINE_CHARS = 4_000; // matches NOTIFY_PREVIEW_CHARS
const MODE_RANK: Record<Mode, number> = { readonly: 0, write: 1, yolo: 2 };
const MAX_ANSWER_CHARS = 50_000; // matches pi's own subagent cap
const MAX_STDERR_CHARS = 8_000;
const NOTIFY_PREVIEW_CHARS = 4_000; // completion callbacks stay small on purpose
const DEFAULT_WATCHDOG_MS = 15 * 60_000; // stall notice after 15m quiet
const WATCHDOG_SCAN_INTERVAL_MS = 30_000;
const MAX_WATCHDOG_NOTICES = 3; // per stall streak (quiet or struggling); then it stays silent
/**
 * Adaptive silence threshold: 8× the task's median meaningful-event gap, held
 * between 3m and the user's watchdog. 8 tolerates one unusually long step; the
 * floor keeps a single long tool call from reading as a stall; 5 samples keep a
 * young task on its watchdog until its cadence is actually known.
 */
const STALL_FACTOR = 8;
const STALL_FLOOR_MS = 3 * 60_000;
const STALL_SAMPLE_MIN = 5;
const MEANINGFUL_INTERVAL_WINDOW = 16;
/**
 * Struggling: no message/reasoning/tool event for this long while warnings or
 * errors are still arriving is the retry-storm shape. Real reconnect loops
 * retry every 60–120s, so 5m tolerates 2–3 attempts before reporting.
 */
const STRUGGLE_MS = 5 * 60_000;
const WAIT_DEFAULT_TIMEOUT_S = 600;
const WAIT_MAX_TIMEOUT_S = 3_600;
const WAIT_ANSWER_PREVIEW_CHARS = 8_000;
/** Compare bounds: below two there is nothing to compare, and each spec costs a process. */
const COMPARE_MIN_AGENTS = 2;
const COMPARE_MAX_AGENTS = 8;
/**
 * Compare blocks inside the turn, so its cost to the caller is pure latency and
 * the scan is tighter than external_agent_wait's 2s one (that one is sized for a
 * 10-minute wait): a batch that settles in 200ms should not report at 2s.
 */
const COMPARE_POLL_INTERVAL_MS = 500;
/**
 * How long a settled persistent session is kept alive for a follow-up. The
 * process is the conversation: once it is gone, a follow-up would be a cold
 * start with no context, so it is refused rather than silently degraded.
 */
const IDLE_REAP_MS = 30 * 60_000;
/** Grace period for a protocol-level cancel before escalating to signals. */
const CANCEL_ESCALATE_MS = 2_000;

function nextId(agent: AgentId): string {
	taskRegistry.sequence += 1;
	return `${agent}-${taskRegistry.sequence}`;
}

function modeDisplay(mode: Mode): string {
	return mode === "readonly" ? "read-only" : mode.toUpperCase();
}

function fmtDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
	if (text.length <= limit) return { text, truncated: false };
	return { text: `${text.slice(0, limit)}\n… [truncated ${text.length - limit} chars]`, truncated: true };
}

function escapeTerminalControls(text: string): string {
	return text
		.replace(/\x1b/g, "\\x1B")
		.replace(/\t/g, "\\t")
		.replace(/\r/g, "\\r")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u0080-\u009f]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase()}`)
		.replace(/[\u202a-\u202e\u2066-\u2069]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}`);
}

function quoteArg(arg: string): string {
	return JSON.stringify(escapeTerminalControls(arg));
}

function modelDisplay(receipt: DispatchReceipt): string {
	if (receipt.model.forwarded) return `requested ${escapeTerminalControls(receipt.model.requested ?? "(unknown)")}; forwarded`;
	if (receipt.model.requested) return `requested ${escapeTerminalControls(receipt.model.requested)}; not forwarded`;
	return "not requested; target CLI/config selects it";
}

function effortDisplay(receipt: DispatchReceipt): string {
	if (receipt.effort.forwarded) return `requested ${escapeTerminalControls(receipt.effort.requested ?? "(unknown)")}; forwarded`;
	if (receipt.effort.requested) return `requested ${escapeTerminalControls(receipt.effort.requested)}; not forwarded`;
	return "not requested; target CLI/config default applies";
}

function enforcementDisplay(receipt: DispatchReceipt): string {
	switch (receipt.readOnlyEnforcement) {
		case "harness-enforced":
			return "harness-enforced";
		case "not-enforced":
			return "NOT enforced by target harness";
		default:
			return "not applicable (write/yolo mode)";
	}
}

function freezeDispatchReceipt(receipt: DispatchReceipt): DispatchReceipt {
	return Object.freeze({
		...receipt,
		argv: Object.freeze([...receipt.argv]) as unknown as string[],
		model: Object.freeze({ ...receipt.model }) as AdapterDispatch["model"],
		effort: Object.freeze({ ...receipt.effort }) as AdapterDispatch["effort"],
	}) as DispatchReceipt;
}

function copyDispatchReceipt(receipt: DispatchReceipt): DispatchReceipt {
	return {
		...receipt,
		argv: [...receipt.argv],
		model: { ...receipt.model },
		effort: { ...receipt.effort },
	};
}

function dispatchSummary(receipt: DispatchReceipt, taskId?: string): string[] {
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

function taskSnapshot(task: Task): TaskSnapshot {
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
function answerOf(task: Task): string {
	return task.events
		.slice(task.answerStartIndex)
		.filter((e) => e.kind === "message")
		.map((e) => e.text)
		.join("\n")
		.trim();
}

/** Every answer this task produced, across all of its turns. */
function allAnswersOf(task: Task): string {
	return task.events
		.filter((e) => e.kind === "message")
		.map((e) => e.text)
		.join("\n")
		.trim();
}

function errorsOf(task: Task): string {
	return task.events
		.filter((e) => e.kind === "error")
		.map((e) => e.text)
		.join("; ");
}

function warningsOf(task: Task): string {
	return task.events
		.filter((e) => e.kind === "warning")
		.map((e) => e.text)
		.join("; ");
}

function usageOf(task: Task): string | undefined {
	const u = task.events.filter((e) => e.kind === "usage");
	return u.length > 0 ? u[u.length - 1].text : undefined;
}

/** One-line status suitable for both TUI streaming and model consumption. */
function summarize(task: Task): string {
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

// ---------------------------------------------------------------------------
// Completion callback
// ---------------------------------------------------------------------------

/**
 * Push a completion notice back into the session when a task settles.
 *
 * Without this, a task started near the end of a turn would finish silently and
 * its answer would sit unread until something happened to poll it. The callback
 * is what makes fire-and-continue usable: dispatch several agents, keep working,
 * get interrupted as each one lands.
 *
 * The notice carries the state and a short answer preview, not the full output,
 * so a long answer cannot blow up the context uninvited. Full text stays
 * available through external_agent_status.
 */
// ---------------------------------------------------------------------------
// Settle finalize: archive + verify (fail-open, mechanical only)
// ---------------------------------------------------------------------------

/**
 * The verify-report template's closing section; the first line (or first fenced
 * block) is the suggested acceptance command.
 */
function parseSuggestedVerifyCommand(answer: string): string | undefined {
	const match = /##\s*Suggested verify command\s*\n([\s\S]*?)(?:\n##\s|$)/i.exec(answer);
	const body = match?.[1]?.trim();
	if (!body) return undefined;
	const fenced = /```(?:bash|sh)?\s*\n([\s\S]*?)```/.exec(body);
	const command = (fenced ? fenced[1] : body).trim().split("\n")[0]?.trim();
	return command || undefined;
}

/**
 * Archive the settled answer when it is long or follows the Summary/Details
 * template structure. Fail-open: no session dir or a write error leaves the
 * answer inline (archiveError recorded), because losing the answer is worse
 * than replaying it.
 */
async function archiveTaskAnswer(task: Task): Promise<void> {
	const answer = answerOf(task);
	if (!answer) return;
	const summary = extractSummary(answer);
	if (answer.length <= ARCHIVE_INLINE_CHARS && summary === undefined) return;
	if (!finalizeHooks.sessionDir) return;
	try {
		const stored = await ensureStored(
			join(finalizeHooks.sessionDir, "external-agent"),
			task.id,
			task.archives?.length ?? 0,
			answer,
		);
		(task.archives ??= []).push(stored);
	} catch (err) {
		task.archiveError = err instanceof Error ? err.message : String(err);
	}
}

/**
 * Run the acceptance command after settle. The caller's verify param wins; a
 * worker-declared command (verify-report template) is the fallback and is never
 * executed for readonly tasks — a read-only worker must not gain execution
 * through its answer text. The result is mechanical (exit code, output tail);
 * what it means is the caller's judgment.
 */
async function maybeRunVerify(task: Task): Promise<void> {
	let command = task.verifyCommand;
	let declaredByWorker = false;
	if (!command) {
		command = parseSuggestedVerifyCommand(answerOf(task));
		declaredByWorker = command !== undefined;
		if (command) task.verifyCommand = command;
	}
	if (!command) return;
	if (declaredByWorker && task.mode === "readonly") {
		task.verifyResult = {
			command,
			exitCode: null,
			outputTail: "",
			durationMs: 0,
			skipped: "worker-declared commands are not executed for readonly tasks",
		};
		return;
	}
	if (!finalizeHooks.exec) {
		task.verifyResult = { command, exitCode: null, outputTail: "", durationMs: 0, skipped: "pi.exec unavailable in this host" };
		return;
	}
	const started = Date.now();
	try {
		const result = await finalizeHooks.exec("bash", ["-lc", command], {
			cwd: task.cwd,
			timeout: (task.verifyTimeoutSeconds ?? 120) * 1000,
		});
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		task.verifyResult = {
			command,
			exitCode: result.code,
			outputTail: truncate(output.trim(), 1_500).text,
			durationMs: Date.now() - started,
		};
	} catch (err) {
		task.verifyResult = {
			command,
			exitCode: null,
			outputTail: "",
			durationMs: Date.now() - started,
			skipped: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Free mechanical facts about an isolated task's worktree, collected at settle:
 * a bounded tail of `git diff --stat HEAD` plus the number of `git status
 * --porcelain` lines (uncommitted and untracked together). The hub never merges,
 * so this is the only place the worker's leftovers become visible.
 */
async function collectWorktreeDiff(task: Task): Promise<void> {
	const worktree = task.worktree;
	if (!worktree) return;
	try {
		const [diff, status] = await Promise.all([
			runGit(["-C", worktree.path, "diff", "--stat", "HEAD"]),
			runGit(["-C", worktree.path, "status", "--porcelain"]),
		]);
		const statLines = diff.stdout.trim().split("\n").filter(Boolean);
		const statTail = statLines.length > 0 ? statLines.slice(-3).join(" · ") : "no diff";
		const statusLines = status.stdout.trim() ? status.stdout.trim().split("\n").length : 0;
		worktree.diffStat = escapeTerminalControls(`${statTail} · ${statusLines} uncommitted/untracked`);
	} catch {
		// The worktree may have been removed by hand between settle and this read;
		// an absent diff is not worth an error line.
	}
}

/** sha256 of UTF-8 text, lowercase hex. */
function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Append one row of settled evidence to the board. One claim per settled slot,
 * anchors extracted the same way relay extracts them, hash and archive handle
 * carried so later readers can re-check the text. Fail-open: a write error is
 * recorded on the task and surfaced in the compare report, never thrown — the
 * answer itself is already safe in the archive.
 */
async function appendBoardEntry(task: Task): Promise<void> {
	if (!task.boardFile || task.state !== "done") return;
	const answer = answerOf(task);
	if (!answer) return;
	const archived = task.archives?.[task.archives.length - 1];
	const row = {
		ts: new Date().toISOString(),
		taskId: task.id,
		agent: task.agent,
		mode: task.mode,
		claim: extractSummary(answer) ?? answer.slice(0, 200),
		anchors: anchorRefs(answer),
		answerRef: archived?.id ?? "inline",
		answerSha256: archived?.sha256 ?? sha256Hex(answer),
		status: "unverified",
		supersedes: null,
	};
	try {
		await mkdir(dirname(task.boardFile), { recursive: true });
		await appendFile(task.boardFile, `${JSON.stringify(row)}\n`, "utf8");
		task.boardWritten = true;
	} catch (err) {
		task.boardError = err instanceof Error ? err.message : String(err);
	}
}

/** Settle-time finalize: archive, verify, worktree diff, board row, then notify. */
async function finalizeAndNotify(task: Task): Promise<void> {
	if (task.state === "done") {
		await archiveTaskAnswer(task);
		await maybeRunVerify(task);
		await collectWorktreeDiff(task);
		await appendBoardEntry(task);
	}
	// Captured here (not in the sync notify path) so the notification can carry it.
	task.retainedWorktrees = await retainedWorktreesLine();
	notifyTaskSettled(task);
}

/** Fire-and-forget at settle sites; reporters await task.finalizePromise. */
function startFinalize(task: Task): void {
	task.finalizePromise = finalizeAndNotify(task);
}

/**
 * The inline form of a settled answer: archived answers show the handle plus the
 * template summary (or a head/tail excerpt); unarchived ones truncate as before.
 */
function presentAnswer(task: Task, inlineLimit: number): { text: string; truncated: boolean } {
	const latest = task.archives?.[task.archives.length - 1];
	if (!latest) return truncate(answerOf(task), inlineLimit);
	const answer = answerOf(task);
	const text = placeholderFor({ ...latest, taskId: task.id, text: answer }, { summary: extractSummary(answer) });
	return { text, truncated: false };
}

/** Compact text dump of the meter for /external_agent_stats. */
function formatMeterSnapshot(snapshot: MeterSnapshot): string {
	const totals = snapshot.totals;
	const lines = [
		"external-agent stats (as reported by the target CLIs; not billing):",
		`dispatches: ${snapshot.dispatchTotal} · tokens in/out/cached: ${totals.in ?? 0}/${totals.out ?? 0}/${totals.cached ?? 0}` +
			(totals.costUsd !== undefined ? ` · cost $${totals.costUsd.toFixed(4)}` : ""),
	];
	const refusals = Object.entries(snapshot.refusedTotal);
	if (refusals.length > 0) lines.push(`refusals: ${refusals.map(([reason, n]) => `${n}× ${reason}`).join("; ")}`);
	for (const [taskId, t] of Object.entries(snapshot.tasks)) {
		lines.push(
			`  ${taskId}: in/out/cached ${t.in ?? 0}/${t.out ?? 0}/${t.cached ?? 0}${t.costUsd !== undefined ? ` · $${t.costUsd.toFixed(4)}` : ""} · ${t.samples} samples`,
		);
	}
	return lines.join("\n");
}

function verifyLine(result: VerifyResult): string {
	if (result.skipped) return `verify: \`${result.command}\` — skipped (${result.skipped})`;
	return `verify: \`${result.command}\` — exit ${result.exitCode ?? "?"} in ${fmtDuration(result.durationMs)}`;
}

function notifyTaskSettled(task: Task): void {
	if (task.notified) return;
	if (task.notify === "off") {
		task.notified = true;
		return;
	}
	// A waiter holds the notice (no push, no tombstone): its receipt carries the
	// answer, and it claims the task when it finishes. If that waiter dies without
	// finishing, session_start drops the tokens and re-delivers the held state.
	if (task.waiters?.size) return;
	if (!taskRegistry.notifySettled) {
		taskRegistry.pendingNotificationIds.add(task.id);
		return;
	}
	taskRegistry.notifySettled(task);
}

function notifySettled(pi: ExtensionAPI, task: Task): void {
	if (task.notified) return;
	if (task.notify === "off") {
		task.notified = true;
		return;
	}

	const elapsed = fmtDuration((task.endedAt ?? Date.now()) - task.startedAt);
	const headline = `External agent ${task.id} (${task.agent}) ${task.state} after ${elapsed}.`;

	const lines = [headline];
	if (task.spawnError) lines.push(`spawn error: ${task.spawnError}`);
	const errs = errorsOf(task);
	if (errs) lines.push(`errors: ${truncate(errs, 500).text}`);
	if (task.worktree) lines.push(`worktree: ${task.worktree.path} (branch ${task.worktree.branch})`);

	if (task.state === "done") {
		if (task.verifyResult) lines.push(verifyLine(task.verifyResult));
		const preview = presentAnswer(task, NOTIFY_PREVIEW_CHARS);
		if (preview.text) {
			lines.push("", preview.text);
			if (preview.truncated) {
				lines.push(`[preview only — call external_agent_status taskId="${task.id}" for the full answer]`);
			}
		} else {
			lines.push(`No answer text was parsed. Inspect with external_agent_status taskId="${task.id}".`);
		}
	} else {
		lines.push(`Inspect with external_agent_status taskId="${task.id}".`);
	}
	// Neutral by design: the line reports accumulation, it does not ask for cleanup.
	if (task.retainedWorktrees) lines.push(task.retainedWorktrees);

	try {
		pi.sendMessage(
			{
				customType: "external-agent",
				content: lines.join("\n"),
				display: true,
				details: {
					kind: "external-agent-notification",
					taskId: task.id,
					agent: task.agent,
					state: task.state,
					exitCode: task.exitCode,
					task: taskSnapshot(task),
				},
			},
			{
				deliverAs: task.notify,
				triggerTurn: task.notify !== "nextTurn",
			},
		);
		task.notified = true;
		taskRegistry.pendingNotificationIds.delete(task.id);
	} catch {
		taskRegistry.pendingNotificationIds.add(task.id);
	}
}

// ---------------------------------------------------------------------------
// Stall watchdog
// ---------------------------------------------------------------------------

/**
 * Safety net that makes end-the-turn-and-wait safe: without it a hung task never
 * settles, never notifies, and a sleeping model would never find out. The scan
 * lives on the shared registry so /reload cannot stack duplicate intervals; the
 * per-session delivery callback is rebound on every session_start exactly like
 * notifySettled. notify "off" suppresses delivery, never stall detection itself:
 * an off task still ends a blocking wait early, because the wait reads the
 * clocks, not the push channel.
 *
 * Two clocks feed one verdict. lastEventAt answers "is anything arriving at
 * all?" (quiet); lastMeaningfulEventAt answers "is any progress happening?"
 * (struggling). A task can be busy and stuck at once — that is exactly what a
 * retry storm under a network outage looks like.
 */

/**
 * The stall clock. Thresholds run to minutes, so time is the one input a suite
 * cannot produce by waiting; tests replace now(), production only reads it.
 */
export const stallClock = { now: (): number => Date.now() };

/** message/reasoning/tool are progress; usage/warning/error are noise around it. */
function isMeaningfulEvent(event: AgentEvent): boolean {
	return event.kind === "message" || event.kind === "reasoning" || event.kind === "tool";
}

/** The last progress signal's text, compacted for the struggle wording. */
function lastMeaningfulExcerpt(task: Task): string {
	for (let index = task.events.length - 1; index >= 0; index -= 1) {
		const event = task.events[index];
		if (isMeaningfulEvent(event)) return event.text.replace(/\s+/g, " ").trim().slice(0, 120);
	}
	return "(none yet)";
}

/** Median of the samples; an even count averages the two middle ones. */
function medianOf(samples: number[]): number {
	const sorted = [...samples].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The silence threshold. A task with a known cadence is judged against it — 8×
 * the median meaningful-event gap — so trailing silence is noticed sooner than
 * the watchdog would; a task without five measured gaps keeps the user's
 * watchdog. The 3m floor keeps one long tool call from reading as a stall; the
 * watchdog ceiling keeps the explicit setting as the slowest possible threshold.
 */
function effectiveStallMs(task: Task): number {
	if (task.meaningfulIntervals.length < STALL_SAMPLE_MIN) return task.watchdogMs;
	return Math.min(
		Math.max(STALL_FACTOR * medianOf(task.meaningfulIntervals), STALL_FLOOR_MS),
		task.watchdogMs,
	);
}

/** Quiet: no event at all for the effective threshold. watchdogMs 0 disables both detectors. */
function stallQuiet(task: Task, now: number): boolean {
	return task.watchdogMs > 0 && now - task.lastEventAt >= effectiveStallMs(task);
}

/**
 * Struggling: noise is still arriving (warnings/errors/usage) but nothing
 * meaningful has for STRUGGLE_MS. A task with no event at all is quiet, not
 * struggling — pure silence stays the user's watchdog's call.
 */
function stallStruggling(task: Task, now: number): boolean {
	return (
		task.watchdogMs > 0 &&
		task.lastEventAt > task.lastMeaningfulEventAt &&
		now - task.lastMeaningfulEventAt >= STRUGGLE_MS
	);
}

/** The stall a task is in, or null. Silence outranks noise: both true reads quiet. */
function stallKind(task: Task, now: number): StallKind | null {
	if (stallQuiet(task, now)) return "quiet";
	if (stallStruggling(task, now)) return "struggling";
	return null;
}

/** The clock a kind is measured against; a notice streak resets when it advances. */
function stallAnchor(task: Task, stall: StallKind): number {
	return stall === "quiet" ? task.lastEventAt : task.lastMeaningfulEventAt;
}

/** One report phrase per kind: quiet measures silence, struggling measures noise. */
function stallPhrase(task: Task, stall: StallKind, now: number): string {
	if (stall === "quiet") return `quiet for ${fmtDuration(now - task.lastEventAt)}`;
	return `only warnings/errors for ${fmtDuration(now - task.lastMeaningfulEventAt)}; last meaningful: ${lastMeaningfulExcerpt(task)}`;
}

/**
 * Whether a stall notice is due for the current streak of this kind. An event
 * the kind is anchored to — any event for quiet, a meaningful one for
 * struggling — resets the streak; repeats are spaced by the threshold that
 * produced them, the effective silence threshold or the struggle gap, and
 * capped per streak. Shared by the scan (scanWatchdogs/notifyWatchdog) and
 * the wait's early return, so the two channels cannot double-report the same
 * stall; note how the struggling anchor ignores error traffic, which would otherwise reset the cap
 * on every retry and turn the notices into a storm. Claiming is separate
 * (claimStallNotice) because a failed delivery must retry on the next scan.
 */
function stallNoticeDue(task: Task, now: number, stall: StallKind): boolean {
	const anchor = stallAnchor(task, stall);
	if (task.lastWatchdogNoticeAt > 0 && anchor > task.lastWatchdogNoticeAt) {
		task.watchdogNotices = 0;
	}
	if (task.watchdogNotices >= MAX_WATCHDOG_NOTICES && task.lastWatchdogNoticeAt > anchor) return false;
	const spacing = stall === "quiet" ? effectiveStallMs(task) : STRUGGLE_MS;
	if (task.lastWatchdogNoticeAt > anchor && now - task.lastWatchdogNoticeAt < spacing) return false;
	return true;
}

/** Consume one notice slot for this stall streak; the caller must deliver or report. */
function claimStallNotice(task: Task, now: number): void {
	task.lastWatchdogNoticeAt = now;
	task.watchdogNotices += 1;
}

function notifyWatchdog(pi: ExtensionAPI, task: Task, stall: StallKind): void {
	const now = stallClock.now();
	const stalledFor = now - stallAnchor(task, stall);
	const elapsed = fmtDuration((task.endedAt ?? now) - task.startedAt);
	const reason =
		stall === "quiet"
			? `has been quiet for ${fmtDuration(stalledFor)}`
			: `has shown only warnings/errors for ${fmtDuration(stalledFor)}; last meaningful: ${lastMeaningfulExcerpt(task)}`;
	const ordinal = task.watchdogNotices + 1;
	const lines = [
		`External agent ${task.id} (${task.agent}) is still running but ${reason} (elapsed ${elapsed}).`,
		stall === "quiet"
			? "This is a stall warning, not a completion. No action is required if the quiet is expected."
			: "This is a stall warning, not a completion. No action is required if the retries are expected.",
		`Inspect with external_agent_status taskId="${task.id}", or stop it with external_agent_stop if you judge it stuck.`,
	];
	if (ordinal >= MAX_WATCHDOG_NOTICES) {
		lines.push(`This is stall notice ${ordinal}; further notices for this stall streak are suppressed.`);
	}
	try {
		pi.sendMessage(
			{
				customType: "external-agent",
				content: lines.join("\n"),
				display: true,
				details: {
					kind: "external-agent-watchdog",
					taskId: task.id,
					agent: task.agent,
					state: task.state,
					stall,
					stalledForMs: stalledFor,
					task: taskSnapshot(task),
				},
			},
			{
				deliverAs: task.notify === "nextTurn" ? "nextTurn" : "steer",
				triggerTurn: task.notify !== "nextTurn",
			},
		);
		claimStallNotice(task, now);
	} catch {
		// Delivery failed (e.g. mid-reload); the next scan retries.
	}
}

/**
 * Exported for tests: the interval is 30s, far too slow to exercise live, and
 * waiting is the one mechanism this scan must not leave uncovered.
 */
export function scanWatchdogs(): void {
	const deliver = taskRegistry.notifyWatchdog;
	if (!deliver) return;
	const now = stallClock.now();
	for (const task of tasks.values()) {
		if (task.state !== "running") continue;
		if (task.notify === "off") continue;
		// A waiter perceives the same stall through its own early return; a push
		// on top of that would be a duplicate delivery, not a safety net.
		if (task.waiters?.size) continue;
		const stall = stallKind(task, now);
		if (!stall) continue;
		if (!stallNoticeDue(task, now, stall)) continue;
		deliver(task, stall);
	}
}

/**
 * Exported for tests: stall suites drive the clock and the event record
 * directly, because thresholds run to minutes and no target CLI emits
 * warning/error streams on stdout (kimi writes them to stderr). The predicates
 * are the production ones.
 */
export const stallTestApi = {
	task: (id: string): Task | undefined => tasks.get(id),
	record: (task: Task, event: AgentEvent): void => pushEvent(task, event),
	quiet: stallQuiet,
	struggling: stallStruggling,
	kind: stallKind,
	effectiveMs: effectiveStallMs,
};

function ensureWatchdogTimer(): void {
	if (taskRegistry.watchdogTimer) return;
	const timer = setInterval(scanWatchdogs, WATCHDOG_SCAN_INTERVAL_MS);
	// Never let the watchdog alone keep the process alive.
	timer.unref?.();
	taskRegistry.watchdogTimer = timer;
}

// ---------------------------------------------------------------------------
// Worktree isolation
// ---------------------------------------------------------------------------

/**
 * Where isolated worktrees live inside the main repository. git runs through
 * node:child_process rather than pi.exec on purpose: these are the hub's own
 * plumbing, and the target CLI must never see or own them.
 */
const WORKTREE_DIR = join(".external-agent", "worktrees");
/** Inventory folding: past this many retained worktrees, only the oldest few are listed. */
const RETAINED_LIST_MAX = 5;
const RETAINED_LIST_SHOWN = 3;

const execFileAsync = promisify(execFile);

/** One git call; rejects with the child's stderr attached (execFile's error shape). */
async function runGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr } = await execFileAsync("git", args, { encoding: "utf8" });
	return { stdout, stderr };
}

/** One-line, bounded git failure text for a refusal message. */
function gitErrorTail(err: unknown): string {
	const shaped = err as { stderr?: string; stdout?: string } | undefined;
	const text = shaped?.stderr?.trim() || shaped?.stdout?.trim() || (err instanceof Error ? err.message : String(err));
	return escapeTerminalControls(text.replace(/\s+/g, " ").trim().slice(0, 300));
}

/**
 * The repository a cwd belongs to, or the reason there is none: isolate refuses
 * a non-git cwd outright instead of silently running the worker unisolated.
 */
async function findGitTopLevel(cwd: string): Promise<{ ok: true; toplevel: string } | { ok: false; reason: string }> {
	try {
		const toplevel = (await runGit(["-C", cwd, "rev-parse", "--show-toplevel"])).stdout.trim();
		if (!toplevel) return { ok: false, reason: `git rev-parse --show-toplevel in ${escapeTerminalControls(cwd)} returned nothing` };
		return { ok: true, toplevel };
	} catch (err) {
		return {
			ok: false,
			reason:
				`${escapeTerminalControls(cwd)} is not inside a git repository (${gitErrorTail(err)}), ` +
				"so isolate cannot give the task its own worktree",
		};
	}
}

/** Whether a path exists at all; used to tell "I created this" from "it was already there". */
async function pathExists(target: string): Promise<boolean> {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
}

/**
 * Create one task's worktree (`<toplevel>/.external-agent/worktrees/<taskId>` on
 * branch `ea-<taskId>`). A failure cleans up whatever this call may have made and
 * refuses the dispatch with git's own words — a half-made checkout is never left
 * behind, and the caller is told rather than degraded silently.
 */
/**
 * Keep hub-created worktrees out of the parent's git status without touching any
 * tracked file: append `.external-agent/` to `.git/info/exclude` (git's local,
 * uncommitted ignore list). Idempotent; failures are ignored — a dirty status is
 * annoying, never a reason to fail a dispatch.
 */
async function excludeRuntimeDir(base: string): Promise<void> {
	try {
		const gitDir = (await runGit(["-C", base, "rev-parse", "--git-dir"])).stdout.trim();
		const excludePath = join(resolve(base, gitDir), "info", "exclude");
		const existing = await readFile(excludePath, "utf8").catch(() => "");
		if (existing.split("\n").some((line) => line.trim() === ".external-agent/")) return;
		await appendFile(excludePath, `${existing && !existing.endsWith("\n") ? "\n" : ""}.external-agent/\n`, "utf8");
	} catch {
		/* best effort only */
	}
}

async function createTaskWorktree(worktree: TaskWorktree): Promise<{ ok: true } | { ok: false; reason: string }> {
	// A path that already exists belongs to a retained worktree (or a foreign
	// directory): the hub never deletes those, not even as failure cleanup.
	const existed = await pathExists(worktree.path);
	try {
		await runGit(["-C", worktree.base, "worktree", "add", worktree.path, "-b", worktree.branch]);
		await excludeRuntimeDir(worktree.base);
		return { ok: true };
	} catch (err) {
		if (!existed) {
			await runGit(["-C", worktree.base, "worktree", "remove", "--force", worktree.path]).catch(() => undefined);
		}
		return {
			ok: false,
			reason: `git worktree add failed for ${escapeTerminalControls(worktree.path)} (${gitErrorTail(err)})`,
		};
	}
}

/** Ages are coarse on purpose: the line reports accumulation, not exact times. */
function formatAge(ageMs: number): string {
	const minutes = Math.max(0, Math.floor(ageMs / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

/**
 * Neutral inventory of worktrees the hub created and did not remove — by design,
 * since it never merges and never deletes. Bases come from the registry, so only
 * repositories this session isolated into are scanned, and the line only exists
 * once such a worktree does. No imperative wording: the line reports, the owner
 * decides.
 */
async function retainedWorktreesLine(): Promise<string | undefined> {
	const bases = new Set<string>();
	for (const task of tasks.values()) {
		if (task.worktree) bases.add(task.worktree.base);
	}
	const entries: Array<{ name: string; ageMs: number }> = [];
	for (const base of bases) {
		const root = join(base, WORKTREE_DIR);
		let dirents;
		try {
			dirents = await readdir(root, { withFileTypes: true });
		} catch {
			continue; // nothing retained here yet, or the directory is unreadable
		}
		for (const dirent of dirents) {
			if (!dirent.isDirectory()) continue;
			try {
				const info = await stat(join(root, dirent.name));
				// The branch is what identifies the retained worktree in git terms.
				entries.push({ name: `ea-${dirent.name}`, ageMs: Date.now() - info.mtimeMs });
			} catch {
				// It disappeared between listing and stat: nothing to report.
			}
		}
	}
	if (entries.length === 0) return undefined;
	entries.sort((a, b) => b.ageMs - a.ageMs);
	const shown = entries.length > RETAINED_LIST_MAX ? entries.slice(0, RETAINED_LIST_SHOWN) : entries;
	const labels = shown.map((entry) => `${entry.name}(${formatAge(entry.ageMs)})`);
	if (shown.length < entries.length) labels.push(`+${entries.length - shown.length} more`);
	return `retained worktrees: ${labels.join(", ")}`;
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

/**
 * Both transports share this prologue: validate the receipt, allocate the id,
 * register the task. The transport-specific half (spawn+parse vs session
 * driver) is what follows.
 */
function createTask(
	agent: AgentId,
	taskText: string,
	cwd: string,
	mode: Mode,
	notify: NotifyMode,
	watchdogMs: number,
	dispatch: DispatchReceipt,
	transport: Transport,
	preallocatedId?: string,
): Task {
	// Isolate hands in the id it already used to name the worktree; everyone else
	// gets the next one here, exactly as before.
	const id = preallocatedId ?? nextId(agent);
	// One clock read for the whole prologue: startedAt and both event clocks must
	// agree, or a fresh task would look stalled before its first event lands.
	const startedAt = stallClock.now();
	const task: Task = {
		id,
		agent,
		task: taskText,
		cwd,
		mode,
		dispatch,
		state: "running",
		proc: null,
		transport,
		answerStartIndex: 0,
		sessionAlive: transport === "persistent",
		startedAt,
		lastEventAt: startedAt,
		lastMeaningfulEventAt: startedAt,
		meaningfulIntervals: [],
		events: [],
		stderr: "",
		exitCode: null,
		notify,
		notified: false,
		watchdogMs,
		lastWatchdogNoticeAt: 0,
		watchdogNotices: 0,
		eventSeq: 0,
		relayDepth: 0,
		relaysReceived: 0,
	};
	tasks.set(task.id, task);
	meter.recordDispatch(task.id);
	ensureWatchdogTimer();
	return task;
}

function startTask(
	agent: AgentId,
	taskText: string,
	cwd: string,
	mode: Mode,
	notify: NotifyMode,
	watchdogMs: number,
	model?: string,
	effort?: Effort,
	extras: DispatchExtras = {},
): Task {
	return hasSessionDriver(agent)
		? startPersistentTask(agent, taskText, cwd, mode, notify, watchdogMs, model, effort, extras)
		: startOneshotTask(agent, taskText, cwd, mode, notify, watchdogMs, model, effort, extras);
}

/** Settle-time fields that come from dispatch extras rather than the agent stream. */
function applyExtras(task: Task, extras: DispatchExtras): void {
	if (extras.templateLabel) task.templateLabel = extras.templateLabel;
	if (extras.verifyCommand) task.verifyCommand = extras.verifyCommand;
	if (extras.verifyTimeoutSeconds !== undefined) task.verifyTimeoutSeconds = extras.verifyTimeoutSeconds;
	if (extras.worktree) task.worktree = extras.worktree;
}

/** The receipt's copy of a worktree reference: path/branch/base, never live diff state. */
function worktreeReceipt(worktree: TaskWorktree | undefined): { worktree?: WorktreeRef } {
	return worktree ? { worktree: { path: worktree.path, branch: worktree.branch, base: worktree.base } } : {};
}

/**
 * Persistent path: a long-lived session whose completion signal is the turn
 * ending, not the process exiting. The process is kept alive afterwards so the
 * same conversation can be steered or continued.
 */
function startPersistentTask(
	agent: AgentId,
	taskText: string,
	cwd: string,
	mode: Mode,
	notify: NotifyMode,
	watchdogMs: number,
	model?: string,
	effort?: Effort,
	extras: DispatchExtras = {},
): Task {
	const adapter = ADAPTERS[agent];
	const driver = SESSION_DRIVERS[agent]!();
	const dispatch = freezeDispatchReceipt({
		version: 1,
		executable: adapter.bin,
		// The session startup command, not a one-shot argv: the prompt is not in
		// it (it goes over the protocol), hence promptArgIndex -1.
		argv: [],
		promptArgIndex: -1,
		prompt: taskText,
		cwd,
		cwdForwardedToCli: driver.cwdForwardedToCli,
		stdin: driver.stdinFormat ?? "jsonrpc",
		shell: false,
		agent,
		provider: adapter.provider,
		requestedMode: mode,
		effectivePolicy: adapter.sessionPolicy?.(mode) ?? `${adapter.session?.steerNote ?? "session"} (persistent session)`,
		readOnlyEnforcement: mode === "readonly" ? "harness-enforced" : "not-applicable",
		model: model
			? { requested: model, forwarded: true, note: "Passed to the persistent session at startup." }
			: { forwarded: false, note: "No model override requested; target CLI/config selects the model." },
		effort: effort
			? {
					requested: effort,
					forwarded: effortForwardedOnSession(agent),
					note: effortSessionNote(agent, effort),
				}
			: { forwarded: false, note: "No effort override requested; the target CLI/config default applies." },
		notify,
		watchdogMs,
		environment: INHERITED_ENVIRONMENT_NOTICE,
		transport: "persistent",
		...(extras.templateLabel ? { template: extras.templateLabel } : {}),
		...worktreeReceipt(extras.worktree),
	});

	const task = createTask(agent, taskText, cwd, mode, notify, watchdogMs, dispatch, "persistent", extras.taskId);
	applyExtras(task, extras);
	task.driver = driver;

	driver.onEvent((event) => {
		pushEvent(task, event);
	});
	driver.onTurnEnd((outcome) => {
		settlePersistentTask(task, outcome);
	});
	driver.onExit((code) => {
		task.sessionAlive = false;
		task.exitCode = code;
		clearIdleReap(task);
		if (task.state === "running") {
			// The session died mid-turn: that is a failure, not an answer.
			task.state = "failed";
			task.endedAt = Date.now();
			if (!task.spawnError) task.spawnError = task.stderr.trim().slice(0, 500) || undefined;
			startFinalize(task);
		}
	});

	driver
		.start({ task: taskText, cwd, mode, model, effort })
		.then(() => {
			// argv is only known once the driver has built it, so fill the frozen
			// receipt copy the task holds from here.
			task.dispatch = freezeDispatchReceipt({ ...task.dispatch, argv: driver.argv });
		})
		.catch((err) => {
			task.state = "failed";
			task.endedAt = Date.now();
			task.sessionAlive = false;
			task.spawnError = err instanceof Error ? err.message : String(err);
			driver.kill();
			startFinalize(task);
		});

	return task;
}

/**
 * Whether the persistent path can actually forward an effort request. reasonix
 * --acp has no effort flag at all, so an override there would be silently
 * dropped — which is exactly the misleading outcome the receipt exists to
 * prevent, so it is reported instead.
 */
function effortForwardedOnSession(agent: AgentId): boolean {
	return agent !== "reasonix";
}

function effortSessionNote(agent: AgentId, effort: Effort): string {
	if (agent === "reasonix") {
		return `requested "${effort}"; NOT forwarded — reasonix --acp accepts no effort flag (the one-shot path would have passed --effort).`;
	}
	return `Passed to the persistent session for "${effort}".`;
}

/** Append an event, keeping the ring cap and the current-turn window aligned. */
function pushEvent(task: Task, event: AgentEvent): void {
	task.events.push(event);
	if (task.events.length > MAX_EVENTS) {
		task.events.shift();
		if (task.answerStartIndex > 0) task.answerStartIndex -= 1;
	}
	const now = stallClock.now();
	if (isMeaningfulEvent(event)) {
		// The gap since the previous meaningful event (start counts as one) is
		// this task's cadence sample; only the recent window is kept.
		task.meaningfulIntervals.push(now - task.lastMeaningfulEventAt);
		if (task.meaningfulIntervals.length > MEANINGFUL_INTERVAL_WINDOW) task.meaningfulIntervals.shift();
		task.lastMeaningfulEventAt = now;
	}
	task.lastEventAt = now;
	task.eventSeq += 1;
	meterUsageEvent(task.id, event);
}

function settlePersistentTask(task: Task, outcome: { status: "done" | "failed" | "cancelled"; error?: string }): void {
	if (task.state !== "running") return;
	task.state = outcome.status === "cancelled" ? "stopped" : outcome.status;
	task.endedAt = Date.now();
	if (outcome.error) task.spawnError = outcome.error;
	startFinalize(task);
	// A cancelled turn is one the model asked to stop; no reason to keep the
	// session around for a follow-up.
	if (task.state === "stopped") {
		reclaimSession(task);
		return;
	}
	scheduleIdleReap(task);
}

/**
 * A settled session is the only way a follow-up can keep the conversation, so
 * it is kept alive for IDLE_REAP_MS and then killed. Timers are unref'd: an
 * idle session must never be the reason the process stays up.
 */
function scheduleIdleReap(task: Task): void {
	clearIdleReap(task);
	task.idleReapTimer = setTimeout(() => reclaimSession(task), IDLE_REAP_MS);
	task.idleReapTimer.unref?.();
}

function clearIdleReap(task: Task): void {
	if (task.idleReapTimer) {
		clearTimeout(task.idleReapTimer);
		task.idleReapTimer = undefined;
	}
}

function reclaimSession(task: Task): void {
	clearIdleReap(task);
	if (!task.sessionAlive) return;
	task.sessionAlive = false;
	task.driver?.kill();
}

/**
 * Re-arm a settled persistent task for a new turn handed to it in place. The
 * answer window moves to the new turn, and the notifications the last turn
 * consumed are re-armed with it.
 */
function beginFollowUpTurn(task: Task): void {
	task.answerStartIndex = task.events.length;
	task.state = "running";
	task.endedAt = undefined;
	task.notified = false;
	task.exitCode = null;
	task.spawnError = undefined;
	// Both clocks restart with the turn: the idle gap between turns is neither
	// silence nor struggle, and counting it would fire a notice on a fresh turn.
	const now = stallClock.now();
	task.lastEventAt = now;
	task.lastMeaningfulEventAt = now;
	task.watchdogNotices = 0;
	clearIdleReap(task);
}

function startOneshotTask(
	agent: AgentId,
	taskText: string,
	cwd: string,
	mode: Mode,
	notify: NotifyMode,
	watchdogMs: number,
	model?: string,
	effort?: Effort,
	extras: DispatchExtras = {},
): Task {
	const adapter = ADAPTERS[agent];
	const adapterDispatch = adapter.buildDispatch({ task: taskText, cwd, mode, model, effort });
	if (
		!Number.isInteger(adapterDispatch.promptArgIndex) ||
		adapterDispatch.promptArgIndex < 0 ||
		adapterDispatch.argv[adapterDispatch.promptArgIndex] !== taskText
	) {
		throw new Error(`Adapter ${agent} produced an invalid dispatch receipt.`);
	}

	const dispatch = freezeDispatchReceipt({
		version: 1,
		executable: adapter.bin,
		argv: [...adapterDispatch.argv],
		promptArgIndex: adapterDispatch.promptArgIndex,
		prompt: taskText,
		cwd,
		cwdForwardedToCli: adapterDispatch.cwdForwardedToCli,
		stdin: "ignored",
		shell: false,
		agent,
		provider: adapter.provider,
		requestedMode: mode,
		effectivePolicy: adapterDispatch.effectivePolicy,
		readOnlyEnforcement: adapterDispatch.readOnlyEnforcement,
		model: { ...adapterDispatch.model },
		effort: { ...adapterDispatch.effort },
		notify,
		watchdogMs,
		environment: INHERITED_ENVIRONMENT_NOTICE,
		transport: "oneshot",
		...(extras.templateLabel ? { template: extras.templateLabel } : {}),
		...worktreeReceipt(extras.worktree),
	});
	const task = createTask(agent, taskText, cwd, mode, notify, watchdogMs, dispatch, "oneshot", extras.taskId);
	applyExtras(task, extras);

	let proc: ChildProcess;
	try {
		// No shell: args are passed as an array so task text cannot inject commands.
		proc = spawn(task.dispatch.executable, task.dispatch.argv, {
			cwd: task.dispatch.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});
	} catch (err) {
		task.state = "failed";
		task.endedAt = Date.now();
		task.spawnError = err instanceof Error ? err.message : String(err);
		return task;
	}

	task.proc = proc;

	proc.on("error", (err) => {
		if (task.state === "stopped") return;
		task.state = "failed";
		task.endedAt = Date.now();
		task.spawnError = err.message;
		startFinalize(task);
	});

	let buffer = "";
	proc.stdout?.setEncoding("utf8");
	proc.stdout?.on("data", (chunk: string) => {
		buffer += chunk;
		// Strict LF framing; tolerate CRLF by stripping a trailing CR.
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const raw of lines) {
			const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
			if (!line.trim()) continue;
			const event = adapter.parseEvent(line);
			if (!event) continue;
			pushEvent(task, event);
		}
	});

	proc.stderr?.setEncoding("utf8");
	proc.stderr?.on("data", (chunk: string) => {
		if (task.stderr.length < MAX_STDERR_CHARS) task.stderr += chunk;
	});

	proc.on("close", (code) => {
		// Flush any trailing partial line: the Claude family emits a single blob
		// with no terminating newline.
		if (buffer.trim()) {
			const event = adapter.parseEvent(buffer.trim());
			if (event) pushEvent(task, event);
		}
		task.exitCode = code;
		task.endedAt = Date.now();
		if (task.state === "stopped") {
			// An explicit stop is something the model already knows about; no callback.
			task.notified = true;
			return;
		}
		// An agent can exit 0 and still have reported an error event, so check both.
		task.state = code === 0 && !errorsOf(task) ? "done" : "failed";
		startFinalize(task);
	});

	return task;
}

function stopTask(task: Task): boolean {
	if (task.state !== "running") return false;
	task.state = "stopped";
	task.endedAt = Date.now();
	if (task.transport === "persistent" && task.driver) {
		// Protocol-level cancel first: it lets the agent unwind (codex reports
		// turn/completed interrupted, pi settles the aborted turn) instead of
		// leaving half-written state behind. A session process does not exit on
		// cancel, so the signal escalation is what actually reaps it.
		const driver = task.driver;
		void driver
			.cancel()
			.catch(() => undefined)
			.finally(() => {
				setTimeout(() => {
					if (task.sessionAlive) reclaimSession(task);
				}, CANCEL_ESCALATE_MS).unref?.();
			});
		task.notified = true;
		return true;
	}
	if (!task.proc) return false;
	try {
		task.proc.kill("SIGTERM");
		// Escalate if the child ignores SIGTERM.
		const proc = task.proc;
		setTimeout(() => {
			if (proc.exitCode === null && proc.signalCode === null) {
				try {
					proc.kill("SIGKILL");
				} catch {
					/* already gone */
				}
			}
		}, 3000).unref?.();
	} catch {
		return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Dispatch validation
// ---------------------------------------------------------------------------

type DispatchCheck = { ok: true } | { ok: false; reason: string };

/**
 * The refusal path every dispatch goes through, shared by external_agent_start
 * and external_agent_compare so both refuse identically and for the same
 * reasons — a compare spec must never be a way around a start-time guard.
 *
 * All three checks are fail-closed: a mode below the adapter's floor (kimi) has
 * no enforcement behind it, a mode above its ceiling has nothing to bound it,
 * and an effort override the target cannot forward would mislead the caller
 * about the run's cost. The last check is the directory conflict: two mutating
 * agents in one directory change files in ways neither the model nor the other
 * agent can observe.
 *
 * `conflictCwd` is where the worker will actually run: an isolated task's cwd is
 * its own fresh worktree, so the conflict check must not refuse it over a writer
 * in the directory the caller named.
 */
function validateDispatch(
	agent: AgentId,
	mode: Mode,
	cwd: string,
	effort: Effort | undefined,
	conflictCwd: string = cwd,
): DispatchCheck {
	const adapter = ADAPTERS[agent];

	// Fail closed below the adapter's floor too: an adapter with minMode
	// (kimi) has no lower tier at all — accepting one would be a label
	// with no enforcement behind it.
	const minMode = adapter.minMode ?? "readonly";
	if (MODE_RANK[mode] < MODE_RANK[minMode]) {
		return {
			ok: false,
			reason:
				`${agent} is ${minMode}-only (requested "${mode}"). ` +
				`Pick an agent with a lower tier (${AGENT_IDS.filter((i) => (ADAPTERS[i].minMode ?? "readonly") === "readonly").join(", ")}).`,
		};
	}

	// Fail closed: never exceed the adapter's mode ceiling. kimi's ceiling is
	// read-only precisely because its harness has no sandbox to bound writes.
	if (MODE_RANK[mode] > MODE_RANK[adapter.maxMode]) {
		const reason = !adapter.enforcesReadOnly
			? `${agent} has no harness-enforced sandbox, so ${mode} mode cannot be bounded. ` +
				`Run it read-only and apply changes yourself, or pick an agent that enforces read-only ` +
				`(${AGENT_IDS.filter((i) => ADAPTERS[i].enforcesReadOnly).join(", ")}).`
			: `${agent} is capped at "${adapter.maxMode}" mode (requested "${mode}").`;
		return { ok: false, reason };
	}

	// Effort is advisory only where the adapter has a real flag for it; a
	// silently dropped override would mislead the caller about the run's cost.
	if (effort) {
		const supported = adapter.supportedEfforts;
		if (!supported) {
			return {
				ok: false,
				reason:
					`${agent} has no reasoning-effort control. Drop the effort parameter or pick an agent ` +
					`that supports one (${AGENT_IDS.filter((i) => ADAPTERS[i].supportedEfforts).join(", ")}).`,
			};
		}
		if (!supported.includes(effort)) {
			return { ok: false, reason: `${agent} supports effort levels ${supported.join(", ")} (requested "${effort}").` };
		}
	}

	// Two mutating agents in one directory conflict in ways the model cannot see coming.
	if (mode !== "readonly") {
		const conflict = [...tasks.values()].find((t) => t.state === "running" && t.mode !== "readonly" && t.cwd === conflictCwd);
		if (conflict) {
			return {
				ok: false,
				reason:
					`${conflict.id} is already running a ${conflict.mode} task in ${escapeTerminalControls(conflictCwd)}. ` +
					`Stop it first (external_agent_stop) or dispatch to a different directory.`,
			};
		}
	}

	return { ok: true };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * Bounded one-line event profile for a wait report, counted over the call's own
 * window (eventSeq delta). It exists so "running but busy" is distinguishable
 * from "running and quiet" — a retry storm shows up as many tool×N events while
 * no answer forms. The hub reports the counts; judging them is the model's job.
 */
function eventProfileLine(task: Task, during: number): string {
	const recent = during > 0 ? task.events.slice(-during) : [];
	const counts = new Map<string, number>();
	for (const event of recent) counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
	const kinds = [...counts.entries()].map(([kind, n]) => `${kind}×${n}`).join(", ");
	const last = recent[recent.length - 1];
	const tail = last ? `; last: ${last.text.replace(/\s+/g, " ").trim().slice(0, 120)}` : "";
	return `events during wait: ${during}${kinds ? ` (${kinds}${tail})` : " (none)"}`;
}

/** Newline-prefixed retained-worktree inventory for status output; "" when there is none. */
async function inventorySuffix(): Promise<string> {
	const line = await retainedWorktreesLine();
	return line ? `\n${line}` : "";
}

function detailReport(task: Task, tailCount: number): string {
	const lines: string[] = [];
	lines.push(summarize(task));
	lines.push(`agent: ${task.agent} (${ADAPTERS[task.agent].provider})`);
	lines.push(`mode: ${modeDisplay(task.mode)} · cwd: ${task.cwd}`);
	if (task.worktree) lines.push(`worktree: ${task.worktree.path} (branch ${task.worktree.branch})`);
	if (task.worktree?.diffStat) lines.push(`worktree diff: ${task.worktree.diffStat}`);
	if (task.exitCode !== null) lines.push(`exit: ${task.exitCode}`);
	if (task.spawnError) lines.push(`spawn error: ${task.spawnError}`);
	if (task.transport === "persistent") {
		const canSteer = ADAPTERS[task.agent].session?.steer === true;
		const blocked = task.driver?.steerUnavailableReason;
		const steering = blocked
			? `steering unavailable: ${blocked}`
			: canSteer ? "external_agent_steer while running" : "no mid-run steer";
		lines.push(
			task.sessionAlive
				? `session: alive (external_agent_follow_up once settled; ${steering})`
				: "session: reclaimed — follow-ups are refused, dispatch a new task",
		);
		if (task.relaysReceived > 0) lines.push(`relays received: ${task.relaysReceived}`);
	}

	const errs = errorsOf(task);
	if (errs) lines.push(`agent errors: ${errs}`);
	if (task.templateLabel) lines.push(`template: ${task.templateLabel}`);
	if (task.verifyResult) {
		lines.push(verifyLine(task.verifyResult));
		if (task.verifyResult.outputTail) lines.push("verify output tail:", task.verifyResult.outputTail);
	}
	const warns = warningsOf(task);
	if (warns) lines.push(`non-fatal warnings: ${truncate(warns, 400).text}`);

	if (task.state === "running") {
		const tail = task.events.slice(-tailCount);
		if (tail.length > 0) {
			lines.push("", "recent activity:");
			for (const e of tail) {
				const oneLine = e.text.replace(/\s+/g, " ").slice(0, 200);
				lines.push(`  ${e.kind}: ${oneLine}`);
			}
		} else {
			lines.push("", "no parsed events yet");
		}
	} else {
		// The current turn's answer is what the caller asked for; earlier turns
		// stay visible through the event tail and are summarized as a count.
		const answer = answerOf(task);
		const earlier = task.answerStartIndex > 0;
		if (answer) {
			const { text, truncated } = presentAnswer(task, MAX_ANSWER_CHARS);
			lines.push("", earlier ? "answer (latest turn):" : "answer:", text);
			if (truncated) lines.push("[answer was truncated]");
			if (task.archiveError) lines.push(`[archive unavailable: ${task.archiveError}; answer inlined]`);
			if (earlier) lines.push(`[earlier turns: ${allAnswersOf(task).length} chars across ${task.answerStartIndex} events — latest turn shown]`);
		} else {
			lines.push("", "no answer produced");
			const err = truncate(task.stderr.trim(), 1500);
			if (err.text) lines.push("stderr:", err.text);
		}
	}
	return lines.join("\n");
}

function isMode(value: unknown): value is Mode {
	return value === "readonly" || value === "write" || value === "yolo";
}

function isNotifyMode(value: unknown): value is NotifyMode {
	return value === "steer" || value === "followUp" || value === "nextTurn" || value === "off";
}

function isEffort(value: unknown): value is Effort {
	return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

function isTaskState(value: unknown): value is TaskState {
	return value === "running" || value === "done" || value === "failed" || value === "stopped";
}

function isTransport(value: unknown): value is Transport {
	return value === "oneshot" || value === "persistent";
}

function isDispatchReceipt(value: unknown): value is DispatchReceipt {
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

function isTaskSnapshot(value: unknown): value is TaskSnapshot {
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

function taskPromptPreview(prompt: string, limit = 96): string {
	const oneLine = escapeTerminalControls(prompt).replace(/\n/g, " ↵ ").trim();
	return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine || "(empty task)";
}

function renderReceipt(
	receipt: DispatchReceipt,
	taskId: string,
	expanded: boolean,
	source: "actual process dispatch" | "requested dispatch (not yet executed)" | "derived from original tool call; actual receipt unavailable",
): string {
	const header = [
		`dispatch: ${source}`,
		`${escapeTerminalControls(taskId)} · ${escapeTerminalControls(receipt.agent)} · ${receipt.requestedMode}`,
		...dispatchSummary(receipt),
	];
	if (!expanded) {
		return `${header.slice(0, 3).join("\n")}\n  ${taskPromptPreview(receipt.prompt)}\n${keyHint("app.tools.expand", "to inspect dispatch")}`;
	}

	const argv = receipt.argv.map((arg, index) => `  [${index}] ${quoteArg(arg)}`).join("\n");
	const cwdForwardedLine = `cwd forwarded to CLI: ${receipt.cwdForwardedToCli ? "yes" : "no"}`;
	const argvBlock =
		receipt.transport === "persistent"
			? ["argv passed to spawn (session startup; the task text is not an argument):", argv || "  (none)"]
			: ["argv passed to spawn:", argv || "  (none)"];
	return [
		...header,
		cwdForwardedLine,
		`model detail: ${escapeTerminalControls(receipt.model.note)}`,
		`effort detail: ${escapeTerminalControls(receipt.effort.note)}`,
		"",
		"executable:",
		`  ${quoteArg(receipt.executable)}`,
		...argvBlock,
		"",
		"task prompt (exact text; terminal controls escaped):",
		escapeTerminalControls(receipt.prompt) || "(empty task)",
	].join("\n");
}

function renderTaskSnapshot(snapshot: TaskSnapshot, expanded: boolean): string {
	const title = `state: ${escapeTerminalControls(snapshot.state)}${snapshot.exitCode === null ? "" : ` · exit ${snapshot.exitCode}`}`;
	const receipt = renderReceipt(snapshot.dispatch, snapshot.taskId, expanded, "actual process dispatch");
	const errors = snapshot.spawnError ? `\nspawn error: ${escapeTerminalControls(snapshot.spawnError)}` : "";
	return `${title}\n${receipt}${errors}`;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
		.map((block) => escapeTerminalControls(block.text))
		.join("\n")
		.trim();
}

function renderResultWithReceipt(
	result: { content: Array<{ type: string; text?: string }> },
	receiptText: string,
	expanded: boolean,
): string {
	const output = resultText(result);
	if (!expanded) return output || receiptText;
	return output ? `${output}\n\n─── Dispatch receipt ───\n${receiptText}` : receiptText;
}

function receiptFromStartArgs(args: Record<string, unknown>, fallbackCwd: string): DispatchReceipt | undefined {
	const agent = typeof args.agent === "string" && AGENT_IDS.includes(args.agent as AgentId) ? (args.agent as AgentId) : undefined;
	const task = typeof args.task === "string" ? args.task : undefined;
	if (!agent || task === undefined) return undefined;
	const adapter = ADAPTERS[agent];
	const mode = isMode(args.mode) ? args.mode : adapter.defaultMode;
	const cwdInput = typeof args.cwd === "string" ? args.cwd.replace(/^@/, "") : fallbackCwd;
	const cwd = resolve(fallbackCwd, cwdInput);
	const notify = isNotifyMode(args.notify) ? args.notify : "steer";
	const watchdogMs =
		typeof args.watchdog === "number" && Number.isFinite(args.watchdog)
			? Math.max(0, args.watchdog) * 60_000
			: DEFAULT_WATCHDOG_MS;
	const model = typeof args.model === "string" ? args.model : undefined;
	const effort = isEffort(args.effort) ? args.effort : undefined;
	// Persistent agents run a session, not a one-shot argv, so the receipt is
	// built from the driver's own argv instead of buildDispatch's.
	if (hasSessionDriver(agent)) {
		const driver = SESSION_DRIVERS[agent]!();
		return {
			version: 1,
			executable: adapter.bin,
			argv: driver.buildArgv({ task, cwd, mode, model, effort }),
			promptArgIndex: -1,
			prompt: task,
			cwd,
			cwdForwardedToCli: driver.cwdForwardedToCli,
			stdin: driver.stdinFormat ?? "jsonrpc",
			shell: false,
			agent,
			provider: adapter.provider,
			requestedMode: mode,
			effectivePolicy: adapter.sessionPolicy?.(mode) ?? `${adapter.session?.steerNote ?? "session"} (persistent session)`,
			readOnlyEnforcement: mode === "readonly" ? "harness-enforced" : "not-applicable",
			model: model
				? { requested: model, forwarded: true, note: "Passed to the persistent session at startup." }
				: { forwarded: false, note: "No model override requested; target CLI/config selects the model." },
			effort: effort
				? { requested: effort, forwarded: effortForwardedOnSession(agent), note: effortSessionNote(agent, effort) }
				: { forwarded: false, note: "No effort override requested; the target CLI/config default applies." },
			notify,
			watchdogMs,
			environment: INHERITED_ENVIRONMENT_NOTICE,
			transport: "persistent",
		};
	}
	const adapterDispatch = adapter.buildDispatch({ task, cwd, mode, model, effort });
	return {
		version: 1,
		executable: adapter.bin,
		argv: [...adapterDispatch.argv],
		promptArgIndex: adapterDispatch.promptArgIndex,
		prompt: task,
		cwd,
		cwdForwardedToCli: adapterDispatch.cwdForwardedToCli,
		stdin: "ignored",
		shell: false,
		agent,
		provider: adapter.provider,
		requestedMode: mode,
		effectivePolicy: adapterDispatch.effectivePolicy,
		readOnlyEnforcement: adapterDispatch.readOnlyEnforcement,
		model: { ...adapterDispatch.model },
		effort: { ...adapterDispatch.effort },
		notify,
		watchdogMs,
		environment: INHERITED_ENVIRONMENT_NOTICE,
		transport: "oneshot",
	};
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

/**
 * One requested spec after validation, kept in request order: the caller asked
 * for [codex, kimi] and must get the answers back in exactly that order to read
 * them side by side. `task` is absent exactly when the spec was refused.
 */
interface CompareSlot {
	index: number;
	agent: string;
	task?: Task;
	reason?: string;
	mode?: Mode;
	cwd?: string;
}

type DispatchedCompareSlot = CompareSlot & { task: Task };

function compareSection(slot: CompareSlot): string[] {
	const head = `[${slot.index + 1}] ${escapeTerminalControls(slot.agent)}`;
	if (!slot.task) return [`${head} · refused`, `Refused: ${slot.reason ?? "unknown reason"}`];

	const task = slot.task;
	const lines = [
		`${head} · ${task.id} · ${task.state} · ${fmtDuration((task.endedAt ?? Date.now()) - task.startedAt)} · ` +
			`${modeDisplay(task.mode)} · ${escapeTerminalControls(task.cwd)}`,
	];
	if (task.state === "done") {
		if (task.verifyResult) lines.push(verifyLine(task.verifyResult));
		const answer = presentAnswer(task, WAIT_ANSWER_PREVIEW_CHARS);
		lines.push(answer.text || `(no answer text was parsed — external_agent_status taskId="${task.id}")`);
		if (answer.truncated) {
			lines.push(
				`[answer truncated at ${WAIT_ANSWER_PREVIEW_CHARS} chars — external_agent_status taskId="${task.id}" has the full text]`,
			);
		}
		return lines;
	}
	if (task.state === "running") {
		lines.push(`still running when the call returned (quiet for ${fmtDuration(Date.now() - task.lastEventAt)})`);
		return lines;
	}
	const detail = [task.spawnError, errorsOf(task)].filter((text): text is string => Boolean(text)).join("; ");
	lines.push(detail || `${task.state} with no error detail — inspect external_agent_status taskId="${task.id}"`);
	return lines;
}

/** The structured half of the receipt: what the caller inspects programmatically. */
function compareResults(slots: CompareSlot[]): CompareResult[] {
	return slots.map((slot) => {
		const task = slot.task;
		if (!task) {
			return {
				index: slot.index,
				agent: slot.agent,
				refused: true,
				reason: slot.reason,
				mode: slot.mode,
				cwd: slot.cwd,
			};
		}
		const result: CompareResult = {
			index: slot.index,
			agent: slot.agent,
			refused: false,
			taskId: task.id,
			state: task.state,
			mode: task.mode,
			cwd: task.cwd,
			dispatch: copyDispatchReceipt(task.dispatch),
		};
		if (task.state === "done") {
			const answer = presentAnswer(task, WAIT_ANSWER_PREVIEW_CHARS);
			if (answer.text) {
				result.answer = answer.text;
				result.answerTruncated = answer.truncated;
			}
		} else if (task.state !== "running") {
			result.reason =
				[task.spawnError, errorsOf(task)].filter((text): text is string => Boolean(text)).join("; ") ||
				`${task.state} with no error detail`;
		}
		return result;
	});
}

/**
 * The text half of the receipt. Answers are pasted verbatim and never compared:
 * judging them (identical, divergent, better) is the caller's job, and an
 * extension that scored them would be answering a question it was not asked.
 */
function compareReport(slots: CompareSlot[], timedOut: boolean, aborted: boolean, timeoutS: number): string {
	const unsettled = slots.filter((slot): slot is DispatchedCompareSlot => slot.task?.state === "running");
	const lines = [
		`Compared ${slots.length} specs on one task with a sync blocking call. Answers below are verbatim and in ` +
			"request order — which ones agree, which disagree and which is better is your judgement to make: this tool " +
			"never diffs, scores or ranks them.",
	];
	for (const slot of slots) lines.push("", ...compareSection(slot));
	if (aborted) lines.push("", "The call was aborted before every agent settled.");
	else if (timedOut) lines.push("", `The ${fmtDuration(timeoutS * 1000)} deadline passed before every agent settled.`);
	if (unsettled.length > 0) {
		const ids = unsettled.map((slot) => slot.task.id);
		lines.push(
			`Still running: ${ids.join(", ")}. Finish them with external_agent_wait taskIds=${JSON.stringify(ids)}, or end your ` +
				"turn: their completion and stall notifications were re-enabled, so settling will re-invoke you.",
		);
	}
	const refused = slots.filter((slot) => !slot.task).length;
	const counted = (state: TaskState) => slots.filter((slot) => slot.task?.state === state).length;
	const counts = [
		`${slots.length} specs`,
		refused > 0 ? `${refused} refused` : null,
		slots.length - refused > 0 ? `${slots.length - refused} dispatched` : null,
		counted("done") > 0 ? `${counted("done")} done` : null,
		counted("failed") > 0 ? `${counted("failed")} failed` : null,
		counted("stopped") > 0 ? `${counted("stopped")} stopped` : null,
		unsettled.length > 0 ? `${unsettled.length} still running` : null,
	].filter((part): part is string => part !== null);
	lines.push("", `summary: ${counts.join(" · ")}`);
	return lines.join("\n");
}

/**
 * Compare starts its tasks with notify "off": for a caller holding the receipt
 * the answers are already in hand, and a callback per agent would be a second
 * copy of what the tool just returned. That stops being true when the deadline
 * or an abort ends the wait early — nobody is left holding those answers — so
 * the still-running ones get the standard notifications back instead of going
 * quiet forever (and the stall watchdog with them, since it skips notify off).
 */
function rearmCompareNotifications(slots: DispatchedCompareSlot[]): void {
	for (const slot of slots) {
		if (slot.task.state === "running") slot.task.notify = "steer";
	}
}

/**
 * Where per-slot evidence rows go: `""` disables the board outright, an explicit
 * path wins, and an omitted param defaults to `<session-dir>/external-agent/
 * board.jsonl` — a default that only exists when the session has a directory.
 */
function boardFileFrom(param: unknown, sessionDir: string | undefined, cwd: string): string | undefined {
	if (param === "") return undefined;
	if (typeof param === "string") return resolve(cwd, param);
	return sessionDir ? join(sessionDir, "external-agent", "board.jsonl") : undefined;
}

/**
 * The report's closing digest: how many rows this call added to the board, or
 * why they are not there. Board trouble never changes the compare result.
 */
function boardDigest(slots: CompareSlot[], boardFile: string | undefined): string | undefined {
	if (!boardFile) return undefined;
	const failure = slots.find((slot) => slot.task?.boardError)?.task?.boardError;
	if (failure) return `board: unavailable (${failure})`;
	const written = slots.filter((slot) => slot.task?.boardWritten).length;
	return `board: ${boardFile} (+${written} entries)`;
}

// ---------------------------------------------------------------------------
// Relay: one worker's answer into another worker's session
// ---------------------------------------------------------------------------

/**
 * How far a message may travel from the coordinator's own dispatch. Past this the
 * workers are negotiating among themselves, and the coordinator — the party that
 * owns the judgment — is the one who has to carry it.
 */
const RELAY_MAX_HOPS = 2;
/** Selection window, in UTF-8 bytes: a default that fits one turn, a hard ceiling. */
const RELAY_DEFAULT_BYTES = 4_000;
const RELAY_MAX_BYTES = 16_000;
/** How much of the excerpt the coordinator sees in the receipt. */
const RELAY_RECEIPT_CHARS = 500;
/** Upper bound on anchors listed for one relay; the body stays the claim surface. */
const RELAY_MAX_ANCHORS = 12;

function isRelayPurpose(value: unknown): value is RelayPurpose {
	return value === "reproduce" || value === "combine" || value === "challenge";
}

/**
 * A byte window of an answer that never reached the archive (short, or archiving
 * was unavailable). Cut on character boundaries, the same rule readChunk follows,
 * so a slice can never emit half a character.
 */
function sliceUtf8(text: string, offset: number, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	let start = offset > 0 ? Math.min(Math.floor(offset), buffer.byteLength) : 0;
	while (start < buffer.byteLength && (buffer[start] & 0xc0) === 0x80) start += 1;
	let end = Math.min(buffer.byteLength, start + Math.max(1, Math.floor(maxBytes)));
	while (end > start && end < buffer.byteLength && (buffer[end] & 0xc0) === 0x80) end -= 1;
	return buffer.toString("utf8", start, end);
}

/** `path:line` and `path:start-end` references inside an excerpt, deduped and capped. */
function anchorRefs(text: string): string[] {
	const found = text.match(/[\w./-]+\.[A-Za-z0-9]+:\d+(?:-\d+)?/g) ?? [];
	return [...new Set(found)].slice(0, RELAY_MAX_ANCHORS);
}

/**
 * The text a relay delivers: the source excerpt as an envelope, wrapped in the
 * relay-envelope template (project > user > builtin, like any other template) so
 * the receiving worker reads it as data from a peer and answers with anchors.
 */
async function relayEnvelope(
	source: Task,
	target: Task,
	purpose: RelayPurpose,
	excerpt: string,
): Promise<{ text: string; anchors: string[] }> {
	const anchors = anchorRefs(excerpt);
	const message = [
		`from: ${source.id}`,
		`to: ${target.id}`,
		`purpose: ${purpose}`,
		"body:",
		excerpt,
		"anchors:",
		...(anchors.length > 0 ? anchors.map((anchor) => `- ${anchor}`) : ["none"]),
	].join("\n");
	const loaded = await loadTemplate("relay-envelope", { projectDir: target.cwd, homeDir: homedir() });
	return { text: applyTemplate(loaded.body, message), anchors };
}

/**
 * Relay one task's settled answer into another task's live session. The channel is
 * whatever that session actually offers — a steer while it runs, a follow-up once
 * it has settled and its process is still up — and anything else is refused with
 * the reason. It never degrades into a fresh dispatch: a new task holds none of the
 * conversation the message was addressed to.
 */
async function relayAnswerToTask(params: Record<string, unknown>): Promise<AgentToolResult<ExternalAgentRelayDetails>> {
	const targetId = typeof params.taskId === "string" ? params.taskId : "";
	const sourceId = typeof params.fromTaskId === "string" ? params.fromTaskId.trim() : "";
	const known = () => [...tasks.keys()].join(", ") || "(none)";
	const refuse = (reason: string, extra: Partial<ExternalAgentRelayDetails> = {}): AgentToolResult<ExternalAgentRelayDetails> => ({
		content: [{ type: "text", text: `Relay refused: ${reason}` }],
		details: { kind: "external-agent-relay", relayed: false, fromTaskId: sourceId || undefined, taskId: targetId || undefined, reason, ...extra },
	});

	const target = tasks.get(targetId);
	if (!target) return refuse(`unknown taskId "${targetId}". Known: ${known()}`);
	const source = tasks.get(sourceId);
	if (!source) return refuse(`unknown fromTaskId "${sourceId}". Known: ${known()}`);
	if (source === target) return refuse(`${source.id} cannot relay to itself.`);
	if (params.purpose !== undefined && !isRelayPurpose(params.purpose)) {
		return refuse(`purpose must be reproduce, combine or challenge (got "${String(params.purpose)}").`);
	}
	const purpose: RelayPurpose = isRelayPurpose(params.purpose) ? params.purpose : "combine";
	if (source.state === "running") return refuse(`${source.id} is still running, so it has no settled answer to relay.`);
	if (source.state === "stopped") return refuse(`${source.id} was stopped before it settled, so it has no answer to relay.`);
	if (source.relayDepth >= RELAY_MAX_HOPS) {
		return refuse(
			`${source.id} already sits ${source.relayDepth} hops from the coordinator and the limit is ${RELAY_MAX_HOPS}. ` +
				`Read its answer with external_agent_status taskId="${source.id}" and carry it yourself.`,
		);
	}

	const maxBytes =
		typeof params.length === "number" && Number.isFinite(params.length)
			? Math.min(Math.max(Math.floor(params.length), 1), RELAY_MAX_BYTES)
			: RELAY_DEFAULT_BYTES;
	const offset = typeof params.offset === "number" && Number.isFinite(params.offset) && params.offset > 0 ? Math.floor(params.offset) : 0;
	const archived = source.archives?.[source.archives.length - 1];
	let excerpt: string;
	if (archived) {
		try {
			excerpt = (await readChunk(archived.filePath, offset, { maxBytes })).text;
		} catch (err) {
			return refuse(`the archived answer of ${source.id} could not be read: ${err instanceof Error ? err.message : String(err)}`);
		}
	} else {
		excerpt = sliceUtf8(answerOf(source), offset, maxBytes);
	}
	if (!excerpt.trim()) {
		return refuse(
			`${source.id} has no answer text at offset ${offset} (${Buffer.byteLength(answerOf(source), "utf8")} bytes available).`,
		);
	}

	const via: "steer" | "followUp" = target.state === "running" ? "steer" : "followUp";
	const guard = requireCapableTask(target.id, via);
	if ("error" in guard) return refuse(guard.error);
	if (via === "steer") {
		const blocked = target.driver?.steerUnavailableReason;
		if (blocked) return refuse(`${target.id} cannot be steered: ${blocked}`);
	} else if (!target.sessionAlive || !target.driver?.alive) {
		return refuse(
			`The session process for ${target.id} has been reclaimed (idle for ${Math.round(IDLE_REAP_MS / 60_000)}m or stopped), ` +
				"so its conversation is gone. Dispatch a new task with a self-contained prompt instead.",
		);
	}

	let envelope: { text: string; anchors: string[] };
	try {
		envelope = await relayEnvelope(source, target, purpose, excerpt);
	} catch (err) {
		return refuse(`the relay envelope could not be built: ${err instanceof Error ? err.message : String(err)}`);
	}

	let note: string | undefined;
	if (via === "steer") {
		const result = await target.driver!.steer(envelope.text);
		if (!result.accepted) return refuse(`${target.id} did not take the steer: ${result.reason}`, { via });
		note = result.note;
	} else {
		try {
			await target.driver!.followUp(envelope.text);
		} catch (err) {
			return refuse(`${target.id} did not take the relay as a follow-up: ${err instanceof Error ? err.message : String(err)}`, { via });
		}
		beginFollowUpTurn(target);
	}
	target.relayDepth = Math.max(target.relayDepth, source.relayDepth + 1);
	target.relaysReceived += 1;
	pushEvent(target, { kind: "tool", text: `relay from ${source.id} (${purpose})`.slice(0, 200) });

	const bytes = Buffer.byteLength(excerpt, "utf8");
	const sha256 = createHash("sha256").update(excerpt, "utf8").digest("hex");
	const waiting =
		target.notify === "off"
			? `Poll external_agent_status taskId="${target.id}" once it settles: it was dispatched with notify off.`
			: `You will be notified when this turn settles; a wait that returns the answer suppresses that notification.`;
	const lines = [
		`relayed ${source.id}→${target.id}: ${bytes} bytes · sha256:${sha256.slice(0, 8)} · via ${via} · hop ${target.relayDepth}`,
		escapeTerminalControls(excerpt.slice(0, RELAY_RECEIPT_CHARS)),
		archived ? placeholderFor({ ...archived, taskId: source.id }) : "",
		`${target.id} ${via === "steer" ? "keeps running, with the message injected at its next step boundary" : "is running again in the same session"}. ${waiting}`,
		note ? `note: ${note}` : "",
		typeof params.message === "string" && params.message.trim()
			? `note: your message parameter was not sent — fromTaskId composes the text from ${source.id}'s answer.`
			: "",
	];

	return {
		content: [{ type: "text", text: lines.filter(Boolean).join("\n") }],
		details: {
			kind: "external-agent-relay",
			relayed: true,
			fromTaskId: source.id,
			taskId: target.id,
			state: target.state,
			via,
			purpose,
			bytes,
			sha256,
			anchors: envelope.anchors,
			hop: target.relayDepth,
			archiveId: archived?.id,
			note,
		},
	};
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const agentTable = AGENT_IDS.map((id) => {
	const a = ADAPTERS[id];
	const flags = [
		`default: ${a.defaultMode}`,
		a.maxMode !== "yolo" ? `max: ${a.maxMode}` : null,
		a.minMode && a.minMode !== "readonly" ? `${a.minMode}-only` : null,
		a.enforcesReadOnly ? null : "read-only NOT enforceable",
		a.supportedEfforts
			? `effort: ${a.supportedEfforts[0]}..${a.supportedEfforts[a.supportedEfforts.length - 1]}`
			: "no effort control",
		a.session
			? a.session.steer && a.session.followUp
				? "steer+follow-up"
				: a.session.followUp
					? "follow-up only"
					: a.session.steer
						? "steer only"
						: "session"
			: "no steer",
		a.degraded ? `DEGRADED: ${a.degraded}` : null,
	]
		.filter(Boolean)
		.join("; ");
	return `${id} = ${a.provider} — ${a.useFor} [${flags}]`;
}).join(" | ");

const STEER_AGENTS = STEER_AGENT_IDS.join(", ") || "(none)";
const FOLLOWUP_AGENTS = FOLLOWUP_AGENT_IDS.join(", ") || "(none)";

/** Shared guard for the two session-only tools. */
function requireCapableTask(taskId: unknown, capability: "steer" | "followUp"): { task: Task } | { error: string } {
	if (typeof taskId !== "string" || !taskId) {
		return { error: `Missing taskId. Known: ${[...tasks.keys()].join(", ") || "(none)"}` };
	}
	const task = tasks.get(taskId);
	if (!task) return { error: `Unknown taskId "${taskId}". Known: ${[...tasks.keys()].join(", ") || "(none)"}` };
	const supportedList = capability === "steer" ? STEER_AGENTS : FOLLOWUP_AGENTS;
	if (task.transport !== "persistent" || !task.driver) {
		return {
			error:
				`${task.agent} runs as a one-shot process, so it cannot be ${capability === "steer" ? "steered" : "continued"} (${task.id}). ` +
				`${capability === "steer" ? "Steering" : "Follow-up"} is available for: ${supportedList}.`,
		};
	}
	const supportedByAgent = capability === "steer" ? ADAPTERS[task.agent].session?.steer : ADAPTERS[task.agent].session?.followUp;
	if (!supportedByAgent) {
		return {
			error:
				`${task.agent} does not support ${capability === "steer" ? "mid-run steering" : "follow-up"} (${task.id}). ` +
				`${capability === "steer" ? "Steering" : "Follow-up"} is available for: ${supportedList}.`,
		};
	}
	return { task };
}

function steerResultText(task: Task, result: SteerResult): string {
	if (!result.accepted) {
		return [
			`Steer not applied to ${task.id}: ${result.reason}`,
			result.accepted === false && /turn/i.test(result.reason)
				? `The turn may have just ended — call external_agent_follow_up taskId="${task.id}" instead.`
				: "",
		]
			.filter(Boolean)
			.join(" ");
	}
	return `Steering message queued for ${task.id} (${task.agent}). It is injected at the next step boundary, not immediately: whatever tool call is already running finishes first.`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "external_agent_start",
		label: "External Agent",
		description: [
			"Dispatch a task to another coding agent CLI. Returns a taskId immediately; the agent runs in the",
			"background and notifies you when it settles, so you can start several and keep working. There is no",
			"wall-clock timeout, but a stall watchdog (default 15m quiet) also notifies you, so ending your turn",
			"while waiting is safe.",
			`Agents: ${agentTable}.`,
			"Task text must be self-contained: the agent sees none of this conversation; state the goal, files and what to return.",
			"Concurrent write/yolo tasks in one directory are refused; effort is opt-in (see the effort parameter).",
			"pi, codex, reasonix, codebuddy and qoder are persistent sessions (the conversation survives the answer,",
			"so it can be followed up or steered); the others are one-shot with no way back in.",
		].join(" "),
		promptSnippet: "Delegate a task to an external coding agent CLI",
		promptGuidelines: [
			"Default: after dispatching tasks whose results you do not need now, end your turn — completion and stall notifications re-invoke you. Never sleep-poll.",
			"Use external_agent_wait only when the result is needed in this turn.",
			"external_agent_steer is not an interrupt (it lands at the next step boundary); if it reports that the turn already ended, use external_agent_follow_up.",
			"external_agent_follow_up continues the same session instead of re-dispatching work already done.",
			"Treat external agent answers as claims to verify against the code, not as fact.",
			"Opt-in extras: template (output contract) · verify (acceptance run after settle) · status offset (paged recall) · follow_up fromTaskId (relay) · isolate (own worktree) · compare board (evidence rows).",
		],
		parameters: Type.Object({
			agent: StringEnum(AGENT_IDS as unknown as readonly string[]),
			task: Type.String({
				description: "Self-contained task text.",
			}),
			cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the session cwd." })),
			mode: Type.Optional(
				StringEnum(["readonly", "write", "yolo"] as const, {
					description:
						"readonly forbids mutations; write allows workspace edits; yolo removes the sandbox. " +
						"An omitted mode uses the agent's own default.",
				}),
			),
			model: Type.Optional(Type.String({ description: "Override the agent's model, if it supports one." })),
			effort: Type.Optional(
				StringEnum(EFFORT_LEVELS, {
					description:
						"Opt-in reasoning-effort override: set it only when the user explicitly requests an effort level, never " +
						"infer one from task complexity. Omit it to inherit the target CLI/config default (\"off\" is an override, " +
						"not an omission). Per-agent levels: agent table.",
				}),
			),
			notify: Type.Optional(
				StringEnum(["steer", "followUp", "nextTurn", "off"] as const, {
					description:
						"How you are told it settled: steer interrupts at the end of the current tool batch, followUp when you " +
						"are idle, nextTurn on the user's next message, off never (poll external_agent_status).",
				}),
			),
			watchdog: Type.Optional(
				Type.Number({
					description:
						"Minutes of no activity before a stall notice (default 15; 0 disables; notify off suppresses delivery only).",
				}),
			),
			template: Type.Optional(
				Type.String({
					description: "Task template name (e.g. evidence-research, verify-report); wraps the task with an output contract.",
				}),
			),
			verify: Type.Optional(
				Type.Object(
					{
						command: Type.String(),
						timeoutSeconds: Type.Optional(Type.Number()),
					},
					{ description: "After settle, run this acceptance command and report its exit code (mechanical, no verdict)." },
				),
			),
			isolate: Type.Optional(
				Type.Boolean({
					description: "Run in a fresh git worktree under .external-agent/worktrees",
				}),
			),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const agent =
				typeof params.agent === "string" && AGENT_IDS.includes(params.agent as AgentId)
					? (params.agent as AgentId)
					: undefined;
			if (!agent) throw new Error("Invalid external agent after tool-call interception.");
			if (typeof params.task !== "string") throw new Error("Invalid external-agent task after tool-call interception.");
			const adapter = ADAPTERS[agent];
			const mode = isMode(params.mode) ? params.mode : adapter.defaultMode;
			const cwdInput = typeof params.cwd === "string" ? params.cwd.replace(/^@/, "") : ctx.cwd;
			const cwd = resolve(ctx.cwd, cwdInput);
			const notify = isNotifyMode(params.notify) ? params.notify : "steer";
			const watchdogMs =
				typeof params.watchdog === "number" && Number.isFinite(params.watchdog)
					? Math.max(0, params.watchdog) * 60_000
					: DEFAULT_WATCHDOG_MS;
			const model = typeof params.model === "string" ? params.model : undefined;
			const effort = isEffort(params.effort) ? params.effort : undefined;

			// isolate: the worker gets its own checkout, so the id and the repository
			// must exist before anything is spawned. A cwd outside a git repository is
			// a refusal, never a silent fallback to running unisolated.
			let taskCwd = cwd;
			let worktree: TaskWorktree | undefined;
			let preallocatedId: string | undefined;
			if (params.isolate === true) {
				const top = await findGitTopLevel(cwd);
				if (!top.ok) {
					meter.recordRefused("isolate-not-a-git-repo");
					return {
						content: [{ type: "text", text: `Refused: ${top.reason}` }],
						details: { refused: true },
					};
				}
				preallocatedId = nextId(agent);
				worktree = {
					path: join(top.toplevel, WORKTREE_DIR, preallocatedId),
					branch: `ea-${preallocatedId}`,
					base: top.toplevel,
				};
			}

			// The conflict check sees where the worker will actually run: an isolated
			// task's own fresh worktree, which no running task can be occupying.
			const checked = validateDispatch(agent, mode, cwd, effort, worktree?.path ?? cwd);
			if (!checked.ok) {
				meter.recordRefused(checked.reason);
				return {
					content: [{ type: "text", text: `Refused: ${checked.reason}` }],
					details: { refused: true },
				};
			}

			// Archive root for settle-time finalize; ephemeral sessions leave it off.
			try {
				finalizeHooks.sessionDir = ctx.sessionManager.getSessionDir() ?? undefined;
			} catch {
				// no persistent session directory: archiving stays off
			}

			let taskText = params.task;
			let templateLabel: string | undefined;
			if (typeof params.template === "string" && params.template) {
				let loaded;
				try {
					loaded = await loadTemplate(params.template, { projectDir: cwd, homeDir: homedir() });
				} catch (err) {
					meter.recordRefused("template-not-found");
					return {
						content: [{ type: "text", text: `Refused: ${err instanceof Error ? err.message : String(err)}` }],
						details: { refused: true },
					};
				}
				taskText = applyTemplate(loaded.body, taskText);
				templateLabel = `${loaded.name}@${loaded.version}`;
			}

			// Created last among the preparations: a refusal above must not leave an
			// unused worktree behind, and a failed create cleans up after itself.
			if (worktree) {
				const created = await createTaskWorktree(worktree);
				if (!created.ok) {
					meter.recordRefused("isolate-worktree-failed");
					return {
						content: [{ type: "text", text: `Refused: ${created.reason}` }],
						details: { refused: true },
					};
				}
				taskCwd = worktree.path;
			}

			const task = startTask(agent, taskText, taskCwd, mode, notify, watchdogMs, model, effort, {
				templateLabel,
				taskId: preallocatedId,
				worktree,
				verifyCommand: typeof params.verify?.command === "string" ? params.verify.command : undefined,
				verifyTimeoutSeconds:
					typeof params.verify?.timeoutSeconds === "number" && Number.isFinite(params.verify.timeoutSeconds)
						? params.verify.timeoutSeconds
						: undefined,
			});

			const notes: string[] = [];
			if (adapter.degraded) notes.push(`note: ${agent} is degraded — ${adapter.degraded}`);
			if (mode === "readonly" && !adapter.enforcesReadOnly) {
				notes.push(`warning: ${agent} cannot enforce read-only; it may still modify files`);
			}
			if (mode === "yolo") {
				notes.push("warning: yolo runs with no sandbox; the agent can modify or delete anything on this machine");
			}
			if (worktree) {
				notes.push(
					`worktree: ${worktree.path} (branch ${worktree.branch}) — the worker runs there, and the hub does not merge or delete it.`,
				);
			}
			if (task.state === "failed") {
				return {
					content: [
						{ type: "text", text: `Failed to start ${agent}: ${task.spawnError ?? "unknown spawn error"}` },
					],
					details: { kind: "external-agent-start", task: taskSnapshot(task) },
				};
			}

			const persistent = task.transport === "persistent";
			const steerBlocked = task.driver?.steerUnavailableReason;
			const canSteer = adapter.session?.steer === true && !steerBlocked;
			const sessionNote = persistent
				? canSteer
					? `This session stays alive after it settles: steer it with external_agent_steer taskId="${task.id}" while it runs, or continue it with external_agent_follow_up taskId="${task.id}" (reclaimed after ${Math.round(IDLE_REAP_MS / 60_000)}m idle).`
					: `This session stays alive after it settles: continue it with external_agent_follow_up taskId="${task.id}" (reclaimed after ${Math.round(IDLE_REAP_MS / 60_000)}m idle). ${steerBlocked ? "Steering compatibility is pending initialization; inspect external_agent_status after startup for the result." : "It does not support mid-run steering."}`
				: null;
			return {
				content: [
					{
						type: "text",
						text: [
							`Started ${agent} as ${task.id} (${modeDisplay(task.mode)}) in ${escapeTerminalControls(taskCwd)}.`,
							...notes,
							task.notify === "off"
								? `No callback was requested, so poll external_agent_status taskId="${task.id}" at sparse intervals (at least 60s apart).`
								: [
										`If you need the result in this turn, call external_agent_wait with taskIds=["${task.id}"]; a wait that returns the answer suppresses that task's settle notification.`,
										task.watchdogMs > 0
											? `Otherwise end your turn now: you will be notified when it settles, and the stall watchdog (${Math.round(task.watchdogMs / 60_000)}m) will notify you if it goes quiet. Do not sleep-poll.`
											: "Otherwise end your turn now: you will be notified when it settles. Do not sleep-poll.",
									].join(" "),
							sessionNote,
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
				details: { kind: "external-agent-start", task: taskSnapshot(task) },
			};
		},

		renderCall(args, theme, context) {
			const receipt = receiptFromStartArgs(args as Record<string, unknown>, context.cwd);
			if (!receipt) return new Text(theme.fg("error", "external-agent: invalid dispatch arguments"), 0, 0);
			const title = theme.fg("toolTitle", theme.bold("external-agent requested dispatch"));
			if (context.executionStarted && !context.expanded) {
				return new Text(`${title}\n${theme.fg("dim", `${receipt.agent} · ${receipt.requestedMode} · ${taskPromptPreview(receipt.prompt)}`)}`, 0, 0);
			}
			return new Text(`${title}\n${theme.fg("muted", renderReceipt(receipt, "pending", context.expanded, "requested dispatch (not yet executed)"))}`, 0, 0);
		},

		renderResult(result, { expanded }, theme, context) {
			const details = result.details as { kind?: unknown; task?: unknown } | undefined;
			const snapshot = details && isTaskSnapshot(details.task) ? details.task : undefined;
			if (snapshot) {
				const status = snapshot.state === "failed" ? "error" : snapshot.state === "running" ? "warning" : "success";
				return new Text(theme.fg(status, renderResultWithReceipt(result, renderTaskSnapshot(snapshot, expanded), expanded)), 0, 0);
			}
			const receipt = receiptFromStartArgs(context.args as Record<string, unknown>, context.cwd);
			if (receipt) {
				return new Text(
					theme.fg(
						"muted",
						renderResultWithReceipt(
							result,
							renderReceipt(receipt, "unknown", expanded, "derived from original tool call; actual receipt unavailable"),
							expanded,
						),
					),
					0,
					0,
				);
			}
			return new Text(theme.fg("toolOutput", resultText(result) || "(no output)"), 0, 0);
		},
	});

	pi.registerTool({
		name: "external_agent_status",
		label: "External Agent Status",
		description: [
			"Check background external agent tasks. Omit taskId to list all; one task shows elapsed and quiet time plus",
			"recent activity, and its answer once settled. Steady activity means working; a long quiet stretch means",
			"consider stopping it.",
		].join(" "),
		promptSnippet: "Check background external agent tasks and their answers",
		parameters: Type.Object({
			taskId: Type.Optional(Type.String()),
			tail: Type.Optional(Type.Number({ description: "Recent events to show. Default 8." })),
			offset: Type.Optional(
				Type.Number({ description: "Page the archived answer from this byte offset (from a placeholder's recall hint)." }),
			),
		}),

		async execute(_id, params) {
			if (tasks.size === 0) {
				return {
					content: [{ type: "text", text: "No external agent tasks in this session." }],
					details: {} as ExternalAgentStatusDetails,
				};
			}

			if (params.taskId) {
				const task = tasks.get(String(params.taskId));
				if (!task) {
					return {
						content: [
							{
								type: "text",
								text: `Unknown taskId "${params.taskId}". Known: ${[...tasks.keys()].join(", ")}`,
							},
						],
						details: {} as ExternalAgentStatusDetails,
					};
				}
				if (params.offset !== undefined) {
					const archived = task.archives?.[task.archives.length - 1];
					if (!archived) {
						return {
							content: [{ type: "text", text: `No archived answer for ${task.id} (answer stayed inline; use external_agent_status without offset).` }],
							details: {} as ExternalAgentStatusDetails,
						};
					}
					try {
						const page = await readChunk(archived.filePath, Number(params.offset));
						const header = `[recall ${archived.id} offset=${Math.max(0, Math.floor(Number(params.offset)))} next_offset=${page.nextOffset} eof=${page.eof}]`;
						return {
							content: [{ type: "text", text: `${header}\n${page.text}` }],
							details: {} as ExternalAgentStatusDetails,
						};
					} catch (err) {
						return {
							content: [{ type: "text", text: `Recall failed for ${archived.id}: ${err instanceof Error ? err.message : String(err)}` }],
							details: {} as ExternalAgentStatusDetails,
						};
					}
				}
				return {
					content: [{ type: "text", text: `${detailReport(task, Number(params.tail ?? 8))}${await inventorySuffix()}` }],
					details: {
						kind: "external-agent-status",
						task: taskSnapshot(task),
						requestedTail: Number(params.tail ?? 8),
					} as ExternalAgentStatusDetails,
				};
			}

			const lines = [...tasks.values()].flatMap((t) => {
				const line = `${summarize(t)} — ${t.agent}: ${t.task.slice(0, 80)}`;
				return t.worktree ? [line, `  worktree: ${t.worktree.path} (branch ${t.worktree.branch})`] : [line];
			});
			return {
				content: [{ type: "text", text: lines.join("\n") + (await inventorySuffix()) }],
				details: {
					kind: "external-agent-status-list",
					tasks: [...tasks.values()].map(taskSnapshot),
				} as ExternalAgentStatusDetails,
			};
		},

		renderCall(args, theme, _context) {
			const taskId = typeof args.taskId === "string" ? escapeTerminalControls(args.taskId) : "all tasks";
			const tail = typeof args.tail === "number" ? ` · tail ${args.tail}` : "";
			return new Text(theme.fg("toolTitle", theme.bold("external-agent status ")) + theme.fg("accent", `${taskId}${tail}`), 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as { kind?: unknown; task?: unknown; tasks?: unknown } | undefined;
			if (details?.kind === "external-agent-status" && isTaskSnapshot(details.task)) {
				return new Text(theme.fg("toolOutput", renderResultWithReceipt(result, renderTaskSnapshot(details.task, expanded), expanded)), 0, 0);
			}
			if (details?.kind === "external-agent-status-list" && Array.isArray(details.tasks)) {
				const snapshots = details.tasks.filter(isTaskSnapshot);
				if (snapshots.length > 0) {
					const receiptText = expanded
						? snapshots.map((snapshot) => renderTaskSnapshot(snapshot, true)).join("\n\n")
						: snapshots
							.map((snapshot) => `${escapeTerminalControls(snapshot.taskId)} · ${escapeTerminalControls(snapshot.agent)} · ${escapeTerminalControls(snapshot.state)}\n  ${taskPromptPreview(snapshot.dispatch.prompt)}`)
							.join("\n");
					return new Text(theme.fg("toolOutput", renderResultWithReceipt(result, receiptText, expanded)), 0, 0);
				}
			}
			return new Text(theme.fg("toolOutput", resultText(result) || "(no output)"), 0, 0);
		},
	});

	pi.registerTool({
		name: "external_agent_wait",
		label: "External Agent Wait",
		description: [
			"Block until external agent tasks settle or the timeout elapses; it also returns early once every",
			"watched task is quiet for its watchdog. On settle it returns the answer and suppresses that task's",
			"notification; otherwise a summary.",
		].join(" "),
		promptSnippet: "Block until external agent tasks settle or time out",
		parameters: Type.Object({
			taskIds: Type.Array(Type.String(), { description: "Task ids from external_agent_start." }),
			timeout: Type.Optional(
				Type.Number({ description: `Seconds to wait at most (default ${WAIT_DEFAULT_TIMEOUT_S}, max ${WAIT_MAX_TIMEOUT_S}).` }),
			),
			mode: Type.Optional(
				StringEnum(["all", "any"] as const, {
					description: "all (default): return when every listed task has settled. any: return as soon as the first one settles.",
				}),
			),
		}),

		async execute(_id, params, signal, onUpdate): Promise<AgentToolResult<ExternalAgentWaitDetails>> {
			const requested = Array.isArray(params.taskIds) ? params.taskIds.map(String) : [];
			if (requested.length === 0) {
				return {
					content: [{ type: "text", text: "No taskIds given. Known: " + ([...tasks.keys()].join(", ") || "(none)") }],
					details: {},
				};
			}
			const unknown = requested.filter((id) => !tasks.has(id));
			const watched = requested.filter((id) => tasks.has(id)).map((id) => tasks.get(id)!);
			if (watched.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `Unknown taskIds: ${unknown.join(", ")}. Known: ${[...tasks.keys()].join(", ") || "(none)"}`,
						},
					],
					details: {},
				};
			}

			const waitAll = params.mode !== "any";
			// notify "off" suppresses delivery, not stall detection: the wait still
			// ends early below, only the wording of its advice changes.
			const allNotifyOff = watched.every((t) => t.notify === "off");
			// Registered before the first await, so a settle racing this call cannot
			// slip a notification past the wait. The token is the claim ticket: this
			// call's receipt replaces the push that notifyTaskSettled would send.
			const token = Symbol("wait");
			for (const task of watched) (task.waiters ??= new Set()).add(token);
			// Event counts are per call: the report's activity line covers this window.
			const seqAtWait = new Map(watched.map((task) => [task, task.eventSeq]));
			try {
				const timeoutS =
					typeof params.timeout === "number" && Number.isFinite(params.timeout)
						? Math.min(Math.max(params.timeout, 5), WAIT_MAX_TIMEOUT_S)
						: WAIT_DEFAULT_TIMEOUT_S;
				const deadline = stallClock.now() + timeoutS * 1000;

				const report = (timedOut: boolean, aborted: boolean, stalled: false | StallKind) => {
					const lines: string[] = [];
					if (unknown.length > 0) lines.push(`Unknown taskIds (ignored): ${unknown.join(", ")}`);
					if (aborted) {
						lines.push("Wait aborted before the tasks settled.");
					} else if (stalled) {
						// Worded like the timeout report it stands in for: the task may still
						// be alive, but while this call blocks no stall notice can get through.
						const now = stallClock.now();
						const stalledFor = watched
							.filter((t) => t.state === "running")
							.map((t) => `${t.id} ${stallPhrase(t, stallKind(t, now) ?? stalled, now)}`)
							.join(", ");
						lines.push(
							`${stalledFor} — ` +
								(allNotifyOff
									? "notify is off, so no stall notice will be delivered: wait again, steer/stop it, or poll external_agent_status."
									: "no stall notice can reach you while this call blocks: wait again, steer/stop it, or end your turn and rely on the watchdog."),
						);
					} else if (timedOut) {
						lines.push(
							allNotifyOff
								? `Still running after ${fmtDuration(timeoutS * 1000)}. Notifications are off for every watched task, so poll external_agent_status at sparse intervals; waiting again only blocks.`
								: `Still running after ${fmtDuration(timeoutS * 1000)}. Wait again, do other work, or end your turn and rely on completion/stall notifications.`,
						);
					}
					for (const task of watched) {
						lines.push(summarize(task));
						lines.push(eventProfileLine(task, task.eventSeq - (seqAtWait.get(task) ?? 0)));
						if (task.worktree) lines.push(`worktree: ${task.worktree.path} (branch ${task.worktree.branch})`);
						if (task.state !== "running") {
							// Settled evidence, worded like the notice this report replaces.
							if (task.retainedWorktrees) lines.push(task.retainedWorktrees);
							if (task.state === "done") {
								if (task.verifyResult) lines.push(verifyLine(task.verifyResult));
								const preview = presentAnswer(task, WAIT_ANSWER_PREVIEW_CHARS);
								if (preview.text) {
									lines.push(preview.text);
									if (preview.truncated) {
										lines.push(`[preview only — call external_agent_status taskId="${task.id}" for the full answer]`);
									}
								} else {
									lines.push(`No answer text was parsed. Inspect with external_agent_status taskId="${task.id}".`);
								}
							} else {
								const errs = errorsOf(task);
								if (task.spawnError) lines.push(`spawn error: ${task.spawnError}`);
								if (errs) lines.push(`errors: ${truncate(errs, 500).text}`);
							}
						}
					}
					return lines.join("\n");
				};

				onUpdate?.({
					content: [
						{
							type: "text",
							text: `Waiting for ${watched.map((t) => t.id).join(", ")} (${waitAll ? "all" : "any"}, timeout ${timeoutS}s)`,
						},
					],
					details: {},
				});

				return await new Promise((resolvePromise) => {
					let finished = false;
					const finish = async (timedOut: boolean, aborted: boolean, stalled: false | StallKind) => {
						// Idempotent: check and abort can both land before this resolves.
						if (finished) return;
						finished = true;
						clearInterval(timer);
						signal?.removeEventListener("abort", onAbort);
						// Settle finalize (archive/verify) is async; the report must see its results.
						await Promise.all(watched.map((t) => t.finalizePromise));
						// Drop this call's tokens; the last waiter out settles each task. A
						// non-aborted finish claims the settled ones — the receipt carries the
						// answer, so the push would be a duplicate. An abort releases them
						// instead: the tool result may never be read, so the notice goes out
						// after all. Running tasks are left alone — their settle is still ahead.
						for (const task of watched) {
							task.waiters?.delete(token);
							if (task.state === "running" || task.notified || task.notify === "off") continue;
							if (aborted) notifyTaskSettled(task);
							else {
								task.notified = true;
								taskRegistry.pendingNotificationIds.delete(task.id);
							}
						}
						resolvePromise({
							content: [{ type: "text", text: report(timedOut, aborted, stalled) }],
							details: {
								kind: "external-agent-wait",
								timedOut,
								aborted,
								stalled,
								tasks: watched.map(taskSnapshot),
							},
						});
					};
					const check = () => {
						const settled = watched.filter((t) => t.state !== "running");
						const condition = waitAll ? settled.length === watched.length : settled.length > 0;
						if (condition) return finish(false, false, false);
						const now = stallClock.now();
						if (now >= deadline) return finish(true, false, false);
						// Third exit: every running task has stalled — quiet past its
						// effective threshold, or struggling past the meaningful gap — so the
						// stall notice the model is waiting for cannot reach it while this
						// call blocks. Settle above always wins; a mode "any" batch still
						// needs all of its tasks stalled. Claiming one notice slot per stall
						// streak, shared with the scanner, keeps a wait-again loop from
						// re-reporting a stall already reported, and once the streak hits
						// its cap the model has been told: continuing is then an informed
						// choice. A mixed batch reports the worse of the two kinds.
						const running = watched.filter((t) => t.state === "running");
						if (running.length === 0) return;
						const stalls = running.map((t) => stallKind(t, now));
						if (stalls.some((stall) => stall === null)) return;
						if (!running.every((task, index) => stallNoticeDue(task, now, stalls[index]!))) return;
						for (const task of running) claimStallNotice(task, now);
						return finish(false, false, stalls.every((stall) => stall === "quiet") ? "quiet" : "struggling");
					};
					const onAbort = () => finish(false, true, false);
					// Ref'd on purpose: an in-flight wait is active work and must keep the
					// event loop alive (print mode exits once only unref'd handles remain).
					const timer = setInterval(check, 2_000);
					signal?.addEventListener("abort", onAbort);
					check();
				});
			} catch (err) {
				// The wait never started — no timer, no promise handed back — so no
				// finish will ever claim or release: drop the tokens rather than hold
				// the tasks until session_start.
				for (const task of watched) task.waiters?.delete(token);
				throw err;
			}
		},
	});

	pi.registerTool({
		name: "external_agent_compare",
		label: "External Agent Compare",
		description: [
			"Put one task to several agent CLIs in one blocking call (specs[].task overrides it per slot): every valid",
			"spec is dispatched in parallel with its own mode, model, effort and cwd; the answers come back side by",
			"side once they settle or the",
			"timeout elapses. It never diffs, scores or ranks — judging is yours. A spec that fails validation",
			"(unsupported mode or effort, write/yolo conflict in its cwd) is recorded as a refusal while the others",
			"still run. On timeout the receipt lists the taskIds still running: finish them with external_agent_wait,",
			"or end your turn; their notifications re-invoke you. Use external_agent_start to keep working meanwhile.",
		].join(" "),
		promptSnippet: "Ask several external agent CLIs the same task at once",
		promptGuidelines: [
			"Prefer external_agent_compare over chaining agents in a pipeline: disagreement between answers is the signal.",
			"specs[].task overrides the shared task per slot; template/verify apply to every slot.",
		],
		parameters: Type.Object({
			task: Type.String({
				description: "Self-contained instruction sent to every agent.",
			}),
			agents: Type.Array(
				Type.Object({
					agent: StringEnum(AGENT_IDS as unknown as readonly string[]),
					task: Type.Optional(
						Type.String({ description: "Per-slot task override; defaults to the shared task." }),
					),
					cwd: Type.Optional(
						Type.String({
							description: "Working directory for this agent. Defaults to the session cwd.",
						}),
					),
					mode: Type.Optional(
						StringEnum(["readonly", "write", "yolo"] as const, {
							description: "Permission mode for this agent. An omitted mode uses its own default.",
						}),
					),
					model: Type.Optional(Type.String({ description: "Override this agent's model." })),
					effort: Type.Optional(
						StringEnum(EFFORT_LEVELS, {
							description: "Same opt-in effort rules as external_agent_start.",
						}),
					),
				}),
				{
					minItems: COMPARE_MIN_AGENTS,
					maxItems: COMPARE_MAX_AGENTS,
					description: `Two to ${COMPARE_MAX_AGENTS} agents to compare.`,
				},
			),
			timeout: Type.Optional(
				Type.Number({
					description: `Seconds to wait for the whole batch (default ${WAIT_DEFAULT_TIMEOUT_S}, max ${WAIT_MAX_TIMEOUT_S}).`,
				}),
			),
			template: Type.Optional(
				Type.String({ description: "Task template applied to every slot (see external_agent_start)." }),
			),
			verify: Type.Optional(
				Type.Object(
					{
						command: Type.String(),
						timeoutSeconds: Type.Optional(Type.Number()),
					},
					{ description: "After each slot settles, run this acceptance command and report its exit code." },
				),
			),
			isolate: Type.Optional(
				Type.Boolean({
					description: "Run in a fresh git worktree under .external-agent/worktrees",
				}),
			),
			board: Type.Optional(
				Type.String({
					description: "Append per-slot evidence rows to this JSONL board (\"\" disables)",
				}),
			),
		}),

		async execute(_id, params, signal, onUpdate, ctx): Promise<AgentToolResult<ExternalAgentCompareDetails>> {
			const taskText = typeof params.task === "string" ? params.task : "";
			const specs = Array.isArray(params.agents) ? params.agents : [];
			const noRun = (text: string): AgentToolResult<ExternalAgentCompareDetails> => ({
				content: [{ type: "text", text }],
				details: { kind: "external-agent-compare", timedOut: false, aborted: false, results: [] },
			});
			// The schema enforces these bounds too; a direct execute call (tests,
			// interception) must not get further than the schema would have.
			if (specs.length < COMPARE_MIN_AGENTS) {
				return noRun(
					`Refused: external_agent_compare needs at least ${COMPARE_MIN_AGENTS} agent specs (got ${specs.length}). ` +
						"For a single agent use external_agent_start and external_agent_wait.",
				);
			}
			if (specs.length > COMPARE_MAX_AGENTS) {
				return noRun(
					`Refused: external_agent_compare accepts at most ${COMPARE_MAX_AGENTS} agent specs (got ${specs.length}). ` +
						"Compare them in batches instead.",
				);
			}

			const timeoutS =
				typeof params.timeout === "number" && Number.isFinite(params.timeout)
					? Math.min(Math.max(params.timeout, 5), WAIT_MAX_TIMEOUT_S)
					: WAIT_DEFAULT_TIMEOUT_S;

			// Archive root for settle-time finalize; ephemeral sessions leave it off.
			try {
				finalizeHooks.sessionDir = ctx.sessionManager.getSessionDir() ?? undefined;
			} catch {
				// no persistent session directory: archiving stays off
			}
			// Evidence board, resolved once for the whole batch: each settled slot
			// appends its own row there (see appendBoardEntry).
			const boardFile = boardFileFrom(params.board, finalizeHooks.sessionDir, ctx.cwd);

			let templateBody: string | undefined;
			let templateLabel: string | undefined;
			if (typeof params.template === "string" && params.template) {
				try {
					const loaded = await loadTemplate(params.template, { projectDir: ctx.cwd, homeDir: homedir() });
					applyTemplate(loaded.body, ""); // dry-run: a body without {{TASK}} must not reach dispatch
					templateBody = loaded.body;
					templateLabel = `${loaded.name}@${loaded.version}`;
				} catch (err) {
					meter.recordRefused("template-not-found");
					return noRun(`Refused: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			const extras: DispatchExtras = {
				templateLabel,
				verifyCommand: typeof params.verify?.command === "string" ? params.verify.command : undefined,
				verifyTimeoutSeconds:
					typeof params.verify?.timeoutSeconds === "number" && Number.isFinite(params.verify.timeoutSeconds)
						? params.verify.timeoutSeconds
						: undefined,
			};

			const slots: CompareSlot[] = [];
			for (const [index, spec] of specs.entries()) {
				// A malformed spec is one refused entry, not a thrown call: the other
				// specs in the batch are still worth running.
				const agent =
					typeof spec?.agent === "string" && AGENT_IDS.includes(spec.agent as AgentId)
						? (spec.agent as AgentId)
						: undefined;
				if (!agent) {
					slots.push({
						index,
						agent: typeof spec?.agent === "string" ? spec.agent : "(missing)",
						reason: `unknown agent. Known: ${AGENT_IDS.join(", ")}`,
					});
					continue;
				}
				const adapter = ADAPTERS[agent];
				const mode = isMode(spec.mode) ? spec.mode : adapter.defaultMode;
				const cwdInput = typeof spec.cwd === "string" ? spec.cwd.replace(/^@/, "") : ctx.cwd;
				const cwd = resolve(ctx.cwd, cwdInput);
				const model = typeof spec.model === "string" ? spec.model : undefined;
				const effort = isEffort(spec.effort) ? spec.effort : undefined;

				// isolate is per slot: each worker gets its own checkout, so two
				// write slots in one repository no longer collide on the cwd.
				let slotCwd = cwd;
				let slotWorktree: TaskWorktree | undefined;
				let preallocatedId: string | undefined;
				if (params.isolate === true) {
					const top = await findGitTopLevel(cwd);
					if (!top.ok) {
						meter.recordRefused("isolate-not-a-git-repo");
						slots.push({ index, agent, reason: top.reason, mode, cwd });
						continue;
					}
					preallocatedId = nextId(agent);
					slotWorktree = {
						path: join(top.toplevel, WORKTREE_DIR, preallocatedId),
						branch: `ea-${preallocatedId}`,
						base: top.toplevel,
					};
				}

				// One refused spec must not cost the caller the others: it is recorded
				// with its reason and the loop keeps going.
				const checked = validateDispatch(agent, mode, cwd, effort, slotWorktree?.path ?? cwd);
				if (!checked.ok) {
					meter.recordRefused(checked.reason);
					slots.push({ index, agent, reason: checked.reason, mode, cwd });
					continue;
				}

				if (slotWorktree) {
					const created = await createTaskWorktree(slotWorktree);
					if (!created.ok) {
						meter.recordRefused("isolate-worktree-failed");
						slots.push({ index, agent, reason: created.reason, mode, cwd });
						continue;
					}
					slotCwd = slotWorktree.path;
				}

				// Same dispatch path as external_agent_start — persistent session
				// driver when the adapter has one, one-shot process otherwise. notify
				// is off because this receipt is the notification (see
				// rearmCompareNotifications for the timeout case).
				const slotTask = typeof spec.task === "string" && spec.task ? spec.task : taskText;
				const task = startTask(
					agent,
					templateBody ? applyTemplate(templateBody, slotTask) : slotTask,
					slotCwd,
					mode,
					"off",
					DEFAULT_WATCHDOG_MS,
					model,
					effort,
					{ ...extras, taskId: preallocatedId, worktree: slotWorktree },
				);
				if (boardFile) task.boardFile = boardFile;
				slots.push({ index, agent, task, mode, cwd });
			}

			const dispatched = slots.filter((slot): slot is DispatchedCompareSlot => slot.task !== undefined);
			if (dispatched.length > 0) {
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `Comparing ${dispatched.map((slot) => slot.task.id).join(", ")} (timeout ${timeoutS}s)`,
						},
					],
					details: { kind: "external-agent-compare", timedOut: false, aborted: false, results: compareResults(slots) },
				});
			}

			let timedOut = false;
			let aborted = false;
			if (dispatched.length > 0) {
				const deadline = Date.now() + timeoutS * 1000;
				const outcome = await new Promise<{ timedOut: boolean; aborted: boolean }>((resolvePromise) => {
					const finish = (nextTimedOut: boolean, nextAborted: boolean) => {
						clearInterval(timer);
						signal?.removeEventListener("abort", onAbort);
						resolvePromise({ timedOut: nextTimedOut, aborted: nextAborted });
					};
					const check = () => {
						if (dispatched.every((slot) => slot.task.state !== "running")) return finish(false, false);
						if (Date.now() >= deadline) return finish(true, false);
					};
					const onAbort = () => finish(false, true);
					// Ref'd on purpose, like external_agent_wait: an in-flight compare is
					// active work and must keep the event loop alive.
					const timer = setInterval(check, COMPARE_POLL_INTERVAL_MS);
					signal?.addEventListener("abort", onAbort);
					check();
				});
				timedOut = outcome.timedOut;
				aborted = outcome.aborted;
				if (timedOut || aborted) rearmCompareNotifications(dispatched);
				// Settle finalize (archive/verify) is async; the report must see its results.
				await Promise.all(dispatched.map((slot) => slot.task.finalizePromise));
			}

			const digest = boardDigest(slots, boardFile);
			return {
				content: [
					{
						type: "text",
						text: [compareReport(slots, timedOut, aborted, timeoutS), digest].filter(Boolean).join("\n"),
					},
				],
				details: { kind: "external-agent-compare", timedOut, aborted, results: compareResults(slots) },
			};
		},

		renderCall(args, theme, _context) {
			const specs = Array.isArray(args.agents) ? (args.agents as Array<Record<string, unknown>>) : [];
			const names = specs.map((spec) => (typeof spec?.agent === "string" ? spec.agent : "?")).join(" vs ");
			const preview = typeof args.task === "string" ? taskPromptPreview(args.task, 60) : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("external-agent compare ")) +
					theme.fg("accent", `${names || "(no agents)"} · ${preview}`),
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as Partial<ExternalAgentCompareDetails> | undefined;
			const results = Array.isArray(details?.results) ? details.results : [];
			const unmet = details?.timedOut === true || details?.aborted === true || results.some((entry) => entry.refused || entry.state !== "done");
			const output = resultText(result) || "(no output)";
			if (!expanded || results.length === 0) {
				return new Text(theme.fg(unmet ? "warning" : "success", output), 0, 0);
			}
			const receipts = results
				.map((entry) =>
					entry.dispatch && entry.taskId
						? renderReceipt(entry.dispatch, entry.taskId, true, "actual process dispatch")
						: `[${entry.index + 1}] ${escapeTerminalControls(entry.agent)} · refused: ${escapeTerminalControls(entry.reason ?? "unknown reason")}`,
				)
				.join("\n\n");
			return new Text(theme.fg(unmet ? "warning" : "success", `${output}\n\n─── Dispatch receipts ───\n${receipts}`), 0, 0);
		},
	});

	pi.registerTool({
		name: "external_agent_steer",
		label: "External Agent Steer",
		description: [
			"Send a mid-run guidance message to a running external agent task: correct the approach, narrow the scope,",
			"add a constraint, or tell it to wrap up early (to cancel instead, use external_agent_stop). Supported:",
			`${STEER_AGENTS}; the others are one-shot. Qoder steering requires qodercli stable >= 1.1.49 and is refused`,
			"with the reported version otherwise. For a settled task, use external_agent_follow_up.",
		].join(" "),
		promptSnippet: "Redirect a running external agent task mid-run",
		promptGuidelines: [
			`Use external_agent_steer while a ${STEER_AGENTS} task is running to correct its approach instead of stopping and re-dispatching it.`,
		],
		parameters: Type.Object({
			taskId: Type.String({ description: "Task id from external_agent_start." }),
			message: Type.String({
				description: "Guidance to inject; it arrives as a new user message.",
			}),
		}),

		async execute(_id, params): Promise<AgentToolResult<ExternalAgentSteerDetails>> {
			const guard = requireCapableTask(params.taskId, "steer");
			if ("error" in guard) {
				return { content: [{ type: "text", text: guard.error }], details: { steered: false } };
			}
			const task = guard.task;
			if (typeof params.message !== "string" || !params.message.trim()) {
				return { content: [{ type: "text", text: "A non-empty message is required." }], details: { steered: false } };
			}
			if (task.state !== "running") {
				return {
					content: [
						{
							type: "text",
							text: `${task.id} is not running (${task.state}). Use external_agent_follow_up taskId="${task.id}" to continue its session.`,
						},
					],
					details: { steered: false, taskId: task.id, state: task.state },
				};
			}

			const result = await task.driver!.steer(params.message);
			if (!result.accepted) {
				return {
					content: [{ type: "text", text: steerResultText(task, result) }],
					details: { steered: false, taskId: task.id, state: task.state, reason: result.reason },
				};
			}
			pushEvent(task, { kind: "tool", text: `steer: ${params.message}`.slice(0, 200) });
			return {
				content: [{ type: "text", text: `${steerResultText(task, result)}${result.note ? ` (${result.note})` : ""}` }],
				details: { steered: true, taskId: task.id, state: task.state, note: result.note },
			};
		},

		renderCall(args, theme, _context) {
			const taskId = typeof args.taskId === "string" ? escapeTerminalControls(args.taskId) : "?";
			const preview = typeof args.message === "string" ? taskPromptPreview(args.message, 60) : "";
			return new Text(theme.fg("toolTitle", theme.bold("external-agent steer ")) + theme.fg("accent", `${taskId} · ${preview}`), 0, 0);
		},
	});

	pi.registerTool({
		name: "external_agent_follow_up",
		label: "External Agent Follow Up",
		description: [
			"Continue a settled external agent task with another message in the SAME session: it still has everything",
			"it did and learned, so you need not restate the task. It runs again and notifies you when the new turn",
			`settles. Supported: ${FOLLOWUP_AGENTS}. Reclaimed after 30 minutes idle; a follow-up is then refused — dispatch a new`,
			"task instead.",
		].join(" "),
		promptSnippet: "Ask a follow-up in the same external agent session",
		parameters: Type.Object({
			taskId: Type.String({ description: "Task id from external_agent_start." }),
			message: Type.String({ description: "Follow-up text; ignored for a relay." }),
			fromTaskId: Type.Optional(Type.String({ description: "Relay source task; its answer is the body." })),
			purpose: Type.Optional(StringEnum(["reproduce", "combine", "challenge"] as const, { description: "Relay intent." })),
			offset: Type.Optional(Type.Number({ description: "Start byte in the source answer." })),
			length: Type.Optional(Type.Number({ description: "Excerpt bytes (default 4000, max 16000)." })),
		}),

		async execute(_id, params): Promise<AgentToolResult<ExternalAgentFollowUpDetails | ExternalAgentRelayDetails>> {
			// A relay composes its own message from another task's answer, so it takes
			// a different channel decision and never falls through to the plain path.
			if (params.fromTaskId != null) return await relayAnswerToTask(params as Record<string, unknown>);
			const guard = requireCapableTask(params.taskId, "followUp");
			if ("error" in guard) {
				return { content: [{ type: "text", text: guard.error }], details: { continued: false } };
			}
			const task = guard.task;
			if (typeof params.message !== "string" || !params.message.trim()) {
				return { content: [{ type: "text", text: "A non-empty message is required." }], details: { continued: false } };
			}
			if (task.state === "running") {
				const steerBlocked = task.driver?.steerUnavailableReason;
				const canSteer = ADAPTERS[task.agent].session?.steer === true && !steerBlocked;
				return {
					content: [
						{
							type: "text",
							text: canSteer
								? `${task.id} is still running. Use external_agent_steer taskId="${task.id}" for mid-run guidance, or wait for it to settle.`
								: `${task.id} is still running. ${steerBlocked ? `Steering is unavailable: ${steerBlocked}.` : `${task.agent} does not support mid-run steering.`} Wait for it to settle, then follow up.`,
						},
					],
					details: { continued: false, taskId: task.id, state: task.state },
				};
			}
			if (!task.sessionAlive || !task.driver?.alive) {
				return {
					content: [
						{
							type: "text",
							text:
								`The session process for ${task.id} has been reclaimed (idle for ${Math.round(IDLE_REAP_MS / 60_000)}m or stopped), ` +
								`so its conversation is gone. Dispatch a new task with a self-contained prompt instead.`,
						},
					],
					details: { continued: false, taskId: task.id, state: task.state, sessionAlive: false },
				};
			}

			try {
				await task.driver!.followUp(params.message);
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Follow-up rejected for ${task.id}: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: { continued: false, taskId: task.id, state: task.state },
				};
			}

			beginFollowUpTurn(task);
			pushEvent(task, { kind: "tool", text: `follow-up: ${params.message}`.slice(0, 200) });

			return {
				content: [
					{
						type: "text",
						text: [
							`Continued ${task.id} (${task.agent}) in the same session; it is running again.`,
							task.notify === "off"
								? `No callback was requested, so poll external_agent_status taskId="${task.id}".`
								: `You will be notified when this turn settles; a wait that returns the answer suppresses that notification.`,
						].join(" "),
					},
				],
				details: { continued: true, taskId: task.id, state: task.state },
			};
		},

		renderCall(args, theme, _context) {
			const taskId = typeof args.taskId === "string" ? escapeTerminalControls(args.taskId) : "?";
			const from = typeof args.fromTaskId === "string" ? escapeTerminalControls(args.fromTaskId) : undefined;
			const preview = from ? `${from}→${taskId}` : `${taskId} · ${typeof args.message === "string" ? taskPromptPreview(args.message, 60) : ""}`;
			return new Text(
				theme.fg("toolTitle", theme.bold(from ? "external-agent relay " : "external-agent follow-up ")) + theme.fg("accent", preview),
				0,
				0,
			);
		},
	});

	pi.registerMessageRenderer("external-agent", (message, { expanded, outputPad }, theme) => {
		const details = message.details as { task?: unknown } | undefined;
		const content = typeof message.content === "string" ? escapeTerminalControls(message.content) : "";
		if (details && isTaskSnapshot(details.task)) {
			const receipt = renderTaskSnapshot(details.task, expanded);
			const text = expanded && content ? `${content}\n\n─── Dispatch receipt ───\n${receipt}` : content || receipt;
			return new Text(theme.fg("toolOutput", text), outputPad, 0);
		}
		return new Text(theme.fg("customMessageText", content), outputPad, 0);
	});

	pi.registerTool({
		name: "external_agent_stop",
		label: "External Agent Stop",
		description:
			"Terminate a running external agent task by taskId, or every task with all=true — for a task you judge stuck or no longer need.",
		promptSnippet: "Stop a background external agent task",
		parameters: Type.Object({
			taskId: Type.Optional(Type.String()),
			all: Type.Optional(Type.Boolean()),
		}),

		async execute(_id, params) {
			if (params.all) {
				const stopped = [...tasks.values()].filter((t) => stopTask(t)).map((t) => t.id);
				return {
					content: [
						{ type: "text", text: stopped.length ? `Stopped: ${stopped.join(", ")}` : "Nothing was running." },
					],
					details: { stopped } as ExternalAgentStopDetails,
				};
			}
			const task = params.taskId ? tasks.get(String(params.taskId)) : undefined;
			if (!task) {
				return {
					content: [{ type: "text", text: `Unknown or missing taskId. Known: ${[...tasks.keys()].join(", ")}` }],
					details: {} as ExternalAgentStopDetails,
				};
			}
			const ok = stopTask(task);
			return {
				content: [{ type: "text", text: ok ? `Stopped ${task.id}.` : `${task.id} was not running (${task.state}).` }],
				details: { taskId: task.id, state: task.state } as ExternalAgentStopDetails,
			};
		},
	});

	// Settle-time verify runs through pi.exec; absent in stubbed hosts (tests).
	finalizeHooks.exec = typeof pi.exec === "function" ? pi.exec.bind(pi) : undefined;

	pi.registerCommand?.("external_agent_stats", {
		description: "External-agent usage counters (CLI-reported; not billing).",
		handler: async (_args, ctx) => {
			ctx.ui?.notify?.(formatMeterSnapshot(meter.snapshot()), "info");
		},
	});

	pi.on("session_start", () => {
		taskRegistry.notifySettled = (task) => notifySettled(pi, task);
		taskRegistry.notifyWatchdog = (task, stall) => notifyWatchdog(pi, task, stall);
		ensureWatchdogTimer();
		// Waiters belong to the session that started them; a new session inherits no
		// in-flight wait, so its tokens must not hold notices forever.
		for (const task of tasks.values()) task.waiters?.clear();
		for (const taskId of [...taskRegistry.pendingNotificationIds]) {
			const task = tasks.get(taskId);
			if (task) notifyTaskSettled(task);
			else taskRegistry.pendingNotificationIds.delete(taskId);
		}
		// Held tasks (settled while a waiter was watching, never pushed) are not in
		// pendingNotificationIds; with the tokens gone they are ordinary unsettled
		// notices now.
		for (const task of tasks.values()) {
			if (!task.notified && task.state !== "running") notifyTaskSettled(task);
		}
	});

	pi.on("session_shutdown", (event) => {
		taskRegistry.notifySettled = undefined;
		taskRegistry.notifyWatchdog = undefined;
		if (event.reason === "reload") return;
		if (taskRegistry.watchdogTimer) {
			clearInterval(taskRegistry.watchdogTimer);
			taskRegistry.watchdogTimer = undefined;
		}
		taskRegistry.pendingNotificationIds.clear();
		// Persistent sessions are separate processes: they outlive the registry
		// unless they are explicitly reaped, which would leave orphans behind.
		for (const task of tasks.values()) {
			clearIdleReap(task);
			stopTask(task);
			reclaimSession(task);
		}
		tasks.clear();
		taskRegistry.sequence = 0;
	});
}
