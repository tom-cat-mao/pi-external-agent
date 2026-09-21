/**
 * ACP over stdio (reasonix, codebuddy, dsh).
 *
 * reasonix initialize advertises _meta["reasonix.io"].sessionSteer.method; read
 * the advertised name, never hardcode it. `--acp` accepts --model but rejects
 * --permission-mode and --effort (verified v1.38.1: "flag provided but not
 * defined"), so permissions are answered over session/request_permission and
 * effort cannot be forwarded. codebuddy is plain ACP: steering is a second
 * session/prompt on the active session. dsh spells the same entry point as a
 * profile (`--profile acp`, verified 0.1.5-rc.2) followed by `--patch` and its
 * overlay, and has no effort flag either, but its session exposes a
 * reasoning_effort config option, so effort is forwarded with
 * session/set_config_option.
 */

import { ADAPTERS, type AgentEvent, type AgentId, type Effort, type Mode } from "../adapters.ts";
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
// ACP (reasonix, codebuddy, dsh)
// ---------------------------------------------------------------------------

export interface AcpDialect {
	id: AgentId;
	/**
	 * The whole ACP entry argv. Every dialect but dsh speaks ACP behind a bare
	 * `--acp` (the default); dsh spells it as `--profile acp`, and a dialect
	 * replaces the entry instead of appending to a hardcoded flag.
	 */
	acpArgv?: string[];
	/** Extra argv appended after the ACP entry. */
	baseArgv: (input: SessionStartInput) => string[];
	/**
	 * Everything this dialect settles before its process is spawned. `env` is
	 * merged over process.env by spawnProcess (never a replacement), and a
	 * value of `undefined` DELETES that key from the child's environment; dsh
	 * uses both — DSH_PERMISSION_MODE carries the tier, and an inherited
	 * DSH_HOME is removed so the shared home the overlay was written into is the
	 * one dsh resolves. `warning` is a non-fatal notice about the start (dsh:
	 * the composition anchor found the composed config disagreeing with what
	 * provisioning wrote, so the requested tier may not be the one in force)
	 * that the driver emits into the task's warning stream, where
	 * external_agent_status reports it. Throwing here fails the session start
	 * with that reason, before anything is spawned.
	 */
	prepare?: (input: SessionStartInput) => { env?: Record<string, string | undefined>; warning?: string } | undefined;
	failClosedPermissionModes?: Mode[];
	/**
	 * Effort forwarding over the protocol, for dialects whose CLI has no effort
	 * flag (dsh: set reasoning_effort to the mapped level after session/new).
	 * Dialects with a real flag (codebuddy) carry it in baseArgv and leave this
	 * unset. A rejected set_config_option fails the session start — the turn
	 * must never run at a default the caller did not ask for.
	 */
	effort?: { configId: string; token: (effort: Effort) => string };
}

/** The ACP entry flag every dialect but dsh uses. */
const DEFAULT_ACP_ARGV = ["--acp"];

const ACP_METHODS = {
	initialize: "initialize",
	sessionNew: "session/new",
	sessionPrompt: "session/prompt",
	sessionCancel: "session/cancel",
	sessionSetConfigOption: "session/set_config_option",
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

export class AcpDriver extends BaseSessionDriver implements SessionDriver {
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
		return [...(this.dialect.acpArgv ?? DEFAULT_ACP_ARGV), ...this.dialect.baseArgv(input)];
	}

	async start(input: SessionStartInput): Promise<void> {
		// Readonly fail-safe only: since the settings-based readonly design
		// (codebuddy: --permission-mode default + --settings deny rules + Bash
		// hook), a permission request should never reach this driver at all —
		// rule-layer denies happen silently inside codebuddy. "reject" stays as
		// the backstop for dialects without settings enforcement (and note that
		// rejecting a codebuddy ACP request cancels the whole turn, which is
		// exactly why readonly moved off plan mode).
		this.autoPermission = (this.dialect.failClosedPermissionModes ?? ["readonly"]).includes(input.mode) ? "reject" : "allow";
		// The dialect's prepare hook runs before the spawn: a dialect that cannot
		// provision what its process needs (dsh: the settings document and the
		// overlay that pins dsh to it) throws here, and the session start fails
		// with that reason instead of running a process that cannot work.
		const prepared = this.dialect.prepare?.(input);
		this.spawnProcess(ADAPTERS[this.dialect.id].bin, this.buildArgv(input), input.cwd, prepared?.env);
		this.onNotification((method, params) => this.handleNotification(method, params));
		this.onRequest((msg) => this.handleRequest(msg));
		// A dialect-level warning about this start (dsh: the composition anchor
		// found a patch, or a replaced row, that leaves the requested tier not in
		// force) rides the task's warning stream — the hub's existing surface for
		// non-fatal notices — rather than being dropped or promoted to a failure.
		if (prepared?.warning) this.emit({ kind: "warning", text: prepared.warning });

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

		// Effort, for dialects whose CLI has no flag for it: set the session
		// config option before the first turn. The rejection is deliberately not
		// caught — the session start fails with the CLI's own error, so a run
		// never proceeds at a default the caller did not ask for.
		const effort = this.dialect.effort;
		if (input.effort && effort) {
			await this.request(
				ACP_METHODS.sessionSetConfigOption,
				{ sessionId: this.sessionId, configId: effort.configId, value: effort.token(input.effort) },
				HANDSHAKE_TIMEOUT_MS,
			);
		}

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
		if (this.autoPermission === "reject") {
			const reject = options.find(
				(o) =>
					(o?.kind === "reject_once" || o?.kind === "reject_always") &&
					typeof o?.optionId === "string" &&
					o.optionId.length > 0,
			);
			if (reject) {
				this.respond(msg.id, { outcome: { outcome: "selected", optionId: reject.optionId } });
				return;
			}
			this.respond(msg.id, { outcome: { outcome: "cancelled" } });
			return;
		}
		const chosen =
			options.find((o) => typeof o?.kind === "string" && o.kind.startsWith("allow")) ??
			options.find((o) => typeof o?.optionId === "string" && o.optionId.toLowerCase().includes("allow")) ??
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
