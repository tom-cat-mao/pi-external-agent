# codebuddy readonly: settings rules + Bash hook

## Problem

codebuddy's readonly tier must refuse edits and writes while keeping the ACP turn alive. Plan mode does not fit: under ACP its permission requests are auto-rejected by the driver, which cancels the whole turn instead of refusing the individual tool call.

## Decision

Run readonly in `default` permission mode with a generated `--settings` payload:

- `permissions.allow`: Read, Grep, Glob, LS, WebSearch, WebFetch.
- `permissions.deny`: Edit, Write, MultiEdit, NotebookEdit. A rule-layer deny is silent, so the turn continues rather than dying on a permission round-trip.
- `hooks.PreToolUse` for Bash: `hooks/codebuddy-readonly.js`, which heuristically allows common read-only commands and denies edits, writes, redirects, command substitution and known-mutating commands.

`--disallowedTools` is ignored under ACP, so every rule goes through `--settings`. The hook path resolves from the module directory at call time, so it survives relocation of the extension.

## Alternatives considered

1. **Plan mode.** Strongest reason: it is the harness's own read-only mode, so no custom rule payload is needed. Why rejected: it is not equivalent headless; its auto-rejected permission request cancels the turn outright, so a readonly run would die instead of refusing one tool call.
2. **OS sandbox.** Strongest reason: an OS-level boundary would be airtight rather than heuristic. Why rejected: no sandbox is available for this CLI on this platform, so there is nothing to bind the tier to.

## Consequences

Benefit: readonly runs neither prompt nor die, and deny-rule refusals are silent so the turn survives.

Cost: the hook is a heuristic filter, **not** a sandbox — general script runners it has to allow (`node`, `npm`, `gh`, …) can act beyond its patterns, so readonly is best-effort rather than an absolute guarantee. The pattern list needs upkeep as tooling changes.
