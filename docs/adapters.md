# Adapters

Generated from `ADAPTERS` in `src/adapters.ts`; update both.

All eight agents share one dispatch path; `mode` defaults when omitted, out-of-range is refused.

| Agent | Provider (`bin`) | Default | Modes | Read-only | Effort | Steer | Follow-up | Degraded |
|---|---|---|---|---|---|---|---|---|
| `codex` | OpenAI (`codex`) | yolo | readonly–yolo | yes: `--sandbox read-only` | off, minimal–xhigh | yes | yes | — |
| `pi` | pi itself (`pi`) | yolo | readonly–yolo | yes: `--tools read,grep,find,ls` | off–max | yes | yes | — |
| `kimi` | Moonshot (`kimi`) | yolo | yolo only (`minMode: "yolo"`) | no | none (refused) | no | no | — |
| `codebuddy` | Tencent (`codebuddy`) | yolo | readonly–yolo | best-effort: `default` + `--settings` + PreToolUse Bash hook | minimal–max (no off) | yes | yes | — |
| `claude` | Anthropic (`claude`) | yolo | readonly–yolo | yes: `dontAsk` + driver-denied `can_use_tool` | low–max | yes | yes | fixture-tested only |
| `reasonix` | DeepSeek-native (`reasonix`) | yolo | readonly–yolo | no pinned tier: driver-rejected prompts confine ≤1.38.7; fail-open from ≥1.38.8 | off–max | yes | yes | — |
| `qoder` | Alibaba (`qodercli`) | yolo | readonly–yolo | yes: `dont_ask` + built-in tool allowlist | off, low–max (no minimal) | yes, version-gated | yes | — |
| `dsh` | DeepSeek harness (`dsh`) | yolo | readonly–yolo | yes: dsh sandbox via `DSH_PERMISSION_MODE` over a scoped settings document; ACP escalation driver-denied | off–max, session-only (one-shot refused) | yes | yes | — |

`enforcesReadOnly` is `false` only for kimi; `degraded` marks a known-degraded upstream. Without a sandbox, `write`/`yolo` are permission-rule tiers, not an OS boundary; a readonly hook is heuristic.

## kimi: yolo-only enforcement

`kimi-code` rejects permission flags alongside `-p`, so headless runs execute under `default_permission_mode` from `~/.kimi-code/config.toml`; `minMode: "yolo"` refuses unenforced tiers, and `effort` is refused — no control exists.

## reasonix: readonly version boundary

`reasonix acp` (the only production path) rejects `--permission-mode`, so nothing pins the tier: readonly rests on the driver rejecting `session/request_permission`. Through v1.38.7 `session/new` boots in `Ask`, so writes and bash calls prompt and get rejected — effective. From v1.38.8 (commit 4daa815be) it hardcodes `workspace-write`, so in-workspace writes and writer bash run unprompted and readonly silently stops confining; outside-workspace writes and the bash Seatbelt sandbox still bound it. The `tool_approval` vocabulary changed at that boundary: tier pinning must capability-negotiate from `session/new`'s `configOptions`.

## qoder: steering version gate

Qoder is driven over its documented stream-json channel; a steer requires an announced stable `qodercli_version` ≥ 1.1.49, the documented SDK baseline. Missing, malformed, prerelease or older versions make `external_agent_steer` refuse, reporting the version, while start, status, follow-up and stop keep working. Details: [qoder.md](qoder.md).

## dsh: shared home, scoped settings

dsh runs against the user's own `~/.dsh`, where `settings.yaml`'s `permission.defaultPreset` outranks `DSH_PERMISSION_MODE` and a higher-precedence patch replaces a row's whole config, so every spawn carries `--patch` re-pointing the settings plugin's document at `~/.dsh/settings.pi-external-agent.yaml`: empty when missing and preset-free, the composed default governs, `DSH_PERMISSION_MODE` picking the tier and dsh's sandbox enforcing it. A shell-exported `DSH_HOME` is stripped from the child env; every extension spawn carries `DSH_TELEMETRY_DISABLED`, dsh's telemetry opt-out. Details: [dsh.md](dsh.md).

## Permission mappings

- codex: `--sandbox read-only`/`workspace-write`/`danger-full-access`.
- pi: readonly restricts `--tools`; with no sandbox, write and yolo are equivalent.
- codebuddy: `default` + `--settings` (readonly)/`acceptEdits`/`bypassPermissions`.
- claude: `dontAsk`/`acceptEdits`/`bypassPermissions` over stream-json; readonly also denies `can_use_tool` in the driver.
- reasonix (`acp` pins no tier): `manual`/`acceptEdits`/`bypassPermissions`; deny rules and the OS sandbox still apply.
- qoder: `dont_ask` + built-in allowlist/`accept_edits`/`bypass_permissions`.
- dsh: `DSH_PERMISSION_MODE=read-only`/`workspace-write`/`danger-full-access` (codex vocabulary); readonly fail-closed over ACP.
