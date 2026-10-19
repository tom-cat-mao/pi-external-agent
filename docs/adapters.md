# Adapters

Generated from `ADAPTERS`; update both.

All eight share one dispatch path; omitted mode uses the default, out-of-range is refused.

| Agent | Provider (`bin`) | Default | Modes | Read-only | Effort | Steer | Follow-up | Degraded |
|---|---|---|---|---|---|---|---|---|
| `codex` | OpenAI (`codex`) | yolo | readonly–yolo | yes: `--sandbox read-only` | off, minimal–xhigh | yes | yes | — |
| `pi` | pi itself (`pi`) | yolo | readonly–yolo | yes: `--tools read,grep,find,ls` | off–max | yes | yes | — |
| `kimi` | Moonshot (`kimi`) | yolo | readonly–yolo | yes: plan-mode guard vetoes Write/Edit + driver-rejected prompts | off–max, session-only (one-shot refused) | no | yes | — |
| `codebuddy` | Tencent (`codebuddy`) | yolo | readonly–yolo | best-effort: `default` + `--settings` + PreToolUse Bash hook | minimal–max (no off) | yes | yes | — |
| `claude` | Anthropic (`claude`) | yolo | readonly–yolo | yes: `dontAsk` mode denies what was not pre-approved | low–max | yes | yes | fixture-tested only |
| `reasonix` | DeepSeek-native (`reasonix`) | yolo | readonly–yolo | no pinned tier: driver-rejected prompts confine ≤1.38.7; fail-open from ≥1.38.8 | off–max; ACP forwards none | yes | yes | — |
| `qoder` | Alibaba (`qodercli`) | yolo | readonly–yolo | yes: `dont_ask` + built-in tool allowlist | off, low–max (no minimal) | yes, version-gated | yes | — |
| `dsh` | DeepSeek harness (`dsh`) | yolo | readonly–yolo | yes: dsh sandbox via `DSH_PERMISSION_MODE` over a permission-preset overlay; readonly/write escalations driver-denied | off–max, ACP advertised | no | yes | — |

Read-only names the enforcement layer; `degraded` marks a known-degraded upstream. Without a sandbox, write/yolo are permission-rule tiers, not an OS boundary.

## kimi: tiers over ACP, print mode still yolo-only

A dispatch boots `kimi acp`, sets the tier with `session/set_mode` before the first prompt (`readonly` → `plan`, `write` → `auto`, `yolo` → `yolo`) and configures effort and model per session. The one-shot `-p` spelling pins no tier and refuses effort. Details: [kimi.md](kimi.md).

## reasonix: readonly version boundary

`reasonix acp` (the only production path) rejects `--permission-mode`, so nothing pins the tier: readonly rests on the driver rejecting `session/request_permission`. Through v1.38.7 `session/new` boots in `Ask`: writes and bash calls prompt and are rejected — effective. From v1.38.8 (commit 4daa815be) it hardcodes `workspace-write`, so in-workspace writes and writer bash run unprompted and readonly silently stops confining; outside-workspace writes and the bash Seatbelt sandbox still bound it. `tool_approval` changed there: tier pinning must capability-negotiate from `session/new`'s `configOptions`.

## qoder: steering version gate

Qoder is driven over its documented stream-json channel; steering needs an announced stable `qodercli_version` ≥ 1.1.49 (the SDK baseline). Missing, malformed, prerelease or older versions make `external_agent_steer` refuse with the reported version; every other tool keeps working. Details: [qoder.md](qoder.md).

## dsh: shared home, permission overlay

Every ACP spawn passes the final `--patch` overlay, replacing dsh's `permission` row with three presets and a `defaultPreset` reading `DSH_PERMISSION_MODE`; sandbox-policy and approval read it too. A `--dump-config` anchor checks them. readonly/write refuse when unproven; yolo warns. ACP escalations are rejected for readonly/write, keeping write workspace-only. Model and effort are validated ACP config options. dsh is follow-up only: one prompt may be in flight and steer is absent. Headless is not production; inherited `DSH_HOME` is stripped.

## Permission mappings

- codex: `--sandbox read-only`/`workspace-write`/`danger-full-access`.
- pi: readonly restricts `--tools`; with no sandbox, write and yolo are equivalent.
- codebuddy: `default` + `--settings` (readonly)/`acceptEdits`/`bypassPermissions`.
- claude: `dontAsk`/`acceptEdits`/`bypassPermissions` over stream-json; readonly is the CLI's `dontAsk` deny (`permissions.allow` rules and read-only Bash heuristics still apply), preempting the driver's `can_use_tool` backstop.
- kimi (session; the `-p` spelling pins no tier): `plan`/`auto`/`yolo` over ACP, readonly fail-closed.
- reasonix (one-shot spelling; `acp` pins no tier): `manual`/`acceptEdits`/`bypassPermissions`; deny rules and OS sandbox still apply.
- qoder: `dont_ask` + built-in allowlist/`accept_edits`/`bypass_permissions`.
- dsh: `DSH_PERMISSION_MODE=read-only`/`workspace-write`/`danger-full-access` (codex vocabulary); readonly and write fail closed over ACP, yolo allows escalation.
