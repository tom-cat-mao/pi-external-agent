# Architecture

Where each piece lives and how a dispatch flows.

## Dispatch flow

1. **Registration** — `src/hub/tools.ts` registers the seven tools, `src/index.ts` wires them in; three are always active, the rest arrive on the first dispatch that runs (see Prompt surface).
2. **Validation** — `validateDispatch(agent, mode, cwd, effort, conflictCwd)` refuses before spawning: modes outside adapter limits, effort outside its range, concurrent writes to one effective directory (isolate points it at a fresh worktree).
3. **Adapter dispatch** — `ADAPTERS[agent].buildDispatch(...)` in `src/adapters.ts` spells the argv, the prompt argument index, the effective policy, and whether model/effort overrides are forwarded.
4. **Spawn and task registry** — the hub spawns the CLI and records it under a taskId: state, cwd, mode, transport, event log, session handle, watchdog counters.
5. **Monitoring** — stdout lines normalize via the adapter's `parseEvent` into message/reasoning/tool/usage/warning/error events, feeding status, notifications, and the final answer.
6. **Watchdog** — a shared scanner flags stalls to the model, at most three per streak: quiet (no event for the task's effective threshold, its cadence clamped to `watchdogMs`) or struggling (warnings/errors arrive while no progress event has for 5m). `external_agent_wait` skips tasks it watches, so the waiter claims the stall first.
7. **Settle** — on process exit (one-shot) or turn end (persistent), the task settles, its notice fires, and the answer lands in status or the receipt; an aborted wait releases it for `session_start` to re-deliver. `isolate` runs the worker in a fresh worktree the owner merges or removes. Finalize runs four fail-open steps: archive long answers, run the verify command via `pi.exec`, collect the worktree's diff-stat, append a board row if compare asked. Usage/cost lands in the meter (`/external_agent_stats`); [capabilities.md](capabilities.md) holds the wait deadlines, stall handling and store/verify detail.

## Prompt surface

Tool text is paid in three layers: the always-active tools' fixed surface (hard-budgeted at 3,500 chars), the `external-agent` skill body read on demand, and runtime refusals naming what the CLI will not do. The session-only four are parked at `session_start`, activated by the first dispatch that runs. Details: [prompt-surface.md](prompt-surface.md).

## Receipts

Every dispatch returns a receipt: the exact argv, the effective policy, the transport, the watchdog setting, and the model/effort forwarding notes. A persistent session's receipt starts empty, backfilled by the driver once it builds the startup command. Unsupported overrides are reported, not forwarded; a refusal names its reason. The receipt is the honest-reporting contract: what the CLI was asked to do.

## Transports

- **One-shot** (`src/adapters.ts`) — a headless process per task; process exit is completion, defined by `buildDispatch` plus `parseEvent`.
- **Persistent** (`src/drivers/`) — a long-lived stdio session whose completion signal is turn end, so follow-ups keep the conversation. Protocols (driver classes): pi rpc (`PiRpcDriver`), codex app-server (`CodexAppServerDriver`), ACP (`AcpDriver`: reasonix, codebuddy, dsh, kimi), stream-json (`ClaudeStreamJsonDriver`, `QoderStreamJsonDriver`). A driver in `SESSION_DRIVERS` (`hasSessionDriver()`) selects it; the adapter's `session` flags say whether steer / follow-up exist, and without one one-shot is the only path.

## Tool map

| Tool | Role |
|---|---|
| `external_agent_start` | Validate, spawn, register; returns a taskId. `notify` = settle channel, `watchdog` = stall minutes |
| `external_agent_status` | Progress, events, answer, steering availability; `tail` bounds events (default 8) |
| `external_agent_wait` | Block in-turn until named tasks settle; `mode: "any"` returns on the first |
| `external_agent_compare` | Fan one task out to 2–8 agents; answers side by side |
| `external_agent_stop` | Protocol cancel where supported, then SIGTERM/SIGKILL; `all: true` stops every task |
| `external_agent_steer` | Guide a running persistent task at its next step boundary |
| `external_agent_follow_up` | Continue a settled persistent session; `purpose` labels a relay |

Handlers live in `src/hub/tools.ts`, act on `src/hub/registry.ts`, and read differences from `ADAPTERS`.

## See also

- [adapters.md](adapters.md) — per-CLI capability matrix and permission mappings.
- [prompt-surface.md](prompt-surface.md) — the three layers of tool text and the activation flow.
- [qoder.md](qoder.md) — the Qoder stream-json contract, including the steering version gate.
