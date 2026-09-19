/**
 * pi --mode rpc.
 *
 * pi's rpc mode is not JSON-RPC: commands and events share one JSONL stream and
 * a command is acknowledged by {"type":"response","command":…,"success":…}.
 * The argv prompt is NOT executed in rpc mode, so the task goes in over stdin
 * after startup; `agent_settled` is the settle signal.
 */

import { ADAPTERS, type AgentEvent } from "../adapters.ts";
import {
	COMMAND_TIMEOUT_MS,
	PI_SETTLE_GRACE_MS,
	StdioProcess,
	type SessionDriver,
	type SessionStartInput,
	type SteerResult,
	type TurnOutcome,
} from "./base.ts";

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
export class PiRpcDriver extends StdioProcess implements SessionDriver {
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
