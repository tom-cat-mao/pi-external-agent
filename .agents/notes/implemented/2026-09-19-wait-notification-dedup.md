# One settle, one delivery: wait receipts claim the notification

## Problem

A settle that lands while an `external_agent_wait` is watching is delivered twice:
the wait's receipt returns the answer, and `notifySettled` pushes the same event
into the session as a steer/followUp message. The coordinator pays twice for the
same text, the second copy can interrupt the turn as a spurious steer, and the
duplicate looks like a second settle. The wait cannot simply be left out of the
notification path, because it may also time out or be aborted before the caller
sees anything — then the push is the only delivery.

## Decision

- `Task.waiters?: Set<symbol>` — internal bookkeeping, absent from TaskSnapshot,
  receipts and status.
- `external_agent_wait` registers one token per watched task in its synchronous
  prologue, before the first await, so a settle racing the call cannot slip a push
  past it.
- `notifyTaskSettled` returns early while `waiters.size > 0`: no push and no
  "off" tombstone. `state !== "running" && !notified` is the held state.
- The wait's finish is idempotent and runs on every path, abort included. It drops
  the token, then per watched task: running, already notified, or `notify: "off"`
  → skip; aborted → release by re-running `notifyTaskSettled`; else claim
  (`notified = true`, drop the pending id — the receipt is the delivery). Only
  tasks settled at finish are claimed, so `mode: "any"` and timeouts leave the
  still-running ones armed for their own push.
- `session_start` clears every token (a wait belongs to the session that started
  it) and re-delivers held tasks through the existing `pendingNotificationIds`
  loop, so a held notice cannot go missing.
- The wait report gains the verify and worktree lines, making the receipt
  content-equivalent to the push it replaces.

## Alternatives considered

1. Model discipline: when planning to wait, dispatch with `notify: "off"`.
   Strongest reason: no mechanism at all — the case disappears if the caller
   chooses right. Why rejected: it is a prompt-level request where the invariant
   calls for harness-level enforcement, and the choice must be made before the
   task is dispatched, when the model does not reliably know whether it will wait;
   the default `steer` is what makes fire-and-continue work.
2. Temporarily flip `task.notify` to `"off"` on wait start and restore it at
   finish. Strongest reason: no new field, and it reuses the tombstone already
   understood by the watchdog and the re-delivery loop. Why rejected: it mutates a
   caller-visible contract (status and receipts would report a notify mode nobody
   set), and the settle tombstone is written before the restore, so the abort path
   would have to un-tombstone a task — more state, not less.
3. Push after a grace window, cancelled if a wait appears. Strongest reason: it
   also covers a wait that starts just after the settle. Why rejected: it delays
   the fire-and-continue path (the common case) by a timer that no value can set
   correctly, and a wait later than the window still double-delivers.

## Consequences

- A wait that returns an answer means the task will never be pushed; a model that
  ends its turn after being told something is settled will not be told again.
- The abort path can push a task whose answer the caller partially saw — a
  duplicate there is the safe direction.
- Held tasks are ordinary settled tasks, so status, verify, archive and the board
  behave exactly as before; only delivery changes.
- The w4 isolate suite now settles by polling status for the notice instead of
  calling `external_agent_wait`: a wait would claim the notice it asserts on.
- Prompt surface 8893/8900: the wait description carries the dedup sentence,
  paid for by dropping its meta "how to wait inside the current turn" clause.
