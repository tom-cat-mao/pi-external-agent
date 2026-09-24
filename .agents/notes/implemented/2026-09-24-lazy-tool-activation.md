# Lazy tool activation: the session-only four arrive on the first dispatch

## Problem

Seven tools are registered, and every registered tool's description is paid in context on every request of the session. Four of them — wait, compare, steer, follow_up — can do nothing until a task exists: there is no taskId to name, no session to steer, no batch to compare. A session that never dispatches still pays for all seven.

## Decision

Split the surface by when it is needed. start/status/stop stay active; a session opens with the other four parked and the first dispatch that really runs adds them back.

- **Parking** happens at session_start: `setActiveTools(getActiveTools() minus the four)`. This is the only removal the extension performs, and it lands while the host is establishing its own active list, so a running session never loses a tool it may already have used. When nothing needs removing, no write is made — a redundant `setActiveTools` would only record a transcript delta with no effect.
- **Activation** is additive and deduped: `setActiveTools(getActiveTools() plus the four)`. The trigger is the dispatch-count site both transports already share, so a refusal (the hub's validation, or an adapter that declines to spell out a command) returns before it, while everything a dispatch does afterwards — including a spawn that fails — was still dispatched.
- **The announcement** (`Tools … are now active.`) rides that one result: the activation site marks the task it was reached from (`activatedNow`), and the result builder of whichever tool dispatched — start or compare — prints the line from `hub/reporting.ts`.

Idempotence: the `activated` flag lives on the shared task registry, which survives `/reload`, and is written synchronously before the host call — nothing awaits between the check and the write, so two dispatches in one tool batch cannot both activate, and only the task the flag landed on carries the line. A genuinely new session resets it; session_shutdown drops the captured accessors with the session, while a reload keeps them (the same session continues).

## Alternatives considered

1. **Keep all seven active.** Strongest reason: no mechanism and no risk — a static tool list cannot surprise the model mid-session. Why rejected: the point of the change is context; four descriptions and their parameter schemas are paid on every request, including the many sessions that never dispatch anything.
2. **Register the lazy four only once a task exists.** Strongest reason: the surface would be exactly right at every moment, with no parked state to unwind. Why rejected: registration is not activation — a tool list that grows mid-session invalidates the prompt cache and rewrites the host's tool inventory, and it would leave the four unregistered in a session whose first dispatch happens inside a batch that already laid out its tools.
3. **A prompt statement that the four are irrelevant before a task exists.** Strongest reason: it needs no host API and works on hosts that expose no tool-list control. Why rejected: it saves no context at all — the descriptions are the cost — and it is a request to the model, not a mechanism.
4. **Announce activation by a message on the next turn.** Strongest reason: no tool-result hook, so no tool result is ever rewritten. Why rejected: it reports a context change out of band, at an arbitrary point in the transcript, instead of on the result that caused it.

## Consequences

Benefit: a session that never dispatches carries three tool descriptions instead of seven, and the four appear in the same turn their first use becomes possible, with the model told why.

Cost: the active-tool list becomes session state the hub mutates, so it joins the things `/reload` has to keep coherent — hence the flag on the shared registry. A host without `getActiveTools`/`setActiveTools` degrades silently: nothing is parked, activation is a no-op, and the line is still true, because on such a host the four are active from the start. Parking is a context choice, never a permission tier: what each tool may do to the target CLI is unchanged. The completion push previews `NOTIFY_PREVIEW_CHARS` = 2,000 chars instead of 4,000 — half of `ARCHIVE_INLINE_CHARS`, deliberately — because an answer past the archive threshold travels as a handle with its recall pointer: the tail is one `external_agent_status` offset call away, and a notification that lands mid-turn is worth less context than the recall path costs.

## Update 2026-09-24

The session boundary between "new" and "reloaded" needed pinning down, and the announcement needed to follow the dispatch rather than a tool name.

- **A reload is not a new session.** pi emits `session_shutdown{reload}`, reinstates every extension tool on the host's active list, then `session_start{reload}`. The reason decides the branch: an activated session gets the four added back additively with `activated` untouched and no second announcement, while a reload before the first dispatch parks as usual. Only startup/new/resume/fork reset the flag.
- **The line follows the dispatch.** A compare batch is the first dispatch on a host that parks nothing, so gating the announcement on the start tool would leave an activation unannounced; the flag is on the task instead, and one code path serves every dispatching tool.

