# A codex turn settles when its completion shares the turn/start response chunk

## Problem

`codex app-server` answers `turn/start` and then emits that turn's notifications. A fast turn puts the response and the notifications in one stdout read, so the driver's line loop handles `turn/completed` in the same synchronous batch as the response — before the `await` on that response has run its continuation. That continuation marked the turn active, and `settle()` notifies turn end only while a turn looks active, so the completion was dropped with nothing left to re-arm it. The task stayed `running` forever: no turn end, no process exit, no answer, and a compare batch polled to its 600s deadline. Three separate reads pass; one coalesced read hangs, which is why it looked like a ~50% flake, why it never reproduced when the test ran alone, and why plain Node 26 scheduling hid it.

The activation therefore rested on `turn/started`, a notification the driver treats as optional — its `handleNotification` default drops unknown methods. codex-cli 0.154.0 does emit `turn/started`, and a `turn/started` handled earlier in the same batch happens to mask the drop, so a stock CLI usually got away with it; a build that stops sending or renames that notification (the file header warns the protocol renames methods across releases) hangs every fast turn instead.

## Decision

`CodexAppServerDriver.startTurn` marks the turn active BEFORE `turn/start` goes out, matching the pi, ACP and Qoder drivers, which all activate the turn on the wire signal that starts it rather than on an awaited acknowledgement. The response only contributes the turn id, and only while the turn is still active, so an id belonging to an already-finished turn can never be adopted for `turn/steer`. The regression test writes the response and both notifications in one chunk, making the previously losing arrival order deterministic instead of a coin flip.

## Alternatives considered

1. **Queue a settle that arrives before the turn is marked active and deliver it from `markActive`.** Strongest reason: it fixes the whole class in `BaseSessionDriver`, so a future driver cannot repeat the mistake. Why rejected: `settle` cannot distinguish "the completion of the turn being started" from a duplicate or stale completion, and the queued one would end the *next* turn instantly; the other three drivers already activate on the wire signal, so the real invariant is "activate when the turn is issued", which this driver should simply follow.
2. **Skip the await: read the turn id in the line parser instead of awaiting the request.** Strongest reason: it removes the async gap entirely, so protocol state advances in a single pass over the chunk. Why rejected: it pushes codex-specific parsing into the shared JSON-RPC layer and duplicates request bookkeeping; the one-line reorder keeps the id handling inside the driver that owns it.
3. **Leave the driver and make the fixture write with delays so the chunk never coalesces.** Strongest reason: no source change, and paced writes look like a calmer CLI. Why rejected: the coalesced order is exactly what a real fast turn produces, so the hang stays reachable with real codex; this fixes the test, not the bug.
4. **Treat the completion as an event only, ignoring the active flag.** Strongest reason: notifications would always reach the turn-end path, with no state to get wrong. Why rejected: `settle` must stay idempotent per turn — `turn/completed` also arrives for interrupts, and dropping unknown completions is what keeps one turn from settling a task twice.

## Consequences

Benefit: a codex turn settles on either arrival order, so a compare batch no longer gambles on how the OS coalesces the child's stdout.

Cost: the driver reports an active turn for the window between issuing `turn/start` and its response. `steer` still refuses inside that window (there is no turn id yet), and a failed `turn/start` leaves the flag set but the task fails through the start path and the driver is killed, so no caller reads it as a running turn.
