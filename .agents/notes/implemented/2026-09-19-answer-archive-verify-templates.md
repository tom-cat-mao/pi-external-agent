# Answer archive + verify + templates + meter (W1–W2)

## Problem

External-agent answers were inlined into the coordinator transcript and replayed
on every later provider request (an 8-way compare: up to ~16k tokens once, then
every turn). Answers had no persistence (MAX_EVENTS ring, registry cleared on
shutdown). Verification cost coordinator turns. Usage/cost that CLIs self-report
was parsed but discarded. Contracts frozen in
`.agents/notes/planned/2026-09-19-sol-pi-inspired-overhaul.md`.

## Decision

1. **Archive at settle** (`artifacts.ts`): answers >4000 chars or matching the
   `## Summary`/`## Details` structure are stored content-addressed under
   `<session-dir>/external-agent/answers/<taskId>-turn<N>.md`. Inline becomes the
   handle + worker Summary (or head/tail excerpt). Recall pages through the
   existing status tool (`offset` param, ≤16KB/400 lines). Fail-open: write errors
   keep the answer inline and set `archiveError`.
2. **verify param** (`start`/`compare`): caller command wins; worker-declared
   (`verify-report` template) is the fallback and never runs for readonly tasks —
   a read-only worker must not gain execution via its answer. Hub runs
   `pi.exec("bash", ["-lc", cmd])` post-settle; receipt/report carry exit code +
   output tail. No verdict, no rollback.
3. **Templates** (`templates.ts` + `templates/`): five builtins; lookup
   project > user > builtin; one `{{TASK}}` placeholder; receipt records
   `name@version`. Unknown template refuses the dispatch.
4. **Meter** (`meter.ts`): every parsed usage/cost event folds into per-task and
   lifetime totals; `/external_agent_stats` dumps them; values are CLI-reported,
   never billing. `total_cost_usd: 0` placeholders are not attached to events
   (keeps existing deep-equal session tests green; zero contributes nothing).
5. **compare** accepts per-slot `task` overrides; same-task default unchanged.
6. **Thin prompt**: no new tools; new params are one-line; one capability-index
   guideline line; `test/prompt-surface-budget.test.ts` caps the tool surface at
   8900 chars (measured 8761 after this wave).

## Alternatives considered

- `pi.on("context")` projection to rewrite older tool results (SoL-Pi's route):
  strongest reason — it can pack results from any tool, not just ours. Rejected:
  rewriting history kills the prompt prefix cache from that point on; we own our
  tools' outputs, so pack-at-write is strictly cheaper and needs no projection.
- Worker-written report files as the persistence layer: strongest reason — the
  file doubles as an evidence-board artifact. Rejected as the universal layer:
  readonly workers cannot write; hub archiving covers every mode.
- New recall tool instead of a status param: strongest reason — cleaner separation.
  Rejected: tool descriptions cost context every request; the single-tool-surface
  invariant wins.
- Executing worker-declared verify commands for readonly tasks too: strongest
  reason — uniform behavior. Rejected: privilege escalation through answer text.
- Reproducing the pre-change 6574-char surface budget: abandoned — that figure
  could not be reproduced with the current measurement; the budget is now anchored
  to the measured post-change surface.

## Consequences

- Long answers stop replaying; reading them costs extra paged tool calls.
- wait/compare await `task.finalizePromise` before reporting, so receipts always
  see archive handles and verify results; notifications fire only after finalize.
- Ephemeral sessions (no session dir) and stubbed hosts (no `pi.exec`) simply skip
  archiving/verify — both mechanisms degrade to the pre-change behavior.
- Relay (W3) and board/isolate (W4) build on the archive store and receipts.
