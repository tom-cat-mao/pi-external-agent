/**
 * LF stream-json drivers: claude and qoder. Both keep one long-lived process
 * whose stdin carries user messages and control requests, and read `result`
 * records as the turn's settle signal.
 *
 * The two are deliberately kept in one file: they share the control-request
 * waiter shape, the initialize handshake, and the assistant/result framing.
 *
 * claude: initialize handshake + system/init events; can_use_tool control
 * requests (uuid-based); user message frames with uuid for steering/follow-up;
 * result records with usage/cost fields. No version gate for steer, effort
 * levels low|medium|high|xhigh|max, permission tiers dontAsk/acceptEdits/
 * bypassPermissions.
 *
 * qoder: the same framing with a version gate on mid-run steering
 * (qodercli stable >= 1.1.49) and a permission-mode argv the driver builds.
 */

import { randomUUID } from "node:crypto";
import { ADAPTERS, qoderPermissionArgs, type AgentEvent, type Mode } from "../adapters.ts";
import {
	COMMAND_TIMEOUT_MS,
	HANDSHAKE_TIMEOUT_MS,
	MAX_THOUGHT_CHARS,
	StdioProcess,
	type SessionDriver,
	type SessionStartInput,
	type SteerResult,
	type TurnOutcome,
} from "./base.ts";

// ---------------------------------------------------------------------------
// claude --input-format stream-json (persistent session)
// ---------------------------------------------------------------------------

/**
 * claude stream-json protocol driver, aligned with qoder's approach.
 * Verified against official Anthropic Code docs that describe:
 *   - initialize handshake + system/init events
 *   - can_use_tool control requests (uuid-based)
 *   - user message frames with uuid for steering/follow-up
 *   - result records with usage/cost fields
 *
 * Key differences from qoder:
 *   - No version gate for steer (claude always supports it over stream-json)
 *   - effort levels: low|medium|high|xhigh|max (no ultracode in pi domain)
 *   - permission tiers map directly: dontAsk/acceptEdits/bypassPermissions
 */
export class ClaudeStreamJsonDriver extends StdioProcess implements SessionDriver {
	readonly cwdForwardedToCli = false;
	readonly stdinFormat = "stream-json";

	private readonly eventCbs: Array<(event: AgentEvent) => void> = [];
	private readonly turnEndCbs: Array<(outcome: TurnOutcome) => void> = [];
	private readonly controlWaiters = new Map<string, ClaudeControlWaiter>();
	private readonly steers = new Set<string>();
	private active = false;
	private cancelRequested = false;
	private turnStarted = false;
	private bootFailure: string | undefined;
	private truncated = false;
	private initVersion: string | undefined;
	private mode: Mode = "yolo";
	private initResolve: (() => void) | undefined;
	private initReject: ((err: Error) => void) | undefined;
	private controlSeq = 0;

	get steerUnavailableReason(): string | undefined {
		// claude stream-json has no known steer blockers; return undefined.
		return undefined;
	}

	onEvent(cb: (event: AgentEvent) => void): void {
		this.eventCbs.push(cb);
	}

	onTurnEnd(cb: (outcome: TurnOutcome) => void): void {
		this.turnEndCbs.push(cb);
	}

	buildArgv(input: SessionStartInput): string[] {
		const argv = ["-p", "--output-format", "stream-json", "--input-format", "stream-json"];
		// Permission mapping follows codebuddy contract
		const permissionMode = input.mode === "readonly" ? "dontAsk" : input.mode === "write" ? "acceptEdits" : "bypassPermissions";
		argv.push("--permission-mode", permissionMode);
		if (input.model) argv.push("--model", input.model);
		if (input.effort) argv.push("--effort", input.effort);
		return argv;
	}

	async start(input: SessionStartInput): Promise<void> {
		this.mode = input.mode;
		const ready = this.awaitInit();
		this.spawnProcess(ADAPTERS.claude.bin, this.buildArgv(input), input.cwd);
		void this
			.controlRequest(
				{
					type: "initialize",
					subtype: "initialize",
				},
				HANDSHAKE_TIMEOUT_MS,
			)
			.then((response: any) => {
				if (response?.subtype === "error") {
					if (this.initResolve) this.failBoot(`claude rejected the initialize request: ${String(response.error ?? "unknown error")}`);
					return;
				}
				// No version field like qoder; just resolve when we get back anything valid
				this.initResolve?.();
			})
			.catch(() => undefined);
		await ready;
		if (this.bootFailure) throw new Error(`claude failed before the first turn: ${this.bootFailure}`);
		if (!this.alive) throw new Error(this.spawnError ?? "the claude session exited before the first turn");
		if (this.cancelRequested) return;
		this.turnStarted = true;
		this.markActive();
		this.sendUserMessage(input.task);
	}

	private awaitInit(): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const done = () => {
			if (timer) clearTimeout(timer);
			timer = undefined;
			this.initResolve = undefined;
			this.initReject = undefined;
		};
		return new Promise<void>((resolve, reject) => {
			this.initResolve = () => {
				done();
				resolve();
			};
			this.initReject = (err: Error) => {
				done();
				reject(err);
			};
			timer = setTimeout(() => {
				this.initReject?.(new Error(`claude: no system/init handshake within ${Math.round(HANDSHAKE_TIMEOUT_MS / 1000)}s`));
			}, HANDSHAKE_TIMEOUT_MS);
			timer.unref?.();
		});
	}

	async followUp(message: string): Promise<void> {
		if (!this.alive) throw new Error("the claude session process is gone");
		if (this.active) throw new Error("a turn is still running; use external_agent_steer instead");
		this.cancelRequested = false;
		this.markActive();
		this.sendUserMessage(message);
	}

	async steer(message: string): Promise<SteerResult> {
		if (!this.active) return { accepted: false, reason: "no turn is currently running" };
		if (!this.alive) return { accepted: false, reason: "the claude session process is gone" };
		// claude has no steer blockers
		this.steers.add(this.sendUserMessage(message, { priority: "next", shouldQuery: false }));
		return {
			accepted: true,
			note:
				"sent with priority next and shouldQuery false: queued for the next step boundary of the active turn, not confirmed applied. " +
				"It never interrupts and never starts a turn of its own, so guidance that misses this turn stays as context for the next user message.",
		};
	}

	async cancel(): Promise<void> {
		if (!this.alive) return;
		this.cancelRequested = true;
		// Use control_request interrupt if supported, else fall through to SIGTERM
		await this.controlRequest({ type: "interrupt", subtype: "interrupt" }, 5_000).catch(() => undefined);
	}

	protected override onProcessExit(): void {
		for (const [id, waiter] of this.controlWaiters) {
			clearTimeout(waiter.timer);
			waiter.resolve({ subtype: "error", error: this.spawnError ?? "session process exited" });
			this.controlWaiters.delete(id);
		}
		const stderrDetail = this.stderr
			.trim()
			.split("\n")
			.map((line) => line.trim())
			.find(Boolean);
		const message =
			this.spawnError ??
			`the claude session exited before the handshake or the turn ended${stderrDetail ? `: ${stderrDetail.slice(0, 300)}` : ""}`;
		this.initReject?.(new Error(message));
		this.settle({ status: "failed", error: message });
	}

	protected handleLine(line: string): void {
		let obj: any;
		try {
			obj = JSON.parse(line);
		} catch {
			return;
		}
		if (!obj || typeof obj !== "object") return;

		// initialize handshake via control_response or system/init event
		if (obj.type === "system" && obj.subtype === "init") {
			this.initResolve?.();
			return;
		}
		if (obj.type === "assistant" && obj.parent_tool_use_id == null) {
			if (obj.aborted === true) this.truncated = true;
			else if (Array.isArray(obj.message?.content)) this.truncated = false;
		}
		if (obj.type === "control_request") {
			this.handleControlRequest(obj);
			return;
		}
		if (obj.type === "control_response") {
			this.handleControlResponse(obj);
			return;
		}

		if (obj.type === "result") {
			this.handleResult(line, obj);
			return;
		}

		const event = ADAPTERS.claude.parseEvent(line);
		if (event) this.emit(event);
	}

	private isTerminalResult(obj: any): boolean {
		if (obj.subtype === "success") return typeof obj.result === "string";
		return obj.subtype === "error_during_execution" || obj.subtype === "error_max_turns" || obj.subtype === "error_max_budget_usd";
	}

	private handleResult(line: string, obj: any): void {
		if (!this.isTerminalResult(obj)) return;
		const event = ADAPTERS.claude.parseEvent(line);
		const failed = event?.kind === "error";
		if (!this.active) {
			if (!this.turnStarted && failed) this.failBoot(event?.text ?? "claude reported a failed result before the first turn");
			return;
		}
		const cancelled = this.cancelRequested;
		if (event?.text && !(cancelled && failed)) this.emit(event);
		if (cancelled) {
			this.settle({ status: "cancelled" });
			return;
		}
		if (failed) {
			this.settle({ status: "failed", error: event?.text ?? "claude reported a failed result" });
			return;
		}
		if (this.truncated) {
			this.settle({ status: "cancelled" });
			return;
		}
		this.settle({ status: "done" });
	}

	private failBoot(detail: string): void {
		this.bootFailure = detail;
		this.initReject?.(new Error(detail));
	}

	private emit(event: AgentEvent): void {
		for (const cb of this.eventCbs) cb(event);
	}

	private sendUserMessage(text: string, options?: { priority?: "next"; shouldQuery?: boolean }): string {
		const uuid = randomUUID();
		const message: Record<string, unknown> = {
			type: "user",
			message: { role: "user", content: [{ type: "text", text }] },
			parent_tool_use_id: null,
			uuid,
		};
		if (options?.priority) message.priority = options.priority;
		if (options?.shouldQuery !== undefined) message.shouldQuery = options.shouldQuery;
		this.writeLine(message);
		return uuid;
	}

	private controlRequest(request: Record<string, unknown>, timeoutMs: number): Promise<any> {
		const requestId = `c${++this.controlSeq}`;
		return new Promise((resolve, reject) => {
			if (!this.alive && this.spawnError) {
				reject(new Error(this.spawnError));
				return;
			}
			const timer = setTimeout(() => {
				this.controlWaiters.delete(requestId);
				reject(new Error(`control request "${String(request.subtype ?? request.type)}" timed out after ${Math.round(timeoutMs / 1000)}s`));
			}, timeoutMs);
			timer.unref?.();
			this.controlWaiters.set(requestId, { resolve, timer });
			this.writeLine({ type: "control_request", request_id: requestId, request });
		});
	}

	private handleControlResponse(obj: any): void {
		const response = obj.response;
		const rawId = response?.request_id;
		const key = typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : undefined;
		const waiter = key === undefined ? undefined : this.controlWaiters.get(key);
		if (!waiter || key === undefined) return;
		this.controlWaiters.delete(key);
		clearTimeout(waiter.timer);
		waiter.resolve(response);
	}

	private handleControlRequest(obj: any): void {
		const rawId = obj.request_id;
		const requestId = typeof rawId === "string" || typeof rawId === "number" ? rawId : undefined;
		const request = obj.request && typeof obj.request === "object" ? obj.request : {};
		const subtype = typeof request.subtype === "string" ? request.subtype : typeof request.type === "string" ? request.type : "unknown";
		if (requestId === undefined) {
			const detail = `claude sent a ${subtype} control request without a usable request_id`;
			if (!this.turnStarted) {
				this.failBoot(detail);
				return;
			}
			if (!this.active) {
				this.kill();
				return;
			}
			this.emit({ kind: "error", text: detail });
			this.settle({ status: "failed", error: detail });
			this.kill();
			return;
		}
		// can_use_tool answers follow the tier the same way the ACP driver does:
		// readonly fails closed as a backstop, while write and yolo already run
		// under their own CLI-side permission mode. On a readonly turn this is
		// normally unreachable: the dontAsk CLI mode denies unapproved tools
		// itself and raises no such request — hence the receipt's "cli-mode"
		// label rather than a claim that this deny is the enforcement point.
		if (subtype === "can_use_tool") {
			const response =
				this.mode === "readonly"
					? {
							behavior: "deny",
							message: `${this.mode} mode does not auto-allow this tool, and pi-external-agent exposes no permission prompt channel.`,
							...(typeof request.tool_use_id === "string" ? { toolUseID: request.tool_use_id } : {}),
						}
					: {
							behavior: "allow",
							updatedInput: request.input ?? {},
							...(typeof request.tool_use_id === "string" ? { toolUseID: request.tool_use_id } : {}),
						};
			this.writeLine({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
			return;
		}
		this.writeLine({
			type: "control_response",
			response: { subtype: "error", request_id: requestId, error: `unsupported control request: ${subtype}` },
		});
	}

	private markActive(): void {
		this.active = true;
		this.truncated = false;
		this.steers.clear();
	}

	private settle(outcome: TurnOutcome): void {
		if (!this.active) return;
		this.active = false;
		this.cancelRequested = false;
		for (const cb of this.turnEndCbs) cb(outcome);
	}
}

interface ClaudeControlWaiter {
	resolve: (response: any) => void;
	timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Qoder — LF stream-json with version gate
// ---------------------------------------------------------------------------

const QODER_INIT_TIMEOUT_MS = 120_000;
const QODER_CANCEL_TIMEOUT_MS = 5_000;
const QODER_SYNTHETIC_MODEL = "<synthetic>";
const QODER_STEER_BASELINE = "1.1.49";
const QODER_STEER_BASELINE_PARTS = [1, 1, 49];
const QODER_STEER_REFUSAL =
	"Mid-run steering is refused rather than sent, because this CLI generation may not honour the shouldQuery contract a steer relies on. " +
	"The baseline is the release our documented SDK pairing targets, not a vendor-stated minimum. " +
	"Follow-up, status and stop still work; install a newer qodercli and dispatch a new task to steer.";

function qoderStableVersion(value: unknown): number[] | undefined {
	if (typeof value !== "string") return undefined;
	const match = value.trim().match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
	if (!match) return undefined;
	const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
	return parts.every(Number.isSafeInteger) ? parts : undefined;
}

function qoderVersionAtLeast(parts: number[], baseline: number[]): boolean {
	for (let index = 0; index < baseline.length; index += 1) {
		const value = parts[index] ?? 0;
		if (value !== baseline[index]) return value > baseline[index];
	}
	return true;
}

interface QoderControlWaiter {
	resolve: (response: any) => void;
	timer: ReturnType<typeof setTimeout>;
	kind?: "interrupt";
}

function qoderApiErrorText(record: any): string | undefined {
	const content = record?.message?.content;
	const text = Array.isArray(content)
		? content
				.filter((block: any) => block?.type === "text" && typeof block.text === "string")
				.map((block: any) => block.text)
				.join("\n")
				.trim()
		: typeof content === "string"
			? content.trim()
			: "";
	if (!text) return undefined;
	const wrapped = text.match(/^\[API Error:\s*([\s\S]*)\]$/);
	return (wrapped?.[1] ?? text).trim() || undefined;
}

export class QoderStreamJsonDriver extends StdioProcess implements SessionDriver {
	readonly cwdForwardedToCli = false;
	readonly stdinFormat = "stream-json";

	private readonly eventCbs: Array<(event: AgentEvent) => void> = [];
	private readonly turnEndCbs: Array<(outcome: TurnOutcome) => void> = [];
	private readonly controlWaiters = new Map<string, QoderControlWaiter>();
	private readonly steers = new Set<string>();
	private active = false;
	private cancelRequested = false;
	private turnStarted = false;
	private bootFailure: string | undefined;
	private truncated = false;
	private initVersion: string | undefined;
	private initializeVersion: string | undefined;
	private mode: Mode = "yolo";
	private initResolve: (() => void) | undefined;
	private initReject: ((err: Error) => void) | undefined;
	private controlSeq = 0;

	get steerUnavailableReason(): string | undefined {
		return this.steerBlock();
	}

	onEvent(cb: (event: AgentEvent) => void): void {
		this.eventCbs.push(cb);
	}

	onTurnEnd(cb: (outcome: TurnOutcome) => void): void {
		this.turnEndCbs.push(cb);
	}

	buildArgv(input: SessionStartInput): string[] {
		const argv = ["-p", "--output-format", "stream-json", "--input-format", "stream-json", ...qoderPermissionArgs(input.mode)];
		if (input.model) argv.push("--model", input.model);
		if (input.effort) argv.push("--reasoning-effort", input.effort);
		return argv;
	}

	async start(input: SessionStartInput): Promise<void> {
		this.mode = input.mode;
		const ready = this.awaitInit();
		this.spawnProcess(ADAPTERS.qoder.bin, this.buildArgv(input), input.cwd);
		void this
			.controlRequest(
				{
					type: "initialize",
					subtype: "initialize",
					modelPolicyProvider: false,
					supportsCatalogReadyInitialize: false,
					supportsAvailableModelsUpdate: false,
					supportsCommandsChanged: false,
				},
				QODER_INIT_TIMEOUT_MS,
			)
			.then((response: any) => {
				if (response?.subtype === "error") {
					if (this.initResolve) this.failBoot(`qoder rejected the initialize request: ${String(response.error ?? "unknown error")}`);
					return;
				}
				const announced = response?.response?.qodercli_version;
				if (typeof announced === "string") this.initializeVersion = announced;
				this.initResolve?.();
			})
			.catch(() => undefined);
		await ready;
		if (this.bootFailure) throw new Error(`qoder failed before the first turn: ${this.bootFailure}`);
		if (!this.alive) throw new Error(this.spawnError ?? "the qoder session exited before the first turn");
		if (this.cancelRequested) return;
		this.turnStarted = true;
		this.markActive();
		this.sendUserMessage(input.task);
	}

	private awaitInit(): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const done = () => {
			if (timer) clearTimeout(timer);
			timer = undefined;
			this.initResolve = undefined;
			this.initReject = undefined;
		};
		return new Promise<void>((resolve, reject) => {
			this.initResolve = () => {
				done();
				resolve();
			};
			this.initReject = (err: Error) => {
				done();
				reject(err);
			};
			timer = setTimeout(() => {
				this.initReject?.(new Error(`qoder: no system/init handshake within ${Math.round(QODER_INIT_TIMEOUT_MS / 1000)}s`));
			}, QODER_INIT_TIMEOUT_MS);
			timer.unref?.();
		});
	}

	async followUp(message: string): Promise<void> {
		if (!this.alive) throw new Error("the qoder session process is gone");
		if (this.active) throw new Error("a turn is still running; use external_agent_steer instead");
		this.cancelRequested = false;
		this.markActive();
		this.sendUserMessage(message);
	}

	async steer(message: string): Promise<SteerResult> {
		if (!this.active) return { accepted: false, reason: "no turn is currently running" };
		if (!this.alive) return { accepted: false, reason: "the qoder session process is gone" };
		const blocked = this.steerBlock();
		if (blocked) return { accepted: false, reason: `${blocked}. ${QODER_STEER_REFUSAL}` };
		this.steers.add(this.sendUserMessage(message, { priority: "next", shouldQuery: false }));
		return {
			accepted: true,
			note:
				"sent with priority next and shouldQuery false: queued for the next step boundary of the active turn, not confirmed applied. " +
				"It never interrupts and never starts a turn of its own, so guidance that misses this turn stays as context for the next user message.",
		};
	}

	private steerBlock(): string | undefined {
		const announced = this.initializeVersion ?? this.initVersion;
		if (announced === undefined) {
			return `qoder announced no qodercli_version in its system/init record or initialize response, so the ${QODER_STEER_BASELINE} steering baseline cannot be confirmed`;
		}
		const parts = qoderStableVersion(announced);
		if (!parts) {
			return `qoder announced version "${announced}", which is not a stable release number, so the ${QODER_STEER_BASELINE} steering baseline cannot be confirmed`;
		}
		if (qoderVersionAtLeast(parts, QODER_STEER_BASELINE_PARTS)) return undefined;
		return `qoder announced version "${announced}", below the ${QODER_STEER_BASELINE} steering baseline`;
	}

	async cancel(): Promise<void> {
		if (!this.alive) return;
		this.cancelRequested = true;
		await this.controlRequest({ type: "interrupt", subtype: "interrupt" }, QODER_CANCEL_TIMEOUT_MS, "interrupt").catch(() => undefined);
	}

	protected override onProcessExit(): void {
		for (const [id, waiter] of this.controlWaiters) {
			clearTimeout(waiter.timer);
			waiter.resolve({ subtype: "error", error: this.spawnError ?? "session process exited" });
			this.controlWaiters.delete(id);
		}
		const stderrDetail = this.stderr
			.trim()
			.split("\n")
			.map((line) => line.trim())
			.find(Boolean);
		const message =
			this.spawnError ??
			`the qoder session exited before the handshake or the turn ended${stderrDetail ? `: ${stderrDetail.slice(0, 300)}` : ""}`;
		this.initReject?.(new Error(message));
		this.settle({ status: "failed", error: message });
	}

	protected handleLine(line: string): void {
		let obj: any;
		try {
			obj = JSON.parse(line);
		} catch {
			return;
		}
		if (!obj || typeof obj !== "object") return;

		if (obj.type === "system" && obj.subtype === "init") {
			if (typeof obj.qodercli_version === "string") this.initVersion = obj.qodercli_version;
			this.initResolve?.();
			return;
		}
		if (obj.type === "assistant" && obj.parent_tool_use_id == null) {
			if (obj.aborted === true) this.truncated = true;
			else if (Array.isArray(obj.message?.content)) this.truncated = false;
			if (obj.isApiErrorMessage === true || obj.message?.model === QODER_SYNTHETIC_MODEL) {
				const detail = qoderApiErrorText(obj) ?? "qoder reported a model request failure";
				if (!this.turnStarted) {
					this.failBoot(detail);
					return;
				}
				if (!this.active) return;
				this.emit({ kind: "error", text: detail });
				this.settle({ status: "failed", error: detail });
				return;
			}
		}
		if (obj.type === "command_lifecycle") {
			this.handleCommandLifecycle(obj);
			return;
		}
		if (obj.type === "control_request") {
			this.handleControlRequest(obj);
			return;
		}
		if (obj.type === "control_response") {
			this.handleControlResponse(obj);
			return;
		}
		if (obj.type === "control_cancel_request") return;

		if (obj.type === "result") {
			this.handleResult(line, obj);
			return;
		}

		const event = ADAPTERS.qoder.parseEvent(line);
		if (event) this.emit(event);
	}

	private isTerminalResult(obj: any): boolean {
		if (obj.subtype === "success") return typeof obj.result === "string";
		return obj.subtype === "error_during_execution" || obj.subtype === "error_max_turns" || obj.subtype === "error_max_budget_usd";
	}

	private handleResult(line: string, obj: any): void {
		if (!this.isTerminalResult(obj)) return;
		const event = ADAPTERS.qoder.parseEvent(line);
		const failed = event?.kind === "error";
		if (!this.active) {
			if (!this.turnStarted && failed) this.failBoot(event?.text ?? "qoder reported a failed result before the first turn");
			return;
		}
		const cancelled = this.cancelRequested;
		if (event?.text && !(cancelled && failed)) this.emit(event);
		if (cancelled) {
			this.settle({ status: "cancelled" });
			return;
		}
		if (failed) {
			this.settle({ status: "failed", error: event?.text ?? "qoder reported a failed result" });
			return;
		}
		if (this.truncated) {
			this.settle({ status: "cancelled" });
			return;
		}
		this.settle({ status: "done" });
	}

	private handleCommandLifecycle(obj: any): void {
		const commandUuid = typeof obj.command_uuid === "string" ? obj.command_uuid : undefined;
		if (!commandUuid || !this.steers.has(commandUuid)) return;
		if (obj.state === "discarded" || obj.state === "cancelled") {
			this.steers.delete(commandUuid);
			this.emit({ kind: "warning", text: `qoder ${obj.state} the steer ${commandUuid}` });
			return;
		}
		if (obj.state === "completed") this.steers.delete(commandUuid);
	}

	private failBoot(detail: string): void {
		this.bootFailure = detail;
		this.initReject?.(new Error(detail));
	}

	private emit(event: AgentEvent): void {
		for (const cb of this.eventCbs) cb(event);
	}

	private sendUserMessage(text: string, options?: { priority: "next"; shouldQuery: boolean }): string {
		const uuid = randomUUID();
		const message: Record<string, unknown> = {
			type: "user",
			message: { role: "user", content: [{ type: "text", text }] },
			parent_tool_use_id: null,
			uuid,
		};
		if (options) {
			message.priority = options.priority;
			message.shouldQuery = options.shouldQuery;
		}
		this.writeLine(message);
		return uuid;
	}

	private controlRequest(request: Record<string, unknown>, timeoutMs: number, kind?: "interrupt"): Promise<any> {
		const requestId = `q${++this.controlSeq}`;
		return new Promise((resolve, reject) => {
			if (!this.alive && this.spawnError) {
				reject(new Error(this.spawnError));
				return;
			}
			const timer = setTimeout(() => {
				this.controlWaiters.delete(requestId);
				reject(new Error(`control request "${String(request.subtype ?? request.type)}" timed out after ${Math.round(timeoutMs / 1000)}s`));
			}, timeoutMs);
			timer.unref?.();
			this.controlWaiters.set(requestId, { resolve, timer, kind });
			this.writeLine({ type: "control_request", request_id: requestId, request });
		});
	}

	private handleControlResponse(obj: any): void {
		const response = obj.response;
		const rawId = response?.request_id;
		const key = typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : undefined;
		const waiter = key === undefined ? undefined : this.controlWaiters.get(key);
		if (!waiter || key === undefined) return;
		this.controlWaiters.delete(key);
		clearTimeout(waiter.timer);
		if (waiter.kind === "interrupt") this.warnStillQueued(response?.response);
		waiter.resolve(response);
	}

	private warnStillQueued(payload: any): void {
		const stillQueued = Array.isArray(payload?.still_queued)
			? payload.still_queued.filter((id: unknown): id is string => typeof id === "string")
			: [];
		if (stillQueued.length === 0) return;
		this.emit({
			kind: "warning",
			text: `the interrupt reported ${stillQueued.length} still-queued command(s); the session is being stopped`,
		});
	}

	private handleControlRequest(obj: any): void {
		const rawId = obj.request_id;
		const requestId = typeof rawId === "string" || typeof rawId === "number" ? rawId : undefined;
		const request = obj.request && typeof obj.request === "object" ? obj.request : {};
		const subtype = typeof request.subtype === "string" ? request.subtype : typeof request.type === "string" ? request.type : "unknown";
		if (requestId === undefined) {
			const detail = `qoder sent a ${subtype} control request without a usable request_id, so it cannot be answered`;
			if (!this.turnStarted) {
				this.failBoot(detail);
				return;
			}
			if (!this.active) {
				this.kill();
				return;
			}
			this.emit({ kind: "error", text: detail });
			this.settle({ status: "failed", error: detail });
			this.kill();
			return;
		}
		if (subtype === "can_use_tool") {
			const response =
				this.mode === "yolo"
					? { behavior: "allow", updatedInput: request.input ?? {}, ...(typeof request.tool_use_id === "string" ? { toolUseID: request.tool_use_id } : {}) }
					: {
							behavior: "deny",
							message: `${this.mode} mode does not auto-allow this tool, and pi-external-agent exposes no permission prompt channel.`,
							...(typeof request.tool_use_id === "string" ? { toolUseID: request.tool_use_id } : {}),
						};
			this.writeLine({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
			return;
		}
		this.writeLine({
			type: "control_response",
			response: { subtype: "error", request_id: requestId, error: `unsupported control request: ${subtype}` },
		});
	}

	private markActive(): void {
		this.active = true;
		this.truncated = false;
		this.steers.clear();
	}

	private settle(outcome: TurnOutcome): void {
		if (!this.active) return;
		this.active = false;
		this.cancelRequested = false;
		for (const cb of this.turnEndCbs) cb(outcome);
	}
}
