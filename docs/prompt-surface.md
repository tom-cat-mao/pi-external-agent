# Prompt surface

What tool text a session pays for, when it pays, and where the budget test pins it.

## Three layers

1. **Fixed tool surface** — the always-active `external_agent_start`, `external_agent_status` and `external_agent_stop`. Their names, descriptions, snippets, guidelines and parameter descriptions are injected into every provider request, dispatch or not, so they are hard-budgeted by `test/prompt-surface-budget.test.ts`.
2. **On-demand skill body** — `skills/external-agent/SKILL.md`, advertised through pi's `resources_discover` hook: only the skill's name and description enter the prompt. The model reads the file for the capability matrix, effort ranges, mode tiers, templates, the relay protocol and the verify/isolate/notify/watchdog knobs. Tool descriptions carry pointers (`read skill \`external-agent\``) instead of repeating that detail.
3. **Runtime refusals** — validation messages and dispatch receipts name what the target CLI will not do: an unsupported mode or effort, a version gate, a write conflict. This text is paid only when a dispatch asks, and it is the layer that stays exact as adapters change.

The four session-only tools — `external_agent_wait`, `external_agent_compare`, `external_agent_steer`, `external_agent_follow_up` — leave the fixed layer until they can act on a task.

## Activation flow

- **Parked at `session_start`**: the extension removes the four from the host's active list (`setActiveTools` minus the four), the only removal it performs, while the host is establishing its own list.
- **Activated additively by the first dispatch that runs**: the shared dispatch path calls `setActiveTools([...current, ...missing])` at most once per session, deduped against the host's list. A refusal — hub validation, or an adapter that declines to spell out a command — returns before that point, so it neither activates nor announces.
- **Announced by the dispatching result**: that result carries one line naming the four (`LAZY_ACTIVATION_NOTICE` in `src/hub/reporting.ts`). Two dispatches racing in one tool batch activate once, and exactly one of their results carries the line.

A host without `getActiveTools`/`setActiveTools` parks nothing and activates nothing: the four are active from the start, and the line is still true. The `activated`/`noticePending` flags live on the shared task registry so `/reload` does not re-arm a session that already activated.

## Budgets

`test/prompt-surface-budget.test.ts` counts both layers with one collector: name + description + `promptSnippet` + `promptGuidelines` + every parameter description. The fixed layer is asserted ≤ 3,500 chars. The lazy layer is measured against the same ceiling as a soft check that reports a crossing as a diagnostic without failing the gate — only dispatched sessions pay it, so the number is recorded for the human reading the run, not enforced. Both totals print as diagnostics with the per-tool split.

Growth is a decision: a budget rises only with a note explaining what the extra chars buy, never by drift. The two layers are budgeted apart because they are paid apart — fixed text by every request, lazy text by sessions that dispatch.

## See also

- [architecture.md](architecture.md) — dispatch flow, receipts, transports.
- [capabilities.md](capabilities.md) — archive, verify, templates, isolate.
