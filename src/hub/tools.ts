/**
 * The registered tool surface: seven tools over the hub registry, the hub
 * message renderer, and nothing else.
 *
 * Descriptions, snippets, guidelines and parameter descriptions are part of
 * every provider request, so they are budgeted by test
 * (test/prompt-surface-budget.test.ts); edit them deliberately.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type AgentToolResult, type ExtensionAPI, keyHint } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readChunk } from "../artifacts.ts";
import { applyTemplate, loadTemplate } from "../templates.ts";
import {
	ADAPTERS,
	AGENT_IDS,
	EFFORT_LEVELS,
	type AgentId,
} from "../adapters.ts";
import {
	COMPARE_MAX_AGENTS,
	COMPARE_MIN_AGENTS,
	COMPARE_POLL_INTERVAL_MS,
	DEFAULT_WATCHDOG_MS,
	IDLE_REAP_MS,
	WAIT_ANSWER_PREVIEW_CHARS,
	WAIT_DEFAULT_TIMEOUT_S,
	WAIT_MAX_TIMEOUT_S,
	errorsOf,
	escapeTerminalControls,
	fmtDuration,
	isEffort,
	isMode,
	isNotifyMode,
	isTaskSnapshot,
	modeDisplay,
	stallClock,
	summarize,
	taskPromptPreview,
	taskSnapshot,
	truncate,
	warningsOf,
	type DispatchExtras,
	type ExternalAgentCompareDetails,
	type ExternalAgentFollowUpDetails,
	type ExternalAgentRelayDetails,
	type ExternalAgentStatusDetails,
	type ExternalAgentSteerDetails,
	type ExternalAgentStopDetails,
	type ExternalAgentWaitDetails,
	type StallKind,
	type Task,
	type TaskWorktree,
} from "./shared.ts";
import type { SteerResult } from "../drivers/index.ts";
import {
	WORKTREE_DIR,
	beginFollowUpTurn,
	claimStallNotice,
	createTaskWorktree,
	finalizeHooks,
	findGitTopLevel,
	meter,
	nextId,
	notifyTaskSettled,
	presentAnswer,
	pushEvent,
	requireCapableTask,
	FOLLOWUP_AGENTS,
	stallKind,
	stallNoticeDue,
	stallPhrase,
	startTask,
	stopTask,
	taskRegistry,
	tasks,
	validateDispatch,
	verifyLine,
} from "./registry.ts";
import {
	boardDigest,
	type CompareSlot,
	type DispatchedCompareSlot,
	boardFileFrom,
	compareReport,
	compareResults,
	detailReport,
	eventProfileLine,
	inventorySuffix,
	rearmCompareNotifications,
	receiptFromStartArgs,
	relayAnswerToTask,
	renderReceipt,
	renderResultWithReceipt,
	renderTaskSnapshot,
	resultText,
} from "./reporting.ts";
/**
 * Guidelines that govern more than one tool live here as single constants, so
 * every carrier registers the byte-identical string: pi dedupes guidelines by
 * exact string match, and the capability detail they lean on has one home in
 * the `external-agent` skill.
 */
const G_END_TURN =
	"Default: after dispatching tasks whose results you do not need now, end your turn — completion and stall notifications re-invoke you. Never sleep-poll.";
const G_WAIT_WHEN_NEEDED = "Use external_agent_wait only when the result is needed in this turn.";
const G_STEER =
	"Prefer external_agent_steer to correct a running task's approach; it is not an interrupt (it lands at the next step boundary) — if the turn already ended, use external_agent_follow_up.";
const G_FOLLOW_UP = "external_agent_follow_up continues the same session instead of re-dispatching work already done.";
const G_VERIFY_CLAIMS = "Treat external agent answers as claims to verify against the code, not as fact.";

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

export function registerHubTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "external_agent_start",
		label: "External Agent",
		description: [
			"Dispatch a task to another coding agent CLI. Returns a taskId immediately; the agent runs in the",
			"background and notifies you when it settles. Start several and keep working. There is no wall-clock",
			"timeout, but a stall watchdog (default 15m quiet) also notifies you, so ending your turn while",
			"waiting is safe.",
			"Agent capability matrix, effort levels, permission tiers, templates, steer/follow-up support: read skill `external-agent` before dispatching.",
			"On first dispatch, external_agent_wait, external_agent_compare, external_agent_steer and external_agent_follow_up become active automatically.",
			"Task text must be self-contained: the agent sees none of this conversation; state the goal, files and what to return.",
			"Concurrent write/yolo tasks in one directory are refused; effort is opt-in (see the effort parameter).",
		].join(" "),
		promptSnippet: "Dispatch a task to an external agent CLI",
		promptGuidelines: [G_END_TURN, G_WAIT_WHEN_NEEDED, G_STEER, G_FOLLOW_UP, G_VERIFY_CLAIMS],
		parameters: Type.Object({
			agent: StringEnum(AGENT_IDS as unknown as readonly string[]),
			task: Type.String({
				description: "Self-contained task text.",
			}),
			cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the session cwd." })),
			mode: Type.Optional(
				StringEnum(["readonly", "write", "yolo"] as const, {
					description:
						"readonly forbids mutations; write allows workspace edits; yolo removes the sandbox; " +
						"omitted = the agent's own default.",
				}),
			),
			model: Type.Optional(Type.String({ description: "Override the agent's model." })),
			effort: Type.Optional(
				StringEnum(EFFORT_LEVELS, {
					description:
						"Opt-in reasoning-effort override: set it only when the user explicitly requests an effort level, never " +
						"infer one from task complexity. Omit it to inherit the target CLI/config default (\"off\" is an override); " +
						"per-agent ranges: see skill `external-agent`.",
				}),
			),
			notify: Type.Optional(
				StringEnum(["steer", "followUp", "nextTurn", "off"] as const, {
					description:
						"Settle notification: steer (at the end of the current tool batch), followUp (when idle), " +
						"nextTurn (next user message), off (never; poll external_agent_status).",
				}),
			),
			watchdog: Type.Optional(
				Type.Number({
					description: "Minutes of no activity before a stall notice (default 15; 0 disables).",
				}),
			),
			template: Type.Optional(
				Type.String({
					description: "Task template name; wraps the task with an output contract.",
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
			"recent activity, and its answer once settled. A long quiet stretch means consider stopping it.",
		].join(" "),
		promptSnippet: "Check external agent tasks and answers",
		parameters: Type.Object({
			taskId: Type.Optional(Type.String()),
			tail: Type.Optional(Type.Number({ description: "Recent events to show. Default 8." })),
			offset: Type.Optional(
				Type.Number({ description: "Page the archived answer from this byte offset (from a recall hint)." }),
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
			"Block until external agent tasks settle or the timeout elapses; it returns early once every watched",
			"task is quiet past its watchdog. On settle it returns the answer and suppresses that task's notification.",
		].join(" "),
		promptGuidelines: [G_WAIT_WHEN_NEEDED],
		parameters: Type.Object({
			taskIds: Type.Array(Type.String(), { description: "Task ids from external_agent_start." }),
			timeout: Type.Optional(
				Type.Number({ description: `Seconds to wait at most (default ${WAIT_DEFAULT_TIMEOUT_S}, max ${WAIT_MAX_TIMEOUT_S}).` }),
			),
			mode: Type.Optional(
				StringEnum(["all", "any"] as const, {
					description: "all (default) waits for every listed task; any returns when the first settles.",
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
						// The same non-fatal notices external_agent_status prints (dsh:
						// the composition anchor finding the requested tier not in
						// force): this report replaces the settle push, so it has to
						// carry what that push carries.
						const warns = warningsOf(task);
						if (warns) lines.push(`non-fatal warnings: ${truncate(warns, 400).text}`);
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
			"Put one task to several agent CLIs in one blocking call (specs[].task overrides it per slot, with per-slot",
			"mode/model/effort/cwd); the answers come back side by side once they settle or the timeout elapses. It never",
			"diffs, scores or ranks — judging is yours. A spec failing validation (unsupported mode or effort, write/yolo",
			"conflict in its cwd) is recorded as a refusal while the others still run. On timeout the receipt lists the",
			"taskIds still running: finish them with external_agent_wait or end your turn; their notifications re-invoke you.",
		].join(" "),
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
					task: Type.Optional(
						Type.String({ description: "Per-slot override of the shared task." }),
					),
					cwd: Type.Optional(
						Type.String({
							description: "Same semantics as external_agent_start.cwd.",
						}),
					),
					mode: Type.Optional(
						StringEnum(["readonly", "write", "yolo"] as const, {
							description: "Same semantics as external_agent_start.mode.",
						}),
					),
					model: Type.Optional(Type.String({ description: "Same semantics as external_agent_start.model." })),
					effort: Type.Optional(
						StringEnum(EFFORT_LEVELS, {
							description: "Same semantics as external_agent_start.effort.",
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
					description: `Batch timeout seconds (default ${WAIT_DEFAULT_TIMEOUT_S}, max ${WAIT_MAX_TIMEOUT_S}).`,
				}),
			),
			template: Type.Optional(
				Type.String({ description: "Same semantics as external_agent_start.template, per slot." }),
			),
			verify: Type.Optional(
				Type.Object(
					{
						command: Type.String(),
						timeoutSeconds: Type.Optional(Type.Number()),
					},
					{ description: "Same semantics as external_agent_start.verify, per slot." },
				),
			),
			isolate: Type.Optional(
				Type.Boolean({
					description: "Same semantics as external_agent_start.isolate.",
				}),
			),
			board: Type.Optional(
				Type.String({
					description: "JSONL board for per-slot evidence rows (\"\" disables).",
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
			"Send mid-run guidance to a running external agent task: correct the approach, narrow scope, add a constraint,",
			"or tell it to wrap up early (to cancel instead, use external_agent_stop). Qoder steering requires qodercli",
			"stable >= 1.1.49 and is refused with the reported version otherwise; support matrix: see skill `external-agent`.",
			"For a settled task, use external_agent_follow_up.",
		].join(" "),
		promptGuidelines: [G_STEER],
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
			"Continue a settled external agent task in the SAME session: it still has everything it did and learned, so do",
			`not restate the task. It runs again and notifies you when the new turn settles. Supported: ${FOLLOWUP_AGENTS}.`,
			"Reclaimed after 30 minutes idle, and a follow-up is then refused — dispatch a new task.",
			"Relay protocol: see skill `external-agent`.",
		].join(" "),
		promptGuidelines: [G_FOLLOW_UP],
		parameters: Type.Object({
			taskId: Type.String({ description: "Task id from external_agent_start." }),
			message: Type.String({ description: "Follow-up text; ignored for a relay." }),
			fromTaskId: Type.Optional(Type.String({ description: "Relay source task; its answer becomes the message." })),
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
}
