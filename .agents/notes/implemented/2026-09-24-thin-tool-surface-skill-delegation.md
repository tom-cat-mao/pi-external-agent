# Thin tool surface: capability detail delegates to the `external-agent` skill

## Problem

The fixed prompt surface in `src/hub/tools.ts` measured 9,046 characters as the
budget test counts it: every provider request paid for the eight-agent
capability table inside `external_agent_start`, for per-slot parameter prose in
`external_agent_compare` that restated `external_agent_start` semantics in
slightly different words, and for guidelines that carried the same rule on
several tools with different wording. The table's own comment already admitted
the cost: each new agent raised the budget deliberately. Capability detail
belongs somewhere a session reads once, not in text every request replays.

## Decision

Move capability detail out of the fixed surface into the `external-agent`
skill, and keep only what shapes a dispatch decision in the tool text:

- `external_agent_start` drops the agent table and the persistent-sessions
  line; one line points at the skill for the capability matrix, effort levels,
  permission tiers, templates and steer/follow-up support. A second line states
  that wait, compare, steer and follow-up activate on first dispatch. The
  anti-polling / end-your-turn / no-wall-clock guidance and the
  dispatch-validation summary stay.
- `external_agent_compare` per-slot fields become `Same semantics as
  external_agent_start.<param>.` pointers; compare-specific text (never diffs,
  scores or ranks; refusal recording; timeout receipt) stays in full.
- `effort` keeps the opt-in rule in two sentences plus a
  `per-agent ranges: see skill` pointer. `external_agent_steer` keeps the qoder
  version gate exactly once, in its description. `external_agent_follow_up`
  keeps the 30-minute idle reclaim and points at the skill for the relay
  protocol.
- Guidelines that govern more than one tool are single constants
  (`G_END_TURN`, `G_WAIT_WHEN_NEEDED`, `G_STEER`, `G_FOLLOW_UP`,
  `G_VERIFY_CLAIMS`), so carriers register byte-identical strings; the host
  dedupes guidelines by exact match when it builds the system prompt.
- Snippets are removed from wait, compare, steer and follow-up (snippets only
  render for active tools, and these are inactive by default); start, status
  and stop keep snippets of 40 characters or fewer.

Measured with `test/prompt-surface-budget.test.ts`'s own collector: 9,046 →
5,977 characters, now budgeted in two layers — fixed 2,915 against a hard 3,500
(the three always-active tools, paid on every request) and lazy 3,062 against a
soft 3,500 (the four parked tools, paid only by sessions that dispatch).

## Alternatives considered

1. **Keep the capability table and only trim parameter prose.** Strongest reason: the table answers "which agent, which mode, does it steer" at the moment of dispatch, without an extra read. Why rejected: it is the single largest line item and it grows with every adapter; the skill carries the same facts with room for the caveats the table flattened into flags.
2. **Delete the facts outright instead of moving them.** Strongest reason:
   smallest possible surface, and runtime refusals already name what is
   unsupported. Why rejected: notify modes, watchdog semantics, verify's
   mechanical exit code, the isolate path, template precedence, the relay
   reclaim and the qoder gate shape caller choices before any refusal is
   visible, so each keeps a home in the skill.
3. **Leave guidelines per-tool and accept near-duplicates.** Strongest reason: each tool's advice stays next to that tool and reads naturally. Why rejected: near-duplicates are deduped only when byte-identical, so drift both costs prompt space and lets one copy go stale.

## Consequences

The fixed surface no longer grows with the adapter roster; new capability
detail lands in the skill, and a session must read the skill before dispatching
to know default modes, effort ranges and steer/follow-up support. The budget
test guards both layers: the fixed layer sits 585 characters under its hard
budget and the lazy layer 438 under its soft ceiling, each of which a later
addition spends deliberately. Tools that lose their snippets stay
callable but leave the `<tools>` list until activation, which is the intended
inactive-by-default behavior.
