# Docs drift sync: 19 confirmed divergences

## Problem

A static comparison of the docs against the code found 19 places where a
document or a comment no longer describes what the code does. The worst are
silent omissions rather than wrong sentences: `notify` / `watchdog` (start),
`tail` (status), `mode: all|any` (wait), `all` (stop) and `purpose` (relay
follow_up) all take effect in `index.ts` but appear in no Markdown file, so a
reader of the docs cannot discover them. Others overstate behavior: settle
finalize is described as "two fail-open mechanics" when it runs four steps,
codebuddy's readonly row reads like a sandbox when its Bash hook is a heuristic,
and the isolate section promises "never deletes" without the failed-create
cleanup exception. The fix must not touch runtime logic.

## Decision

Align the docs and comments with the code in one pass, without changing any
behavior:

- Document the five undocumented parameters in the architecture tool map, where
  readers already look for the tool surface.
- State the archive trigger as "both `## Summary` and `## Details`", the actual
  `extractSummary` condition, and note that review-report's Summary + Checklist
  answers stay inline below 4000 chars.
- Record the transport selector as `SESSION_DRIVERS` / `hasSessionDriver()`,
  not the adapter's `session` field, and the persistent receipt's empty-argv
  backfill.
- Record codebuddy's hook as best-effort, isolate's cleanup exception, the
  4-step settle finalize, status-only diff-stat, and extraction-not-validation
  for anchors; describe compare's board rows as built inline from the
  board-entry fields.
- Correct the two `adapters.ts` comments (`steerNote` goes to the receipt, not
  the tool description; there is no one-shot fallback when a driver exists).
- Refresh the README install pin to the released tag and add the per-slot
  `task` override to the compare spec list.

Both nearly-full docs are compressed by the same amount the new text adds, so
every file stays inside the test-enforced budgets (AGENTS.md 550 words,
`docs/*.md` 650 words, notes 120 lines, READMEs 70 lines).

## Alternatives considered

1. **Put the missing parameters in AGENTS.md.** Strongest reason: it sits at
   328/550 words, so no compression of the near-full docs would be needed.
   Why rejected: AGENTS.md is repository working rules; a product tool
   parameter list there is a category error a future reader will not find.
2. **Leave the parameters to the tool schemas and document nothing.** Strongest reason: the schemas are the executable source of truth, so docs cannot
   drift from them. Why rejected: the docs present the tool map as complete;
   five live parameters that exist only in a schema are exactly the drift
   class this pass exists to remove.
3. **Make room in `docs/capabilities.md` by deleting a subsection.** Strongest reason: it is the fastest way to reclaim 50+ words. Why rejected: every
   section documents a distinct opt-in capability covered nowhere else, so the
   deletion would trade one accuracy problem for a larger one.

## Consequences

Docs and comments now match the implemented behavior, and the five parameters
are discoverable from the tool map. The cost is terser prose in two files and a
standing obligation: any future change to these behaviors must update the
matching sentence in the same commit, or the discrepancy returns unrecorded.
