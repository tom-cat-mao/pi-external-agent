# pi-external-agent

English | [中文](README.zh-CN.md)

A [pi](https://github.com/earendil-works/pi) extension that lets pi dispatch coding tasks to other agent CLIs installed on the same machine, then continue the same session or steer it while it runs.

## Install

```bash
# Pin a version (recommended; pi update leaves pinned installs alone)
pi install git:github.com/tom-cat-mao/pi-external-agent@v0.2.0

# Or track main
pi install git:github.com/tom-cat-mao/pi-external-agent
```

Requires pi ≥ 0.85 and whichever agent CLIs you want to drive (they don't all need to be installed).

For the Qoder agent, install the Qoder CLI (`qodercli`) and make sure it is on `PATH` and signed in (`qodercli login`). This integration is tested against qodercli 1.0.18; official references: [Input Modes](https://docs.qoder.com/cli/sdk/input-modes) (the streaming `priority` / `shouldQuery` contract), [Run in Scripts](https://docs.qoder.com/cli/run-in-scripts) (`--input-format stream-json`), [Permissions](https://docs.qoder.com/cli/permissions), the [CLI reference](https://docs.qoder.com/cli/cli-reference) and the [Settings reference](https://docs.qoder.com/cli/settings-reference). The wire shapes were cross-checked against the published [`@qoder-ai/qoder-agent-sdk`](https://www.npmjs.com/package/@qoder-ai/qoder-agent-sdk) 1.0.39.

## Tools

| Tool | Purpose |
|---|---|
| `external_agent_start` | Dispatch a task in the background, returns a taskId immediately |
| `external_agent_status` | Inspect progress, recent events, and the full answer |
| `external_agent_wait` | Block in-turn until tasks settle, when the result is needed now |
| `external_agent_stop` | Cancel a task (protocol cancel, then SIGTERM/SIGKILL) |
| `external_agent_steer` | Inject guidance into a running task at its next step boundary |
| `external_agent_follow_up` | Continue a settled task in the same session, with full context |

## Agents

| Agent | Vendor | Default mode | Role | Steer / follow-up |
|---|---|---|---|---|
| `codex` | OpenAI | yolo | Primary executor | ✅ via `app-server` |
| `pi` | pi itself (child process) | yolo | Executor with fully configurable `--model` | ✅ via `--mode rpc` |
| `reasonix` | DeepSeek-native | yolo (deny rules + OS sandbox still apply) | Executor / reviewer | ✅ via ACP vendor extension |
| `codebuddy` | Tencent | yolo | Fast executor / repo exploration | ✅ via ACP step-boundary injection |
| `qoder` | Alibaba | yolo | Executor / independent reviewer | ✅ via `--input-format stream-json` (`priority: next`) |
| `kimi` | Moonshot | yolo only (its headless mode rejects permission flags) | Executor | ❌ |
| `claude` | Anthropic | readonly | Analysis / planning | ❌ |

## Behavior

- **Modes**: `readonly` / `write` / `yolo`, mapped to each CLI's real sandbox or permission flags — not prompt-level requests. Where a CLI has no OS sandbox, `write`/`yolo` are permission-rule tiers only, not an OS sandbox. Concurrent write/yolo tasks in the same directory are refused.

- **No hard timeout**: tasks run to completion. A stall watchdog (default 15m quiet) notifies the host model, which decides whether to stop the task. `external_agent_wait` exists for when you need the answer inside the current turn.

- **Persistent sessions mean follow-up**: for agents with a session transport, completion means the turn ended, not that the process exited. The process stays alive for 30 minutes, which is what lets `external_agent_follow_up` ask a second question with the full conversation intact. Mid-run steering is a separate capability that all five session agents (`codex`, `pi`, `reasonix`, `codebuddy`, `qoder`) support.

- **Honest receipts**: every dispatch returns a receipt recording the exact argv, effective permission policy, and whether model/effort overrides were actually forwarded — unsupported overrides are reported as not forwarded instead of silently dropped.

- **Effort is opt-in**: omit `effort` unless the user explicitly requests a reasoning-effort or thinking-level override. The target CLI/config default then applies; never infer a level from task complexity. Explicit overrides are validated against the adapter's allowlist, with final support depending on the selected model and CLI. `off` is an explicit override, not the same as omission.

- **Codebuddy `readonly` enforcement**: instead of plan mode, codebuddy's readonly tier runs in `default` permission mode with a generated `--settings` payload — allow/deny tool rules plus a `PreToolUse` Bash hook (`hooks/codebuddy-readonly.js`) that heuristically allows common read-only commands and denies edits, writes, redirects, command substitution and known-mutating commands. The hook is a heuristic shell filter, **not** an OS sandbox: general script runners it has to allow (`node`, `npm`, `gh`, …) can act beyond its patterns, so readonly is best-effort, not an absolute guarantee. Claude's readonly tier keeps plan mode.

- **Qoder `readonly` enforcement**: `--permission-mode dont_ask` (any operation that would prompt is denied in headless mode), a built-in tool allowlist (`--tools Read,Grep,Glob,WebSearch,WebFetch`), `--disallowed-tools mcp__*,Agent`, `--strict-mcp-config` with an empty server list, and a per-invocation `--settings {"disableAllHooks":true}` that disables user, project, local and plugin hooks — so a hook cannot short-circuit the pipeline. Edits, shell/Bash, MCP tools and subagent launches are thus refused by Qoder itself. Verified on qodercli 1.0.18: a readonly run refused to create a fixture file.

- **Qoder `write` / `yolo`**: `write` maps to `--permission-mode accept_edits` (in-directory edits auto-approved; every other operation that would prompt is refused, never auto-allowed) and `yolo` to `bypass_permissions`. Both inherit Qoder's configured permission rules and hooks and are **not** an OS sandbox. Non-default modes only take effect in a trusted startup directory; otherwise Qoder falls back to `default` (where headless asks are denied). Verified on qodercli 1.0.18: `accept_edits` created a fixture file.

- **Qoder steering and its transport**: Qoder is driven over its documented streaming input channel — `qodercli -p --output-format stream-json --input-format stream-json`, the exact argv the official SDK builds in `buildArgs()` — instead of `--acp`. The ACP page documents only editor integration and exposes no steering metadata there, so a second `session/prompt` under ACP would prove queueing, not step-boundary steering.

  Wire shape, all cross-checked against `@qoder-ai/qoder-agent-sdk` 1.0.39 and the CLI docs:

  - The task text is not an argv argument; it is one JSON object per LF on stdin (`{"type":"user","message":{"role":"user","content":[{"type":"text","text":…}]},"parent_tool_use_id":null,"uuid":…}`), with a `randomUUID` as the message uuid because the protocol keys commands by it.
  - Boot sends the SDK's `initialize` control request as soon as the process is up, then waits for **either** its `control_response` **or** the CLI's `system`/`init` record before sending the first user message. Neither signal can be required on its own: an authenticated qodercli 1.0.18 answers `initialize` and does not announce `system`/`init` until later, while an unauthenticated one announces `system`/`init` and never answers. A failure frame (synthetic API error, failed result, unanswerable control request) that arrives with the handshake makes `start()` throw instead of opening a turn on a dead session.
  - `result` ends exactly one turn; a result record without a `subtype` is incomplete and is ignored rather than settling the turn with an empty answer.
  - A steer is one user message with `priority: "next"` (the documented "next suitable opportunity", i.e. a step boundary) and `shouldQuery: false` (the message joins the active turn without starting a turn of its own), so it never interrupts and is never promoted into an independent turn of its own. Because of that the steer receipt says the guidance was **sent/queued**, not definitely applied: guidance that arrives after the turn's last step stays as context for the next user message. `priority: "now"` (an interrupt) is deliberately never used for steering.
  - An assistant frame marked `aborted` (the stream was truncated) settles the turn as cancelled, not as a clean done, and a synthetic API-error assistant frame (`message.model === "<synthetic>"`) fails the turn with the unwrapped `[API Error: …]` text.
  - Cancelling uses the SDK's `interrupt` control request. When the response reports a non-empty `still_queued`, a warning is surfaced and the queued command's own later `result` is reported as a later turn instead of being discarded — continued work after a cancel never goes invisible.
  - Any inbound `can_use_tool` control request is answered (fail-closed `deny` for readonly/write, `allow` for yolo) with its own `request_id` echoed back, and a request that arrives without a usable id fails the turn instead of leaving the CLI blocked on a reply nobody sends.
  - `command_lifecycle` records are honoured when the CLI sends them: a `discarded`/`cancelled` state for a steer raises a warning rather than leaving the earlier "accepted" claim standing.

  **Steering is conditional.** A steer is only sent when the CLI announces a stable release at or above **1.1.49** — the version our documented SDK pairing (`@qoder-ai/qoder-agent-sdk` 1.0.39) targets. That is *our documented-contract baseline*, not a claim about the vendor's earliest supporting version. The announced `qodercli_version` (from the `system`/`init` record, or the same field in the `initialize` response when present) must be present, be a stable release number, and meet the baseline; a missing, malformed, prerelease or older version makes `external_agent_steer` refuse with the reported version and an upgrade note, writes no steer frame at all, and leaves start/status/follow-up/stop fully usable.

  Why the gate exists: the local public binary's inbound user-message schema declares `priority: ["now","next","later"]` but not `shouldQuery`, and nothing in it reads `shouldQuery` off an inbound frame — so on an older CLI a steer would be an ordinary queued message whose delivery contract we cannot confirm. The per-command `command_lifecycle` ack is absent on 1.0.18 for the same reason (it exists from the 1.1.x generation), so nothing waits on it.

  **Live verification status:** the one approved live probe on this machine was stopped by an account entitlement rejection before any tool call, and an earlier no-model run showed the entitlement gate too. Qoder steering has therefore **not** been verified against a live model on any version — including 1.0.18 — and rests on the documented contract, the public SDK/binary evidence and offline protocol tests.

Per-CLI compatibility notes live as comments in `adapters.ts` and in the `effective policy` line of each dispatch receipt.

## Files

```
index.ts       tool registration, task registry, watchdog, notifications
adapters.ts    per-CLI one-shot adapters
sessions.ts    persistent session drivers (steer / follow-up)
hooks/         PreToolUse Bash hook used by codebuddy's readonly --settings
```

## Community

[LINUX DO](https://linux.do/)

## License

MIT
