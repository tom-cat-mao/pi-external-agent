# pi-external-agent

English | [中文](README.zh-CN.md)

A [pi](https://github.com/earendil-works/pi) extension that lets pi dispatch coding tasks to other agent CLIs installed on the same machine, then continue the same session or steer it while it runs.

## Install

```bash
# Pin a version (recommended; pi update leaves pinned installs alone)
pi install git:github.com/tom-cat-mao/pi-external-agent@v0.6.1
# Or track main
pi install git:github.com/tom-cat-mao/pi-external-agent
```

Requires pi ≥ 0.85 and whichever agent CLIs you want to drive (they don't all need to be installed). Qoder needs `qodercli` on `PATH`, signed in; steering additionally needs an announced stable qodercli ≥ 1.1.49 — see [docs/qoder.md](docs/qoder.md).

Releases are published by tag: pushing `vX.Y.Z` runs the suite and typecheck, then creates the GitHub Release.

## Tools

| Tool | Purpose |
|---|---|
| `external_agent_start` | Dispatch a task in the background, returns a taskId immediately |
| `external_agent_status` | Inspect progress, recent events, and the full answer |
| `external_agent_wait` | Block in-turn until tasks settle, when the result is needed now |
| `external_agent_compare` | Send one task to several agents in one blocking call, collect the answers side by side |
| `external_agent_stop` | Cancel a task (protocol cancel, then SIGTERM/SIGKILL) |
| `external_agent_steer` | Inject guidance into a running task at its next step boundary |
| `external_agent_follow_up` | Continue a settled task in the same session, with full context |

## Comparing agents

`external_agent_compare` hands the same task to several agents in one call and returns their answers side by side, without diffing, scoring or ranking them — disagreement is the signal the tool exists to surface. Each spec runs through the same dispatch path and validation as `external_agent_start` (a refused spec is recorded in the receipt while the rest still run), and on timeout the receipt returns what settled plus the taskIds still running.

| Parameter | Meaning |
|---|---|
| `task` | The instruction sent to every agent (required; self-contained, like `external_agent_start`) |
| `agents` | 2–8 specs of `{ agent, task?, cwd?, mode?, model?, effort? }`; a spec's `task` overrides the shared one. `mode` defaults to that agent's own default, `cwd` to the session directory |
| `timeout` | Seconds to wait for the whole batch (optional; default 600, max 3600) |

## Capabilities (opt-in)

All off by default; enable per call — `template` (output contract), `verify` (acceptance command after settle), `isolate` (fresh git worktree), `board` (JSONL evidence rows, compare only), `fromTaskId` (relay a settled answer into another session, follow_up only), `offset` (paged answer recall, status only), `/external_agent_stats` (CLI-reported usage counters). Long answers are archived at settle and shown as a handle + summary instead of replaying. Details: [docs/capabilities.md](docs/capabilities.md).

## Agents

| Agent | Vendor | Default mode | Steer / follow-up |
|---|---|---|---|
| `codex` | OpenAI | yolo | ✅ via `app-server` |
| `pi` | pi itself (child process) | yolo | ✅ via `--mode rpc` |
| `reasonix` | DeepSeek-native | yolo (deny rules + OS sandbox still apply) | ✅ via ACP vendor extension |
| `codebuddy` | Tencent | yolo | ✅ via ACP step-boundary injection |
| `qoder` | Alibaba | yolo | follow-up ✅; steer ✅ when the announced CLI meets the 1.1.49 baseline |
| `kimi` | Moonshot | yolo only (its headless mode rejects permission flags) | ❌ |
| `claude` | Anthropic | yolo (readonly–yolo; effort low–max, no off) | ✅ via stream-json |

## Documentation

- [AGENTS.md](AGENTS.md) — repository layout, commands, invariants, documentation rules
- [docs/architecture.md](docs/architecture.md) — dispatch flow, receipts, transports · [docs/adapters.md](docs/adapters.md) — per-CLI capability matrix
- [docs/capabilities.md](docs/capabilities.md) — archive, verify, templates, relay, isolate, board, meter · [docs/qoder.md](docs/qoder.md) — Qoder stream-json contract · [.agents/notes/](.agents/notes/) — decision records

## Community

[LINUX DO](https://linux.do/)

## License

MIT
