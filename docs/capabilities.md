# Capabilities: archive, verify, templates, meter

Opt-in mechanics that change what happens around a dispatch. The tool schemas stay
the short version; this file is the reference the coordinator reads when it actually
uses one of them.

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
page ≤16KB/400 lines, `next_offset`/`eof` in the recall header. Paging back the
whole file and comparing sha256 is the integrity check. Archiving fails open: a
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
- `relay-envelope` — worker-to-worker message format (used by relay, Wave 3).
- `board-entry` — evidence-board entry format (used by board, Wave 4).

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
