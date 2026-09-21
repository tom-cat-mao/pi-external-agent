# dsh: extension spawns opt out of dsh's session telemetry

## Problem

dsh collects session telemetry by default. Its shipped composition mounts
`@deepseek-ai/dsh-session-telemetry-otel` in `FEEDBACK_ONLY` mode: ordinary
activity captures nothing, but an explicit feedback event releases the session
log's canonical prefix — message content, tool arguments and results, the system
prompt and tool schemas, todo text, the session `cwd` — to
`https://harness-telemetry.deepseeksvc.com/v1/logs`, carrying the harness home's
anonymous user id (`$DSH_HOME/.anonymous-user-id`, a machine-local random UUID)
as the Resource `user.id`.

Extension runs are dsh processes the extension spawns, so they inherit that
default — and since [the shared-home decision](2026-09-21-dsh-shared-home-scoped-settings.md)
they run under the user's own `~/.dsh`: same profile composition, same session
store, same identity file. A feedback event raised inside an extension session
would upload under an identity the user set up for their own terminal, out of a
context they did not open. The data is theirs and the decision to send it is
ours; nothing about an extension dispatch needs the operator's telemetry
pipeline.

## Decision

- Every dsh spawn the extension makes carries `DSH_TELEMETRY_DISABLED=1` in its
  environment: the one-shot dispatch env (`src/adapters.ts`, beside
  `DSH_PERMISSION_MODE`), and the ACP dialect's `prepare` env
  (`src/drivers/index.ts`). Both merge over the inherited environment through
  `mergeSpawnEnv`, and the existing `DSH_HOME` deletion is untouched.
- One exported constant (`DSH_TELEMETRY_OPT_OUT`) feeds both sites, so the two
  transports cannot drift.
- The variable and its value semantics are verified from the installed launcher
  (dsh 0.1.5-rc.2), not from prose: `resolveTelemetryPatch` in
  `@deepseek-ai/dsh/lib/profile-boot-Dk-7KqJc.js` (the chunk the `bin.js`
  `case "profile"` path loads, i.e. every `dsh --profile <name>` — the entry both
  transports use) reads `process.env.DSH_TELEMETRY_DISABLED` while composing the
  profile and, for ANY non-empty value, appends
  `{ id: "session-telemetry-otel", disabled: true }` to the overlay stack LAST.
  `1`, `0` and `false` all disable — dsh's comment: a privacy switch prefers
  off-by-mistake — and empty or unset is the only "on".
  `@deepseek-ai/dsh-base/cordis.patch.yml` documents the same contract
  ("the launchers patch the row disabled; config cannot disable a row").
- Last position is load-bearing: the disable patch outranks the bundle layers,
  our own overlay, the profile patch, the home patch and any other `--patch`.
- Disabling the row mounts no telemetry service at all. That is a supported
  state — dsh documents "no telemetry service is mounted", and no plugin
  declares an injection on it — so no other row can fail on its absence.
- The switch rides in the spawn env, not in our overlay: it is launcher-level
  and adds no file to the user's shared home.
- Only the extension's spawns opt out. An interactive dsh in the user's
  terminal, their web UI and their own scripts keep their own setting.

## Alternatives considered

1. **Leave dsh's default alone.** Strongest reason: the user picked dsh and its defaults for their machine; `FEEDBACK_ONLY` captures nothing from ordinary activity, and an extension re-deciding a privacy default it was not asked about is its own presumption.
   Why rejected: an extension run is the extension's context, not the user's terminal — feedback raised inside one of our sessions uploads the session prefix under the shared home's identity, and "only explicit feedback uploads" is a guarantee a dsh upgrade can change under us.
2. **Ask the caller per dispatch (a parameter, or a user setting).** Strongest reason: the sharing preference is genuinely the user's to hold, and a knob avoids the extension deciding a privacy question for them.
   Why rejected: decision fatigue for a clear-cut default — the honest default is the one that does not leak, so the question would be noise on every dispatch with one defensible answer. Opting back in stays available later as an adapter parameter.
3. **Set `DSH_TELEMETRY_MODE=DISABLED` instead (the other documented switch).** Strongest reason: it is the row's own mode, documented in dsh's telemetry README (`DISABLED` constructs no coordinator, provider, processor or exporter), so it needs no reliance on the launcher's patch machinery.
   Why rejected: it is config on a row, so it binds only while that row's config survives composition — a higher-precedence layer replacing the row's whole config takes the mode with it. The launcher switch patches the row disabled after every layer, which is exactly why dsh's shipped comment says config cannot disable a row.
4. **Write the disable into our `--patch` overlay.** Strongest reason: one artifact already in the argv, no env coupling, and the anchor guard probes with that same overlay, so it would read the row's effect back from the config dump.
   Why rejected: the overlay is a file in the user's shared home that provisioning does not rewrite while it is present — a user or another tool can replace it, and the anchor guard merely warns about that. It would also fold a second row into the artifact whose single settings row the guard verifies, buying from a file what the launcher already offers as a spawn-level switch.
5. **Spawn env on both transports (chosen).** Strongest reason: the launcher reads it itself, it outranks every config layer, it covers every profile the extension boots without a file in the user's home, and one constant plus one env key per transport is the whole mechanism.
   Why rejected: nothing was — this is the decision. Its accepted cost is in the consequences below.

## Consequences

Benefit: no extension-spawned dsh run can upload session telemetry, whatever the
user's own dsh configuration, patch files or `.env` layers say — dsh's layered
`.env` only fills variables the process did not already have, so an inherited
`DSH_TELEMETRY_DISABLED=1` cannot be cleared. The user's interactive dsh is
untouched: the extension's policy lives in its own spawn env, not in their
settings.

Cost and consequences:

- (a) A caller cannot opt a run back into telemetry: the value is set
  unconditionally, overriding an ambient one. If that is ever wanted, it becomes
  an adapter parameter — and that is a deliberate, reviewed change rather than a
  side effect of an ambient variable.
- (b) The switch is read by a hashed launcher chunk, so a dsh upgrade must
  re-verify it — grep the installed `@deepseek-ai/dsh/lib/profile-boot-*.js` for
  `DSH_TELEMETRY_DISABLED` and `session-telemetry-otel`, and add that to the
  upgrade smoke checklist in `docs/adapters.md`.
- (c) The composition anchor cannot see this: `resolveTelemetryPatch` runs in
  `runProfile`'s compose, and the `--dump-config` probe never calls it, so the
  opt-out is not readable from the existing dump and a future warning about it
  must not be assumed.
- (d) The opt-out is about our spawns only; it is not a claim about what the
  user's own dsh surfaces upload.
