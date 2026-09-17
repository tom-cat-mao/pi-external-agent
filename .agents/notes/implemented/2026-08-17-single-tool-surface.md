# One tool surface, not one tool per CLI

## Problem

Seven agents times N capabilities would become a large tool family (`start_codex`, `steer_kimi`, …) if each CLI got its own tools. Tool descriptions are paid in context on every request, whether or not that agent is used.

## Decision

Keep one small tool set with an `agent` enum parameter. Per-agent differences are carried by the enum description (`useFor`), the `steerNote` text and the receipt, rather than by separate tool schemas.

## Alternatives considered

1. **One tool per CLI.** Strongest reason: a per-CLI tool can describe exactly that CLI's flags, tiers and quirks without generalization, so the model reads only the relevant schema. Why rejected: prompt bloat — multiplying the surface by seven costs context on every request, including requests that never touch an external agent.
2. **Dynamic tool registration.** Strongest reason: only installed CLIs would register tools, so the surface adapts to the machine and no unusable agent is advertised. Why rejected: cache-hostile — a tool list that changes between machines or restarts invalidates prompt caches, and a non-deterministic surface makes the model's options harder to reason about.

## Consequences

Benefit: the context cost of the tool surface stays constant regardless of how many CLIs are installed or how many capabilities are added.

Cost: per-agent detail lives in enum and `steerNote` descriptions instead of bespoke schemas, and adding a shared capability widens a schema every caller sees.
