---
name: external-agent
description: "Capability reference for the external_agent_* delegation tools: agent comparison matrix, effort levels, permission tiers, templates, steer/follow-up support, relay protocol. Read before choosing an agent, effort, mode, or template for external_agent_start, or before steering."
---

# External-agent capability index

Reference for the `external_agent_*` delegation tools: which agent to pick and how
each knob behaves. Live state — task ids, answers, receipts — is not here; read it
with `external_agent_status`.

## Agent matrix

All eight agents accept `mode: readonly | write | yolo`, default to `yolo`, and sit
behind one dispatch path: a persistent session driver where the agent has one, a
one-shot process otherwise.

| Agent | Provider (`bin`) | Best use | Read-only bound by | Effort | Steer | Follow-up | Degraded |
|---|---|---|---|---|---|---|---|
| `codex` | OpenAI (`codex`) | Primary workhorse for code writing and task execution | harness: `--sandbox read-only` | off, minimal–xhigh | yes | yes | — |
| `pi` | pi itself (`pi`) | Workhorse with a fully configurable model (`model` → child `--model`) | harness: `--tools read,grep,find,ls`; no sandbox, so write ≈ yolo | off–max | yes | yes | — |
| `kimi` | Moonshot (`kimi`) | Execution workhorse like codex and pi; tiers are real over its ACP session | plan-mode guard vetoes Write/Edit + driver rejects permission prompts | off–max (session only) | no | yes | — |
| `codebuddy` | Tencent (`codebuddy`) | Fast repository explorer; a full execution agent too | best effort: default mode + `--settings` deny rules + PreToolUse Bash hook (silent denies) | minimal–max | yes | yes | — |
| `claude` | Anthropic (`claude`) | Full coding agent; shares pi's gateway, so no model diversity | CLI mode `dontAsk` denies anything not pre-approved | low–max | yes | yes | unverified against a real endpoint; fixture-tested only |
| `reasonix` | DeepSeek-native (`reasonix`) | Workhorse on a prefix-cache-tuned harness; omit `model` unless another provider is genuinely needed | driver rejects permission prompts (nothing pins the tier) | off–max | yes | yes | readonly confines ≤1.38.7, fail-open from ≥1.38.8 |
| `qoder` | Alibaba Qoder (`qodercli`) | Third independent executor or reviewer | harness: `dont_ask` + built-in tool allowlist; MCP and Agent launches denied | off, low–max (no `minimal`) | yes, version-gated | yes | — |
| `dsh` | DeepSeek harness (`dsh`) | Workhorse on a DeepSeek-native harness | harness: `DSH_PERMISSION_MODE` through dsh's own sandbox; escalations driver-denied | off–max (session only) | yes | yes | — |

Read-only is always enforced mechanically — by the target harness or by the session
driver answering protocol permission requests — never by a prompt request.
`write`/`yolo` are permission-rule tiers, not an OS boundary, wherever the agent has
no sandbox. Concurrent write/yolo tasks in one directory are refused; qoder's
non-default modes also need a trusted startup directory.

## Effort

- Opt-in: set `effort` only when the user explicitly requests a level, never inferred
  from task complexity. Omit it to inherit the target CLI/config default; `"off"` is
  an override, not an omission.
- Levels per agent are the Effort column above; a request outside the range is
  refused with the supported list.
- `kimi` and `dsh` forward effort only inside their session — the one-shot spelling
  has no effort knob and a request there is refused, not dropped. `codex` has no
  dedicated flag (a `-c` config override, with `off` spelled `none`); `reasonix` maps
  onto its relay's `disabled|low|high|max`; `qoder` uses `--reasoning-effort`.

## Permission tiers

`readonly` forbids mutations, `write` allows workspace edits, `yolo` removes the
sandbox — a yolo agent can modify or delete anything on this machine. An omitted
`mode` uses the agent's own default (yolo everywhere today). The tiers are enforced
by the harness or the session driver, so a tier the agent cannot really run is
refused at dispatch instead of being labelled.

## Templates

`template: "<name>"` wraps the task text with a reusable output contract. First hit
wins: `<project>/.pi/external-agent/templates/<name>.md` → `~/.pi/agent/external-agent/templates/<name>.md`
→ builtin. An unknown name is refused with the searched paths.

Builtins:

- `evidence-research` — read-only research; Summary plus Details with `path:line` anchors.
- `verify-report` — write tasks; change list plus one suggested verify command.
- `review-report` — reviews; verdict plus a per-item checklist with evidence locations.
- `relay-envelope` — worker-to-worker message format; every relay travels through it.
- `board-entry` — evidence-board row format; compare builds its rows inline from these
  fields rather than loading the template.

## Steer and follow-up

Both need the agent's persistent session; all eight agents have one.

- `external_agent_steer` works on codex, pi, codebuddy, claude, reasonix, qoder and
  dsh. It is not an interrupt: the message lands at the next step boundary. If the
  turn already ended, use `external_agent_follow_up`.
- `kimi` is follow-up only: a concurrent prompt is rejected and no steer method is
  advertised, so guidance waits for the turn to end.
- `qoder` steering requires an announced stable `qodercli_version` >= 1.1.49; a
  missing, malformed, prerelease or older version refuses with the reported version,
  while start, status, follow-up and stop keep working.
- `external_agent_follow_up` continues the same session, so it keeps everything the
  worker did and learned. A session idled past 30 minutes is reclaimed and the
  follow-up is refused — dispatch a new task instead.

## Relay

`external_agent_follow_up` with `fromTaskId` injects another task's settled answer
into a live session, wrapped in the `relay-envelope` template: `offset` picks the
start byte, `length` the excerpt bytes (default 4000, max 16000), and `purpose`
(`reproduce` | `combine` | `challenge`) states the intent. Delivery is steer for a
running task, follow-up for a settled-alive session, refusal otherwise; chains cap
at two hops.

## verify, isolate, notify, watchdog

- `verify: {command, timeoutSeconds?}` runs the command after settle to done and
  reports its exit code plus an output tail — a mechanical check, no verdict.
- `isolate: true` runs the worker in a fresh git worktree
  `<repo>/.external-agent/worktrees/<taskId>` on branch `ea-<taskId>`; a non-git cwd
  is refused, and the hub never merges or deletes it.
- `notify` — `steer` (default) interrupts at the end of the current tool batch,
  `followUp` when you are idle, `nextTurn` on the user's next message, `off` never
  (poll `external_agent_status`).
- `watchdog` — minutes of no activity before a stall notice (default 15; `0`
  disables). `notify: "off"` suppresses delivery only; the wait tool still returns
  early on a stall.

Runtime details — supported levels, refusal reasons, live receipts — also surface via
dispatch refusal messages and `external_agent_status`.
