# Capabilities: archive, verify, templates, meter

Opt-in mechanics that change what happens around a dispatch. This file is the
reference the coordinator reads when it uses one of them.

## Answer archive

Answers longer than 4000 chars — or any answer following the `## Summary` /
`## Details` structure — are written to `<session-dir>/external-agent/answers/`
at settle (per-turn files, sha256 recorded). What enters the conversation is the
handle line plus the worker's Summary section (or a head/tail excerpt when no
template was used):

```
[answer archived: ans_<id> | N bytes | M lines | sha256:xxxxxxxx |
 recall: external_agent_status({taskId, offset})]
```

Recall pages through `external_agent_status({taskId, offset})` — byte offset, one
page ≤16KB/400 lines, `next_offset`/`eof` in the recall header. Archiving fails open: a
write error keeps the answer inline and marks `archive unavailable` in the status.

Persistent sessions archive every settled turn as its own file; recall always
pages the latest turn.

## verify

`external_agent_start` / `external_agent_compare` accept
`verify: {command, timeoutSeconds?}`. After the task settles to done, the hub runs
the command via `pi.exec` in the task cwd and reports exit code plus a truncated
output tail — in the settle notice, in status, and per compare slot. The hub never
interprets the result; what a non-zero exit means is the caller's call. No rollback.

When no caller command is given, a worker-declared one from the `verify-report`
template's `## Suggested verify command` section is used — but never for readonly
tasks (a read-only worker must not gain execution through its answer text); those
are reported as `skipped` with the reason.

## Templates

`template: "<name>"` wraps the task text before dispatch. Resolution order:
`.pi/external-agent/templates/<name>.md` (project) →
`~/.pi/agent/external-agent/templates/<name>.md` (user) → builtin. A template is
Markdown with frontmatter (`name`, `version`, `description`) and exactly one
`{{TASK}}` placeholder; text after the placeholder is the output contract the
worker reads last. The dispatch receipt records `template: "name@version"`.
Unknown names refuse the dispatch with the searched paths.

Builtins:

- `evidence-research` — readonly research; Summary + Details with `path:line` anchors.
- `verify-report` — write tasks; change list + suggested verify command.
- `review-report` — reviews; verdict + per-item checklist with evidence locations.
- `relay-envelope` — worker-to-worker message format; follow_up with `fromTaskId` relays through it.
- `board-entry` — evidence-board row format; compare appends to a board through it.

## Isolate

`isolate: true` (start/compare) runs the worker in a fresh git worktree
`<repo>/.external-agent/worktrees/<taskId>` on branch `ea-<taskId>`; a non-git cwd
is refused. The hub never merges and never deletes. Status and settle notices carry
the path, a diff-stat summary, and a neutral `retained worktrees:` line (folded
past five). Merging or removing is the owner's call.

## Board

compare appends one JSONL row per settled slot (`claim`, `anchors`, `answerRef`,
`status: "unverified"`) to the board file — explicit `board` path, else
`<session-dir>/external-agent/board.jsonl`, `""` disables. The report ends with a
digest line; write failures are reported, never fatal.

## Relay

`external_agent_follow_up` with `fromTaskId` injects a settled task's answer (or an
archived page via `offset`/`length`) into another live session, wrapped in the
relay-envelope template. Delivery is layered:
steer for a running task, follow-up for a settled-alive session, explicit refusal
otherwise — a relay never silently becomes a new task. Chains cap at 2 hops; the
receipt carries bytes + sha256 prefix + a 500-char excerpt so the coordinator keeps
visibility without replay. `external_agent_status` shows how many relays a session
received.

## Meter

Usage and cost events self-reported by target CLIs are accumulated per task and
lifetime. `/external_agent_stats` dumps the counters. Numbers are "as reported by
the target CLI", never billing; cost exists only for CLIs that print it.

## Evidence rule

Terminal consumption (the coordinator reads and moves on): trust the summary, no
checks. Propagation (relay, board, acceptance): the Details section must carry
anchors and the hub or a verifier spot-checks them. Free mechanical facts — git
pre-snapshot + post diff stat, exit codes, CLI-reported usage — are always
captured when available.
