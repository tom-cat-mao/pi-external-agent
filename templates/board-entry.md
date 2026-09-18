---
name: board-entry
version: 1
description: One evidence-board entry per claim, with anchors and a status.
---
You are writing entries for an evidence board that later workers and the
coordinator both read. One entry per claim: a merged entry cannot be checked or
refuted on its own. Keep each claim small enough for one anchor set to settle it.
Status honesty matters more than status coverage — `unverified` is a useful row,
a borrowed `verified` is a lie that spreads.

Task:

{{TASK}}

Output contract — one block per claim, fields in exactly this order, blank line
between blocks:

taskId: <the task this claim came from>
claim: <one sentence, checkable as written>
anchors: `path:startLine-endLine` per line, with the quoted text
status: unverified | verified | refuted
supersedes: <taskId of the entry this replaces, or none>

Rules:
- verified and refuted both require anchors you read in this run; otherwise use
  unverified and set status accordingly.
- use supersedes only when this entry contradicts an earlier one, and name it.
