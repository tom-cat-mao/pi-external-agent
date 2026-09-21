# dsh

The current contract for the `dsh` harness, which runs against the user's own `~/.dsh`.

## Shared home

dsh runs against the user's own `~/.dsh` (profiles, plugins, credentials, sessions), but `settings.yaml`'s `permission.defaultPreset` outranks `DSH_PERMISSION_MODE`, and a higher-precedence patch only ever replaces a row's whole config — re-pointing the settings row, not editing permission keys. Every spawn carries `--patch` with the absolute `~/.dsh/cordis.patch.pi-external-agent.yml`, a static overlay re-pointing the settings plugin's document (`- id: settings`, `config.path` at the absolute `~/.dsh/settings.pi-external-agent.yaml`). Empty when missing and never overwritten, it holds no preset, so the composed default governs: `DSH_PERMISSION_MODE` picks the tier and dsh's sandbox enforces it.

## Consequences

`settings.yaml` is never read, so Models-page providers and other settings-document preferences do not apply (credentials-file providers still do); plugins install per-profile: `dsh plugin --profile acp add <pkg>` shares one with the `acp`/`headless` profiles the extension boots; sessions land in the shared store. A best-effort anchor guard probes each profile (`headless`, `acp`) and warns (status, wait, settle) when the overlay lost effect, a user patch replaced the sandbox/approval env hook, or our document gained a permission section. A shell-exported `DSH_HOME` is stripped from the child env. Telemetry is the composition's to decide and the extension sets no telemetry variable, so a user who wants dsh's session telemetry off disables the row in their own layer (`- id: session-telemetry-otel` with `disabled: true` in `~/.dsh/cordis.patch.yml`).

## Effort and verification

Effort travels only over ACP (`session/set_config_option`, configId `reasoning_effort`); one-shot it is refused, never dropped. Verified on 0.1.5-rc.2: a readonly dispatch under a `danger-full-access` user preset was sandbox-denied, `settings.yaml` untouched; upgrades re-run the smoke checklist (headless text/exit code, ACP handshake, `set_config_option`, readonly denial). One-shot answers are plain stdout until `--json`/`--session-id` land, then NDJSON.
