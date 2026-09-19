# Architecture

Where each piece lives, and how a dispatch flows.

## Dispatch flow

1. **Registration** — `src/hub/tools.ts` registers the seven tools; `src/index.ts` wires them into the extension.
2. **Validation** — `validateDispatch(agent, mode, cwd, effort, conflictCwd)` refuses a dispatch before spawning: modes outside adapter limits, effort outside supported range, or concurrent writes to the same effective directory (isolate points it at a fresh worktree).
3. **Adapter dispatch** — `ADAPTERS[agent].buildDispatch(...)` in `src/adapters.ts` spells the argv, the prompt argument index, the effective policy, and whether model/effort overrides are forwarded.
4. **Spawn and task registry** — the hub spawns the CLI and records the task under a taskId: state, cwd, mode, transport, event log, session handle, watchdog counters.
5. **Monitoring** — stdout lines normalize via the adapter's `parseEvent` into message/reasoning/tool/usage/warning/error events, feeding the status view, notification callback, and final answer.
6. **Watchdog** — a shared scanner notices stalled tasks and notifies the model, at most three times per streak. *Quiet* means no event for the task's effective threshold (its own cadence, clamped to `watchdogMs`); *struggling* means warnings/errors keep arriving while no progress event has for 5m. `external_agent_wait` skips tasks it watches, so the waiter claims the stall first.
7. **Settle** — on process exit (one-shot) or turn end (persistent), the task settles, its notice fires, and the answer lands in status or the receipt. A wait that observes the settle takes the answer in its receipt; an aborted wait releases it, and `session_start` re-delivers what a wait held. When every watched task has stalled, `external_agent_wait` returns early with `stalled:"quiet"|"struggling"`; the thresholds ignore `notify`, which gates only the push channel. `isolate` runs the worker in a fresh git worktree that the owner merges or removes. Finalize then runs four fail-open steps: archive long or Summary+Details answers, run the verify command via `pi.exec`, collect the isolated worktree's diff-stat, and append a board row if compare asked. CLI-reported usage/cost accumulates in the meter (`/external_agent_stats`). See [capabilities.md](capabilities.md).

## Receipts

Every dispatch returns a receipt: the exact argv, the effective policy, the transport, the watchdog setting, and the model/effort forwarding notes. A persistent session's receipt starts with an empty argv, backfilled by the driver once it builds the startup command. Unsupported overrides are reported, not forwarded; a refusal names its reason. The receipt is the honest-reporting contract: it claims what the target CLI was actually asked to do.

## Transports

- **One-shot** (`src/adapters.ts`) — a headless process per task; process exit is completion, defined by `buildDispatch` plus `parseEvent`.
- **Persistent** (`src/drivers/`) — a long-lived stdio session whose completion signal is turn end, not process exit, so a follow-up keeps the conversation. Drivers: `PiRpcDriver` (pi `--mode rpc`), `CodexAppServerDriver` (`codex app-server`), `AcpDriver` (reasonix, codebuddy), `ClaudeStreamJsonDriver` (claude stream-json), `QoderStreamJsonDriver` (qoder stream-json). A driver in `SESSION_DRIVERS` (tested by `hasSessionDriver()`) selects this transport; the adapter's `session` flags say whether steer / follow-up exist. Without a driver, one-shot is the only path.

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

All seven handlers live in `src/hub/tools.ts` and act on the registry in `src/hub/registry.ts`; capability differences are read from `ADAPTERS`.

## See also

- [adapters.md](adapters.md) — per-CLI capability matrix and permission mappings.
- [qoder.md](qoder.md) — the Qoder stream-json contract, including the steering version gate.
