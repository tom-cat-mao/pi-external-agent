/**
 * Persistent session drivers for external agents.
 *
 * The one-shot transport in index.ts spawns a headless process and treats its
 * exit as completion. That shape cannot steer a run or ask a follow-up: by the
 * time the answer exists, the process — and its conversation — is gone. These
 * drivers keep a long-lived stdio session alive instead, so the completion
 * signal moves from "process exited" to "turn ended" while the process stays up
 * for follow-ups.
 *
 * Three wire protocols, one interface:
 *
 *   PiRpcDriver          pi --mode rpc        — line JSON commands + events
 *   CodexAppServerDriver codex app-server     — JSON-RPC 2.0, experimental
 *   AcpDriver            reasonix / codebuddy — JSON-RPC 2.0 ACP over stdio
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
 *
 * Steering is never an immediate interrupt. All four deliver at a step boundary
 * (between tool calls), so a steer cannot cancel a bash command that is already
 * running — only change what the agent does next.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { ADAPTERS, buildReadonlySettings, codexEffortToken, qoderPermissionArgs, type AgentEvent, type AgentId, type Effort, type Mode } from "./adapters.ts";

const MAX_STDERR_CHARS = 8_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 20_000;
/** Grace period after agent_end before settling, for pi builds without agent_settled. */
const PI_SETTLE_GRACE_MS = 1_000;
const MAX_THOUGHT_CHARS = 1_500;

export type SteerResult = { accepted: true; note?: string } | { accepted: false; reason: string };

export type TurnOutcome = { status: "done" | "failed" | "cancelled"; error?: string };

export interface SessionStartInput {
	task: string;
	cwd: string;
	mode: Mode;
	model?: string;
	effort?: Effort;
}

export interface SessionDriver {
	/** argv handed to spawn (binary excluded); surfaced in the dispatch receipt. */
	readonly argv: string[];
	/** Whether the driver forwards cwd through the protocol rather than only inheriting it. */
	readonly cwdForwardedToCli: boolean;
	/** Truncated stderr, same cap as the one-shot path. */
	readonly stderr: string;
	/** True while the session process is up and able to take a follow-up. */
	readonly alive: boolean;
	/** The spawn argv for this session, without the binary. */
	buildArgv(input: SessionStartInput): string[];
	/** spawn + handshake + open session + start the first turn. Throws on failure. */
	start(input: SessionStartInput): Promise<void>;
	/** Mid-run guidance. Only meaningful while a turn is active. */
	steer(message: string): Promise<SteerResult>;
	/** Continue the same session after its turn ended. Throws if it cannot. */
	followUp(message: string): Promise<void>;
	/** Protocol-level graceful cancel; the caller still SIGTERMs as a backstop. */
	cancel(): Promise<void>;
	kill(): void;
	onEvent(cb: (event: AgentEvent) => void): void;
	onTurnEnd(cb: (outcome: TurnOutcome) => void): void;
	onExit(cb: (code: number | null) => void): void;
}

// ---------------------------------------------------------------------------
// stdio plumbing
// ---------------------------------------------------------------------------

/**
 * spawn + strict LF framing + stderr capture, shared by all three protocols.
 *
 * LF only, never `readline`: pi's rpc docs call out that Node's readline also
 * splits on U+2028/U+2029, which are legal inside JSON strings.
 */
abstract class StdioProcess {
	protected proc: ChildProcess | null = null;
	protected spawnArgv: string[] = [];
	private buffer = "";
	private stderrText = "";
	private exited = false;
	private exitCode: number | null = null;
	private spawnErrorMessage: string | undefined;
	private readonly exitCbs: Array<(code: number | null) => void> = [];

	get argv(): string[] {
		return [...this.spawnArgv];
	}

	get stderr(): string {
		return this.stderrText;
	}

	get alive(): boolean {
		return !this.exited && this.proc !== null && this.exitCode === null;
	}

	get spawnError(): string | undefined {
		return this.spawnErrorMessage;
	}

	protected spawnProcess(executable: string, argv: string[], cwd: string): void {
		this.spawnArgv = argv;
		const proc = spawn(executable, argv, {
			cwd,
			// stdin is a live protocol channel here, not the "ignore" of the one-shot path.
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
		});
		this.proc = proc;

		proc.stdout?.setEncoding("utf8");
		proc.stdout?.on("data", (chunk: string) => {
			this.buffer += chunk;
			const lines = this.buffer.split("\n");
			this.buffer = lines.pop() ?? "";
			for (const raw of lines) {
				const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
				if (!line.trim()) continue;
				try {
					this.handleLine(line);
				} catch {
					// A malformed line must never take the session down.
				}
			}
		});

		proc.stderr?.setEncoding("utf8");
		proc.stderr?.on("data", (chunk: string) => {
			if (this.stderrText.length < MAX_STDERR_CHARS) this.stderrText += chunk;
		});

		proc.on("error", (err) => {
			this.spawnErrorMessage = err.message;
			// Spawn/IO failure: treat it like an exit so waiters stop hanging.
			this.finishExit(this.exitCode);
		});

		proc.on("close", (code) => {
			// Flush a trailing partial record: some CLIs emit a final blob with
			// no terminating newline.
			const tail = this.buffer.trim();
			this.buffer = "";
			if (tail) {
				try {
					this.handleLine(tail);
				} catch {
					/* partial line, nothing to recover */
				}
			}
			this.finishExit(code);
		});
	}

	private finishExit(code: number | null): void {
		if (this.exited) return;
		this.exited = true;
		this.exitCode = code;
		this.onProcessExit();
		for (const cb of this.exitCbs) cb(code);
	}

	onExit(cb: (code: number | null) => void): void {
		this.exitCbs.push(cb);
		if (this.exited) cb(this.exitCode);
	}

	kill(): void {
		const proc = this.proc;
		if (!proc || this.exited) return;
		try {
			proc.kill("SIGTERM");
		} catch {
			/* already gone */
		}
		// Backstop for a child that ignores SIGTERM, so no orphan outlives us.
		setTimeout(() => {
			if (proc.exitCode === null && proc.signalCode === null) {
				try {
					proc.kill("SIGKILL");
				} catch {
					/* already gone */
				}
			}
		}, 3_000).unref?.();
	}

	protected writeLine(obj: unknown): void {
		const stdin = this.proc?.stdin;
		if (!stdin || !this.alive) return;
		try {
			stdin.write(`${JSON.stringify(obj)}\n`);
		} catch {
			/* closed pipe; the exit handler settles the task */
		}
	}

	/** Called once when the process goes away; drivers reject pending waiters here. */
	protected onProcessExit(): void {}

	protected abstract handleLine(line: string): void;
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 over stdio (codex app-server, ACP)
// ---------------------------------------------------------------------------

interface PendingRequest {
	resolve: (value: any) => void;
	reject: (err: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
	method: string;
}

abstract class JsonRpcConnection extends StdioProcess {
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly notificationCbs: Array<(method: string, params: any) => void> = [];
	private readonly requestCbs: Array<(msg: any) => void> = [];

	onNotification(cb: (method: string, params: any) => void): void {
		this.notificationCbs.push(cb);
	}

	/** Server -> client requests, e.g. ACP session/request_permission. */
	onRequest(cb: (msg: any) => void): void {
		this.requestCbs.push(cb);
	}

	/** timeoutMs <= 0 waits forever: a turn can legitimately run for hours. */
	request(method: string, params?: unknown, timeoutMs: number = COMMAND_TIMEOUT_MS): Promise<any> {
		return this.enqueue(method, params, timeoutMs).promise;
	}

	/** Same as request, but exposes the id so a stale response can be ignored. */
	enqueue(method: string, params: unknown | undefined, timeoutMs: number): { id: number; promise: Promise<any> } {
		const id = this.nextId++;
		const message: Record<string, unknown> = { jsonrpc: "2.0", id, method };
		if (params !== undefined) message.params = params;
		const failNow = (reject: (err: Error) => void) => {
			reject(new Error(`${method}: ${this.spawnError ?? "session process is gone"}`));
		};
		const promise = new Promise<any>((resolve, reject) => {
			if (!this.alive && this.spawnError) return failNow(reject);
			const entry: PendingRequest = { resolve, reject, method };
			if (timeoutMs > 0) {
				entry.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new Error(`${method}: timed out after ${Math.round(timeoutMs / 1000)}s`));
				}, timeoutMs);
			}
			this.pending.set(id, entry);
			this.writeLine(message);
		});
		return { id, promise };
	}

	notify(method: string, params?: unknown): void {
		const message: Record<string, unknown> = { jsonrpc: "2.0", method };
		if (params !== undefined) message.params = params;
		this.writeLine(message);
	}

	respond(id: number, result: unknown): void {
		this.writeLine({ jsonrpc: "2.0", id, result });
	}

	respondError(id: number, message: string): void {
		this.writeLine({ jsonrpc: "2.0", id, error: { code: -32601, message } });
	}

	protected override onProcessExit(): void {
		for (const [id, entry] of this.pending) {
			if (entry.timer) clearTimeout(entry.timer);
			entry.reject(new Error(`${entry.method}: session process exited`));
			this.pending.delete(id);
		}
	}

	protected handleLine(line: string): void {
		let msg: any;
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		if (!msg || typeof msg !== "object") return;

		if (typeof msg.id === "number" && this.pending.has(msg.id)) {
			const entry = this.pending.get(msg.id)!;
			this.pending.delete(msg.id);
			if (entry.timer) clearTimeout(entry.timer);
			if (msg.error) {
				const detail = typeof msg.error.message === "string" ? msg.error.message : JSON.stringify(msg.error);
				entry.reject(new Error(`${entry.method}: ${detail}`));
			} else {
				entry.resolve(msg.result);
			}
			return;
		}

		if (typeof msg.method !== "string") return;
		// A message carrying both method and id is a request we must answer;
		// without an id it is a fire-and-forget notification.
		if (typeof msg.id === "number") {
			for (const cb of this.requestCbs) cb(msg);
			return;
		}
		for (const cb of this.notificationCbs) cb(msg.method, msg.params);
	}
}

// ---------------------------------------------------------------------------
// Shared driver skeleton: event/turn-end fan-out
// ---------------------------------------------------------------------------

abstract class BaseSessionDriver extends JsonRpcConnection {
	private readonly eventCbs: Array<(event: AgentEvent) => void> = [];
	private readonly turnEndCbs: Array<(outcome: TurnOutcome) => void> = [];
	protected active = false;

	onEvent(cb: (event: AgentEvent) => void): void {
		this.eventCbs.push(cb);
	}

	onTurnEnd(cb: (outcome: TurnOutcome) => void): void {
		this.turnEndCbs.push(cb);
	}

	protected emit(event: AgentEvent | null): void {
		if (!event?.text) return;
		for (const cb of this.eventCbs) cb(event);
	}

	/** Idempotent: only the first settle of a turn notifies. */
	protected settle(outcome: TurnOutcome): void {
		if (!this.active) return;
		this.active = false;
		for (const cb of this.turnEndCbs) cb(outcome);
	}

	protected markActive(): void {
		this.active = true;
	}

	async steer(message: string): Promise<SteerResult> {
		if (!this.active) return { accepted: false, reason: "no turn is currently running" };
		return this.sendSteer(message);
	}

	protected abstract sendSteer(message: string): Promise<SteerResult>;
}

// ---------------------------------------------------------------------------
// pi --mode rpc
// ---------------------------------------------------------------------------

interface PiCommandWaiter {
	resolve: (value: { success: boolean; error?: string }) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * pi's rpc mode is not JSON-RPC: commands and events share one JSONL stream and
 * a command is acknowledged by {"type":"response","command":…,"success":…}
 * carrying the caller's optional `id`.
 */
class PiRpcDriver extends StdioProcess implements SessionDriver {
	readonly cwdForwardedToCli = false;

	private readonly eventCbs: Array<(event: AgentEvent) => void> = [];
	private readonly turnEndCbs: Array<(outcome: TurnOutcome) => void> = [];
	private readonly waiters = new Map<string, PiCommandWaiter>();
	private commandSeq = 0;
	private active = false;
	private settleTimer: ReturnType<typeof setTimeout> | undefined;

	onEvent(cb: (event: AgentEvent) => void): void {
		this.eventCbs.push(cb);
	}

	onTurnEnd(cb: (outcome: TurnOutcome) => void): void {
		this.turnEndCbs.push(cb);
	}

	buildArgv(input: SessionStartInput): string[] {
		const argv = ["--mode", "rpc", "--no-session", "--no-extensions"];
		// pi has no sandbox, so the tiers map onto the tool allowlist exactly as
		// the one-shot path does.
		if (input.mode === "readonly") argv.push("--tools", "read,grep,find,ls");
		if (input.model) argv.push("--model", input.model);
		if (input.effort) argv.push("--thinking", input.effort);
		return argv;
	}

	async start(input: SessionStartInput): Promise<void> {
		this.spawnProcess(ADAPTERS.pi.bin, this.buildArgv(input), input.cwd);
		// The argv prompt is ignored in rpc mode; the task goes in over stdin.
		const res = await this.command({ type: "prompt", message: input.task });
		if (!res.success) {
			throw new Error(`pi rpc rejected the prompt: ${res.error ?? this.spawnError ?? "unknown error"}`);
		}
		this.markActive();
	}

	async followUp(message: string): Promise<void> {
		// `follow_up` only drains while the agent is running — on an idle session
		// it would just sit in the queue, so `prompt` is the right command here.
		const res = await this.command({ type: "prompt", message });
		if (!res.success) {
			const queued = await this.command({ type: "follow_up", message });
			if (!queued.success) throw new Error(`pi rpc rejected the follow-up: ${queued.error ?? "unknown error"}`);
		}
		this.markActive();
	}

	async steer(message: string): Promise<SteerResult> {
		if (!this.active) return { accepted: false, reason: "no turn is currently running" };
		const res = await this.command({ type: "steer", message });
		if (!res.success) return { accepted: false, reason: res.error ?? "pi rpc rejected the steer" };
		return { accepted: true, note: "queued for the next step boundary" };
	}

	async cancel(): Promise<void> {
		if (!this.alive) return;
		await this.command({ type: "abort" }, 5_000).catch(() => undefined);
	}

	private markActive(): void {
		this.active = true;
		if (this.settleTimer) {
			clearTimeout(this.settleTimer);
			this.settleTimer = undefined;
		}
	}

	private settle(outcome: TurnOutcome): void {
		if (!this.active) return;
		this.active = false;
		if (this.settleTimer) {
			clearTimeout(this.settleTimer);
			this.settleTimer = undefined;
		}
		for (const cb of this.turnEndCbs) cb(outcome);
	}

	private command(
		cmd: Record<string, unknown>,
		timeoutMs = COMMAND_TIMEOUT_MS,
	): Promise<{ success: boolean; error?: string }> {
		const id = `c${++this.commandSeq}`;
		return new Promise((resolve) => {
			if (!this.alive && this.spawnError) {
				resolve({ success: false, error: this.spawnError });
				return;
			}
			const timer = setTimeout(() => {
				this.waiters.delete(id);
				resolve({ success: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s` });
			}, timeoutMs);
			this.waiters.set(id, { resolve, timer });
			this.writeLine({ ...cmd, id });
		});
	}

	protected override onProcessExit(): void {
		for (const [id, waiter] of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.resolve({ success: false, error: this.spawnError ?? "session process exited" });
			this.waiters.delete(id);
		}
		if (this.settleTimer) {
			clearTimeout(this.settleTimer);
			this.settleTimer = undefined;
		}
		// An exit mid-turn is a failure, not an answer.
		this.settle({ status: "failed", error: this.spawnError ?? "pi rpc process exited before the turn ended" });
	}

	protected handleLine(line: string): void {
		let obj: any;
		try {
			obj = JSON.parse(line);
		} catch {
			return;
		}
		if (!obj || typeof obj !== "object") return;

		if (obj.type === "response") {
			const id = typeof obj.id === "string" ? obj.id : undefined;
			const waiter = id ? this.waiters.get(id) : undefined;
			if (!waiter) return;
			this.waiters.delete(id!);
			clearTimeout(waiter.timer);
			waiter.resolve({ success: obj.success === true, error: typeof obj.error === "string" ? obj.error : undefined });
			return;
		}

		// Lifecycle first: a follow-up's new run must re-arm the settle guard.
		if (obj.type === "agent_start" || obj.type === "turn_start") {
			this.markActive();
		}
		if (obj.type === "agent_settled") {
			this.settle({ status: "done" });
			return;
		}
		if (obj.type === "agent_end") {
			// Builds without agent_settled stop here; settle on a short grace
			// period so a retry or queued continuation can still claim the turn.
			if (obj.willRetry === true) {
				this.markActive();
			} else if (this.active && !this.settleTimer) {
				this.settleTimer = setTimeout(() => this.settle({ status: "done" }), PI_SETTLE_GRACE_MS);
				this.settleTimer.unref?.();
			}
		}

		// Reuse the one-shot pi parser: message_end / turn_end /
		// tool_execution_start have identical shapes in rpc mode.
		const event = ADAPTERS.pi.parseEvent(line);
		if (event) for (const cb of this.eventCbs) cb(event);
	}
}

// ---------------------------------------------------------------------------
// codex app-server
// ---------------------------------------------------------------------------

/**
 * Method names are centralized because `codex app-server` is explicitly
 * experimental and has renamed methods across releases. Verified against
 * codex-cli 0.153.4 via `codex app-server generate-json-schema`.
 */
const CODEX_SUBCOMMAND = "app-server";

const CODEX_METHODS = {
	initialize: "initialize",
	initialized: "initialized",
	threadStart: "thread/start",
	turnStart: "turn/start",
	turnSteer: "turn/steer",
	turnInterrupt: "turn/interrupt",
} as const;

class CodexAppServerDriver extends BaseSessionDriver implements SessionDriver {
	readonly cwdForwardedToCli = true;

	private threadId: string | undefined;
	private currentTurnId: string | undefined;
	private effort: Effort | undefined;
	private readonly agentId = "codex";

	buildArgv(): string[] {
		return [CODEX_SUBCOMMAND];
	}

	async start(input: SessionStartInput): Promise<void> {
		this.effort = input.effort;
		const sandbox = input.mode === "readonly" ? "read-only" : input.mode === "write" ? "workspace-write" : "danger-full-access";

		this.spawnProcess(ADAPTERS[this.agentId].bin, this.buildArgv(), input.cwd);
		this.onNotification((method, params) => this.handleNotification(method, params));
		this.onRequest((msg) => {
			// approvalPolicy "never" means codex should not ask; if it still does,
			// answer rather than leave the turn blocked forever.
			this.respondError(msg.id, `unsupported client request: ${msg.method}`);
		});

		await this.request(
			CODEX_METHODS.initialize,
			{ clientInfo: { name: "pi-external-agent", version: "1.0" } },
			HANDSHAKE_TIMEOUT_MS,
		);
		// codex expects the initialized notification before any other call.
		this.notify(CODEX_METHODS.initialized);

		const thread = await this.request(
			CODEX_METHODS.threadStart,
			{
				cwd: input.cwd,
				approvalPolicy: "never",
				sandbox,
				...(input.model ? { model: input.model } : {}),
			},
			HANDSHAKE_TIMEOUT_MS,
		);
		this.threadId = thread?.thread?.id;
		if (!this.threadId) throw new Error(`${this.agentId} app-server returned no thread id`);

		await this.startTurn(input.task);
	}

	async followUp(message: string): Promise<void> {
		if (!this.threadId) throw new Error(`no ${this.agentId} thread to continue`);
		await this.startTurn(message);
	}

	async cancel(): Promise<void> {
		if (!this.threadId || !this.currentTurnId || !this.alive) return;
		await this
			.request(CODEX_METHODS.turnInterrupt, { threadId: this.threadId, turnId: this.currentTurnId }, 5_000)
			.catch(() => undefined);
	}

	protected async sendSteer(message: string): Promise<SteerResult> {
		if (!this.threadId || !this.currentTurnId) return { accepted: false, reason: `no active ${this.agentId} turn to steer` };
		try {
			const res = await this.request(
				CODEX_METHODS.turnSteer,
				{
					threadId: this.threadId,
					expectedTurnId: this.currentTurnId,
					input: [{ type: "text", text: message }],
				},
				COMMAND_TIMEOUT_MS,
			);
			const turnId = res?.turnId;
			if (turnId) this.currentTurnId = turnId;
			return { accepted: true, note: `accepted for turn ${turnId ?? this.currentTurnId}` };
		} catch (err) {
			// A stale expectedTurnId means the turn already ended: say so instead
			// of pretending the guidance landed.
			return { accepted: false, reason: err instanceof Error ? err.message : String(err) };
		}
	}

	private async startTurn(text: string): Promise<void> {
		const res = await this.request(
			CODEX_METHODS.turnStart,
			{
				threadId: this.threadId,
				input: [{ type: "text", text }],
				...(this.effort ? { effort: codexEffortToken(this.effort) } : {}),
			},
			COMMAND_TIMEOUT_MS,
		);
		this.currentTurnId = res?.turn?.id;
		this.markActive();
	}

	private handleNotification(method: string, params: any): void {
		switch (method) {
			case "turn/started": {
				const id = params?.turn?.id;
				if (id) this.currentTurnId = id;
				this.markActive();
				return;
			}
			case "turn/completed": {
				const status = params?.turn?.status;
				this.currentTurnId = undefined;
				if (status === "interrupted") {
					this.settle({ status: "cancelled", error: params?.turn?.error?.message });
				} else if (status === "failed") {
					this.settle({ status: "failed", error: params?.turn?.error?.message ?? `${this.agentId} turn failed` });
				} else {
					this.settle({ status: "done" });
				}
				return;
			}
			case "item/completed":
				this.emit(codexItemEvent(params?.item));
				return;
			case "error": {
				const message = params?.error?.message ?? params?.message;
				this.emit(message ? { kind: "error", text: String(message).slice(0, 500) } : null);
				return;
			}
			default:
				return;
		}
	}
}

function codexItemEvent(item: any): AgentEvent | null {
	if (!item) return null;
	switch (item.type) {
		case "agentMessage":
			return { kind: "message", text: String(item.text ?? "") };
		case "reasoning":
			return { kind: "reasoning", text: String(item.text ?? "").slice(0, MAX_THOUGHT_CHARS) };
		case "commandExecution":
			return { kind: "tool", text: `$ ${String(item.command ?? "")}`.trim().slice(0, 200) };
		case "fileChange":
		case "patchApply":
			return { kind: "tool", text: `edit ${String(item.path ?? "")}`.trim().slice(0, 200) };
		case "error":
			// Non-fatal in this family, exactly as in the one-shot parser.
			return { kind: "warning", text: String(item.message ?? "").slice(0, 500) };
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// ACP (reasonix, codebuddy)
// ---------------------------------------------------------------------------

interface AcpDialect {
	id: AgentId;
	/** Extra argv appended after --acp. */
	baseArgv: (input: SessionStartInput) => string[];
}

const ACP_FLAG = "--acp";

const ACP_METHODS = {
	initialize: "initialize",
	sessionNew: "session/new",
	sessionPrompt: "session/prompt",
	sessionCancel: "session/cancel",
	requestPermission: "session/request_permission",
} as const;

/**
 * Pull the real failure text out of a prompt response's `_meta`. codebuddy
 * nests it as a JSON-encoded string under "codebuddy.ai/errorMessage" whose
 * payload's .message holds the human text; fall back to plainer shapes.
 */
function extractMetaError(meta: unknown): string | undefined {
	if (!meta || typeof meta !== "object") return undefined;
	const record = meta as Record<string, unknown>;
	const raw = record["codebuddy.ai/errorMessage"] ?? record.errorMessage ?? record.error;
	if (typeof raw !== "string" || !raw.trim()) return undefined;
	try {
		const inner = JSON.parse(raw) as { message?: unknown };
		if (typeof inner.message === "string" && inner.message.trim()) return inner.message.slice(0, 500);
	} catch {
		/* not JSON-encoded; use as-is */
	}
	return raw.slice(0, 500);
}

class AcpDriver extends BaseSessionDriver implements SessionDriver {
	readonly cwdForwardedToCli = true;

	private sessionId: string | undefined;
	private steerMethod: string | undefined;
	private activePromptId: number | undefined;
	private messageBuffer = "";
	private thoughtBuffer = "";
	private autoPermission: "allow" | "reject" = "allow";
	private readonly toolCalls = new Map<string, { title: string; emitted: boolean }>();
	private readonly dialect: AcpDialect;

	constructor(dialect: AcpDialect) {
		super();
		this.dialect = dialect;
	}

	buildArgv(input: SessionStartInput): string[] {
		return [ACP_FLAG, ...this.dialect.baseArgv(input)];
	}

	async start(input: SessionStartInput): Promise<void> {
		// Readonly fail-safe only: since the settings-based readonly design
		// (codebuddy: --permission-mode default + --settings deny rules + Bash
		// hook), a permission request should never reach this driver at all —
		// rule-layer denies happen silently inside codebuddy. "reject" stays as
		// the backstop for dialects without settings enforcement (and note that
		// rejecting a codebuddy ACP request cancels the whole turn, which is
		// exactly why readonly moved off plan mode).
		this.autoPermission = input.mode === "readonly" ? "reject" : "allow";
		this.spawnProcess(ADAPTERS[this.dialect.id].bin, this.buildArgv(input), input.cwd);
		this.onNotification((method, params) => this.handleNotification(method, params));
		this.onRequest((msg) => this.handleRequest(msg));

		const init = await this.request(
			ACP_METHODS.initialize,
			{
				protocolVersion: 1,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
				clientInfo: { name: "pi-external-agent", version: "1.0" },
			},
			HANDSHAKE_TIMEOUT_MS,
		);

		// The steer method is advertised, not fixed: take it from whichever
		// vendor namespace offers one, so a rename cannot break us silently.
		const meta = init?.agentCapabilities?._meta;
		if (meta && typeof meta === "object") {
			for (const value of Object.values(meta as Record<string, any>)) {
				const method = (value as any)?.sessionSteer?.method;
				if (typeof method === "string" && method) {
					this.steerMethod = method;
					break;
				}
			}
		}

		const created = await this.request(ACP_METHODS.sessionNew, { cwd: input.cwd, mcpServers: [] }, HANDSHAKE_TIMEOUT_MS);
		this.sessionId = created?.sessionId;
		if (!this.sessionId) throw new Error(`${this.dialect.id} ACP returned no sessionId`);

		this.startPrompt(input.task);
	}

	async followUp(message: string): Promise<void> {
		if (!this.sessionId) throw new Error(`no ${this.dialect.id} session to continue`);
		if (this.activePromptId !== undefined) throw new Error("a turn is still running; use external_agent_steer instead");
		this.startPrompt(message);
	}

	async cancel(): Promise<void> {
		if (!this.sessionId || !this.alive) return;
		// Best effort; the caller's SIGTERM backstop covers dialects where cancel
		// is unimplemented. (reasonix v1.38.1 DOES honor it — verified 2026-09-08:
		// the turn settled as cancelled ~0.2s after the notification.)
		this.notify(ACP_METHODS.sessionCancel, { sessionId: this.sessionId });
	}

	protected async sendSteer(message: string): Promise<SteerResult> {
		if (!this.sessionId) return { accepted: false, reason: `no ${this.dialect.id} session` };

		if (this.steerMethod) {
			try {
				const res = await this.request(
					this.steerMethod,
					{ sessionId: this.sessionId, prompt: [{ type: "text", text: message }] },
					COMMAND_TIMEOUT_MS,
				);
				const disposition = res?.disposition;
				if (disposition === "queued_followup") {
					return { accepted: true, note: "queued_followup: the turn had already moved on, so it runs as the next follow-up" };
				}
				return { accepted: true, note: disposition ? `disposition: ${disposition}` : "accepted for the next step boundary" };
			} catch (err) {
				return { accepted: false, reason: err instanceof Error ? err.message : String(err) };
			}
		}

		// No advertised steer method (codebuddy): a second prompt on the active
		// session is the steer. Its response only lands when the turn ends, so it
		// is deliberately not tracked as this turn's own prompt.
		void this
			.request(ACP_METHODS.sessionPrompt, { sessionId: this.sessionId, prompt: [{ type: "text", text: message }] }, 0)
			.catch(() => undefined);
		return {
			accepted: true,
			note: "sent as an extra prompt; injected at the next step boundary, or as a follow-up if the turn ends first",
		};
	}

	/**
	 * Fire the turn's prompt and drive the settle from its response, which ACP
	 * only sends once the turn finishes (it must never be awaited inline).
	 */
	private startPrompt(text: string): void {
		this.resetTurnBuffers();
		this.markActive();
		const { id, promise } = this.enqueue(
			ACP_METHODS.sessionPrompt,
			{ sessionId: this.sessionId, prompt: [{ type: "text", text }] },
			0,
		);
		this.activePromptId = id;
		promise
			.then((result) => {
				if (id !== this.activePromptId) return;
				this.activePromptId = undefined;
				this.finishTurn(result?.stopReason, result?._meta);
			})
			.catch((err: Error) => {
				if (id !== this.activePromptId) return;
				this.activePromptId = undefined;
				this.settle({ status: "failed", error: err.message });
			});
	}

	private finishTurn(stopReason: unknown, meta?: unknown): void {
		// Chunks are incremental; emit one assembled message so callers never
		// see the answer shredded into per-token events.
		if (this.messageBuffer.trim()) this.emit({ kind: "message", text: this.messageBuffer.trim() });
		if (this.thoughtBuffer.trim()) {
			this.emit({ kind: "reasoning", text: this.thoughtBuffer.trim().slice(0, MAX_THOUGHT_CHARS) });
		}
		this.resetTurnBuffers();
		// ACP stop reasons: end_turn / max_tokens / max_turn_requests / refusal /
		// cancelled. codebuddy reports quota and model failures as a SUCCESSFUL
		// prompt response with stopReason "refusal" and the real error buried in
		// _meta["codebuddy.ai/errorMessage"] (observed 2026-09-08: 429 quota as
		// stopReason refusal, zero assistant chunks). Mapping that to "done"
		// would report a dead run as a completed one with an empty answer.
		if (stopReason === "cancelled") {
			this.settle({ status: "cancelled" });
			return;
		}
		if (stopReason === "refusal") {
			const detail = extractMetaError(meta) ?? "agent refused (no detail)";
			this.emit({ kind: "error", text: detail });
			this.settle({ status: "failed", error: detail });
			return;
		}
		this.settle({ status: "done" });
	}

	private resetTurnBuffers(): void {
		this.messageBuffer = "";
		this.thoughtBuffer = "";
		this.toolCalls.clear();
	}

	private handleRequest(msg: any): void {
		if (msg.method !== ACP_METHODS.requestPermission) {
			this.respondError(msg.id, `unsupported client request: ${msg.method}`);
			return;
		}
		const options: any[] = Array.isArray(msg.params?.options) ? msg.params.options : [];
		const wanted = this.autoPermission;
		const chosen =
			options.find((o) => typeof o?.kind === "string" && o.kind.startsWith(wanted)) ??
			options.find((o) => typeof o?.optionId === "string" && o.optionId.toLowerCase().includes(wanted)) ??
			options[0];
		if (!chosen) {
			this.respondError(msg.id, "no permission option available");
			return;
		}
		this.respond(msg.id, { outcome: { outcome: "selected", optionId: chosen.optionId ?? chosen.kind } });
	}

	private handleNotification(method: string, params: any): void {
		if (method !== "session/update") return;
		const update = params?.update;
		if (!update) return;
		switch (update.sessionUpdate) {
			case "agent_message_chunk": {
				const content = update.content;
				if (content?.type === "text" && typeof content.text === "string") this.messageBuffer += content.text;
				return;
			}
			case "agent_thought_chunk": {
				const content = update.content;
				if (content?.type === "text" && typeof content.text === "string") this.thoughtBuffer += content.text;
				return;
			}
			case "tool_call": {
				const id = update.toolCallId;
				const title = String(update.title ?? update.name ?? "tool");
				if (update.rawInput && Object.keys(update.rawInput).length > 0) {
					this.emitTool(id, title, update.rawInput);
					return;
				}
				// codebuddy announces the call before streaming its arguments, so
				// wait for the update that actually carries them.
				if (id) this.toolCalls.set(id, { title, emitted: false });
				return;
			}
			case "tool_call_update": {
				const id = update.toolCallId;
				const entry = id ? this.toolCalls.get(id) : undefined;
				if (!entry || entry.emitted) return;
				if (update.rawInput && Object.keys(update.rawInput).length > 0) {
					this.emitTool(id, entry.title, update.rawInput);
				} else if (update.status === "completed") {
					this.emitTool(id, entry.title, undefined);
				}
				return;
			}
			case "usage_update": {
				if (typeof update.used === "number") {
					const size = typeof update.size === "number" ? `/${update.size}` : "";
					this.emit({ kind: "usage", text: `ctx=${update.used}${size}` });
				}
				return;
			}
			default:
				return;
		}
	}

	private emitTool(id: string | undefined, title: string, rawInput: unknown): void {
		if (id) this.toolCalls.set(id, { title, emitted: true });
		const args = rawInput === undefined ? "" : ` ${JSON.stringify(rawInput)}`;
		this.emit({ kind: "tool", text: `${title}${args}`.trim().slice(0, 200) });
	}
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/**
 * Agents that run over a persistent session. Everything else keeps the
 * one-shot spawn path in index.ts.
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
	qoder: () =>
		new AcpDriver({
			id: "qoder",
			baseArgv: (input) => {
				const argv = qoderPermissionArgs(input.mode);
				if (input.model) argv.push("--model", input.model);
				if (input.effort) argv.push("--reasoning-effort", input.effort);
				return argv;
			},
		}),
};

export const SESSION_AGENT_IDS = Object.keys(SESSION_DRIVERS) as AgentId[];

export function hasSessionDriver(agent: AgentId): boolean {
	return SESSION_DRIVERS[agent] !== undefined;
}
