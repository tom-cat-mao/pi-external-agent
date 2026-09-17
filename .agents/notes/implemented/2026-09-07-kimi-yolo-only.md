# kimi is yolo-only

## Problem

kimi-code 0.41.0 rejects every permission flag with `-p` ("Cannot combine --prompt with --auto/--yolo/--plan"), so a headless run always executes under `default_permission_mode` in `~/.kimi-code/config.toml`. Accepting a readonly or write request would produce a receipt with nothing enforcing it.

## Decision

Set `minMode: "yolo"` on the adapter, keep its ceiling at yolo, and mark `enforcesReadOnly: false`. readonly and write requests are refused at dispatch with the reason and a list of agents that can run them. The adapter stays callable for yolo work.

## Alternatives considered

1. **Label-only readonly/write tiers.** Strongest reason: the tool surface stays uniform — every adapter accepts the same three modes, so callers never have to special-case kimi. Why rejected: a receipt claiming readonly while the harness enforces nothing is dishonest reporting, and the receipt is the contract callers trust.
2. **Wait for an upstream fix.** Strongest reason: kimi may add permission flags, and the tiers would then be real rather than labels. Why rejected: it leaves dispatch ambiguous today; the refusal is cheap, and the flag surface is re-checked on each upgrade instead.

## Consequences

Benefit: no false readonly receipts, and kimi's single real behavior is stated where the caller reads it.

Cost: kimi cannot serve read-only review, and effort requests are refused because the CLI exposes no reasoning-effort control.
