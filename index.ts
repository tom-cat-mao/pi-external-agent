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

import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
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
	events: AgentEvent[];
	stderr: string;
	exitCode: number | null;
	spawnError?: string;
	/** How to notify the model when this task settles. */
	notify: NotifyMode;
	/** Guards against double-notifying, since close and error can both fire. */
	notified: boolean;
	/** Stall watchdog: notify when quiet this long (ms). 0 disables. */
	watchdogMs: number;
	/** Last time a stall notice was sent; compared against lastEventAt to space repeats. */
	lastWatchdogNoticeAt: number;
	/** Consecutive stall notices sent during the current quiet streak. */
	watchdogNotices: number;
	/** Idle reap: kills a persistent session that got no follow-up in time. */
	idleReapTimer?: ReturnType<typeof setTimeout>;
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

type ExternalAgentWaitDetails =
	| {
			kind: "external-agent-wait";
			timedOut: boolean;
			aborted: boolean;
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

interface SharedTaskRegistry {
	tasks: Map<string, Task>;
	sequence: number;
	notifySettled?: (task: Task) => void;
	notifyWatchdog?: (task: Task, quietMs: number) => void;
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
		return existing as SharedTaskRegistry;
	}
	const created: SharedTaskRegistry = { tasks: new Map(), sequence: 0, pendingNotificationIds: new Set() };
	Reflect.set(globalThis, TASK_REGISTRY_KEY, created);
	return created;
}

const taskRegistry = getTaskRegistry();
const tasks = taskRegistry.tasks;

const MAX_EVENTS = 400; // ring cap; oldest dropped
const MODE_RANK: Record<Mode, number> = { readonly: 0, write: 1, yolo: 2 };
const MAX_ANSWER_CHARS = 50_000; // matches pi's own subagent cap
const MAX_STDERR_CHARS = 8_000;
const NOTIFY_PREVIEW_CHARS = 4_000; // completion callbacks stay small on purpose
const DEFAULT_WATCHDOG_MS = 15 * 60_000; // stall notice after 15m quiet
const WATCHDOG_SCAN_INTERVAL_MS = 30_000;
const MAX_WATCHDOG_NOTICES = 3; // per quiet streak; then it stays silent
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
		`model: ${modelDisplay(receipt)}`,
		`effort: ${effortDisplay(receipt)}`,
		`notify: ${receipt.notify} (Pi-only; not sent to the target CLI)`,
		`watchdog: ${receipt.watchdogMs > 0 ? `stall notice after ${fmtDuration(receipt.watchdogMs)} quiet` : "disabled"} (Pi-only)`,
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
	const now = Date.now();
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
function notifyTaskSettled(task: Task): void {
	if (task.notified) return;
	if (task.notify === "off") {
		task.notified = true;
		return;
	}
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

	if (task.state === "done") {
		const preview = truncate(answerOf(task), NOTIFY_PREVIEW_CHARS);
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
 * notifySettled. notify "off" is respected: no callbacks means no watchdog.
 */
function notifyWatchdog(pi: ExtensionAPI, task: Task, quietMs: number): void {
	const elapsed = fmtDuration((task.endedAt ?? Date.now()) - task.startedAt);
	const ordinal = task.watchdogNotices + 1;
	const lines = [
		`External agent ${task.id} (${task.agent}) is still running but has been quiet for ${fmtDuration(quietMs)} (elapsed ${elapsed}).`,
		"This is a stall warning, not a completion. No action is required if the quiet is expected.",
		`Inspect with external_agent_status taskId="${task.id}", or stop it with external_agent_stop if you judge it stuck.`,
	];
	if (ordinal >= MAX_WATCHDOG_NOTICES) {
		lines.push(`This is stall notice ${ordinal}; further notices for this quiet streak are suppressed.`);
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
					quietMs,
					task: taskSnapshot(task),
				},
			},
			{
				deliverAs: task.notify === "nextTurn" ? "nextTurn" : "steer",
				triggerTurn: task.notify !== "nextTurn",
			},
		);
		task.lastWatchdogNoticeAt = Date.now();
		task.watchdogNotices += 1;
	} catch {
		// Delivery failed (e.g. mid-reload); the next scan retries.
	}
}

function scanWatchdogs(): void {
	const deliver = taskRegistry.notifyWatchdog;
	if (!deliver) return;
	const now = Date.now();
	for (const task of tasks.values()) {
		if (task.state !== "running") continue;
		if (task.notify === "off") continue;
		if (task.watchdogMs <= 0) continue;
		const quiet = now - task.lastEventAt;
		if (quiet < task.watchdogMs) continue;
		// New activity since the last notice resets the streak.
		if (task.lastWatchdogNoticeAt > 0 && task.lastEventAt > task.lastWatchdogNoticeAt) {
			task.watchdogNotices = 0;
		}
		if (task.watchdogNotices >= MAX_WATCHDOG_NOTICES && task.lastWatchdogNoticeAt > task.lastEventAt) continue;
		// Space repeat notices by the same threshold.
		if (task.lastWatchdogNoticeAt > task.lastEventAt && now - task.lastWatchdogNoticeAt < task.watchdogMs) continue;
		deliver(task, quiet);
	}
}

function ensureWatchdogTimer(): void {
	if (taskRegistry.watchdogTimer) return;
	const timer = setInterval(scanWatchdogs, WATCHDOG_SCAN_INTERVAL_MS);
	// Never let the watchdog alone keep the process alive.
	timer.unref?.();
	taskRegistry.watchdogTimer = timer;
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
): Task {
	const id = nextId(agent);
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
		startedAt: Date.now(),
		lastEventAt: Date.now(),
		events: [],
		stderr: "",
		exitCode: null,
		notify,
		notified: false,
		watchdogMs,
		lastWatchdogNoticeAt: 0,
		watchdogNotices: 0,
	};
	tasks.set(task.id, task);
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
): Task {
	return hasSessionDriver(agent)
		? startPersistentTask(agent, taskText, cwd, mode, notify, watchdogMs, model, effort)
		: startOneshotTask(agent, taskText, cwd, mode, notify, watchdogMs, model, effort);
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
	});

	const task = createTask(agent, taskText, cwd, mode, notify, watchdogMs, dispatch, "persistent");
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
			notifyTaskSettled(task);
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
			notifyTaskSettled(task);
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
	task.lastEventAt = Date.now();
}

function settlePersistentTask(task: Task, outcome: { status: "done" | "failed" | "cancelled"; error?: string }): void {
	if (task.state !== "running") return;
	task.state = outcome.status === "cancelled" ? "stopped" : outcome.status;
	task.endedAt = Date.now();
	if (outcome.error) task.spawnError = outcome.error;
	notifyTaskSettled(task);
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

function startOneshotTask(
	agent: AgentId,
	taskText: string,
	cwd: string,
	mode: Mode,
	notify: NotifyMode,
	watchdogMs: number,
	model?: string,
	effort?: Effort,
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
	});
	const task = createTask(agent, taskText, cwd, mode, notify, watchdogMs, dispatch, "oneshot");

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
		notifyTaskSettled(task);
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
		notifyTaskSettled(task);
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
 */
function validateDispatch(agent: AgentId, mode: Mode, cwd: string, effort: Effort | undefined): DispatchCheck {
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
		const conflict = [...tasks.values()].find((t) => t.state === "running" && t.mode !== "readonly" && t.cwd === cwd);
		if (conflict) {
			return {
				ok: false,
				reason:
					`${conflict.id} is already running a ${conflict.mode} task in ${escapeTerminalControls(cwd)}. ` +
					`Stop it first (external_agent_stop) or dispatch to a different directory.`,
			};
		}
	}

	return { ok: true };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function detailReport(task: Task, tailCount: number): string {
	const lines: string[] = [];
	lines.push(summarize(task));
	lines.push(`agent: ${task.agent} (${ADAPTERS[task.agent].provider})`);
	lines.push(`mode: ${modeDisplay(task.mode)} · cwd: ${task.cwd}`);
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
	}

	const errs = errorsOf(task);
	if (errs) lines.push(`agent errors: ${errs}`);
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
			const { text, truncated } = truncate(answer, MAX_ANSWER_CHARS);
			lines.push("", earlier ? "answer (latest turn):" : "answer:", text);
			if (truncated) lines.push("[answer was truncated]");
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
		const answer = truncate(answerOf(task), WAIT_ANSWER_PREVIEW_CHARS);
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
			const answer = truncate(answerOf(task), WAIT_ANSWER_PREVIEW_CHARS);
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
			"Task text must be self-contained: the agent sees none of this conversation, so state the goal, name the",
			"files and what to return.",
			"Concurrent write/yolo tasks in the same directory are refused, and effort is opt-in (see the effort",
			"parameter).",
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
						"Opt-in reasoning-effort override. Set it only when the user explicitly requests an effort/thinking level; " +
						"never infer one from task complexity. Omit it to inherit the target CLI/config default — specifying off is " +
						"an explicit override, not the same as omitting. Per-agent levels are in the agent table.",
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
						"Minutes of no activity before a stall notice (default 15; 0 disables; notify off disables it too).",
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

			const checked = validateDispatch(agent, mode, cwd, effort);
			if (!checked.ok) {
				return {
					content: [{ type: "text", text: `Refused: ${checked.reason}` }],
					details: { refused: true },
				};
			}

			const task = startTask(agent, params.task, cwd, mode, notify, watchdogMs, model, effort);

			const notes: string[] = [];
			if (adapter.degraded) notes.push(`note: ${agent} is degraded — ${adapter.degraded}`);
			if (mode === "readonly" && !adapter.enforcesReadOnly) {
				notes.push(`warning: ${agent} cannot enforce read-only; it may still modify files`);
			}
			if (mode === "yolo") {
				notes.push("warning: yolo runs with no sandbox; the agent can modify or delete anything on this machine");
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
							`Started ${agent} as ${task.id} (${modeDisplay(task.mode)}) in ${escapeTerminalControls(cwd)}.`,
							...notes,
							task.notify === "off"
								? `No callback was requested, so poll external_agent_status taskId="${task.id}" at sparse intervals (at least 60s apart).`
								: [
										`If you need the result in this turn, call external_agent_wait with taskIds=["${task.id}"].`,
										`Otherwise end your turn now: you will be notified when it settles, and the stall watchdog (${Math.round(task.watchdogMs / 60_000)}m) will notify you if it goes quiet. Do not sleep-poll.`,
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
			"Check background external agent tasks. Omit taskId to list all; for one task you get elapsed and quiet",
			"time plus recent activity, and its answer once settled. Steady activity means it is working; a long quiet",
			"stretch means consider stopping it.",
		].join(" "),
		promptSnippet: "Check background external agent tasks and their answers",
		parameters: Type.Object({
			taskId: Type.Optional(Type.String()),
			tail: Type.Optional(Type.Number({ description: "Recent events to show. Default 8." })),
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
				return {
					content: [{ type: "text", text: detailReport(task, Number(params.tail ?? 8)) }],
					details: {
						kind: "external-agent-status",
						task: taskSnapshot(task),
						requestedTail: Number(params.tail ?? 8),
					} as ExternalAgentStatusDetails,
				};
			}

			const lines = [...tasks.values()].map((t) => `${summarize(t)} — ${t.agent}: ${t.task.slice(0, 80)}`);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
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
			"Block until external agent tasks settle or the timeout elapses: how to wait inside the current turn. On",
			"settle it returns the answer; on timeout a still-running summary, and you may wait again, do other work,",
			"or end your turn and rely on notifications.",
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
			const timeoutS =
				typeof params.timeout === "number" && Number.isFinite(params.timeout)
					? Math.min(Math.max(params.timeout, 5), WAIT_MAX_TIMEOUT_S)
					: WAIT_DEFAULT_TIMEOUT_S;
			const deadline = Date.now() + timeoutS * 1000;

			const report = (timedOut: boolean, aborted: boolean) => {
				const lines: string[] = [];
				if (unknown.length > 0) lines.push(`Unknown taskIds (ignored): ${unknown.join(", ")}`);
				if (aborted) {
					lines.push("Wait aborted before the tasks settled.");
				} else if (timedOut) {
					lines.push(
						`Still running after ${fmtDuration(timeoutS * 1000)}. Wait again, do other work, or end your turn and rely on completion/stall notifications.`,
					);
				}
				for (const task of watched) {
					lines.push(summarize(task));
					if (task.state !== "running") {
						if (task.state === "done") {
							const preview = truncate(answerOf(task), WAIT_ANSWER_PREVIEW_CHARS);
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
				const finish = (timedOut: boolean, aborted: boolean) => {
					clearInterval(timer);
					signal?.removeEventListener("abort", onAbort);
					resolvePromise({
						content: [{ type: "text", text: report(timedOut, aborted) }],
						details: {
							kind: "external-agent-wait",
							timedOut,
							aborted,
							tasks: watched.map(taskSnapshot),
						},
					});
				};
				const check = () => {
					const settled = watched.filter((t) => t.state !== "running");
					const condition = waitAll ? settled.length === watched.length : settled.length > 0;
					if (condition) return finish(false, false);
					if (Date.now() >= deadline) return finish(true, false);
				};
				const onAbort = () => finish(false, true);
				// Ref'd on purpose: an in-flight wait is active work and must keep the
				// event loop alive (print mode exits once only unref'd handles remain).
				const timer = setInterval(check, 2_000);
				signal?.addEventListener("abort", onAbort);
				check();
			});
		},
	});

	pi.registerTool({
		name: "external_agent_compare",
		label: "External Agent Compare",
		description: [
			"Put one task to several agent CLIs in one blocking call: every valid spec is dispatched in parallel with",
			"its own mode, model, effort and cwd, and the answers come back side by side once they settle or the",
			"timeout elapses. It never diffs, scores or ranks — judging is yours. A spec that fails validation",
			"(unsupported mode or effort, write/yolo conflict in its cwd) is recorded as a refusal while the others",
			"still run. On timeout the receipt lists the taskIds still running: finish them with external_agent_wait,",
			"or end your turn and their notifications re-invoke you. Use external_agent_start when you want to keep",
			"working meanwhile.",
		].join(" "),
		promptSnippet: "Ask several external agent CLIs the same task at once",
		promptGuidelines: [
			"Prefer external_agent_compare over chaining agents in a pipeline: disagreement between answers is the signal.",
		],
		parameters: Type.Object({
			task: Type.String({
				description: "Self-contained instruction sent to every agent.",
			}),
			agents: Type.Array(
				Type.Object({
					agent: StringEnum(AGENT_IDS as unknown as readonly string[]),
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

				// One refused spec must not cost the caller the others: it is recorded
				// with its reason and the loop keeps going.
				const checked = validateDispatch(agent, mode, cwd, effort);
				if (!checked.ok) {
					slots.push({ index, agent, reason: checked.reason, mode, cwd });
					continue;
				}

				// Same dispatch path as external_agent_start — persistent session
				// driver when the adapter has one, one-shot process otherwise. notify
				// is off because this receipt is the notification (see
				// rearmCompareNotifications for the timeout case).
				const task = startTask(agent, taskText, cwd, mode, "off", DEFAULT_WATCHDOG_MS, model, effort);
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
			}

			return {
				content: [{ type: "text", text: compareReport(slots, timedOut, aborted, timeoutS) }],
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
			"add a constraint, or tell it to wrap up early (to cancel it instead, use external_agent_stop). Supported:",
			`${STEER_AGENTS}; the others are one-shot and cannot be steered. Qoder steering requires the announced qodercli stable`,
			"version >= 1.1.49 and is refused with the reported version otherwise. For a settled task, use",
			"external_agent_follow_up.",
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
			"it did and learned, so you need not restate the task. It goes back to running and notifies you again when",
			`the new turn settles. Supported: ${FOLLOWUP_AGENTS}. Reclaimed after 30 minutes idle; a follow-up is then refused, so`,
			"dispatch a new task instead.",
		].join(" "),
		promptSnippet: "Ask a follow-up in the same external agent session",
		parameters: Type.Object({
			taskId: Type.String({ description: "Task id from external_agent_start." }),
			message: Type.String({ description: "Follow-up message for the same session." }),
		}),

		async execute(_id, params): Promise<AgentToolResult<ExternalAgentFollowUpDetails>> {
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

			// A new turn starts: report it, and scope the answer to it.
			task.answerStartIndex = task.events.length;
			task.state = "running";
			task.endedAt = undefined;
			task.notified = false;
			task.exitCode = null;
			task.spawnError = undefined;
			task.lastEventAt = Date.now();
			task.watchdogNotices = 0;
			clearIdleReap(task);
			pushEvent(task, { kind: "tool", text: `follow-up: ${params.message}`.slice(0, 200) });

			return {
				content: [
					{
						type: "text",
						text: [
							`Continued ${task.id} (${task.agent}) in the same session; it is running again.`,
							task.notify === "off"
								? `No callback was requested, so poll external_agent_status taskId="${task.id}".`
								: `You will be notified when this turn settles. Call external_agent_wait with taskIds=["${task.id}"] if you need it now.`,
						].join(" "),
					},
				],
				details: { continued: true, taskId: task.id, state: task.state },
			};
		},

		renderCall(args, theme, _context) {
			const taskId = typeof args.taskId === "string" ? escapeTerminalControls(args.taskId) : "?";
			const preview = typeof args.message === "string" ? taskPromptPreview(args.message, 60) : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("external-agent follow-up ")) + theme.fg("accent", `${taskId} · ${preview}`),
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

	pi.on("session_start", () => {
		taskRegistry.notifySettled = (task) => notifySettled(pi, task);
		taskRegistry.notifyWatchdog = (task, quietMs) => notifyWatchdog(pi, task, quietMs);
		ensureWatchdogTimer();
		for (const taskId of [...taskRegistry.pendingNotificationIds]) {
			const task = tasks.get(taskId);
			if (task) notifyTaskSettled(task);
			else taskRegistry.pendingNotificationIds.delete(taskId);
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
