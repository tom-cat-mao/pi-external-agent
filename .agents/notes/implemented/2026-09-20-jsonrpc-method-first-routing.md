# JSON-RPC: route by method before matching a pending reply

## Problem

`JsonRpcConnection.handleLine` (`src/drivers/base.ts`) matched an inbound message
against the pending-request table before reading its method. Both ends of a
JSON-RPC link number their own requests independently, so ids collide: a harness
counting its requests from a small counter — dsh escalates several
`session/request_permission` calls inside one turn — eventually hands one the id
of the pending `session/prompt`. The hub then read a permission request as the
prompt's reply: the turn settled on a result that was not one (an early answer,
or a rejection that looked like a protocol error), the escalation was never
answered, and the harness waited forever.

## Decision

Route by shape first. A message carrying `method` is a request when it also
carries an `id`, and a notification when it does not; both go to their callbacks.
Only a message without a method is a candidate reply, matched against the pending
table by id. A reply never carries a method, so every dialect keeps the behavior
it had for replies, and the collision case is removed where it can occur: the
`JsonRpcConnection` dialects, which are codex app-server and ACP (reasonix,
codebuddy, dsh). pi-rpc and the two stream-json drivers extend `StdioProcess`
directly, so they never matched a reply through that pending table and this
change does not reach them.

Request ids are routed only when numeric. JSON-RPC 2.0 also permits string ids;
the ACP dialects (reasonix, codebuddy, dsh) number requests with integers, which
is the type `respond`/`respondError` replies in. A string-id server request would
reach the notification callback instead of being answered — an assumption of the
ACP contract, documented in the code rather than guessed around.

## Alternatives considered

1. **Namespace our own ids away from the harness's.** Strongest reason: no framing change at all — start our counter high (say 1e9) and collisions become practically impossible.
   Why rejected: it turns a shape rule into a bet on the other side's counter, which is not observable from here. Any harness that reaches our range brings back the same silent corruption, now harder to see.
2. **Keep the pending-table match first and fall back to method dispatch when no id matches.** Strongest reason: the smallest diff — one added condition on the existing path, and replies stay the fast common case.
   Why rejected: it preserves the wrong precedence. The bug is precisely the case where an id DOES match, so the fallback would never run for it.
3. **Answer the unmatched request with method-not-found and keep the old order.** Strongest reason: it at least unblocks a harness waiting on a request, and it is one branch in the request path.
   Why rejected: the turn would still settle early on the misread reply, so a permission escalation could be silently taken for an answer; replying with an error hides the corruption instead of removing it.
4. **Reject string request ids loudly (fail the session).** Strongest reason: an unsupported shape should be visible rather than quietly downgraded to a notification.
   Why rejected: no observed dialect sends one, and taking a session down over an id type turns a hypothetical into an outage. The numeric assumption stated in the code keeps the behavior inspectable.

## Consequences

Benefit: a harness request can no longer be consumed as a reply, for any
`JsonRpcConnection` dialect, and a turn settles only on a real result. dsh's
multi-escalation turns — the case that exposed it — answer every request and
settle once.

Cost: `handleLine` now relies on the protocol rule "a reply carries no method"
instead of on local bookkeeping; a dialect that echoed a method on a response
would be misrouted, though none does. String request ids stay unhandled by
decision, with the assumption written down next to the check that makes it.
