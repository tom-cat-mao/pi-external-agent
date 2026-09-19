# Isolate (git worktree) + board (compare evidence) — W4

## Problem

Parallel write tasks in one directory are refused by `validateDispatch`, with no
escape hatch — so grouped implementation work was impossible. And compare results
lived only in the transcript: once judged, nothing durable remained for a later
wave to build on. Contracts 7 and 4 (free facts) in
`.agents/notes/planned/2026-09-19-sol-pi-inspired-overhaul.md`.

## Decision

**Isolate.** `isolate: true` on start/compare: hub runs `git rev-parse` then
`git worktree add <repo>/.external-agent/worktrees/<taskId> -b ea-<taskId>` via
`execFile` (not `pi.exec` — hub-internal plumbing, testable with real git), and
dispatches with the worktree as cwd. Task ids are allocated before creation so a
refused dispatch never leaves a worktree behind. The hub never merges and never
deletes; failure cleanup runs `worktree remove --force` **only when the path did
not exist before this call** (a retained same-id worktree is never touched).
Settle finalize collects `diff --stat HEAD` + porcelain count. Status and settle
notices carry a neutral `retained worktrees:` inventory (oldest 3 past five).
Known consequence: task ids restart per session while worktrees persist, so a
repeated id fails the add and refuses with git's own words — no reuse, no delete.

**Board.** compare gains `board?: string`: explicit path, else
`<session-dir>/external-agent/board.jsonl`, `""` disables. Each settled slot
appends one JSONL row at finalize time (so post-timeout settles still land):
`{ts, taskId, agent, mode, claim, anchors, answerRef, answerSha256,
status:"unverified", supersedes:null}`, aligned with `templates/board-entry.md`.
The report ends with a digest line; write failure degrades to
`board: unavailable (<reason>)`, never failing the compare.

## Alternatives considered

- Auto-merge or auto-clean on settle: strongest reason — worktrees pile up
  otherwise. Rejected: merge/cleanup are semantic calls (the diff may be garbage);
  the inventory line keeps accumulation visible instead.
- pi.exec for git: strongest reason — one execution path. Rejected: pi.exec is the
  host shell for user-facing verify; git plumbing must work in stubbed hosts
  (tests) where pi.exec is absent.
- Board written at report time: strongest reason — one write site. Rejected:
  slots settling after a timeout would never land on the board.
- Prompt-surface room by raising the 8900 budget: rejected — two one-line param
  descriptions were fitted by compressing older wording (effort/status/wait/steer/
  follow_up), keeping every phrase `test/effort.test.ts` pins.

## Consequences

- Grouped parallel writes are now possible without weakening the same-directory
  guard; each writer simply gets its own directory.
- Worktree garbage is visible but never auto-collected — deletion is the owner's.
- Board rows are unverified claims by construction; promotion happens only through
  verify runs or caller judgment.
