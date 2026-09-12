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

For the Qoder agent, install the Qoder CLI (`qodercli`) and make sure it is on `PATH` and signed in (`qodercli login`). This integration is tested against qodercli 1.0.18; official references: [Run in Scripts](https://docs.qoder.com/cli/run-in-scripts), [Permissions](https://docs.qoder.com/cli/permissions), [ACP](https://docs.qoder.com/cli/acp) and the [Settings reference](https://docs.qoder.com/cli/settings-reference).

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
| `qoder` | Alibaba | yolo | Executor / independent reviewer | follow-up ✅ via `--acp`; steer ❌ (queueing only, not verified) |
| `kimi` | Moonshot | yolo only (its headless mode rejects permission flags) | Executor | ❌ |
| `claude` | Anthropic | readonly | Analysis / planning | ❌ |

## Behavior

- **Modes**: `readonly` / `write` / `yolo`, mapped to each CLI's real sandbox or permission flags — not prompt-level requests. Where a CLI has no OS sandbox, `write`/`yolo` are permission-rule tiers only, not an OS sandbox. Concurrent write/yolo tasks in the same directory are refused.

- **No hard timeout**: tasks run to completion. A stall watchdog (default 15m quiet) notifies the host model, which decides whether to stop the task. `external_agent_wait` exists for when you need the answer inside the current turn.

- **Persistent sessions mean follow-up**: for agents with a session transport, completion means the turn ended, not that the process exited. The process stays alive for 30 minutes, which is what lets `external_agent_follow_up` ask a second question with the full conversation intact. Mid-run steering is a separate capability: `codex`, `pi`, `reasonix` and `codebuddy` support it too, while `qoder` is follow-up only.

- **Honest receipts**: every dispatch returns a receipt recording the exact argv, effective permission policy, and whether model/effort overrides were actually forwarded — unsupported overrides are reported as not forwarded instead of silently dropped.

- **Effort is opt-in**: omit `effort` unless the user explicitly requests a reasoning-effort or thinking-level override. The target CLI/config default then applies; never infer a level from task complexity. Explicit overrides are validated against the adapter's allowlist, with final support depending on the selected model and CLI. `off` is an explicit override, not the same as omission.

- **Codebuddy `readonly` enforcement**: instead of plan mode, codebuddy's readonly tier runs in `default` permission mode with a generated `--settings` payload — allow/deny tool rules plus a `PreToolUse` Bash hook (`hooks/codebuddy-readonly.js`) that heuristically allows common read-only commands and denies edits, writes, redirects, command substitution and known-mutating commands. The hook is a heuristic shell filter, **not** an OS sandbox: general script runners it has to allow (`node`, `npm`, `gh`, …) can act beyond its patterns, so readonly is best-effort, not an absolute guarantee. Claude's readonly tier keeps plan mode.

- **Qoder `readonly` enforcement**: `--permission-mode dont_ask` (any operation that would prompt is denied in headless mode), a built-in tool allowlist (`--tools Read,Grep,Glob,WebSearch,WebFetch`), `--disallowed-tools mcp__*,Agent`, `--strict-mcp-config` with an empty server list, and a per-invocation `--settings {"disableAllHooks":true}` that disables user, project, local and plugin hooks — so a hook cannot short-circuit the pipeline. Edits, shell/Bash, MCP tools and subagent launches are thus refused by Qoder itself. Verified on qodercli 1.0.18: a readonly run refused to create a fixture file.

- **Qoder `write` / `yolo`**: `write` maps to `--permission-mode accept_edits` (in-directory edits auto-approved; every ACP permission request is answered reject, or cancelled when no reject option exists — it is never auto-allowed) and `yolo` to `bypass_permissions`. Both inherit Qoder's configured permission rules and hooks and are **not** an OS sandbox. Non-default modes only take effect in a trusted startup directory; otherwise Qoder falls back to `default` (where headless asks are denied). Verified on qodercli 1.0.18: `accept_edits` created a fixture file.

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
