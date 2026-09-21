# Adapters

Generated from `ADAPTERS` in `src/adapters.ts`; update both.

All eight agents share one dispatch path; an omitted `mode` takes its default, out-of-range is refused.

| Agent | Provider (`bin`) | Default | Modes | Read-only | Effort | Steer | Follow-up | Degraded |
|---|---|---|---|---|---|---|---|---|
| `codex` | OpenAI (`codex`) | yolo | readonly–yolo | yes: `--sandbox read-only` | off, minimal–xhigh | yes | yes | — |
| `pi` | pi itself (`pi`) | yolo | readonly–yolo | yes: `--tools read,grep,find,ls` | off–max | yes | yes | — |
| `kimi` | Moonshot (`kimi`) | yolo | yolo only (`minMode: "yolo"`) | no | none (refused) | no | no | — |
| `codebuddy` | Tencent (`codebuddy`) | yolo | readonly–yolo | best-effort: `default` + `--settings` + PreToolUse Bash hook | minimal–max (no off) | yes | yes | — |
| `claude` | Anthropic (`claude`) | yolo | readonly–yolo | yes: `dontAsk` + driver-denied `can_use_tool` | low–max | yes | yes | fixture-tested only |
| `reasonix` | DeepSeek-native (`reasonix`) | yolo | readonly–yolo | no pinned tier: driver-rejected prompts confine ≤1.38.7; fail-open from ≥1.38.8 | off–max | yes | yes | — |
| `qoder` | Alibaba (`qodercli`) | yolo | readonly–yolo | yes: `dont_ask` + built-in tool allowlist | off, low–max (no minimal) | yes, version-gated | yes | — |
| `dsh` | DeepSeek harness (`dsh`) | yolo | readonly–yolo | yes: dsh sandbox via `DSH_HOME`/`DSH_PERMISSION_MODE`; ACP escalation driver-denied | off–max, session-only (one-shot refused) | yes | yes | — |

`enforcesReadOnly` is `false` only for kimi; `degraded` marks a known-degraded upstream. Without a sandbox, `write`/`yolo` are permission-rule tiers, not an OS boundary; a readonly hook is heuristic.

## kimi: yolo-only enforcement

`kimi-code` rejects permission flags alongside `-p`, so headless runs execute under `default_permission_mode` from `~/.kimi-code/config.toml`; `minMode: "yolo"` refuses unenforced tiers, and `effort` is refused — no control exists.

## reasonix: readonly version boundary

`reasonix acp` (the only production path) rejects `--permission-mode`, so nothing pins the tier: readonly rests on the driver rejecting `session/request_permission`. Through v1.38.7 `session/new` boots in `Ask`, so writes and bash calls prompt and get rejected — effective. From v1.38.8 (commit 4daa815be) it hardcodes `workspace-write`, so in-workspace writes and writer bash run unprompted and readonly silently stops confining; outside-workspace writes and the bash Seatbelt sandbox still bound it. The `tool_approval` vocabulary changed at that boundary: tier pinning must capability-negotiate from `session/new`'s `configOptions`.

## qoder: steering version gate

Qoder is driven over its documented stream-json channel; a steer requires an announced stable `qodercli_version` ≥ 1.1.49, the documented SDK baseline. Missing, malformed, prerelease or older versions make `external_agent_steer` refuse, reporting the version, while start, status, follow-up and stop keep working. Details: [qoder.md](qoder.md).

## dsh: dedicated harness home

Every dsh spawn carries `DSH_HOME=~/.dsh-external-agent`, provisioned lazily by `ensureDshHome()` (0o700). The home is load-bearing: `permission.defaultPreset` in `~/.dsh/settings.yaml` outranks `DSH_PERMISSION_MODE` and `--patch`, so a shared home leaves the tier unenforced. Credentials: `~/.dsh/.credentials.yaml` is symlinked when present, warned about when absent; a copy left by dsh's atomic write is kept (delete-to-re-link warning). An empty home still completes a headless run on the default provider route because `.env` fallbacks carry auth; the file matters only for a provider key kept in it (`dsh web` manages it).

Effort travels only over ACP (`set_config_option`, `reasoning_effort`); the one-shot profile has no knob and refuses it.

Verified on 0.1.5-rc.2; upgrades re-run the smoke checklist (headless text/exit code, ACP handshake, `set_config_option`, readonly denial). One-shot answers are plain stdout, NDJSON once `--json`/`--session-id` land.

## Permission mappings

- codex: `--sandbox read-only`/`workspace-write`/`danger-full-access`.
- pi: readonly restricts `--tools`; with no sandbox, write and yolo are equivalent.
- codebuddy: `default` + `--settings` (readonly)/`acceptEdits`/`bypassPermissions`.
- claude: `dontAsk`/`acceptEdits`/`bypassPermissions` over stream-json; readonly also denies `can_use_tool` in the driver.
- reasonix (`acp` pins no tier): `manual`/`acceptEdits`/`bypassPermissions`; deny rules and the OS sandbox still apply.
- qoder: `dont_ask` + built-in allowlist/`accept_edits`/`bypass_permissions`.
- dsh: `DSH_PERMISSION_MODE=read-only`/`workspace-write`/`danger-full-access` (codex vocabulary) in the harness home.
