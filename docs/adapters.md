# Adapters

Generated from `ADAPTERS` in `src/adapters.ts` — update both together.

All eight agents share one dispatch path; the matrix records what each forwards. An omitted `mode` takes the adapter default; an out-of-range request is refused.

| Agent | Provider (`bin`) | Default | Mode range | Read-only enforced | Effort levels | Steer | Follow-up | Degraded |
|---|---|---|---|---|---|---|---|---|
| `codex` | OpenAI (`codex`) | yolo | readonly–yolo | yes — `--sandbox read-only` | off, minimal–xhigh | yes | yes | — |
| `pi` | pi itself (`pi`) | yolo | readonly–yolo | yes — `--tools read,grep,find,ls` | off–max | yes | yes | — |
| `kimi` | Moonshot (`kimi`) | yolo | yolo only (`minMode: "yolo"`) | no | none (requests refused) | no | no | — |
| `codebuddy` | Tencent (`codebuddy`) | yolo | readonly–yolo | best-effort — `default` + `--settings` rules + PreToolUse Bash hook | minimal–max (no off) | yes | yes | — |
| `claude` | Anthropic (`claude`) | yolo | readonly–yolo | yes — `dontAsk` + driver-denied `can_use_tool` (stream-json) | low–max | yes | yes | fixture-tested only |
| `reasonix` | DeepSeek-native (`reasonix`) | yolo | readonly–yolo | yes — `--permission-mode manual` | off–max | yes | yes | — |
| `qoder` | Alibaba (`qodercli`) | yolo | readonly–yolo | yes — `dont_ask` + built-in tool allowlist | off, low–max (no minimal) | yes, version-gated | yes | — |
| `dsh` | DeepSeek harness (`dsh`) | yolo | readonly–yolo | yes — dsh sandbox via `DSH_PERMISSION_MODE` in a dedicated `DSH_HOME`; ACP escalation driver-denied | off–max, session-only (one-shot refused) | yes | yes | — |

`enforcesReadOnly` is `false` only for kimi; `degraded` marks a callable-but-known-degraded upstream (claude is fixture-tested only). Without a sandbox, `write`/`yolo` are permission-rule tiers, not an OS boundary; a readonly hook is a heuristic filter.

## kimi: yolo-only enforcement

`kimi-code` rejects every permission flag alongside `-p`, so a headless run always executes under `default_permission_mode` from `~/.kimi-code/config.toml`; `minMode: "yolo"` refuses the tiers that would carry no enforcement, and an `effort` request is refused because no reasoning-effort control exists.

## qoder: steering version gate

Qoder is driven over its documented stream-json channel; a steer is sent only when the announced `qodercli_version` is a stable release ≥ 1.1.49, the documented SDK baseline. Anything else — missing, malformed, prerelease, older — makes `external_agent_steer` refuse with the reported version, while start, status, follow-up and stop keep working. Details: [qoder.md](qoder.md).

## dsh: dedicated harness home

Every dsh spawn carries `DSH_HOME=~/.dsh-external-agent`, provisioned lazily by `ensureDshHome()` (0o700; symlinked homes are refused), with `.credentials.yaml` symlinked to the user's own file. The home is load-bearing: `~/.dsh/settings.yaml`'s `permission.defaultPreset` outranks `DSH_PERMISSION_MODE` and `--patch` alike, so the shared home would leave the requested tier unenforced. dsh's atomic credential write replaces the symlink with a real file, so the home can hold a local credentials copy that drifts as credentials rotate; provisioning keeps it and warns, naming the file to delete and re-link. An unsigned-in user gets the `dsh web` instruction.

Effort travels only over ACP (`session/set_config_option`, configId `reasoning_effort`); the one-shot profile has no knob, so such a request is refused rather than dropped.

Verified against dsh 0.1.5-rc.2; upgrades re-run the smoke checklist (headless text/exit code, ACP handshake, `set_config_option`, read-only write denial). One-shot answers are plain stdout; the parse moves to NDJSON when `--json`/`--session-id` arrive.

## Permission mappings

- codex: `--sandbox read-only` / `workspace-write` / `danger-full-access`.
- pi: readonly restricts `--tools`; with no sandbox, write and yolo are equivalent.
- codebuddy: `default` + `--settings` (readonly) / `acceptEdits` / `bypassPermissions`.
- claude: `dontAsk` / `acceptEdits` / `bypassPermissions` over stream-json; a readonly turn also denies `can_use_tool` in the driver.
- reasonix: `manual` / `acceptEdits` / `bypassPermissions` (deny rules and the OS sandbox still apply).
- qoder: `dont_ask` + built-in allowlist / `accept_edits` / `bypass_permissions`.
- dsh: `DSH_PERMISSION_MODE=read-only` / `workspace-write` / `danger-full-access` (codex vocabulary) in the harness home.
