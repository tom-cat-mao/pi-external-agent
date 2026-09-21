# Doc-surface sweep: four pages re-verified against the code

## Problem

Main absorbed four changes that touch what the docs assert (dsh's shared home with
the scoped settings overlay, reasonix's readonly version boundary, the telemetry
reversal, the receipt-label truth pass) and this branch added a fifth (kimi's ACP
session, with its own page and an AGENTS.md index entry). A full re-read of every
doc-surface file against `src/adapters.ts`, `src/drivers/*` and `src/hub/*` found
four claims that no longer describe what the code does:

- Both READMEs' documentation index still listed only architecture / adapters /
  capabilities / qoder / notes: the two per-agent pages added this week
  (`docs/dsh.md`, `docs/kimi.md`) were reachable from AGENTS.md but not from
  either README.
- The READMEs' `kimi` row said `❌` under `Steer / follow-up`. Follow-up works —
  the ACP session persists (`session: {steer: false, followUp: true}`) — so the
  cell asserted the absence of a capability kimi has.
- `docs/adapters.md`'s `reasonix` Effort cell said `off–max` without saying where
  the level would travel. `reasonix --acp` accepts no effort flag, no dialect
  `configureSession` sets one, and `effortForwardedOnSession("reasonix")` returns
  false, so the persistent path — the only path a dispatch takes — forwards none
  of them and the receipt reports `NOT forwarded`.
- `docs/dsh.md` documented the effort channel's transport split and said nothing
  about the model, which has the same shape: `modelForwardedOnSession("dsh")` is
  false and both one-shot and session notes report a request as not forwarded.

## Decision

Fix the four claims, drop no fact, and touch nothing else:

- Add `docs/dsh.md` and `docs/kimi.md` to the Documentation index in both READMEs,
  on the existing line so the 70-line budget is unchanged.
- Restate the `kimi` cell as `follow-up ✅; steer ❌` in both READMEs, matching how
  the `qoder` row already splits the two.
- Say `off–max; ACP forwards none` in the reasonix Effort cell, and pay for the
  three extra words by tightening the matrix footnote ("names that layer") — the
  file stays at 646/650 with no fact removed.
- Add one sentence to `docs/dsh.md`: a model request is reported not forwarded on
  either transport, because the run profile selects the model and no model flag is
  verified on either path.

`docs/architecture.md` (649/650) is left untouched. Its Transports bullet already
names `AcpDriver`'s four dialects without narrating any driver's startup handshake
(codex's `initialize`/`thread/start`, pi's stdin prompt, qoder's handshake are all
likewise absent), so one dialect family's internal configure phase is not an
omission there but a level of detail the per-agent pages own — `docs/kimi.md`
documents the phase in full.

## Alternatives considered

1. **Add the configure phase to `docs/architecture.md`'s dispatch flow.**
   Strongest reason: the phase is a named, shared lifecycle step this branch
   introduced (`AcpDriver.start()`: spawn → initialize → session/new → configure →
   first prompt), and the page is the dispatch-flow reference. Why rejected: the
   page deliberately stops at the hub's task lifecycle and leaves wire handshakes
   to the per-agent pages, so adding one family's phase would be arbitrary — and at
   649/650 words it would need ~16 words of prose deleted to say it.
2. **Make reasonix refuse an effort request at the adapter instead of annotating
   the cell.** Strongest reason: a refused request cannot mislead, whereas an
   accepted one relies on the caller reading the receipt's `not forwarded` note.
   Why rejected: that is a behavior change to a validated capability, out of scope
   for a docs pass, and the receipt already reports the request honestly — the gap
   was in the doc, not the code.
3. **Leave the README `kimi` cell as `❌` and let the follow-up capability be
   discovered from `docs/adapters.md`.** Strongest reason: the cell is terse by
   design and the matrix has the authoritative per-agent row. Why rejected: a
   capability the agent has, denied in the first table a user reads, is exactly the
   dishonesty class this repository's receipt pass exists to remove.
4. **Raise the `docs/*.md` budget to fit the new text.** Strongest reason: the new
   sentences are small and the budgets are tight at 646–649. Why rejected: budgets
   are enforced by test on purpose, the wording fits once prose is tightened, and
   no fact had to be dropped to do it.

## Consequences

Every page now states what the code does for the five recent changes: kimi's tiers,
steer and follow-up, dsh's model and effort channels, reasonix's effort channel,
and the two per-agent pages are discoverable from both READMEs. The cost is that
the reasonix effort claim now depends on `effortForwardedOnSession` — wiring a
reasonix effort path (capability negotiation, as the readonly boundary note already
calls for) must update the cell in the same commit, or the doc will understate what
travels.
