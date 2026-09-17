# Qoder live verification — September 2026

What was attempted against a live model, what blocked it, and where the implementation's confidence comes from.

## What happened

- **qodercli 1.0.18 probes** — startup, permission and follow-up paths were exercised by hand. The runs were blocked by the test account's restrictions before any model output, and the 1.0.18 binary's inbound user-message schema declares `priority` but not `shouldQuery`, so its steering delivery contract could not be confirmed either.
- **Upgrade to qodercli 1.1.52** — a read-only probe completed the real driver handshake (`initialize` was answered, `system`/`init` announced the version) and passed the steering version gate (stable release ≥ 1.1.49), with no model or effort override.
- **Inference blocked** — the test account's credits were exhausted, so the CLI refused inference before any tool call. No steering message was sent, and no follow-up after a steer could be attempted.

## Unverified

- Live-model mid-run steering.
- Follow-up after a steering message.

Both paths are exercised only by offline protocol tests and hand-driven probes that stop short of inference.

## What the implementation rests on

- Qoder's documented stream-json contract: the `priority: "next"` + `shouldQuery: false` steering semantics in the Input Modes page, and `--input-format stream-json` in Run in Scripts.
- The published `@qoder-ai/qoder-agent-sdk` 1.0.39 protocol types, cross-checked against the wire shapes the driver sends and parses.
- Offline protocol tests (`test/qoder*.test.ts`) covering the handshake, result handling, steering frames, the version gate, cancels and `can_use_tool` answers.

## Follow-up

When an account with inference credits is available, re-run the read-only probe end to end, send one steer while a turn is active, and then a follow-up. Record the observed `command_lifecycle` states for the steer frame. Until then, live-model steering and post-steer follow-up stay listed as unverified.
