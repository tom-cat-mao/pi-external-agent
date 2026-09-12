# pi-external-agent

English | [中文](README.zh-CN.md)

A [pi](https://github.com/earendil-works/pi) extension that lets pi dispatch coding tasks to other agent CLIs installed on the same machine, and steer them while they run.

## Install

```bash
# Pin a version (recommended; pi update leaves pinned installs alone)
pi install git:github.com/tom-cat-mao/pi-external-agent@v0.2.0

# Or track main
pi install git:github.com/tom-cat-mao/pi-external-agent
```

Requires pi ≥ 0.85 and whichever agent CLIs you want to drive (they don't all need to be installed).

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
| `qoder` | Alibaba | yolo | Executor / independent reviewer | ✅ via `--acp` (`session/prompt` queueing) |
| `kimi` | Moonshot | yolo only (its headless mode rejects permission flags) | Executor | ❌ |
| `claude` | Anthropic | readonly | Analysis / planning | ❌ |

## Behavior

- **Modes**: `readonly` / `write` / `yolo`, mapped to each CLI's real sandbox or permission flags — not prompt-level requests. Concurrent write/yolo tasks in the same directory are refused.
- **No hard timeout**: tasks run to completion. A stall watchdog (default 15m quiet) notifies the host model, which decides whether to stop the task. `external_agent_wait` exists for when you need the answer inside the current turn.
- **Persistent sessions**: for steer-capable agents, completion means the turn ended, not that the process exited. The process stays alive for 30 minutes, which is what makes follow-up questions keep their context.
- **Honest receipts**: every dispatch returns a receipt recording the exact argv, effective permission policy, and whether model/effort overrides were actually forwarded — unsupported overrides are reported as not forwarded instead of silently dropped.
- **Effort is opt-in**: the `effort` override is forwarded (and validated against each CLI's supported levels) only when it is explicitly requested. Otherwise the target CLI/config default applies — the extension never infers a thinking level from task complexity, and `off` is an explicit request rather than the same as omitting it.
- **Codebuddy `readonly` enforcement**: instead of plan mode, codebuddy's readonly tier runs in `default` permission mode with a generated `--settings` payload — allow/deny tool rules plus a `PreToolUse` Bash hook (`hooks/codebuddy-readonly.js`) that heuristically allows common read-only commands and denies edits, writes, redirects, command substitution and known-mutating commands. The hook is a heuristic shell filter, **not** an OS sandbox: general script runners it has to allow (`node`, `npm`, `gh`, …) can act beyond its patterns, so readonly is best-effort, not an absolute guarantee. Claude's readonly tier keeps plan mode.
- **Qoder `readonly` enforcement**: `--permission-mode dont_ask` (any operation that would prompt is denied in headless mode), a built-in tool allowlist (`--tools Read,Grep,Glob,WebSearch,WebFetch`), `--disallowed-tools mcp__*,Agent`, and `--strict-mcp-config` with an empty server list — so edits, shell/Bash, MCP tools and subagent launches are refused by Qoder itself. `write` maps to `--permission-mode accept_edits` (in-directory edits auto-approved; other ask decisions still denied) and `yolo` to `bypass_permissions`. Non-default modes only take effect in a trusted startup directory; otherwise Qoder falls back to `default` (where headless asks are denied). User/project `PreToolUse` hooks outrank modes, so a hook that returns `allow` can still short-circuit the pipeline. Verified on qodercli 1.0.18: a readonly run refused to create a fixture file, while `accept_edits` created it.

Per-CLI compatibility notes (flags, output formats, pitfalls) live as comments in `adapters.ts`.

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
