# dsh: dedicated harness home, ACP sessions, refused one-shot effort

## Problem

dsh is the DeepSeek-native harness CLI. Wiring it as an adapter forced four decisions, because its defaults disagree with what a receipt must be able to claim:

1. A run under the user's shared `~/.dsh` is not bounded by the tier the hub asks for: dsh's own `~/.dsh/settings.yaml` carries `permission.defaultPreset`, and measurement against 0.1.5-rc.2 showed that key outranks both `DSH_PERMISSION_MODE` and a `--patch` overlay. A readonly task could still write while the receipt said otherwise.
2. The hub's effort check is adapter-level, but dsh splits effort by transport: the headless profile has no effort knob at all, while an ACP session sets one (`session/set_config_option`, configId `reasoning_effort`).
3. rc.2's headless profile has neither `--json` nor `--session-id`, so a one-shot run cannot be resumed — any session-shaped capability has to travel over ACP.
4. Every dispatch must be able to sign in, and credentials live in `~/.dsh/.credentials.yaml`, outside whatever home the adapter picks.

## Decision

- `ADAPTERS.dsh`: yolo default, readonly–yolo range, `enforcesReadOnly: true`, all seven effort levels, `session: { steer, followUp }`.
- Every spawn carries `DSH_HOME=~/.dsh-external-agent`, provisioned lazily and idempotently by `ensureDshHome()`, with `.credentials.yaml` symlinked to the user's own file.
  Missing credentials fail the dispatch with the `dsh web` instruction instead of spawning a home that cannot authenticate.
- The tier travels as `DSH_PERMISSION_MODE` in codex's vocabulary, under a home where the composed defaults govern.
  Over ACP the driver also denies `session/request_permission` escalations, so readonly fails closed there too.
- Sessions run `dsh --profile acp`; a steer is a second `session/prompt` on the active session, and effort is forwarded over the protocol with `session/set_config_option`.
- An effort request on the one-shot path is REFUSED with `DSH_ONESHOT_EFFORT_REFUSAL`, never dropped.
- Verified against 0.1.5-rc.2; each upgrade re-runs the smoke checklist (headless text plus exit code, ACP handshake, `set_config_option`, read-only write denial), because dsh ships often while its automation surface stays put.

## Alternatives considered

1. **Share the user's `~/.dsh` home.** Strongest reason: no provisioning, no second home to explain, and credentials are simply where dsh already looks.
   Why rejected: measured on 0.1.5-rc.2 — `settings.yaml`'s `permission.defaultPreset` outranks `DSH_PERMISSION_MODE` and `--patch`, so the requested tier would not bind and readonly receipts would be false.
2. **Per-run temporary homes.** Strongest reason: the strongest isolation — one run cannot see another's state, and a crash leaves nothing behind.
   Why rejected: it discards the session persistence and resume that the ACP transport exists for, and it re-solves credentials on every spawn.
3. **Copy the credentials file into the harness home.** Strongest reason: no symlink to maintain, and the harness home is self-contained if the user's file moves.
   Why rejected: a copy drifts as the token rotates, leaving a stale credential that fails in a way nobody can attribute; the symlink keeps one source of truth.
4. **Enforce readonly in the prompt only.** Strongest reason: no harness home and no env var — the adapter could stay as simple as the flag spelling.
   Why rejected: it violates the mechanical-enforcement invariant; a prompt-level request is a suggestion, and the receipt would claim a boundary that does not exist.
5. **Drive dsh one-shot only.** Strongest reason: one transport for the whole adapter, one parse path, nothing to keep alive.
   Why rejected: rc.2's headless profile has no `--json`/`--session-id`, so there is no resume, no steer, no follow-up and no effort knob — the adapter would forfeit everything the hub's session tools exist for.
6. **Silently drop an effort request on the one-shot path.** Strongest reason: the task still runs, and effort is advisory rather than a permission, so a refusal costs the caller a dispatch.
   Why rejected: a dropped override misleads the caller about the run's cost (the rule `hub/registry.ts` already applies to unsupported efforts); the refusal names both escapes — drop effort, or use the persistent session.

## Consequences

Benefit: the receipt is honest on all three axes — the tier binds through dsh's own sandbox, effort is either forwarded inside a session or refused outside one, and readonly holds over ACP because the driver answers escalation requests itself.
Sign-in stays in one place, and an unsigned-in user is told to run `dsh web` instead of hitting an authentication failure mid-task.

Cost: a second harness home to explain and keep working; dsh moves fast (22 versions in six weeks), so the adapter is pinned in documentation to a verified release with a smoke checklist rather than a version range; and when `--json`/`--session-id` land for the headless profile, the one-shot parse must move to NDJSON.
