# Adapters

Generated from `ADAPTERS` in `src/adapters.ts`; update both.

All eight agents share one dispatch path; an omitted `mode` takes its default, out-of-range is refused.

| Agent | Provider (`bin`) | Default | Modes | Read-only | Effort | Steer | Follow-up | Degraded |
|---|---|---|---|---|---|---|---|---|
| `codex` | OpenAI (`codex`) | yolo | readonly–yolo | yes: `--sandbox read-only` | off, minimal–xhigh | yes | yes | — |
| `pi` | pi itself (`pi`) | yolo | readonly–yolo | yes: `--tools read,grep,find,ls` | off–max | yes | yes | — |
| `kimi` | Moonshot (`kimi`) | yolo | readonly–yolo | yes: plan-mode guard vetoes Write/Edit + driver-rejected prompts | off–max, session-only (one-shot refused) | no | yes | — |
| `codebuddy` | Tencent (`codebuddy`) | yolo | readonly–yolo | best-effort: `default` + `--settings` + PreToolUse Bash hook | minimal–max (no off) | yes | yes | — |
| `claude` | Anthropic (`claude`) | yolo | readonly–yolo | yes: `dontAsk` mode denies what was not pre-approved | low–max | yes | yes | fixture-tested only |
| `reasonix` | DeepSeek-native (`reasonix`) | yolo | readonly–yolo | no pinned tier: driver-rejected prompts confine ≤1.38.7; fail-open from ≥1.38.8 | off–max | yes | yes | — |
| `qoder` | Alibaba (`qodercli`) | yolo | readonly–yolo | yes: `dont_ask` + built-in tool allowlist | off, low–max (no minimal) | yes, version-gated | yes | — |
| `dsh` | DeepSeek harness (`dsh`) | yolo | readonly–yolo | yes: dsh sandbox via `DSH_PERMISSION_MODE` over a scoped settings document; ACP escalation driver-denied | off–max, session-only (one-shot refused) | yes | yes | — |

Every adapter enforces read-only, and the Read-only column names the layer that does it; `degraded` marks a known-degraded upstream. Without a sandbox, `write`/`yolo` are permission-rule tiers, not an OS boundary; a readonly hook is heuristic.

## kimi: tiers over ACP, print mode still yolo-only

A dispatch boots `kimi acp`, sets the tier with `session/set_mode` before the first prompt (`readonly` → `plan`, `write` → `auto`, `yolo` → `yolo`) and configures effort and model per session. The one-shot `-p` spelling pins no tier and refuses effort. Details: [kimi.md](kimi.md).

## reasonix: readonly version boundary

`reasonix acp` (the only production path) rejects `--permission-mode`, so nothing pins the tier: readonly rests on the driver rejecting `session/request_permission`. Through v1.38.7 `session/new` boots in `Ask`: writes and bash calls prompt and are rejected — effective. From v1.38.8 (commit 4daa815be) it hardcodes `workspace-write`, so in-workspace writes and writer bash run unprompted and readonly silently stops confining; outside-workspace writes and the bash Seatbelt sandbox still bound it. `tool_approval` changed there: tier pinning must capability-negotiate from `session/new`'s `configOptions`.

## qoder: steering version gate

Qoder is driven over its documented stream-json channel; steering needs an announced stable `qodercli_version` ≥ 1.1.49 (the SDK baseline). Missing, malformed, prerelease or older versions make `external_agent_steer` refuse with the reported version; every other tool keeps working. Details: [qoder.md](qoder.md).

## dsh: shared home, scoped settings

dsh runs against the user's own `~/.dsh`, where `settings.yaml`'s `permission.defaultPreset` outranks `DSH_PERMISSION_MODE` and a higher-precedence patch replaces a row's whole config, so every spawn carries `--patch` pointing the settings document at `~/.dsh/settings.pi-external-agent.yaml`: empty when missing and preset-free, the composed default governs — `DSH_PERMISSION_MODE` picking the tier, dsh's sandbox enforcing it. A shell-exported `DSH_HOME` is stripped from the child env. Details: [dsh.md](dsh.md).

## Permission mappings

- codex: `--sandbox read-only`/`workspace-write`/`danger-full-access`.
- pi: readonly restricts `--tools`; with no sandbox, write and yolo are equivalent.
- codebuddy: `default` + `--settings` (readonly)/`acceptEdits`/`bypassPermissions`.
- claude: `dontAsk`/`acceptEdits`/`bypassPermissions` over stream-json; readonly is the CLI's `dontAsk` deny (`permissions.allow` rules and read-only Bash heuristics still apply), preempting the driver's `can_use_tool` backstop.
- kimi (session; the `-p` spelling pins no tier): `plan`/`auto`/`yolo` over ACP, readonly fail-closed.
- reasonix (one-shot spelling; `acp` pins no tier): `manual`/`acceptEdits`/`bypassPermissions`; deny rules and OS sandbox still apply.
- qoder: `dont_ask` + built-in allowlist/`accept_edits`/`bypass_permissions`.
- dsh: `DSH_PERMISSION_MODE=read-only`/`workspace-write`/`danger-full-access` (codex vocabulary); readonly fail-closed over ACP.
