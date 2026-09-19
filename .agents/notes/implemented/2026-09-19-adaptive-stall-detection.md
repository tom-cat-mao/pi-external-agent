# Adaptive stall detection: two clocks, a struggle verdict, a cadence threshold

## Problem

The wait handoff gave `external_agent_wait` an early return on silence past
`watchdogMs`, shared with the scanner. One clock and one fixed threshold leave
two blind spots: a task that keeps emitting retry warnings while its real work
is wedged still looks "active" to the model, and a chatty task that goes silent
is only noticed after the full watchdog (15m default) no matter how tight its
own cadence is.

## Decision

- **Dual clock** — `lastEventAt` (any parsed event) and `lastMeaningfulEventAt`
  (message/reasoning/tool only; usage/warning/error refresh the first). Both
  start at `startedAt`; both are internal, absent from snapshots and receipts.
- **Struggle verdict** — `watchdogMs > 0 && lastEventAt > lastMeaningfulEventAt
  && now - lastMeaningfulEventAt >= 5m`. Real reconnect/retry loops space
  attempts 60–120s apart, so 5m tolerates 2–3 attempts before reporting. The
  "noise is flowing" term keeps a task with no event at all on the user's
  watchdog: pure silence is *quiet*, not *struggling*, and the wording stays
  accurate.
- **Adaptive silence threshold** — median of the last 16 meaningful-event gaps;
  with ≥5 samples `min(max(8 × median, 3m), watchdogMs)`, else `watchdogMs`.
  8 tolerates one unusually long step, the 3m floor keeps a build in the low
  minutes from reading as a stall, 5 samples is the least that is a cadence,
  and 16 bounds memory while staying recent.
- **Wording** — quiet: `quiet for X`; struggling: `only warnings/errors for X;
  last meaningful: <excerpt>`. Wait details carry `stalled: false | "quiet" |
  "struggling"` — truthiness is preserved — and the push carries the same kind.
- **One budget** — a streak is anchored to its kind's clock; the struggling
  anchor ignores error traffic, so retries cannot reset the cap. Notices are
  spaced by the threshold that produced them and capped at three per streak.
  `watchdog: 0` disables both kinds; `notify: "off"` gates delivery only.
- **Verbose-task tradeoff** — a chatty task entering a 20-minute build with
  zero events mis-fires at the 3m floor. The wait's event-profile line
  (`tool×N`, last excerpt) and the three-notice cap bound the cost; the model
  can tell a build's silence from a retry storm.

## Alternatives considered

1. One fixed threshold for every task
   Strongest reason: a single number is predictable for the model and needs no
   cadence estimation or new state; Why rejected: any value is either too tight
   for long tool calls or too loose for chatty tasks — the exact failure the
   early return exists to prevent — while two clocks give the same
   predictability with better sensitivity.
2. Only lower the default watchdog
   Strongest reason: a one-line change, no new fields, no median to test;
   Why rejected: it is blind to task shape and to the retry-storm signal: a
   tight default punishes slow builds and still cannot tell "busy" from
   "stuck".
3. Protocol-level ping / liveness probe
   Strongest reason: it would measure the target CLI's own liveness instead of
   inferring it from stdout; Why rejected: no adapter exposes a portable ping,
   adding one means per-CLI protocol work plus permission questions, and a
   process wedged in a retry loop would answer a ping anyway — liveness is not
   progress.

## Consequences

- The wait and the push report the same stall kinds, so a model that reads only
  the receipt and one that reads only notifications see the same verdict.
- Minute-scale thresholds are testable without waiting: `stallClock` is the one
  injectable clock and `stallTestApi` exposes the production predicates and
  event record to `test/stall-adaptive.test.ts`.
- Known debt, unchanged: `external_agent_compare` has no stall early return.
