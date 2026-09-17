# Qoder steering: version gate

## Problem

Mid-run steering over Qoder's stream-json channel relies on `shouldQuery: false` to keep a steer inside the active turn instead of promoting it to a turn of its own. An inspected qodercli 1.0.18 binary declares `priority: ["now","next","later"]` in its inbound user-message schema but no `shouldQuery`, and nothing in it reads that field off an inbound frame. On a CLI of that generation a steer is an ordinary queued message whose delivery contract cannot be confirmed from the outside.

## Decision

Send a steer only when the CLI announces a stable `qodercli_version` at or above 1.1.49 — the release our documented SDK pairing (`@qoder-ai/qoder-agent-sdk` 1.0.39) targets. Anything else (missing, malformed, prerelease, older) makes `external_agent_steer` refuse with the reported version and an upgrade note, and no steer frame is written. Start, status, follow-up and stop are unaffected.

## Alternatives considered

1. **Steer over `--acp`.** Strongest reason: ACP is a single JSON-RPC transport the other session drivers already speak, so Qoder would reuse proven infrastructure. Why rejected: the ACP page documents only editor integration and exposes no steering metadata there, so a second `session/prompt` would prove queueing, not step-boundary steering.
2. **`priority: "now"` interrupt.** Strongest reason: an interrupt has immediate, unambiguous delivery, so the receipt could claim application. Why rejected: it violates the never-interrupt contract — a steer must land at a step boundary and must not cancel a tool call already running.
3. **Ungated steering.** Strongest reason: it would keep steering available on every qodercli build, including 1.0.18, maximizing capability. Why rejected: with `shouldQuery` absent from the 1.0.18 schema and unread by the binary, delivery would be an ordinary queued message; the receipt would then claim a contract we cannot confirm, which is exactly what the honest-receipt model forbids.

## Consequences

Benefit: steer receipts never overstate what the CLI honours, and a refusal names the reported version so the user can act on it.

Cost: steering is unavailable on older CLIs even though a queued message might have been useful, and the gate must be re-checked against future SDK pairings.
