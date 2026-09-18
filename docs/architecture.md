# Architecture

Where each piece of the current system lives, and how one dispatch flows through them. This is a navigation document: protocol details belong to the code and to the focused documents linked at the end.

## Dispatch flow

1. **Registration** — `index.ts` registers seven tools with pi: `external_agent_start`, `external_agent_status`, `external_agent_wait`, `external_agent_compare`, `external_agent_stop`, `external_agent_steer`, `external_agent_follow_up`.
2. **Validation** — `validateDispatch(agent, mode, cwd, effort)` refuses a dispatch before anything is spawned: a mode below the adapter's `minMode` or above its `maxMode`, an effort outside `supportedEfforts` (or an adapter with no effort control), and a second write/yolo task in a directory that already has one running.
3. **Adapter dispatch** — `ADAPTERS[agent].buildDispatch(...)` in `adapters.ts` spells the argv, and returns the prompt argument index, the effective permission policy, and whether model/effort overrides are forwarded.
4. **Spawn and task registry** — the hub spawns the CLI and records the task under a taskId: state, cwd, mode, transport, event log, session handle, watchdog counters.
5. **Monitoring** — stdout lines are normalized by the adapter's `parseEvent` into message / reasoning / tool / usage / warning / error events. Those events feed the status view, the notification callback, and the final answer.
6. **Watchdog** — a shared scanner notices a running task that has been quiet for its `watchdogMs` (default 15m) and notifies the model, at most three times per quiet streak.
7. **Settle** — on process exit (one-shot) or turn end (persistent), the task settles, notifications fire, and the answer is available through status or the receipt. `isolate` runs the worker in a fresh git worktree (never merged or deleted by the hub), and compare can append per-slot evidence rows to a JSONL board. Settle-time finalize then runs two fail-open mechanics: long or template-structured answers are archived to the session dir and replaced inline by a handle + summary (recall pages back via `external_agent_status` `offset`), and a known verify command runs via `pi.exec` with its exit code reported. Usage/cost events self-reported by CLIs accumulate in the meter (`/external_agent_stats`). Dispatch may wrap the task in a `template` output contract; the receipt records `name@version`. See [capabilities.md](capabilities.md).

## Receipts

Every dispatch returns a receipt: the exact argv, the effective permission policy, the transport, the watchdog setting, and the model/effort forwarding notes. Unsupported overrides are reported as not forwarded rather than silently dropped, and a refusal names its reason. The receipt is the honest-reporting contract — what it claims is what the target CLI was actually asked to do.

## Transports

- **One-shot** (`adapters.ts`) — a headless process per task; process exit is completion. `buildDispatch` plus `parseEvent` define this transport for every adapter.
- **Persistent** (`sessions.ts`) — a long-lived stdio session where turn end, not process exit, is the completion signal, so a follow-up keeps the conversation. Drivers: `PiRpcDriver` (pi `--mode rpc`), `CodexAppServerDriver` (`codex app-server`), `AcpDriver` (reasonix, codebuddy), `QoderStreamJsonDriver` (qoder stream-json). An adapter's `session` field selects this transport, and its `steer` / `followUp` flags say which capabilities exist. Without `session`, the one-shot path is the only path.

## Tool map

| Tool | Role |
|---|---|
| `external_agent_start` | Validate, spawn, register; returns a taskId immediately |
| `external_agent_status` | Progress, recent events, full answer, steering availability |
| `external_agent_wait` | Block in-turn until the named tasks settle |
| `external_agent_compare` | Fan one task out to 2–8 agents, block, return answers side by side |
| `external_agent_stop` | Protocol cancel where supported, then SIGTERM/SIGKILL |
| `external_agent_steer` | Guide a running persistent task at its next step boundary |
| `external_agent_follow_up` | Continue a settled persistent task in the same session |

All seven handlers live in `index.ts`; capability differences are read from `ADAPTERS`.

## See also

- [adapters.md](adapters.md) — per-CLI capability matrix and permission mappings.
- [qoder.md](qoder.md) — the Qoder stream-json contract, including the steering version gate.
