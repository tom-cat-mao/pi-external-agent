# kimi

The current contract for the `kimi` harness (Moonshot), read off MoonshotAI/kimi-code @2.0.2.

## Session

A dispatch boots `kimi acp` — a subcommand, not a flag — and the task travels on the protocol. Every spawn sets `KIMI_CODE_NO_AUTO_UPDATE=1`, because a self-update inside a live session would swap the binary under it. An ambient `KIMI_MODEL_THINKING_EFFORT` is stripped from the child when the dispatch sets an effort level itself.

After `session/new` and before the first prompt, the configure phase settles the session's mode, model and effort. A rejection fails the session start, so no turn runs under a configuration the caller did not ask for. The one tolerated rejection is `already in … mode`: a resumed session boots in the mode it was left in, and `session/set_mode` is not idempotent.

## Tiers

| Requested | Wire mode | What bounds it |
|---|---|---|
| `readonly` | `plan` | the plan-mode guard vetoes Write/Edit before approval; the driver rejects every `session/request_permission` as a backstop |
| `write` | `auto` | the asks the harness raises reach the driver, which allows them; AskUserQuestion is denied |
| `yolo` | `yolo` | as `write`, except AskUserQuestion is approved |

Plan mode is what makes a readonly label true: in every other mode `git-cwd-write-approve` quietly approves in-workspace Write/Edit. `write` and `yolo` differ only in AskUserQuestion handling — `dangerous-command-ask` survives both — so no receipt claims one is the more bounded tier.

The one-shot print spelling is different: `-p` rejects `--yolo`/`--auto`/`--plan` and the print path forces Never Ask, so it selects no tier at all, and it refuses a below-yolo or effort request instead of labelling what cannot run. No dispatch takes that path — kimi has a session driver.

## Effort and model

Effort is per session: `session/set_config_option` with configId `thinking` and the requested level sent verbatim. Its vocabulary is read off `session/new`'s config options; a level the session does not advertise fails the start rather than being sent as a guess, and a model set that re-advertises the option replaces the list the check reads. The model travels the same way, configId `model`, with a raw model id (not dsh's provider/model pair) and never a startup flag.

## Permissions, steering, usage, auth

`session/request_permission` is answered mechanically: readonly selects a reject option, or cancels when the harness offers none, while write/yolo allow. Steering does not exist — a concurrent `session/prompt` during an active turn is rejected (-32600) and no steer method is advertised — so `external_agent_steer` refuses and guidance waits for the turn to end; sessions persist, so follow-up keeps the conversation.

`usage_update {used, size}` reports context tokens, not cost, and arrives after the turn settles: the driver keeps reading the stream past the settle so the figure reaches the task's status line. A resumed session replays its conversation as `session/update` chunks, which the driver drops by clearing its turn buffers when the prompt is sent. A logged-out `session/new` answers -32000 with an auth complaint, which the driver expands into the `kimi login` hint.

## Verification

The contract above is read off the kimi-code 2.0.2 sources and exercised by fixture, not by a live run. Until a live session is probed, these stay unconfirmed: the `thinking` vocabulary and its level names, the exact mode-conflict and auth failure wording the driver matches on, and whether an ambient `KIMI_MODEL_THINKING_EFFORT` outranks the session's own set.
