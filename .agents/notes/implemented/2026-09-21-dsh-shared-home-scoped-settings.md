# dsh: shared home, scoped settings document

## Problem

The dsh adapter gave every spawn a dedicated `DSH_HOME` (`~/.dsh-external-agent`), because
`~/.dsh/settings.yaml`'s `permission.defaultPreset` outranks `DSH_PERMISSION_MODE` and
`--patch` — measured on 0.1.5-rc.2 and recorded in
[2026-09-20-dsh-adapter.md](2026-09-20-dsh-adapter.md) and
[2026-09-20-dsh-credentials-fork-and-refusal-integrity.md](2026-09-20-dsh-credentials-fork-and-refusal-integrity.md).
The price was the user's own configuration: profiles, plugins, credentials and session
store all live in `~/.dsh`, so extension sessions ran in a second, empty home with none of
it — no user plugins, no Models-page preferences, our own credentials link to maintain and
a fork warning whenever dsh's atomic write replaced it. The only reason for that design was
that the tier would not bind under a shared home; verified live on 0.1.5-rc.2, it does.

## Decision

- dsh runs against the shared `~/.dsh` — the user's own profiles, plugins, credentials and session store.
- `~/.dsh` itself is created when it is absent: the overlay has nowhere to live otherwise, and an existing home is left exactly as it is. dsh then records its own composition per profile inside it (`<profile>/cordis.yml`, materialized on a profile's first dispatch) — dsh's file in dsh's home, not extension state.
- Every spawn carries `--patch ~/.dsh/cordis.patch.pi-external-agent.yml`, a static overlay whose only entry re-points the settings plugin's document:

```yaml
- id: settings
  config:
    path: ~/.dsh/settings.pi-external-agent.yaml
```

- That document is provisioned empty when missing and NEVER overwritten.
- Both names are reserved for our two files, so a symlink at either is REPLACED, never followed: the settings document by an empty regular file, the overlay by a temp-file write plus rename (atomic, and it replaces the link). Following one would let a link we did not write decide what dsh reads — for the settings document, a file that may carry `permission.defaultPreset`.
- Session creation finds no `permission.defaultPreset` in our document, so the composed default governs and `DSH_PERMISSION_MODE` decides the tier per dispatch (readonly → `read-only`, write → `workspace-write`, yolo → `danger-full-access`), enforced mechanically by dsh's sandbox; over ACP, readonly is additionally fail-closed by the driver answering `session/request_permission`.
- Verified live against the user's real `~/.dsh`, preset `danger-full-access`: a read-only dispatch was denied by the sandbox, and the user's `settings.yaml` was untouched.
- A best-effort anchor guard warns on status, wait and settle when the overlay lost effect, when a user profile or home patch replaced the sandbox/approval rows' env hook, or when our settings document gains a permission section. It probes once per profile, under the profile the spawn boots (`headless` for a one-shot run, `acp` for a session): dsh composes base → profile → home → `--patch`, so one profile's composition says nothing about the other's. A probe that cannot run warns (`dsh composition anchor unavailable: …`) rather than passing for a clean composition, and is retried on the next dispatch.
- An ambient `DSH_HOME` exported in the user's shell is explicitly stripped from the child env.
- Provisioning refuses only when its two files — the overlay and the settings document — cannot be created.
- One-shot effort requests are still refused, never dropped: the `headless` profile has no effort knob.
- `src/dsh-home.ts` is renamed `src/dsh-launch.ts`.

## Alternatives considered

1. **Keep the dedicated home (the 2026-09-20 design this note supersedes).** Strongest reason: it isolates tier enforcement from whatever the user's `settings.yaml` says, and it was already measured, shipped and reviewed — the two notes above.
   Why rejected: it locked the user out of their own configuration — a second home with none of their profiles, plugins or sessions, plus a credentials link to maintain and a fork to explain. Its premise no longer holds: verified live, the tier binds under the shared home.
2. **Shared home, accept the user's preset, refuse a requested tier that differs (kimi-style).** Strongest reason: honest without writing anything of the user's — the receipt claims only what their preset enforces, and kimi already establishes the refusal pattern for tiers carrying no enforcement.
   Why rejected: the extension's tiers would follow web-UI clicks — a readonly dispatch refused because the user's page says `danger-full-access`, or a yolo dispatch silently downgraded — and two concurrent dispatches at different tiers become impossible.
3. **Mutate the user's `settings.yaml` per dispatch (set the preset, run, restore).** Strongest reason: the user's own document stays the single source of truth for the tier, so no second settings document exists to drift.
   Why rejected: racy and intrusive — a concurrent dsh run or the user's own web UI observes the mutated file, and a crash between write and restore leaves their preference changed.
4. **Re-point the settings plugin's document through `--patch` (chosen).** Strongest reason: dsh's official settings-file `path` option plus `--patch` precedence lets the composed default decide the tier without touching the user's file — verified live on 0.1.5-rc.2, where the real `~/.dsh` had `danger-full-access` and a readonly dispatch was still denied.
   Why rejected: nothing was — this is the decision. Its accepted cost is in the consequences below.

## Consequences

Benefit: extension sessions are the user's own — profiles, plugins, credentials and session
store — with no second home to provision and no credential link to keep. The receipt stays
honest: `DSH_PERMISSION_MODE` binds through dsh's sandbox, escalation stays driver-denied
under readonly over ACP, and the user's `settings.yaml` is never touched.

Cost and consequences:

- (a) The user's `settings.yaml` is never read by extension runs: Models-page provider profiles and other settings-document preferences do not apply. Credentials-file providers and the default DeepSeek route do.
- (b) Plugins install per-profile: a plugin added to the web profile is not visible to the `acp`/`headless` profiles the extension boots. Share one with `dsh plugin --profile acp add <pkg>`.
- (c) Extension sessions land in the shared session store, visible to the user's dsh surfaces.
- (d) The anchor guard is best-effort, not a boundary: a user profile or home patch that replaces the sandbox/approval rows' env hook, or a `permission` section someone adds to our settings document, is reported on status, wait and settle rather than prevented — and a machine where the probe cannot run reports that instead of reporting nothing.
- (e) A `DSH_HOME` exported in the user's shell cannot silently re-route a spawn: it is stripped from the child env.
- (f) A provisioning failure is a refusal — a run never falls back to the user's preset with a receipt that claims otherwise.
- (g) `~/.dsh-external-agent`, left by the previous design, is inert user data the extension does not reference; users may delete it.
