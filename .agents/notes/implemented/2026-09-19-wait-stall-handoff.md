# Wait silent early return when watched tasks stall

## Problem

A task blocked for more than its `watchdogMs` (default 15m) can make a subsequent
`external_agent_wait` spin forever in-turn, because the tool simply watches for
a settle that will never arrive while the CLI cannot interrupt an executing tool
call. The model sees no signal and may retry the same wait, looping the turn.

## Decision

- **Silent early return** — if all watched tasks are "silent" (no stdout lines)
  past their `watchdogMs`, `external_agent_wait` returns immediately. Details
  include `"stalled": true` plus counts per task; the model can choose to keep
  waiting, steer/stop, or yield to the watchdog scanner.
- **Shared threshold, zero disables** — the watchdog threshold is used for both
  scanner notification and wait early return. Setting `watchdog: 0` disables
  silent early return (the safety valve).
- **Throttle** — once a wait claims a silent period it increments a per-task
  counter bounded by three. A second call within one `watchdogMs` does not count
  as another claim. After three claims, the wait stops returning on silence
  alone, allowing the normal timeout/mode logic to proceed. Spacing matches the
  watchdog; caps match its stalling limit.
- **Scan skip during observation** — `external_agent_scan_watchdogs` skips any
  task currently held by a waiter at the moment of scan. When a wait finishes
  (settle/timeout/abort/early-return), the skip drops. If the task remains
  silent, the scanner resumes notifications within ≈30s (at-least-once, bounded
  by the timer granularity).
- **Event summary line** — every wait report adds one "event summary" line showing
  total events counted since wait started plus an excerpt from the last event
  (or `(none)`). The hub does not interpret this; it just exposes whether there
  is activity without progress so the model can see a retry storm versus genuine
  silence.
- **Notify mode orthogonal** — the notify setting controls only delivery channels.
  `notify:"off"` does not prevent silent early return for that task.

## Alternatives considered

1. Narrow the wait timeout ceiling
   Strongest reason: simpler—hub would stop guessing work duration; Why rejected: hub cannot know worker duration without wall-clock time, violating 2026-08-17 no-wall-clock-decision; 600 default is already less than 15m threshold with no benefit.
2. Pure description layer guidance
   Strongest reason: zero-code—documented prompt discipline handles all cases; Why rejected: guidance exists but doesn't rescue already-stuck waits; precedent rejects prompt-discipline-only fixes.
3. Watchdog alarm escalation
   Strongest reason: avoid changing wait—pi's physical inability to penetrate an executing tool call stays; Why rejected: pi cannot interrupt active tool call, so escalation has no path to execution.

## Consequences

- Silent early return competes with the scanner for the same stalled condition;
  claiming a period suppresses that period's scanner alert, preserving at-most-three
  alerts per streak.
- The event summary exposes retries and storms but leaves health judgment to the
  caller; the hub never acts on it.
- Known debts: `external_agent_compare` lacks waiters mechanism (same-class block);
  "active-but-stalled" relies on disclosure+model judgment without enforcement.
