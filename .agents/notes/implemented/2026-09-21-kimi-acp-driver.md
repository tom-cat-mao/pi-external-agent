# kimi gains an ACP session driver, and the start path a configure phase

## Problem

kimi was yolo-only and one-shot: `-p` rejects every permission flag and the print path forces Never Ask, so no tier could be selected and readonly/write were refused at dispatch. Against kimi-code 2.0.2 its harness exposes a real ACP surface that serves all three tiers, so the refusal had become the wrong side of the receipt-honesty rule.

Three facts made this more than a new dialect entry:

- **The configure timing already existed, unowned.** dsh settles `reasoning_effort` with `session/set_config_option` after `session/new` and before the first prompt, and a rejection has to fail the session start. kimi needs the same window for its mode (set before the first prompt), its model and its effort. Two dialects reaching into one window from `AcpDriver.start()` invites the timing and the failure policy to drift apart.
- **kimi's mode set is not idempotent.** Setting `plan` while the session is in `plan` throws, and a session can boot in a mode of its own — a state the hub cannot reach yet, because no transport resumes a session, so the tolerance guards against it rather than a live path. Since a rejected set must fail the start — no prompt under a tier the caller did not ask for — the one rejection that means "already there" needs classifying without swallowing real failures. kimi does not put those words in the JSON-RPC error's message: a plan→plan conflict arrives as message `Internal error` with `Already in plan mode` in `error.data.details`, which the plumbing never surfaced — so a classifier reading only the message was dead code as wired.
- **kimi has no steer, and the fallback claims otherwise.** `AcpDriver.sendSteer`'s no-advertised-method path sends a second `session/prompt`, swallows the rejection and reports `accepted: true`. kimi rejects a concurrent prompt with -32600, so that path would report guidance that never landed.

## Decision

- `AcpDriver.start()` becomes an explicit lifecycle: spawn → initialize → session/new → **configureSession phase** → first prompt. The phase is opt-in (`AcpDialect.configureSession`); a dialect declaring none sends nothing in that window, which is reasonix's and codebuddy's behavior, pinned unchanged by their existing tests.
- The phase receives `{sessionId, mode, model, effort, configOptions, setMode, call}`: the driver owns the timing, the fail-closed policy and the tolerance, the dialect owns its wire calls.
- Tolerance is driver-owned and narrow: `setMode` swallows a rejection the dialect's `benignModeRejection` matches — for kimi, one that names the REQUESTED mode id as already in force — and rethrows everything else. Effort and model rejections are never tolerated — they decide how the turn runs and what it costs. The text it reads is what the plumbing surfaces: the error's own message first, plus anything `error.data.details` carries (a general plumbing change: a fixed wrapper message must not hide the dialect's real words, and a conflict about a different mode stays fatal).
- The write-tier receipt stops claiming the harness's dangerous-command asks survive it: in `auto` that guard short-circuits and `auto-mode-approve` approves every tool call, so dangerous Bash runs unasked there — `yolo` is the tier where such an ask survives and the driver allows it, and AskUserQuestion is the one that runs the other way (denied in auto).
- dsh's `effort: {configId, token}` member is deleted and migrated into the phase: one `session/set_config_option reasoning_effort` frame in the same position, with the same failure semantics, and its driver tests run unmodified.
- kimi dialect (`SESSION_DRIVERS.kimi`): entry `acp` (a subcommand); `prepare` sets `KIMI_CODE_NO_AUTO_UPDATE=1` and strips an ambient `KIMI_MODEL_THINKING_EFFORT` when the dispatch sets effort itself; configure sets `plan`/`auto`/`yolo`, then the model (`model`, raw id), then effort (`thinking`, validated against the vocabulary `session/new` advertises and re-read from a model set that re-advertises it); `failClosedPermissionModes: ["readonly"]`; `sessionNewHint` maps an auth failure to the `kimi login` hint; `steerViaConcurrentPrompt: false` refuses a steer instead of claiming one.
- Adapter: `minMode` opens to readonly, `readonlyEnforcement: "plan-mode-guard"` (plan's guard plus the driver's rejections), `session: {steer: false, followUp: true}`, `supportedEfforts: EFFORT_LEVELS` so the hub routes effort into the driver. The one-shot spelling keeps truthful refusals for below-yolo modes and effort: those are that spelling's limits, not kimi's.

## Alternatives considered

1. **A narrow `sessionMode` hook** (mode only; leave dsh's effort where it was). Strongest reason: the smallest diff, since mode is the one thing kimi needs that dsh did not. Why rejected: dsh's effort set already occupied that exact window, so it needed a second hook with the same timing, tolerance and failure semantics — two owners for one phase — and kimi would still need both, because its phase is mode *and* model *and* effort.
2. **A declarative mapping** (`mode`/`effort`/`model` as data the driver applies). Strongest reason: no dialect code, and kimi's mode map is pure data. Why rejected: kimi's rules are not data — the effort token is checked against the vocabulary the session advertised, which a model set can replace mid-phase — so either the driver grows kimi's rules or the data carries closures, which is a handler with extra steps.
3. **Keep the `effort` member and add kimi's mode and model as separate members.** Strongest reason: no new lifecycle concept; each concern keeps its own field. Why rejected: the order is part of the contract (mode before the first prompt; model before the effort that is validated against the freshest advertisement), and separate fields leave that order to be inferred from `start()`'s sequence instead of declared.
4. **Keep kimi yolo-only and send readonly work to another agent.** Strongest reason: nothing new to defend, and the label stays trivially true. Why rejected: plan mode does confine Write/Edit, so the tier is real; refusing it would hide a usable capability behind an out-of-date label.
5. **Probe the installed kimi at dispatch to pick the tier and vocabulary.** Strongest reason: the vocabulary may be version-dependent. Why rejected: the receipt is built before any handshake (the reasonix version boundary is the precedent), while the session advertises its own vocabulary at runtime — which is what the phase validates against.

## Consequences

Benefit: kimi's three tiers are real and labelled, its effort and model requests travel per session instead of being refused, and the window between `session/new` and the first prompt has one owner with one failure policy.

Cost: `Adapter.minMode`/`minModeNote` have no producer any more (the floor guard stays as the hub's fail-closed default); the one-shot transport is unreachable from the hub for every agent, so tests reach it by removing a driver entry; kimi's readonly label names two layers rather than one.

Known limitation (no boundary): plan mode is agent-scoped — the guard is registered per agent and the mode broadcast carries the permission mode alone — while `Agent`/`AgentSwarm` are approved by the default-tool list in every mode and `git-cwd-write-approve` checks no mode. A model that DELEGATES a write to a subagent under readonly is therefore statically reachable with no driver-visible ask; a direct readonly write is live-verified vetoed (see the probe below).

## Live probe (2026-09-21, kimi-code 2.0.2)

- `session/new` advertises `model` (raw ids), `thinking` — `low`, `high`, `max` on `kimi-code/k3-256k`, with `max` current and no `off` — and `mode` (`default`, `plan`, `auto`, `yolo`).
- `session/set_mode plan` succeeds on a fresh session.
- The plan guard vetoes `Write` with no ask and no file created; `ExitPlanMode` raises an ask, and the driver's rejection holds (no file, mode unchanged).
- `usage_update` arrives once per turn, after the turn settles, and never enters the meter.
- The achievable effort vocabulary is per-model advertised: on that model `off`, `minimal`, `medium` and `xhigh` refuse at session start — fail-closed by design, never a silent fallback to a nearby level.
- Indicated statically but not exercised live: the delegation path above, an ambient `KIMI_MODEL_THINKING_EFFORT`'s precedence over the session's own set, and the auth-failure wording.
