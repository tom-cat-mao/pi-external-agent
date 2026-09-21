/**
 * Persistent session plumbing shared by every driver: spawn + strict LF framing,
 * stderr capture, JSON-RPC 2.0 over stdio, and the event/turn-end fan-out.
 *
 * The drivers themselves live in pi-rpc.ts, codex-app-server.ts, acp.ts and
 * stream-json.ts; the registry that names them is drivers/index.ts.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mergeSpawnEnv, type AgentEvent, type Effort, type Mode } from "../adapters.ts";

const MAX_STDERR_CHARS = 8_000;
export const HANDSHAKE_TIMEOUT_MS = 30_000;
export const COMMAND_TIMEOUT_MS = 20_000;
/** Grace period after agent_end before settling, for pi builds without agent_settled. */
export const PI_SETTLE_GRACE_MS = 1_000;
export const MAX_THOUGHT_CHARS = 1_500;

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
	readonly stdinFormat?: "jsonrpc" | "stream-json";
	readonly steerUnavailableReason?: string;
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
 * spawn + strict LF framing + stderr capture, shared by every driver.
 *
 * LF only, never `readline`: pi's rpc docs call out that Node's readline also
 * splits on U+2028/U+2029, which are legal inside JSON strings.
 */
export abstract class StdioProcess {
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

	/**
	 * `extraEnv` is merged OVER process.env, never a replacement: a dialect
	 * contributes what its CLI needs (dsh: DSH_PERMISSION_MODE) without taking
	 * away the environment the process has to run in at all. An `undefined`
	 * value DELETES that key from the child's environment (dsh: an inherited
	 * DSH_HOME must not reach the process, or it would resolve a different home
	 * than the provisioned one).
	 */
	protected spawnProcess(
		executable: string,
		argv: string[],
		cwd: string,
		extraEnv?: Record<string, string | undefined>,
	): void {
		this.spawnArgv = argv;
		const proc = spawn(executable, argv, {
			cwd,
			// stdin is a live protocol channel here, not the "ignore" of the one-shot path.
			stdio: ["pipe", "pipe", "pipe"],
			env: extraEnv ? mergeSpawnEnv(process.env, extraEnv) : process.env,
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

		proc.stdin?.on("error", (err) => {
			this.spawnErrorMessage = `stdin: ${err.message}`;
			this.kill();
			this.finishExit(null);
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

/**
 * The real failure text a JSON-RPC error hides in `error.data.details`. A
 * harness that wraps every engine failure in one fixed message puts the human
 * words there (kimi answers a plan→plan mode set with message "Internal error"
 * and data.details "Already in plan mode"), so a driver matching on the
 * rejection's text — or reporting it to the caller — never sees the reason
 * otherwise. A string is used as it is; a structured value is JSON-encoded, so
 * nothing is dropped. Returns "" when there is no such field, which keeps an
 * error that carries only a message surfaced exactly as it was.
 */
function errorDataDetails(data: unknown): string {
	if (!data || typeof data !== "object") return "";
	const details = (data as { details?: unknown }).details;
	if (typeof details === "string") return details.trim().slice(0, 500);
	if (details === undefined || details === null) return "";
	try {
		const encoded = JSON.stringify(details);
		return encoded && encoded !== "{}" ? encoded.slice(0, 500) : "";
	} catch {
		return "";
	}
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

		// A message carrying a method is a request or a notification, never a
		// response — even when its id matches a request we are waiting on. Both
		// sides number their requests independently, so a harness counting its
		// permission requests from its own small counter (dsh escalates several
		// times inside one turn) eventually hands one the id of the pending
		// session/prompt; reading that as the reply settles the turn early and
		// leaves the escalation unanswered.
		if (typeof msg.method === "string") {
			// A message carrying both method and id is a request we must answer;
			// without an id it is a fire-and-forget notification. Only NUMERIC
			// ids are routed as requests: JSON-RPC 2.0 also allows string ids,
			// and the ACP dialects (reasonix, codebuddy, dsh, kimi) number their
			// requests with integers, which is the type respond() replies in. A
			// string-id request would fall through to the notification callback
			// and never be answered — the ACP contract, not a case to guess at.
			if (typeof msg.id === "number") {
				for (const cb of this.requestCbs) cb(msg);
				return;
			}
			for (const cb of this.notificationCbs) cb(msg.method, msg.params);
			return;
		}

		if (typeof msg.id === "number" && this.pending.has(msg.id)) {
			const entry = this.pending.get(msg.id)!;
			this.pending.delete(msg.id);
			if (entry.timer) clearTimeout(entry.timer);
			if (msg.error) {
				const detail = typeof msg.error.message === "string" ? msg.error.message : JSON.stringify(msg.error);
				// Message first, then whatever the error quarantined in
				// data.details: the message alone is often a fixed wrapper.
				const hidden = errorDataDetails(msg.error.data);
				entry.reject(new Error(`${entry.method}: ${detail}${hidden ? ` — ${hidden}` : ""}`));
			} else {
				entry.resolve(msg.result);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Shared driver skeleton: event/turn-end fan-out
// ---------------------------------------------------------------------------

export abstract class BaseSessionDriver extends JsonRpcConnection {
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
