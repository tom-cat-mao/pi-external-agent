# Three-layer docs and the prompt slim

## Problem

The tool descriptions and guidelines injected into every pi session had grown to 15,812 characters, with each rule repeated three to five times across the injected text. The README carried both present-tense facts and decision history, so neither the current contract nor the reasoning behind it had a single home. The repository had no AGENTS.md, no docs/ tree and no decision-record folder.

## Decision

Adopt a three-layer documentation model:

- Root `AGENTS.md` — the thin rulebook: layout, commands, invariants and documentation rules, each pointing at its detail.
- `docs/` — present-tense facts about the current system, with word budgets enforced by `test/docs-budget.test.ts` so prose cannot silently regrow.
- `.agents/notes/` — decision records holding the history the other two layers exclude.

Injected text is slimmed to a single home per rule — 6,574 characters — and the detail those one-line rules cannot carry moves to runtime refusal and error messages, which session-time models actually read.

## Alternatives considered

1. **Keep appending rules to the prompt text.** Strongest reason: zero tooling cost, and a rule stays co-located with the tool it governs, so editing a tool and its prompt text is one edit in one file. Why rejected: repetition degrades instruction-following and is paid in context on every request, so the prompt grows more expensive and less reliable at the same time.
2. **Move the detail into `docs/` files that runtime pi sessions cannot read.** Strongest reason: prose gets a single home and the injected surface stays minimal without inventing a new mechanism for it. Why rejected: a session using the extension never checks out the repository, so docs are invisible at the moment a rule must guide behavior; only the one-line prompt rules and runtime refusal/error messages reach the model.
3. **One tool per CLI to shrink each description.** Strongest reason: a per-CLI tool describes exactly that CLI's flags and quirks, so every injected schema stays small and specific. Why rejected: it multiplies the tool surface and is cache-hostile — already decided against in [2026-08-17-single-tool-surface.md](2026-08-17-single-tool-surface.md).

## Consequences

Benefit: every rule has one home, the injected text states each rule once, and "the docs stay current" becomes a test failure rather than a hope; history sits in notes where it cannot pollute present-tense facts.

Cost: documentation changes must fit the word budgets and pass `node --test test/docs-budget.test.ts`, and detail that neither the prompt nor docs can carry has to be encoded in runtime messages, which are harder to review than prose.
