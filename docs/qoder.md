# Qoder

The current contract for driving `qodercli` over its documented stream-json channel.

## Invocation and framing

One-shot dispatches use `qodercli -p <task> --output-format stream-json`; persistent sessions use `qodercli -p --output-format stream-json --input-format stream-json`. In the streaming form the task text is not an argv argument: it is one JSON object per LF on stdin.

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]},"parent_tool_use_id":null,"uuid":"…"}
```

The `uuid` is a `randomUUID`, because the protocol keys commands by it.

## Handshake

Boot sends the SDK `initialize` control request as soon as the process is up, then waits for **either** its `control_response` **or** the CLI's `system`/`init` record before sending the first user message. Neither signal is sufficient on its own: an authenticated CLI answers `initialize` and announces `system`/`init` later; an unauthenticated one announces `system`/`init` and never answers. A failure frame arriving with the handshake — a synthetic API error, a failed result, an unanswerable control request — makes `start()` throw instead of opening a turn on a dead session.

## Turn semantics

- `result` ends exactly one turn. A result record without a `subtype` is incomplete and is ignored rather than settling the turn with an empty answer.
- An unrecovered, truncated main-assistant stream settles as cancelled; a synthetic main-assistant API error fails the turn with its message. Child-assistant errors do not independently fail or cancel the main turn.
- A leftover result after a cancel does not create a new task turn.

## Steering

A steer is one user message with `priority: "next"` — the documented "next suitable opportunity", a step boundary — and `shouldQuery: false`, so it joins the active turn without starting one of its own. It never interrupts and is never promoted into an independent turn. The receipt therefore reports the guidance as **sent/queued**, not applied: guidance that arrives after the turn's last step stays as context for the next user message. Steering never sends `priority: "now"`.

## Version gate

A steer is sent only when the announced `qodercli_version` is present, a stable release number, and at least 1.1.49. The version is read from the `system`/`init` record, or from the same field in the `initialize` response when present. A missing, malformed, prerelease or older version makes `external_agent_steer` refuse with the reported version and an upgrade note, writes no steer frame, and leaves start, status, follow-up and stop fully usable. 1.1.49 is the documented-contract baseline this adapter targets — not a claim about the vendor's earliest supporting release.

## Cancel

Cancellation is the SDK `interrupt` control request. A matched response reporting `still_queued` produces a warning; the hub's stop path then terminates the process.

## Permission requests

Every inbound `can_use_tool` control request is answered with its own `request_id` echoed back: fail-closed `deny` for readonly and write, `allow` for yolo. A request without a usable id fails the turn instead of leaving the CLI blocked on a reply nobody sends.

## command_lifecycle

`command_lifecycle` records are honoured when the CLI sends them: a `discarded` or `cancelled` state for a steer raises a warning rather than letting an earlier "accepted" claim stand.

## Permission tiers

- readonly — `--permission-mode dont_ask`, `--tools Read,Grep,Glob,WebSearch,WebFetch`, `--disallowed-tools mcp__*,Agent`, `--strict-mcp-config` with an empty server list, and `--settings {"disableAllHooks":true}`.
- write — `--permission-mode accept_edits` (in-directory edits auto-approved; every other ask is refused).
- yolo — `--permission-mode bypass_permissions`.

Non-default modes require a trusted startup directory; otherwise the CLI falls back to `default`, where a headless ask is denied.
