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

## Update 2026-09-24

The decision stands — one tool set with an `agent` enum — and the thin-surface wave keeps that shape while moving CLI capability detail into the `external-agent` skill. The update separates two mechanisms the original note ran together.

- **Alternative 2 (dynamic registration) stays rejected for what it was rejected for**: a surface that varies with what is installed differs between machines and restarts, invalidates prompt caches, and makes the model's options non-deterministic. That reason is untouched.
- **Session-internal additive activation is a different mechanism, and pi sanctions it.** wait/compare/steer/follow_up are parked at `session_start` and added back with `setActiveTools` by the first dispatch that runs — additive, deduped against the host's current list, never a mid-session removal. Pi's extension docs (Dynamic Tool Loading) describe the loader-tool pattern: the change must be purely additive, the host records the added names on that tool result, and applies them before the next model request; on Anthropic the definitions arrive at that load point, so the cached prompt prefix survives.
- **The extension keeps activation prompt-invisible beyond the definitions**: the four carry no `promptSnippet`, and wait/steer/follow_up carry guideline strings the always-active `external_agent_start` already registers, which the host dedupes by exact match. compare's own guideline is the one system-prompt line activation adds.

Costs: `setActiveTools` becomes session state (`/reload` keeps the flag on the shared registry and restores the four additively, since the host reinstates every extension tool there), and a host without the tool-list API parks nothing — the four stay active and the announcement is still true. The seven tools measure 5,977 chars; 2,915 of them are paid on every request. See `.agents/notes/implemented/2026-09-24-lazy-tool-activation.md` and `2026-09-24-thin-tool-surface-skill-delegation.md`.
