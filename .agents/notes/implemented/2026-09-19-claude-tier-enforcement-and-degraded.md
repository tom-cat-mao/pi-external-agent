# Claude tier enforcement: driver-enforced readonly, degraded mark

## Problem

The claude session driver answered `can_use_tool` with allow only in yolo and deny
otherwise, so a write turn refused every tool the CLI asked about even though
`acceptEdits` had already opened edits. The receipt also claimed
`harness-enforced` for a readonly tier no target-harness boundary backs, and no
`degraded` mark told the model that nothing in the claude path has met a real
endpoint. The modernization note's checklist described the old behaviour.

## Decision

- `can_use_tool`: deny for readonly, allow for write and yolo — the same split
  the ACP driver makes (`failClosedPermissionModes`, sessions.ts).
- Receipts label a claude readonly turn `driver-enforced (can_use_tool deny)`
  instead of `harness-enforced`, via `Adapter.driverEnforcedReadOnly`.
- `ADAPTERS.claude.degraded` is set to "unverified against a real endpoint;
  fixture-tested only", so both the tool table and the start result carry the
  caveat until a live run retires it (checklist in the modernization note).
- Docs, tests and stale comments are synced to those facts; the effort guideline
  wording in `external_agent_start` is untouched (a test pins it).

## Alternatives considered

1. Keep denying in write mode. Strongest reason: denying tools the CLI asks
   about is the fail-closed default, so a mislabelled write turn cannot mutate
   anything. Why rejected: the CLI's `acceptEdits` mode is the tier's
   enforcement point, and a driver deny there does not add safety — the request
   only reaches the driver for tools the mode has not already settled — while
   making write delegation unusable.
2. Keep the single `harness-enforced` label. Strongest reason: one label keeps
   the receipt enum and the display switch simple. Why rejected: it claims a
   target-harness boundary that does not exist for claude, which contradicts the
   receipt's honest-reporting contract in docs/architecture.md.
3. Leave `degraded` unset until a real endpoint is configured. Strongest reason:
   avoids a caveat that may soon be obsolete. Why rejected: the field exists
   exactly for callable-but-known-degraded upstreams, and the model should be
   told before it trusts a claude answer.

## Consequences

Benefit: the mode a caller asks for is the mode that runs; the receipt says where
the readonly tier is enforced; the model sees the verification gap up front.

Cost: one more `readOnlyEnforcement` value to validate (`isDispatchReceipt`) and
a caveat that must be removed once the checklist passes. The prompt surface stays
inside its 8900-char budget because the claude additions are offset by
compressing prose that already had a second home (extras guideline, provider,
kimi/qoder tails).
