# Architecture

Where each piece lives, and how a dispatch flows through them. Protocol details belong to the code and the focused documents linked at the end.

## Dispatch flow

1. **Registration** — `index.ts` registers the seven tools listed in the tool map below with pi.
2. **Validation** — `validateDispatch(agent, mode, cwd, effort, conflictCwd)` refuses a dispatch before anything is spawned: a mode below the adapter's `minMode` or above its `maxMode`, an effort outside `supportedEfforts` (or an adapter with no effort control), and a second write/yolo task in the worker's effective directory (`conflictCwd`; isolate points it at the fresh worktree).
3. **Adapter dispatch** — `ADAPTERS[agent].buildDispatch(...)` in `adapters.ts` spells the argv, and returns the prompt argument index, the effective permission policy, and whether model/effort overrides are forwarded.
4. **Spawn and task registry** — the hub spawns the CLI and records the task under a taskId: state, cwd, mode, transport, event log, session handle, watchdog counters.
5. **Monitoring** — stdout lines are normalized by the adapter's `parseEvent` into message / reasoning / tool / usage / warning / error events; they feed the status view, the notification callback, and the final answer.
6. **Watchdog** — a shared scanner notices a task quiet for its `watchdogMs` (default 15m) and notifies the model, at most three times per quiet streak.
7. **Settle** — on process exit (one-shot) or turn end (persistent), the task settles, its notice fires, and the answer is available through status or the receipt. `isolate` runs the worker in a fresh git worktree that the owner merges or removes. Settle-time finalize then runs four fail-open steps: archive long or Summary+Details answers (recall pages back via `external_agent_status` `offset`), run a known verify command via `pi.exec`, collect the isolated worktree's diff-stat, and append a board row when compare asked for one. CLI-reported usage/cost accumulates in the meter (`/external_agent_stats`). See [capabilities.md](capabilities.md).

## Receipts

Every dispatch returns a receipt: the exact argv, the effective permission policy, the transport, the watchdog setting, and the model/effort forwarding notes. A persistent session's receipt starts with an empty argv; the driver backfills it once it has built the startup command. Unsupported overrides are reported as not forwarded rather than silently dropped, and a refusal names its reason. The receipt is the honest-reporting contract — what it claims is what the target CLI was actually asked to do.

## Transports

- **One-shot** (`adapters.ts`) — a headless process per task; process exit is completion. `buildDispatch` plus `parseEvent` define this transport for every adapter.
- **Persistent** (`sessions.ts`) — a long-lived stdio session where turn end, not process exit, is the completion signal, so a follow-up keeps the conversation. Drivers: `PiRpcDriver` (pi `--mode rpc`), `CodexAppServerDriver` (`codex app-server`), `AcpDriver` (reasonix, codebuddy), `QoderStreamJsonDriver` (qoder stream-json). A driver in `SESSION_DRIVERS` (tested by `hasSessionDriver()`) selects this transport; the adapter's `session` flags say whether steer / follow-up exist. Without a driver, one-shot is the only path.

## Tool map

| Tool | Role |
|---|---|
| `external_agent_start` | Validate, spawn, register; returns a taskId immediately. `notify` picks the settle-notice channel, `watchdog` the stall threshold in minutes |
| `external_agent_status` | Progress, recent events, full answer, steering availability; `tail` bounds the event list (default 8) |
| `external_agent_wait` | Block in-turn until the named tasks settle; `mode: "any"` returns on the first |
| `external_agent_compare` | Fan one task out to 2–8 agents, block, return answers side by side |
| `external_agent_stop` | Protocol cancel where supported, then SIGTERM/SIGKILL; `all: true` stops every task |
| `external_agent_steer` | Guide a running persistent task at its next step boundary |
| `external_agent_follow_up` | Continue a settled persistent task in the same session; `purpose` labels a relay |

All seven handlers live in `index.ts`; capability differences are read from `ADAPTERS`.

## See also

- [adapters.md](adapters.md) — per-CLI capability matrix and permission mappings.
- [qoder.md](qoder.md) — the Qoder stream-json contract, including the steering version gate.
