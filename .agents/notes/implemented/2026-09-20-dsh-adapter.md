# dsh: dedicated harness home, ACP sessions, refused one-shot effort

## Problem

dsh is the DeepSeek-native harness CLI. Wiring it as an adapter forced four decisions, because its defaults disagree with what a receipt must be able to claim:

1. A run under the user's shared `~/.dsh` is not bounded by the tier the hub asks for: dsh's own `~/.dsh/settings.yaml` carries `permission.defaultPreset`, and measurement against 0.1.5-rc.2 showed that key outranks both `DSH_PERMISSION_MODE` and a `--patch` overlay. A readonly task could still write while the receipt said otherwise.
2. The hub's effort check is adapter-level, but dsh splits effort by transport: the headless profile has no effort knob at all, while an ACP session sets one (`session/set_config_option`, configId `reasoning_effort`).
3. rc.2's headless profile has neither `--json` nor `--session-id`, so a one-shot run cannot be resumed — any session-shaped capability has to travel over ACP.
4. Credentials live in `~/.dsh/.credentials.yaml`, outside whatever home the adapter picks — and whether a run needs them at all is conditional, not a prerequisite: verified against 0.1.5-rc.2, a completely EMPTY `DSH_HOME` completes `dsh --profile headless` on the default deepseek-official route with no credentials, a real user's credentials file holds only the web UI's browser-session record rather than a provider key, and dsh reads project and user `.env` fallbacks too.

## Decision

- `ADAPTERS.dsh`: yolo default, readonly–yolo range, `enforcesReadOnly: true`, all seven effort levels, `session: { steer, followUp }`.
- Every spawn carries `DSH_HOME=~/.dsh-external-agent`, provisioned lazily and idempotently by `ensureDshHome()`, with `.credentials.yaml` symlinked to the user's own file.
  The link is BEST-EFFORT: a missing `~/.dsh/.credentials.yaml` links nothing, still succeeds, and returns a warning ("the default provider route or .env must carry auth (run `dsh web` once to manage credentials)") — the empty-home measurement above shows that file is simply not needed on the default route, so a hard prerequisite would block working runs. Provisioning still refuses when the home itself cannot be owned (a symlinked or unusable path), and the warning travels the non-fatal channel exactly like the fork warning: `AdapterDispatch.warning` on the one-shot path, the ACP dialect `prepare` hook for sessions, both landing as a task `warning` event.
- The tier travels as `DSH_PERMISSION_MODE` in codex's vocabulary, under a home where the composed defaults govern.
  Over ACP the driver also denies `session/request_permission` escalations, so readonly fails closed there too.
- Sessions run `dsh --profile acp`; a steer is a second `session/prompt` on the active session, and effort is forwarded over the protocol with `session/set_config_option`.
- An effort request on the one-shot path is REFUSED with `DSH_ONESHOT_EFFORT_REFUSAL`, never dropped.
- Model forwarding is a considered-and-deferred capability, not an oversight: dsh's ACP advertises a `model` configOption and `set_config_option` could carry it — the plumbing exists — but the value is a JSON-stringified `[provider, model]` pair tied to provider ids, while the hub's model surface is per-agent free text with no catalog to resolve against. v1 keeps `model` un-forwarded, and the receipt says so.
- That refusal, and the one-shot half of the adapter generally, is a contract rather than a live transport: `startTask` in `hub/registry.ts` picks the persistent driver for exactly the agents in `SESSION_DRIVERS` — with no fallback between the two — so dsh always runs over ACP, as reasonix, codebuddy, pi, codex, claude and qoder already do, and kimi is the only agent a one-shot spawn still reaches. `ADAPTERS.dsh`'s `buildDispatch`/`parseEvent` therefore run only under `test/dsh.test.ts`, which drives the hub's one-shot path by removing the driver entry; everything else on the adapter (bin, provider, mode and effort ranges, session policy) is what the persistent path reads.
- A dispatch that fails before it spawns — the refusal above, or a spawn that throws — is settled by its tool result: the task is marked settled without a push, so a later `session_start` cannot replay the failure as a notice after a /reload.
- The one-shot parse never invents progress: a bare `dsh: reasoning:` line parses to null instead of an empty reasoning event, which would count as meaningful and move the stall clock.
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
7. **Refuse a dispatch when the user has no credentials file yet (the original design).** Strongest reason: the file is what a signed-in user has, and a run that cannot authenticate fails mid-task in a way the caller cannot attribute.
   Why rejected: an empty home was measured to complete a headless run on the default provider route, and the real file may hold only the web UI's browser session — so the refusal blocked working runs over a file that is not universally required. The warning carries the same remedy without losing the dispatch.

## Consequences

Benefit: the receipt is honest on all three axes — the tier binds through dsh's own sandbox, effort is either forwarded inside a session or refused outside one, and readonly holds over ACP because the driver answers escalation requests itself.
Sign-in stays in one place, and a user whose credentials file is absent is warned — with `dsh web` and the `.env` / default-route fallbacks named — instead of being blocked from dispatching at all.

Cost: a second harness home to explain and keep working, and a one-shot half with no live caller, which ages on its own test coverage alone; pinning the session contract also exposed a shared JSON-RPC framing defect, fixed for every dialect in [2026-09-20-jsonrpc-method-first-routing.md](2026-09-20-jsonrpc-method-first-routing.md); the link to the user's credentials is conditional in two ways — it is skipped (warning, not failure) when there is no credentials file to link, and dsh's atomic credential write replaces a symlink with a real file, so the harness home can end up holding a local copy that drifts as credentials rotate, which provisioning keeps (never deleting what may be the only working credentials) and warns about with the delete-to-re-link fix; dsh moves fast (22 versions in six weeks), so the adapter is pinned in documentation to a verified release with a smoke checklist rather than a version range; and when `--json`/`--session-id` land for the headless profile, the one-shot parse must move to NDJSON.
