# The prompt surface gets its own page, and the budget test counts two layers

## Problem

The thin-surface wave needs two facts in the docs: the three layers of tool text, and the lazy activation flow. `docs/architecture.md` sits at 649 of its 650-word budget, so the full model cannot land there without deleting facts, and the detail has no other home — `docs/capabilities.md` covers archive/verify/templates/meter, `docs/adapters.md` the per-CLI tiers, and the skill is model-facing text, not a maintainer reference. The budget test has the same mis-fit: one 3,500-char number for all seven tools no longer describes what a request pays, because three tools are active from `session_start` and four arrive on the first dispatch that runs.

## Decision

Split both the page and the accounting.

- `test/prompt-surface-budget.test.ts` measures the **fixed layer** (`external_agent_start/status/stop`) against a hard 3,500-char budget, and records the **lazy layer** (wait/compare/steer/follow_up) against the same ceiling as a soft, diagnostic-only check. Both totals and the per-tool split print as test diagnostics. The split is read from `LAZY_TOOL_NAMES`, so a tool that is active from the start counts in the hard layer by default.
- `docs/prompt-surface.md` carries the three layers, the activation flow (parked at `session_start` → additive activation on the first dispatch that runs → the announcement on its result), the budget mechanics and the degradation on hosts without the tool-list API. `docs/architecture.md` keeps a three-line `## Prompt surface` summary ending in a link to the page, and `AGENTS.md`'s docs index lists it.

## Alternatives considered

1. **Keep one 3,500-char budget over all seven tools.** Strongest reason: one number, one assertion, and it caps the total the session eventually pays. Why rejected: it charges the fixed layer for the lazy layer's growth, so a lazy-only addition would fail a gate that no request pays for — the two-layer split is the point of the wave.
2. **Compress `architecture.md` until the full model fits.** Strongest reason: no new page, no index change, everything in the doc a maintainer already reads. Why rejected: measured ~50 words over at best, and the remaining candidates were facts (the wait's receipt claim, the driver protocol spellings) — the `2026-09-21-dsh-detail-in-its-own-page.md` situation again.
3. **Raise the `docs/*.md` budget for architecture.md.** Strongest reason: all the content is true and the number is self-imposed. Why rejected: `AGENTS.md` declares the budget an invariant enforced by test; widening it for one addition blunts the pressure that keeps every other page tight.
4. **Put the three-layer model only in `skills/external-agent/SKILL.md`.** Strongest reason: the skill is already the home of capability detail and a new section there costs no docs budget. Why rejected: the skill serves the model at dispatch time; prompt-layer accounting is a maintenance fact — which layer a request pays, where a test pins it — and belongs with the other docs.

## Consequences

- `architecture.md` 645 words, `prompt-surface.md` 481, `AGENTS.md` 546 — the docs gate stays green with the new page indexed.
- The fixed layer is 2,915 chars and the lazy layer 3,062, of 5,977 for the seven tools. A future addition states which layer it grows.
- The soft check only reports: a lazy-layer crossing shows up as a diagnostic line, not a red gate, because only dispatched sessions pay that layer. The hard gate covers what every request pays.
- Wording is one vocabulary across the three carriers: `tools.ts` builds its activation sentence from `LAZY_TOOL_NAMES`, `SKILL.md` heads its tier section `Permission tiers`, and `LAZY_ACTIVATION_NOTICE` names the four in the same order.
