# Capabilities: archive, verify, templates, meter

Opt-in mechanics that change what happens around a dispatch; the coordinator's
reference for using them.

## Answer archive

Answers longer than 4000 chars — or any answer carrying both `## Summary` and
`## Details` — are written to `<session-dir>/external-agent/answers/` at settle
(per-turn files, sha256 recorded); answers to other contracts (e.g. review-report's
Summary + Checklist) stay inline. What enters the conversation is the handle line
plus the Summary (or a head/tail excerpt otherwise):

```
[answer archived: ans_<id> | N bytes | M lines | sha256:xxxxxxxx |
 recall: external_agent_status({taskId, offset})]
```

Recall pages through `external_agent_status({taskId, offset})` — byte offset, one
page ≤16KB/400 lines, `next_offset`/`eof` in the header. Archiving fails open: a
write error keeps the answer inline and marks `archive unavailable` in status.

Persistent sessions archive each turn separately; recall pages the latest.

## verify

`external_agent_start` / `external_agent_compare` accept
`verify: {command, timeoutSeconds?}`. After settle to done, the hub runs the
command via `pi.exec` in the task cwd and reports exit code plus a truncated
output tail — in the settle notice, in status, and per compare slot. The result is
never interpreted; a non-zero exit means what the caller decides. No rollback.

With no caller command, a worker-declared one from `verify-report`'s `## Suggested
verify command` section is used — never for readonly tasks (a read-only worker
must not gain execution through its answer text); those report `skipped` with the
reason.

## Templates

`template: "<name>"` wraps the task text before dispatch. Resolution order:
`.pi/external-agent/templates/<name>.md` (project) →
`~/.pi/agent/external-agent/templates/<name>.md` (user) → builtin. A template is
Markdown with frontmatter (`name`, `version`, `description`) and exactly one
`{{TASK}}` placeholder; text after it is the output contract the worker reads
last. The receipt records `template: "name@version"`. Unknown names refuse with
the searched paths.

Builtins:

- `evidence-research` — readonly research; Summary + Details with `path:line` anchors.
- `verify-report` — write tasks; change list + suggested verify command.
- `review-report` — reviews; verdict + per-item checklist with evidence locations.
- `relay-envelope` — worker-to-worker message format; follow_up with `fromTaskId` relays through it.
- `board-entry` — evidence-board row format; compare builds its rows inline from
  these fields, never loading the template.

## Isolate

`isolate: true` (start/compare) runs the worker in a fresh git worktree
`<repo>/.external-agent/worktrees/<taskId>` on branch `ea-<taskId>`; a non-git cwd
is refused. The hub never merges or deletes retained worktrees; one exception:
cleanup of what a failed `git worktree add` just created (`git worktree remove
--force`). Status carries path plus diff-stat; the settle notice carries path and
branch. A neutral `retained worktrees:` line lists what remains (folded past
five). Merging or removing is the owner's call.

## Board

compare appends one JSONL row per settled slot (`claim`, `anchors`, `answerRef`,
`status: "unverified"`) to the board file — explicit `board` path, else
`<session-dir>/external-agent/board.jsonl`, `""` disables. The report ends with a
digest line; write failures are reported, never fatal.

## Relay

`external_agent_follow_up` with `fromTaskId` injects a settled task's answer (or an
archived page via `offset`/`length`) into another live session, wrapped in the
relay-envelope template. Delivery is layered:
steer for a running task, follow-up for a settled-alive session, refusal
otherwise — a relay never silently becomes a new task. Chains cap at 2 hops; the
receipt carries bytes + sha256 prefix + a 500-char excerpt for visibility without
replay. `external_agent_status` shows how many relays a session received.

## Meter

Usage and cost self-reported by target CLIs accumulate per task and lifetime;
`/external_agent_stats` dumps the counters. Numbers are as reported by the target
CLI, never billing; cost exists only where the CLI prints it.

## Evidence rule

Terminal consumption (read and move on): trust the summary, no checks.
Propagation (relay, board, acceptance): the Details section must carry anchors;
the hub only extracts them into relay envelopes and board rows, so checking them
is the caller's or a verifier's job. Free mechanical facts — git pre/post diff
stat, exit codes, CLI-reported usage — are always captured when available.
