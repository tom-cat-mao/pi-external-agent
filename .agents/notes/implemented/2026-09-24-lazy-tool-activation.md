# Lazy tool activation: the session-only four arrive on the first dispatch

## Problem

Seven tools are registered, and every registered tool's description is paid in context on every request of the session. Four of them — wait, compare, steer, follow_up — can do nothing until a task exists: there is no taskId to name, no session to steer, no batch to compare. A session that never dispatches still pays for all seven.

## Decision

Split the surface by when it is needed. start/status/stop stay active; a session opens with the other four parked and the first dispatch that really runs adds them back.

- **Parking** happens at session_start: `setActiveTools(getActiveTools() minus the four)`. This is the only removal the extension performs, and it lands while the host is establishing its own active list, so a running session never loses a tool it may already have used. When nothing needs removing, no write is made — a redundant `setActiveTools` would only record a transcript delta with no effect.
- **Activation** is additive and deduped: `setActiveTools(getActiveTools() plus the four)`. The trigger is the dispatch-count site both transports already share, so a refusal (the hub's validation, or an adapter that declines to spell out a command) returns before it, while everything a dispatch does afterwards — including a spawn that fails — was still dispatched.
- **The announcement** (`Tools … are now active.`) rides that one result. The sentence is built in `hub/reporting.ts` and attached as the result passes the `tool_result` hook, because the start tool composes its own model-visible text in `hub/tools.ts`, which this change does not own.

Idempotence: the two flags (`activated`, `noticePending`) live on the shared task registry, which survives `/reload`, and are written synchronously before the host call — nothing awaits between the check and the write, so two dispatches in one tool batch cannot both activate, and exactly one of their results carries the line. session_start resets both per session; session_shutdown drops the captured accessors with the session, while a reload keeps them (the same session continues).

## Alternatives considered

1. **Keep all seven active.** Strongest reason: no mechanism and no risk — a static tool list cannot surprise the model mid-session. Why rejected: the point of the change is context; four descriptions and their parameter schemas are paid on every request, including the many sessions that never dispatch anything.
2. **Register the lazy four only once a task exists.** Strongest reason: the surface would be exactly right at every moment, with no parked state to unwind. Why rejected: registration is not activation — a tool list that grows mid-session invalidates the prompt cache and rewrites the host's tool inventory, and it would leave the four unregistered in a session whose first dispatch happens inside a batch that already laid out its tools.
3. **A prompt statement that the four are irrelevant before a task exists.** Strongest reason: it needs no host API and works on hosts that expose no tool-list control. Why rejected: it saves no context at all — the descriptions are the cost — and it is a request to the model, not a mechanism.
4. **Announce activation by a message on the next turn.** Strongest reason: no tool-result hook, so no tool result is ever rewritten. Why rejected: it reports a context change out of band, at an arbitrary point in the transcript, instead of on the result that caused it.

## Consequences

Benefit: a session that never dispatches carries three tool descriptions instead of seven, and the four appear in the same turn their first use becomes possible, with the model told why.

Cost: the active-tool list becomes session state the hub mutates, so it joins the things `/reload` has to keep coherent — hence the flags on the shared registry. A host without `getActiveTools`/`setActiveTools` degrades silently: nothing is parked, activation is a no-op, and the line is still true, because on such a host the four are active from the start. A host that drops the `tool_result` hook loses the line but not the activation. Parking is a context choice, never a permission tier: what each tool may do to the target CLI is unchanged.
