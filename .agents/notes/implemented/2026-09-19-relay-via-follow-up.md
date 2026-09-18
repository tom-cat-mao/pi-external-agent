# Relay: worker-to-worker answer injection via follow_up (W3)

## Problem

The only path for "A's finding reaches B" was A's answer → coordinator transcript
→ coordinator retypes it into B's prompt. Every relay paid the coordinator's
replay multiplier, and the coordinator became a serial bottleneck for worker
exchange. Contract 5 in
`.agents/notes/planned/2026-09-19-sol-pi-inspired-overhaul.md`.

## Decision

`external_agent_follow_up` grows four optional params — `fromTaskId`, `purpose`
(reproduce|combine|challenge, default combine), `offset`, `length` (default 4000,
cap 16000). With `fromTaskId` set, the hub composes the message itself: a page
from the source's latest archive (or a UTF-8-safe window of the inline answer),
wrapped in the relay-envelope template with `path:line` anchors extracted (≤12).

Delivery is layered by target capability and reported honestly: steer for a
running steer-capable task (qoder's version gate honored), follow-up for a
settled-alive session, explicit `Relay refused:` otherwise — oneshot CLIs and
reaped sessions are refused, never silently respawned.

Hop discipline: `Task.relayDepth` = max(target, source+1), refused at ≥2 with the
refusal telling the caller to read the answer itself instead. `relaysReceived`
shows in status. Receipt: one line (`bytes · sha256:8 · via · hop`) + 500-char
excerpt + archive handle, so the coordinator keeps visibility without replay.

## Alternatives considered

- New `external_agent_relay` tool: strongest reason — cleaner schema (message
  makes no sense for relays). Rejected: tool descriptions cost context every
  request; the single-tool-surface invariant wins; `message` stays required and is
  reported as ignored on the relay path.
- Oneshot fallback as a new-task prefix (the planned contract): strongest reason —
  relay reaches one-shot CLIs too. Rejected: it is a cold start wearing relay's
  clothes; the cost shape is a full dispatch, so the caller should dispatch
  explicitly. Deviation from the planned note, decided during W3.
- Unlimited hops with per-chain budgets: strongest reason — flexible topologies.
  Rejected: relay chains grow silently; a hard cap fails closed and visible.

## Consequences

- Coordinator sees every relay as a compact receipt, but no longer reads the full
  text unless it chooses to (the intended trade).
- A stale hop count or a reused session can surprise; refusals name the known
  taskIds and the reason.
- Prompt surface: 8885/8900 after this wave; the capability-index guideline line
  carries relay discoverability.
