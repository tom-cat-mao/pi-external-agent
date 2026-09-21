# dsh detail moves to its own page rather than raising the docs budget

## Problem

`feat/dsh-shared-home` rewrote `docs/adapters.md`'s dsh section to 228 words and `docs/reasonix-readonly-version-boundary` added an 86-word reasonix section plus a row and a mapping bullet. Each branch fits the 650-word budget alone (647 and 648 words). Merged with both sides' facts intact, and after compressing every paragraph that carried filler, the file lands at ~716 words: the two additions cannot both fit, because what is left to cut is the facts themselves — paths, profile names, verification results.

## Decision

Follow the `docs/qoder.md` precedent. `docs/dsh.md` carries the dsh mechanism in full: the shared home, the higher-precedence `--patch` overlay that re-points the settings document, the consequences for settings-document preferences, per-profile plugins and sessions, the anchor guard, `DSH_HOME` stripping, effort over ACP and the verification checklist. `docs/adapters.md` keeps the `dsh` matrix row, the mapping bullet, and a compact `## dsh: shared home, scoped settings` summary ending in `Details: [dsh.md](dsh.md)`. Both PRs' facts land in the docs, none deleted, and `AGENTS.md`'s docs index lists the new page.

## Alternatives considered

1. **Raise the `docs/*.md` budget to 720.** Strongest reason: the merged content is all true, and the number is self-imposed — moving it is a one-line change against a merge that would otherwise lose information. Why rejected: the budget is a repo invariant enforced by test and stated in `AGENTS.md`; widening it to fit one merge blunts the pressure that keeps prose out of every other page, and would need a second edit to the rule that declares it.
2. **Compress prose until it fits.** Strongest reason: keeps the matrix self-contained in one page, with no new file and no rule change. Why rejected: measured 66 words over after an aggressive pass, and the remaining words are load-bearing facts; the result would be deletion dressed as editing, which is what this resolution exists to avoid.
3. **Take the other branch's shorter dsh section as-is.** Strongest reason: that 129-word section already fits and was written in the same tightening pass as the rest of the file, so the merge would look like a clean take-theirs. Why rejected: it describes the dedicated `DSH_HOME` home that the shared-home design replaces, so taking it would silently reassert a design that is gone and drop the overlay, anchor-guard and per-profile-plugin facts.
4. **Move the dsh mechanism into `docs/architecture.md`.** Strongest reason: dispatch environment is architectural, and the file already covers the dispatch path. Why rejected: that page sits at 648 of 650 words, so it offers no room, and its subject is the dispatch flow rather than one harness's environment contract.

## Consequences

- `docs/adapters.md` 592 words, `docs/dsh.md` 246, `AGENTS.md` 526 — all inside budget, `test/docs-budget.test.ts` green.
- The matrix keeps what a caller needs (which tier, enforced how) and links out for mechanism; `docs/dsh.md` becomes the single home for dsh environment facts, so the next dsh change edits one page.
- Consistency between the two pages is a manual `update both` contract, like the one `src/adapters.ts` and the matrix already share — no test enforces it.
