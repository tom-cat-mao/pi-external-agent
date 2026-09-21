# dsh review fixes: credentials fork, home hygiene, honest counters

## Problem

Two reviewers accepted the dsh adapter with findings. The load-bearing one: `ensureDshHome()` links
the harness home's `.credentials.yaml` to the user's file, but dsh writes credentials through an
atomic rename whose documented behavior REPLACES a symlink with a real file
(verified in `@deepseek-ai/dsh-atomic-write`). After such a write the home holds its own copy that
drifts as credentials rotate, and the printed remedy no longer describes the state. Alongside it,
four smaller defects: provisioning could lose a race with a second pi process; the receipt's dsh
session policy promised fail-closed escalations for write/yolo, where the ACP driver allows them;
a refused dispatch was counted by the meter as a dispatch; and the routing note claimed a blast
radius wider than `JsonRpcConnection` has.

## Decision

- A credentials entry that is a REAL FILE is kept (never deleted — it may be the only working
  credentials) and reported: `ensureDshHome` returns a `warning` naming the file and the fix
  ("delete it to re-link"). The warning rides the existing non-fatal channel: `AdapterDispatch.warning`
  for the one-shot path, the ACP dialect `prepare` hook (renamed from `env`) for sessions, both
  landing as a task `warning` event. Every surface that reports a task carries it in the status
  report's wording — `external_agent_status`, the settle notice (`notifySettled`) and the
  `external_agent_wait` report — so a caller that never polls still learns of it.
- Provisioning tolerates the one race it can lose: on `EEXIST` it re-inspects the entry, and a
  correct link by then is the peer's success, not our failure (`linkDshCredentials`).
- The harness home is created `0o700` and forced back to `0o700` on every provisioning run (a
  best-effort chmod, never a failure: mkdir's mode is masked by the umask and an existing directory
  keeps its bits). A symlinked home path is provisioned through the link like dsh would use it, not
  refused — see the amendment below.
- The dsh session policy states fail-closed escalations for readonly only; write/yolo say the driver
  allows the escalations that tier permits, because that is what `AcpDriver.autoPermission` does.
- A dispatch refused via `AdapterDispatch.refusal` is not a dispatch: it is counted under the
  `adapter refusal` label (what `/external_agent_stats` prints under "refusals"), and
  `meter.recordDispatch` moved from `createTask` to the two start paths.
- Model forwarding is recorded in the dsh note as considered and deferred: the ACP `model`
  configOption exists, but its value is a JSON-stringified `[provider, model]` pair tied to provider
  ids, and the hub's model surface is free text with no catalog. No code change.
- The routing note's scope is corrected: `JsonRpcConnection`'s subclasses are codex app-server and
  ACP; pi-rpc and the two stream-json drivers extend `StdioProcess` and never matched replies
  through the pending table.
- Amended 2026-09-21 — the symlinked-home REFUSAL is dropped. Evidence: dsh's SAFETY.md documents no symlink or path hardening and disclaims being a security boundary, and `@deepseek-ai/dsh-home-paths` canonicalizes paths via realpath (configured path > `$DSH_HOME` > `~/.dsh`) with no symlink rejection, so the rule mirrored nothing of dsh's own model and its threat required an attacker who already owns the user's home directory. `ensureDshHome` now follows the link: mkdir is a no-op through it, the 0o700 fix reaches the linked directory, and nothing else changes.
- Amended 2026-09-21 — the missing-credentials REFUSAL was too strict and is now a best-effort
  link. Evidence against the hard prerequisite: a completely EMPTY `DSH_HOME` completes
  `dsh --profile headless` on the default deepseek-official route with zero credentials
  (verified 0.1.5-rc.2), a real user's `~/.dsh/.credentials.yaml` holds only a
  `client-connection/browser-session` record (the web UI's browser secret, not a provider key),
  and dsh reads project and user `.env` fallbacks. `ensureDshHome` therefore links when the source
  exists — fork behavior unchanged — and otherwise skips the link, SUCCEEDS, and returns
  `dshCredentialsMissingWarning` naming the remedy; an existing link of ours whose source went away
  is cleared rather than left dangling. Both start paths carry that warning through the channel
  above, never as a refusal, so such a dispatch is counted as a dispatch and not as a refusal.

## Alternatives considered

1. **Delete the local copy and re-link on sight.** Strongest reason: restores the single source of truth with no user action, so nothing can drift.
   Why rejected: it deletes user data — possibly the only credentials that still work, possibly a file dsh wrote a moment ago mid-migration. The warning names the same fix and leaves the decision with the owner.
2. **Fail provisioning when the entry is a real file.** Strongest reason: a hard failure cannot be ignored, and a stale copy is a correctness problem.
   Why rejected: the copy usually authenticates, so this breaks every dispatch over a state dsh itself creates; a warning is the honest middle, and the run still works.
3. **Copy the credentials into the harness home up front.** Strongest reason: the home is self-contained, and a copy is a plain file for both sides.
   Why rejected: it makes the drift the default instead of an accident, and the note's own alternative 3 already rejected copies for that reason.
4. **Retry provisioning from the top on `EEXIST`.** Strongest reason: one code path handles every failure, and the retry re-reads the world.
   Why rejected: a retry re-runs the source check and the unlink of a wrong link, so two racing processes could trade deletions; re-inspecting the single entry is both smaller and safer.
5. **Refuse a symlinked harness home (the original call).** Strongest reason: provisioning through a link writes dsh's settings and credentials wherever it points, outside the path this module could vouch for, and a real home is one `rm` plus one dispatch away.
   Why rejected: dsh's own model has no such hardening to mirror — SAFETY.md documents no symlink or path defense and explicitly disclaims being a security boundary, and `@deepseek-ai/dsh-home-paths` canonicalizes paths via realpath and resolves the home as configured path > `$DSH_HOME` > `~/.dsh` without rejecting links. The threat the refusal imagined required an attacker who already owned the user's home directory, while the legitimate "dotfiles symlinked to another volume" setup it broke is real.
6. **Keep counting refused dispatches, noting the refusal in the receipt.** Strongest reason: no meter change, and the task does exist in the registry.
   Why rejected: `/external_agent_stats` would report work that never ran; a refusal is precisely the case where the counter must not move.

## Consequences

Benefit: the receipt and the stats stay honest — a forked credentials file is visible with its fix on
every surface that reports the task, including the settle notice and the wait report, a refused
dispatch is counted as a refusal, and the dsh session policy claims fail-closed escalations only
where the driver provides them. Provisioning is race-safe against a second pi process, and the
harness home is owner-only — new or pre-existing — and a symlinked home path is followed rather than
refused, so a dotfiles layout pointing the home at another volume keeps working. Missing
credentials are a warning rather than a wall: only a provider key kept in that file makes the link
matter, so a user without one still dispatches, unlinked and counted as a dispatch.

Cost: a second way for credentials to live, plus an unlinked home to explain, both a warning to read
rather than a failure to fix; `AcpDialect`'s `env` hook became `prepare` returning env plus warning,
so a dialect with a start-time notice has a channel but also one more shape to fill; and the meter's
dispatch count now depends on the start paths calling `recordDispatch` rather than on task creation,
which the comment at `createTask` records.
