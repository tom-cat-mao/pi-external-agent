# Adapters

Generated from `ADAPTERS` in `src/adapters.ts`; update both.

All eight agents share one dispatch path; an omitted `mode` takes its default, out-of-range is refused.

| Agent | Provider (`bin`) | Default | Modes | Read-only | Effort | Steer | Follow-up | Degraded |
|---|---|---|---|---|---|---|---|---|
| `codex` | OpenAI (`codex`) | yolo | readonly–yolo | yes: `--sandbox read-only` | off, minimal–xhigh | yes | yes | — |
| `pi` | pi itself (`pi`) | yolo | readonly–yolo | yes: `--tools read,grep,find,ls` | off–max | yes | yes | — |
| `kimi` | Moonshot (`kimi`) | yolo | yolo only (`minMode: "yolo"`) | no | none (refused) | no | no | — |
| `codebuddy` | Tencent (`codebuddy`) | yolo | readonly–yolo | best-effort: `default` + `--settings` + PreToolUse Bash hook | minimal–max (no off) | yes | yes | — |
| `claude` | Anthropic (`claude`) | yolo | readonly–yolo | yes: `dontAsk` + driver-denied `can_use_tool` (stream-json) | low–max | yes | yes | fixture-tested only |
| `reasonix` | DeepSeek-native (`reasonix`) | yolo | readonly–yolo | yes: `--permission-mode manual` | off–max | yes | yes | — |
| `qoder` | Alibaba (`qodercli`) | yolo | readonly–yolo | yes: `dont_ask` + built-in tool allowlist | off, low–max (no minimal) | yes, version-gated | yes | — |
| `dsh` | DeepSeek harness (`dsh`) | yolo | readonly–yolo | yes: dsh sandbox via `DSH_PERMISSION_MODE` over a shared `~/.dsh` with a scoped settings document; ACP escalation driver-denied | off–max, session-only (one-shot refused) | yes | yes | — |

`enforcesReadOnly` is `false` only for kimi; `degraded` marks a known-degraded upstream. Without a sandbox, `write`/`yolo` are permission-rule tiers, not an OS boundary; a readonly hook is heuristic.

## kimi: yolo-only enforcement

`kimi-code` rejects permission flags alongside `-p`, so headless runs under `default_permission_mode` from `~/.kimi-code/config.toml`; `minMode: "yolo"` refuses unenforced tiers, and `effort` is refused — no control exists.

## qoder: steering version gate

Qoder is driven over its documented stream-json channel; a steer requires an announced stable `qodercli_version` ≥ 1.1.49, the SDK baseline; missing, malformed, prerelease or older versions make `external_agent_steer` refuse with the reported version, while start, status, follow-up and stop keep working. Details: [qoder.md](qoder.md).

## dsh: shared home, scoped settings

dsh runs against the user's own `~/.dsh` (profiles, plugins, credentials, sessions), but `settings.yaml`'s `permission.defaultPreset` outranks `DSH_PERMISSION_MODE` and `--patch`. Every spawn carries `--patch ~/.dsh/cordis.patch.pi-external-agent.yml`, a static overlay re-pointing the settings plugin's document (`- id: settings`, `config.path: ~/.dsh/settings.pi-external-agent.yaml`). Empty when missing and never overwritten, it holds no `permission.defaultPreset`, so the composed default governs: `DSH_PERMISSION_MODE` picks the tier and dsh's sandbox enforces it.

Consequences: `settings.yaml` is never read, so Models-page providers and other settings-document preferences do not apply (credentials-file providers and the default DeepSeek route still do); plugins install per-profile: `dsh plugin --profile acp add <pkg>` shares a web-profile plugin with the `acp`/`headless` profiles the extension boots; sessions land in the shared store, visible to the user's dsh surfaces. A best-effort anchor guard warns (status, wait, settle) when the overlay lost effect, a user profile/home patch replaced the sandbox/approval rows' env hook, or our settings document gained a permission section. A shell-exported `DSH_HOME` is stripped from the child env.

Effort travels only over ACP (`session/set_config_option`, configId `reasoning_effort`); one-shot it is refused, never dropped. Verified on 0.1.5-rc.2: a readonly dispatch under a `danger-full-access` user preset was sandbox-denied, `settings.yaml` untouched; upgrades re-run the smoke checklist (headless text/exit code, ACP handshake, `set_config_option`, readonly denial). One-shot answers are plain stdout until `--json`/`--session-id` land, then NDJSON.

## Permission mappings

- codex: `--sandbox read-only`/`workspace-write`/`danger-full-access`.
- pi: readonly restricts `--tools`; with no sandbox, write and yolo are equivalent.
- codebuddy: `default` + `--settings` (readonly)/`acceptEdits`/`bypassPermissions`.
- claude: `dontAsk`/`acceptEdits`/`bypassPermissions` over stream-json; readonly also denies `can_use_tool` in the driver.
- reasonix: `manual`/`acceptEdits`/`bypassPermissions` (deny rules and the OS sandbox still apply).
- qoder: `dont_ask` + built-in allowlist/`accept_edits`/`bypass_permissions`.
- dsh: `DSH_PERMISSION_MODE=read-only`/`workspace-write`/`danger-full-access` (codex vocabulary) over the shared home; readonly fail-closed over ACP.
