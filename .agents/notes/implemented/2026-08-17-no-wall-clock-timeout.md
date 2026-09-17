# No wall-clock timeout

## Problem

A dispatched task can run for minutes or hours, and the hub has no way to know from the outside whether it is working or stuck. A wall-clock limit is the obvious control, but any duration is a guess about work the hub cannot see: too short kills legitimate long tasks, too long fails to help.

## Decision

Tasks have no wall-clock timeout. They run to completion, until the model stops them, or until the session ends. A stall watchdog notifies the host model when a running task has been quiet for `watchdogMs` (default 15m), so the model decides whether to stop a task after being told it went quiet. `external_agent_wait` exists for when the answer is needed inside the current turn; ending the turn otherwise is safe because settle and stall notifications re-invoke the model. Sleep-polling is the anti-pattern both shapes replace.

## Alternatives considered

1. **Hard wall-clock timeout with auto-kill.** Strongest reason: simple and bounds resource use — no task can occupy a slot indefinitely, and the behavior is easy to reason about. Why rejected: it kills legitimate long tasks, and the hub cannot judge task health better than the model can after a stall notification; killing a quiet-but-working task loses the work.
2. **No watchdog at all.** Strongest reason: less code — no scanner, no quiet tracking, no `watchdogMs` plumbing. Why rejected: a silently stuck task would never re-invoke the model, so ending the turn while a task runs would be unsafe and the only recovery would be polling; the watchdog is what makes the end-the-turn shape safe.

## Consequences

Benefit: tasks are never killed on a timer, and the stop decision sits with the model, which can weigh progress, cost and intent together.

Cost: a quiet task can run indefinitely unless someone acts; the watchdog only warns — at most three times per quiet streak — and blocking callers rely on `external_agent_wait` when they need the answer now.
