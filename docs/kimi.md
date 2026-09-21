# kimi

The current contract for the `kimi` harness (Moonshot), read off MoonshotAI/kimi-code @2.0.2 and probed live 2026-09-21.

## Session

A dispatch boots `kimi acp` — a subcommand, not a flag — and the task travels on the protocol. Every spawn sets `KIMI_CODE_NO_AUTO_UPDATE=1` (a self-update would swap the binary under a live session) and strips an ambient `KIMI_MODEL_THINKING_EFFORT` when the dispatch sets an effort level itself.

`session/new` advertises `model` (raw ids), `thinking` (its values, per model) and `mode` (`default`, `plan`, `auto`, `yolo`). The configure phase then settles mode, model and effort before the first prompt; a rejection fails the session start, so no turn runs under a configuration the caller did not ask for. The one tolerated rejection is a conflict naming the REQUESTED mode as already in force — `set_mode` is not idempotent (plan while in plan throws), and those words reach the driver in `error.data.details` behind a fixed `Internal error` message. A conflict naming any other mode fails the start.

## Tiers

| Requested | Wire mode | What bounds it |
|---|---|---|
| `readonly` | `plan` | the plan-mode guard vetoes Write/Edit before approval; the driver rejects every `session/request_permission` as a backstop |
| `write` | `auto` | never-ask: the dangerous-command guard short-circuits and `auto-mode-approve` approves every tool call, so dangerous Bash runs unasked; AskUserQuestion is denied |
| `yolo` | `yolo` | dangerous-command asks survive and the driver allows them; AskUserQuestion is approved |

Plan mode is what makes a readonly label true: elsewhere `git-cwd-write-approve` quietly approves in-workspace Write/Edit. `write` and `yolo` differ in how kimi's own asks are handled — auto raises none, yolo keeps the dangerous-command ask — so neither is claimed to be the more bounded tier.

The one-shot spelling selects no tier — `-p` rejects every permission flag and forces Never Ask — and refuses a below-yolo or effort request instead of labelling what cannot run. No dispatch takes it.

## Effort and model

Effort is per session: `session/set_config_option` configId `thinking`, the requested level sent verbatim. The vocabulary is advertised per model by `session/new` and re-read from a model set that re-advertises it; an unadvertised level fails the start rather than being guessed at. On the probed model (`kimi-code/k3-256k`) it is `low`, `high`, `max` — `off`, `minimal`, `medium` and `xhigh` refuse at session start. The model travels the same way, configId `model`, raw id (not dsh's provider/model pair), never a startup flag.

## Permissions, steering, usage, auth

`session/request_permission` is answered mechanically: readonly selects a reject option (or cancels when none is offered), write/yolo allow. Steering does not exist — a concurrent `session/prompt` is rejected (-32600) and no steer method is advertised — so `external_agent_steer` refuses and guidance waits for the turn to end; follow-up keeps the conversation. `usage_update {used, size}` reports context tokens, not cost, once per turn and after the settle; kimi advertises no such capability, and it never enters the meter — the driver keeps reading past the settle so the figure reaches the status line. A replayed conversation arriving as `session/update` chunks is dropped: the driver clears its turn buffers when the prompt is sent. A logged-out `session/new` answers -32000 with an auth complaint, which the driver expands into the `kimi login` hint.

## Known limitations

Plan mode is agent-scoped: the guard is per agent and the mode broadcast carries the permission mode alone, not plan state. `Agent`/`AgentSwarm` are approved by the default-tool list in every mode, and `git-cwd-write-approve` has no mode check — so a DELEGATED write under readonly is statically reachable with no driver-visible ask, while a direct one is live-verified vetoed.

## Verification

Live-probed 2026-09-21: the advertised config options; `session/set_mode plan`; the plan guard vetoing Write with no ask and no file; `ExitPlanMode` asking and the driver's rejection holding; `usage_update` once per turn, after the settle, outside the meter; the per-model effort refusals. An ambient `KIMI_MODEL_THINKING_EFFORT`'s precedence and the auth-failure wording stay source-read.
