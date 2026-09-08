# pi-external-agent

A [pi](https://github.com/earendil-works/pi) extension that lets pi dispatch coding tasks to other agent CLIs installed on the same machine, and steer them while they run.

## Install

```bash
pi install git:https://github.com/tom-cat-mao/pi-external-agent
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
| `kimi` | Moonshot | yolo only (its headless mode rejects permission flags) | Executor | ❌ |
| `claude` | Anthropic | readonly | Analysis / planning | ❌ |

## Behavior

- **Modes**: `readonly` / `write` / `yolo`, mapped to each CLI's real sandbox or permission flags — not prompt-level requests. Concurrent write/yolo tasks in the same directory are refused.
- **No hard timeout**: tasks run to completion. A stall watchdog (default 15m quiet) notifies the host model, which decides whether to stop the task. `external_agent_wait` exists for when you need the answer inside the current turn.
- **Persistent sessions**: for steer-capable agents, completion means the turn ended, not that the process exited. The process stays alive for 30 minutes, which is what makes follow-up questions keep their context.
- **Honest receipts**: every dispatch returns a receipt recording the exact argv, effective permission policy, and whether model/effort overrides were actually forwarded — unsupported overrides are reported as not forwarded instead of silently dropped.

Per-CLI compatibility notes (flags, output formats, pitfalls) live as comments in `adapters.ts`.

## Files

```
index.ts       tool registration, task registry, watchdog, notifications
adapters.ts    per-CLI one-shot adapters
sessions.ts    persistent session drivers (steer / follow-up)
```

## License

MIT
