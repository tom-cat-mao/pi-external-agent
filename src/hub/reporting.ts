/**
 * Caller-facing text: the status detail report, the dispatch receipts the TUI
 * renders, the compare report, and the relay receipt.
 *
 * It never decides anything — the counts, hashes and excerpts it prints are
 * mechanical facts, and every judgement (is this stuck, do these answers agree)
 * stays with the caller.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type AgentToolResult, keyHint } from "@earendil-works/pi-coding-agent";
import { ADAPTERS, AGENT_IDS, type AgentId, type Mode } from "../adapters.ts";
import { placeholderFor, readChunk } from "../artifacts.ts";
import { SESSION_DRIVERS, hasSessionDriver } from "../drivers/index.ts";
import { applyTemplate, loadTemplate } from "../templates.ts";
import {
	beginFollowUpTurn,
	effortForwardedOnSession,
	effortSessionNote,
	presentAnswer,
	pushEvent,
	requireCapableTask,
	retainedWorktreesLine,
	tasks,
	verifyLine,
} from "./registry.ts";
import {
	DEFAULT_WATCHDOG_MS,
	IDLE_REAP_MS,
	INHERITED_ENVIRONMENT_NOTICE,
	MAX_ANSWER_CHARS,
	WAIT_ANSWER_PREVIEW_CHARS,
	allAnswersOf,
	anchorRefs,
	answerOf,
	copyDispatchReceipt,
	dispatchSummary,
	errorsOf,
	escapeTerminalControls,
	fmtDuration,
	isEffort,
	isMode,
	isNotifyMode,
	modeDisplay,
	quoteArg,
	sessionReadOnlyEnforcement,
	summarize,
	taskPromptPreview,
	truncate,
	warningsOf,
	type CompareResult,
	type DispatchReceipt,
	type ExternalAgentRelayDetails,
	type RelayPurpose,
	type Task,
	type TaskSnapshot,
	type TaskState,
} from "./shared.ts";

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * Bounded one-line event profile for a wait report, counted over the call's own
 * window (eventSeq delta). It exists so "running but busy" is distinguishable
 * from "running and quiet" — a retry storm shows up as many tool×N events while
 * no answer forms. The hub reports the counts; judging them is the model's job.
 */
export function eventProfileLine(task: Task, during: number): string {
	const recent = during > 0 ? task.events.slice(-during) : [];
	const counts = new Map<string, number>();
	for (const event of recent) counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
	const kinds = [...counts.entries()].map(([kind, n]) => `${kind}×${n}`).join(", ");
	const last = recent[recent.length - 1];
	const tail = last ? `; last: ${last.text.replace(/\s+/g, " ").trim().slice(0, 120)}` : "";
	return `events during wait: ${during}${kinds ? ` (${kinds}${tail})` : " (none)"}`;
}

/** Newline-prefixed retained-worktree inventory for status output; "" when there is none. */
export async function inventorySuffix(): Promise<string> {
	const line = await retainedWorktreesLine();
	return line ? `\n${line}` : "";
}

export function detailReport(task: Task, tailCount: number): string {
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
export function renderReceipt(
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

export function renderTaskSnapshot(snapshot: TaskSnapshot, expanded: boolean): string {
	const title = `state: ${escapeTerminalControls(snapshot.state)}${snapshot.exitCode === null ? "" : ` · exit ${snapshot.exitCode}`}`;
	const receipt = renderReceipt(snapshot.dispatch, snapshot.taskId, expanded, "actual process dispatch");
	const errors = snapshot.spawnError ? `\nspawn error: ${escapeTerminalControls(snapshot.spawnError)}` : "";
	return `${title}\n${receipt}${errors}`;
}

export function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
		.map((block) => escapeTerminalControls(block.text))
		.join("\n")
		.trim();
}

export function renderResultWithReceipt(
	result: { content: Array<{ type: string; text?: string }> },
	receiptText: string,
	expanded: boolean,
): string {
	const output = resultText(result);
	if (!expanded) return output || receiptText;
	return output ? `${output}\n\n─── Dispatch receipt ───\n${receiptText}` : receiptText;
}

export function receiptFromStartArgs(args: Record<string, unknown>, fallbackCwd: string): DispatchReceipt | undefined {
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
			readOnlyEnforcement: sessionReadOnlyEnforcement(agent, mode),
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
export interface CompareSlot {
	index: number;
	agent: string;
	task?: Task;
	reason?: string;
	mode?: Mode;
	cwd?: string;
}

export type DispatchedCompareSlot = CompareSlot & { task: Task };

export function compareSection(slot: CompareSlot): string[] {
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
export function compareResults(slots: CompareSlot[]): CompareResult[] {
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
export function compareReport(slots: CompareSlot[], timedOut: boolean, aborted: boolean, timeoutS: number): string {
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
export function rearmCompareNotifications(slots: DispatchedCompareSlot[]): void {
	for (const slot of slots) {
		if (slot.task.state === "running") slot.task.notify = "steer";
	}
}

/**
 * Where per-slot evidence rows go: `""` disables the board outright, an explicit
 * path wins, and an omitted param defaults to `<session-dir>/external-agent/
 * board.jsonl` — a default that only exists when the session has a directory.
 */
export function boardFileFrom(param: unknown, sessionDir: string | undefined, cwd: string): string | undefined {
	if (param === "") return undefined;
	if (typeof param === "string") return resolve(cwd, param);
	return sessionDir ? join(sessionDir, "external-agent", "board.jsonl") : undefined;
}

/**
 * The report's closing digest: how many rows this call added to the board, or
 * why they are not there. Board trouble never changes the compare result.
 */
export function boardDigest(slots: CompareSlot[], boardFile: string | undefined): string | undefined {
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

export function isRelayPurpose(value: unknown): value is RelayPurpose {
	return value === "reproduce" || value === "combine" || value === "challenge";
}

/**
 * A byte window of an answer that never reached the archive (short, or archiving
 * was unavailable). Cut on character boundaries, the same rule readChunk follows,
 * so a slice can never emit half a character.
 */
export function sliceUtf8(text: string, offset: number, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	let start = offset > 0 ? Math.min(Math.floor(offset), buffer.byteLength) : 0;
	while (start < buffer.byteLength && (buffer[start] & 0xc0) === 0x80) start += 1;
	let end = Math.min(buffer.byteLength, start + Math.max(1, Math.floor(maxBytes)));
	while (end > start && end < buffer.byteLength && (buffer[end] & 0xc0) === 0x80) end -= 1;
	return buffer.toString("utf8", start, end);
}

/**
 * The text a relay delivers: the source excerpt as an envelope, wrapped in the
 * relay-envelope template (project > user > builtin, like any other template) so
 * the receiving worker reads it as data from a peer and answers with anchors.
 */
export async function relayEnvelope(
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
export async function relayAnswerToTask(params: Record<string, unknown>): Promise<AgentToolResult<ExternalAgentRelayDetails>> {
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
