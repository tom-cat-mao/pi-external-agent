# SoL-Pi-inspired overhaul: archive, verify, templates, relay, isolation

Status: planned (contracts frozen via grill session 2026-09-19). Spec for Wave 1+ workers.

## Problem

External-agent answers are inlined into the coordinator transcript and replayed on
every later provider request (compare worst case ≈16k tokens once, then every turn).
Answers have no persistence layer (MAX_EVENTS ring, registry cleared on shutdown).
Verification costs coordinator turns. Worker-to-worker exchange routes through the
coordinator's most expensive channel. Parallel write tasks are refused by
validateDispatch without an isolation escape hatch.

## Decision

Ten frozen contracts:

1. **Answer archive (hub-side).** On settle, answers >4000 chars — or any answer
   matching the `## Summary` / `## Details` template structure — are written to
   `<session-dir>/external-agent/answers/<taskId>-turn<N>.md` (content-addressed,
   sha256 recorded, O_NOFOLLOW). Inline keeps: worker Summary section, else head/tail
   excerpt (~500 chars each, whole lines), plus handle line `ans_<hex12> | bytes |
   lines | sha256:8 | recall hint`. Full text also goes to `details` (TUI-only).
   Recall: `external_agent_status(taskId, offset)` — byte-offset paging, ≤16KB/400
   lines per page, returns next_offset/eof. No grep, no new tool. Write failure
   fails open to today's inline behavior with `archive unavailable` noted.
2. **verify param.** `external_agent_start/compare` accept `verify:{command,
   timeoutSeconds?}`. Caller command wins; absent that, a worker-declared command
   from `verify-report` template is used. Hub runs it via `pi.exec` post-settle;
   receipt gets exit code + truncated output. No rollback, no semantic judgment.
3. **Templates.** Data files; lookup: `.pi/external-agent/templates/` (project) >
   `~/.pi/agent/external-agent/templates/` > builtin `templates/`. Injected once at
   startTask entry: header (role/rules) / task text / footer (output contract +
   anchors — anchors always at tail). Opt-in via `template` param. All five ship
   across waves: evidence-research, verify-report, review-report, relay-envelope,
   board-entry. Receipt records `template@version`.
4. **Evidence rule.** Terminal consumption: trust summary, no checks. Propagation
   (relay/board/acceptance): details must carry anchors (path:line:quote); hub
   spot-checks mechanically (substring match against archived source). Free facts
   always captured: git pre-snapshot + post diff stat, exit codes, CLI-reported usage.
5. **Relay.** Hub injects an archived excerpt of A's answer into B's live session
   (steer if running, followUp if settled-alive, new-task prefix for oneshot CLIs —
   cost reported honestly). Coordinator sees: receipt + ~500-char excerpt + handle.
   Hop limit 2; excess refused.
6. **compare per-slot task.** `specs[].task?` optional; absent = shared task (today).
7. **Worktree isolation.** `isolate:true` → hub runs `git worktree add
   .external-agent/worktrees/<taskId>` + branch before spawn; worker cwd = worktree,
   unaware. Hub never merges, never auto-deletes. Settle receipt + status list carry
   a neutral inventory line (`retained worktrees: task-3(6d), …`, fold past 5).
8. **Thin prompt.** No new tools. Param descriptions one line each. Guidelines add a
   single capability-index line (~150 chars) pointing to `docs/capabilities.md`.
   New `test/prompt-surface-budget.test.ts`: total tool surface ≤ current + 800 chars.
9. **Meter.** Accumulate CLI self-reported usage (incl. `total_cost_usd` where the
   claude-family adapter already receives it) labeled "as reported by CLI, not
   billing". `/external_agent_stats` command dumps counters.
10. **Build waves.** W0 this spec. W1 parallel leaf modules in separate worktrees
    (artifacts.ts, templates.ts + templates, adapter meter) — no index.ts edits, so
    merges are disjoint. W2 index.ts wiring + tests green gate. W3 relay. W4 board +
    isolate. Acceptance gate per wave: `node --test` + `tsc --noEmit` + budgets.

## Alternatives considered

- `pi.on("context")` projection to rewrite history (SoL-Pi does this): rejected —
  destroys prefix cache from the edit point; we own our tools' outputs, so
  pack-at-write is strictly better.
- Worker-written report files as primary persistence: rejected as universal layer —
  readonly workers cannot write; kept as optional fast path for write tasks.
- New "report-writable" permission tier: rejected — unenforceable uniformly across
  CLI harnesses; hub archive gives the same persistence without touching adapters.
- Threshold-based worktree reminder: rejected by owner — always-on neutral inventory
  preferred; imperative wording avoided to defuse premature-cleanup pressure.
- Worktree-per-slice parallel builds editing index.ts concurrently: rejected — merge
  conflicts concentrate in the hub file; module-first slicing instead.
- Hub-side semantic scoring of compare answers: rejected — standing invariant, the
  extension reports mechanical facts; judgment stays with the coordinator.

## Consequences

- Long answers stop replaying; recall costs extra tool round-trips (bounded pages).
- Relay reduces coordinator visibility into worker exchange; mitigated by excerpt +
  hash + hop limit, not eliminated.
- Worktrees accumulate by design; inventory line makes garbage visible, owner deletes.
- Prompt surface grows ≤800 chars, enforced by test.
- Worker-side context waste remains out of reach; the only lever is smaller tasks.
