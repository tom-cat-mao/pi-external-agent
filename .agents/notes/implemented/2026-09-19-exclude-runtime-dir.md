# Hub writes .git/info/exclude for the runtime worktree dir

## Problem

Isolated tasks live at `<repo>/.external-agent/worktrees/<taskId>`, inside the
parent checkout. Unignored, every isolated dispatch pollutes the parent's
`git status`, and a careless `git add -A` could drag a nested worktree (a full
checkout plus its `.git` pointer) into the parent index.

## Decision

After a successful `git worktree add`, the hub appends `.external-agent/` to the
parent repo's `.git/info/exclude` — git's local, uncommitted ignore list.
Idempotent (exact-line check, never duplicates); best-effort (failures are
swallowed — a dirty status is never a reason to fail a dispatch). Covered by
assertions in `test/w4-isolate-board.test.ts`.

## Alternatives considered

- Each repo adds `.external-agent/` to its committed `.gitignore` itself.
  Strongest reason: visible to every collaborator. Why rejected: repetitive
  per-repo toil for a directory the hub chose; a tool that creates runtime state
  should keep it out of the way itself.
- Place worktrees outside the repo (sibling dirs). Strongest reason: nothing to
  ignore at all. Why rejected: breaks the fixed, scannable location the inventory
  line relies on; not worth a migration for a cosmetic concern.
- Committed `.git/info/exclude` equivalent via a tracked file: rejected — the
  whole point is that no tracked file changes.

## Consequences

- Parent checkouts stay clean by default; collaborators see nothing and need
  nothing.
- `.git/info/exclude` is invisible to `git status` users who never look there —
  accepted, since the directory is hub-owned runtime state.
