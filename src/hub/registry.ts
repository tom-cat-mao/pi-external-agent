/**
 * The hub's task registry and state machine: dispatch validation, the two
 * transports (one-shot process, persistent session), settle-time finalize
 * (archive + verify + worktree diff + evidence board), the completion and stall
 * notifications, the stall watchdog, worktree isolation, and the session
 * lifecycle that owns all of it.
 *
 * The tool surface over this registry is hub/tools.ts; the text it prints comes
 * from hub/reporting.ts; the vocabulary both share is hub/shared.ts.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { ADAPTERS, AGENT_IDS, dshEffortToken, type AgentEvent, type AgentId, type Effort, type Mode } from "../adapters.ts";
import { ensureStored, extractSummary, placeholderFor } from "../artifacts.ts";
import {
	FOLLOWUP_AGENT_IDS,
	SESSION_DRIVERS,
	STEER_AGENT_IDS,
	hasSessionDriver,
	type SessionDriver,
	type SteerResult,
} from "../drivers/index.ts";
import {
	ARCHIVE_INLINE_CHARS,
	CANCEL_ESCALATE_MS,
	IDLE_REAP_MS,
	INHERITED_ENVIRONMENT_NOTICE,
	MAX_EVENTS,
	MAX_STDERR_CHARS,
	MAX_WATCHDOG_NOTICES,
	MEANINGFUL_INTERVAL_WINDOW,
	MODE_RANK,
	NOTIFY_PREVIEW_CHARS,
	STALL_FACTOR,
	STALL_FLOOR_MS,
	STALL_SAMPLE_MIN,
	STRUGGLE_MS,
	WATCHDOG_SCAN_INTERVAL_MS,
	anchorRefs,
	answerOf,
	errorsOf,
	escapeTerminalControls,
	fmtDuration,
	freezeDispatchReceipt,
	sessionReadOnlyEnforcement,
	stallClock,
	taskSnapshot,
	truncate,
	type DispatchExtras,
	type DispatchReceipt,
	type NotifyMode,
	type SharedTaskRegistry,
	type StallKind,
	type Task,
	type TaskWorktree,
	type Transport,
	type VerifyResult,
	type WorktreeRef,
} from "./shared.ts";
import { createMeter, type MeterSnapshot, type UsageSample } from "../meter.ts";

const TASK_REGISTRY_KEY = Symbol.for("pi.external-agent.task-registry.v1");

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

export const taskRegistry = getTaskRegistry();
export const tasks = taskRegistry.tasks;

/** CLI-reported usage/cost accounting; "as reported by the target CLI", never billing. */
export const meter = createMeter();

/**
 * Host capabilities the module-level settle paths cannot see on their own: the
 * session directory (archive root) and pi.exec (verify runs). Captured by the
 * factory from tool ctx / the pi object; absent in tests and ephemeral sessions,
 * where both mechanisms stay off (fail-open).
 */
export const finalizeHooks: {
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
export function nextId(agent: AgentId): string {
	taskRegistry.sequence += 1;
	return `${agent}-${taskRegistry.sequence}`;
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
export function presentAnswer(task: Task, inlineLimit: number): { text: string; truncated: boolean } {
	const latest = task.archives?.[task.archives.length - 1];
	if (!latest) return truncate(answerOf(task), inlineLimit);
	const answer = answerOf(task);
	const text = placeholderFor({ ...latest, taskId: task.id, text: answer }, { summary: extractSummary(answer) });
	return { text, truncated: false };
}

/** Compact text dump of the meter for /external_agent_stats. */
export function formatMeterSnapshot(snapshot: MeterSnapshot): string {
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

export function verifyLine(result: VerifyResult): string {
	if (result.skipped) return `verify: \`${result.command}\` — skipped (${result.skipped})`;
	return `verify: \`${result.command}\` — exit ${result.exitCode ?? "?"} in ${fmtDuration(result.durationMs)}`;
}

export function notifyTaskSettled(task: Task): void {
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
export function stallKind(task: Task, now: number): StallKind | null {
	if (stallQuiet(task, now)) return "quiet";
	if (stallStruggling(task, now)) return "struggling";
	return null;
}

/** The clock a kind is measured against; a notice streak resets when it advances. */
function stallAnchor(task: Task, stall: StallKind): number {
	return stall === "quiet" ? task.lastEventAt : task.lastMeaningfulEventAt;
}

/** One report phrase per kind: quiet measures silence, struggling measures noise. */
export function stallPhrase(task: Task, stall: StallKind, now: number): string {
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
export function stallNoticeDue(task: Task, now: number, stall: StallKind): boolean {
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
export function claimStallNotice(task: Task, now: number): void {
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
export const WORKTREE_DIR = join(".external-agent", "worktrees");
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
export async function findGitTopLevel(cwd: string): Promise<{ ok: true; toplevel: string } | { ok: false; reason: string }> {
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

export async function createTaskWorktree(worktree: TaskWorktree): Promise<{ ok: true } | { ok: false; reason: string }> {
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
export async function retainedWorktreesLine(): Promise<string | undefined> {
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

export function startTask(
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
		readOnlyEnforcement: sessionReadOnlyEnforcement(agent, mode),
		model: model
			? { requested: model, forwarded: modelForwardedOnSession(agent), note: modelSessionNote(agent, model) }
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
export function effortForwardedOnSession(agent: AgentId): boolean {
	return agent !== "reasonix";
}

export function effortSessionNote(agent: AgentId, effort: Effort): string {
	if (agent === "reasonix") {
		return `requested "${effort}"; NOT forwarded — reasonix --acp accepts no effort flag (the one-shot path would have passed --effort).`;
	}
	if (agent === "dsh") {
		return `Set inside the ACP session as session/set_config_option reasoning_effort=${dshEffortToken(effort)}; dsh accepts effort only there, never on its one-shot path.`;
	}
	return `Passed to the persistent session for "${effort}".`;
}

/**
 * Whether the persistent path forwards a model override. dsh takes its model
 * from the run profile (`--profile` is the whole entry point, verified
 * 0.1.5-rc.2) and no session-start model flag is verified, so a request is
 * reported as not forwarded rather than claimed.
 */
export function modelForwardedOnSession(agent: AgentId): boolean {
	return agent !== "dsh";
}

export function modelSessionNote(agent: AgentId, model: string): string {
	if (agent === "dsh") {
		return `requested "${model}"; NOT forwarded — dsh selects its model from the run profile, not from a session-start flag.`;
	}
	return "Passed to the persistent session at startup.";
}

/** Append an event, keeping the ring cap and the current-turn window aligned. */
export function pushEvent(task: Task, event: AgentEvent): void {
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
export function beginFollowUpTurn(task: Task): void {
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

/**
 * A dispatch that fails before it spawns is reported by its tool result, not by
 * a notification: the caller already holds the reason, exactly as a wait receipt
 * claims a settled task instead of letting its notice fire. Marking the task
 * settled here is what keeps that failure from being replayed — session_start
 * re-delivers every task that is neither running nor notified, so a task left
 * unnotified would come back as a stale failure notice after a /reload.
 */
function failBeforeStart(task: Task, reason: string): Task {
	task.state = "failed";
	task.endedAt = Date.now();
	task.spawnError = reason;
	task.notified = true;
	task.finalizePromise = Promise.resolve();
	return task;
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

	// An adapter that cannot honour the request says so instead of spelling out a
	// command whose result would mislead the caller (dsh: an effort request on a
	// path with no effort knob, or a harness home with no credentials yet). It
	// fails like a spawn that never started — reason recorded, nothing spawned.
	if (adapterDispatch.refusal) return failBeforeStart(task, adapterDispatch.refusal);

	let proc: ChildProcess;
	try {
		// No shell: args are passed as an array so task text cannot inject commands.
		proc = spawn(task.dispatch.executable, task.dispatch.argv, {
			cwd: task.dispatch.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			// Adapter-contributed env is merged OVER the inherited environment,
			// never a replacement: it carries what the CLI needs (dsh's DSH_HOME
			// and DSH_PERMISSION_MODE) without removing the rest.
			env: adapterDispatch.env ? { ...process.env, ...adapterDispatch.env } : process.env,
		});
	} catch (err) {
		return failBeforeStart(task, err instanceof Error ? err.message : String(err));
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

export function stopTask(task: Task): boolean {
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
export function validateDispatch(
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
// Session-only tool guards (steer / follow-up)
// ---------------------------------------------------------------------------

/** Agent lists the steer and follow-up descriptions name, in AGENT_IDS order. */
export const STEER_AGENTS = STEER_AGENT_IDS.join(", ") || "(none)";
export const FOLLOWUP_AGENTS = FOLLOWUP_AGENT_IDS.join(", ") || "(none)";

/** Shared guard for the two session-only tools. */
export function requireCapableTask(taskId: unknown, capability: "steer" | "followUp"): { task: Task } | { error: string } {
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

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Bind the session-scoped delivery callbacks and re-deliver whatever the last
 * session could not: notices held for a waiter whose wait never finished, and
 * tasks that settled while no callback was installed.
 */
export function sessionStarted(pi: ExtensionAPI): void {
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
}

/** Drop this session's callbacks; a reload keeps the registry and the timer. */
export function sessionShutdown(event: SessionShutdownEvent): void {
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
}
