/**
 * codex app-server — JSON-RPC 2.0, explicitly experimental.
 *
 * initialize -> `initialized` notification -> thread/start -> turn/start.
 * Steering requires expectedTurnId to match the active turn; turn/completed
 * (status completed|interrupted|failed) is the settle signal and the process
 * stays up.
 */

import { ADAPTERS, codexEffortToken, type AgentEvent, type Effort } from "../adapters.ts";
import {
	BaseSessionDriver,
	COMMAND_TIMEOUT_MS,
	HANDSHAKE_TIMEOUT_MS,
	MAX_THOUGHT_CHARS,
	type SessionDriver,
	type SessionStartInput,
	type SteerResult,
} from "./base.ts";

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

export class CodexAppServerDriver extends BaseSessionDriver implements SessionDriver {
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
		// The turn is marked active BEFORE turn/start goes out, as the ACP and
		// Qoder drivers do. `codex app-server` can write the response and the
		// turn's notifications in one stdout chunk; a turn/completed read from
		// that chunk would reach settle() before the awaited response had run
		// its continuation and be dropped as if it were stale, leaving the task
		// running forever. Activating up front makes either arrival order work;
		// the response only contributes the turn id.
		this.currentTurnId = undefined;
		this.markActive();
		const res = await this.request(
			CODEX_METHODS.turnStart,
			{
				threadId: this.threadId,
				input: [{ type: "text", text }],
				...(this.effort ? { effort: codexEffortToken(this.effort) } : {}),
			},
			COMMAND_TIMEOUT_MS,
		);
		// The turn may already have settled out of the same chunk; never adopt
		// the id of a turn that is no longer running.
		if (this.active) this.currentTurnId = res?.turn?.id;
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
