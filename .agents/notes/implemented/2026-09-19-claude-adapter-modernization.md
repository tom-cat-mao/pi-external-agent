# Claude Adapter Modernization — Full First-Class Citizen

**Date**: 2026-09-19  
**Goal**: Align claude with codebuddy as a full execution agent, not "analysis and planning only".

## Problem

The claude adapter was capped at `readonly` → `write` (no yolo) and driven via one-shot `--output-format json` (not persistent). This made it inferior to codebuddy despite sharing the same Anthropic gateway.

## Decision

Upgrade claude to first-class citizen status:

1. **Adapter (`adapters.ts`)**
   - Permission tiers: readonly → write → **yolo** (`bypassPermissions`)
   - Effort levels: `low|medium|high|xhigh|max` (pi domain mapping; no ultracode)
   - Output format: `stream-json`, driven as a persistent session for parity with qoder/codebuddy
   - Session capability: steer + follow-up enabled

2. **Driver (`sessions.ts`)**
   - New `ClaudeStreamJsonDriver` based on Qoder pattern
   - Initialize handshake → system/init → user frames with UUID
   - `can_use_tool` control requests per mode (deny in readonly, allow in write/yolo)
   - Result parsing with usage/cost from Claude-Code schema
   - No version gate (claude always supports stream-json steering)

3. **Documentation (`docs/adapters.md`)**
   - Update matrix row: yolo default, steer/follow-up yes
   - Permission mappings: `dontAsk` / `acceptEdits` / `bypassPermissions` over stream-json

4. **Index.ts comment**
   - Remove "readonly" cap mention; claude now listed with other yolo agents

5. **Tests (`test/claude.test.ts`)**
   - Fixture-driven test suite: parser events, session driver behavior
   - Mode mapping verification for readonly/write/yolo
   - Control request handling (can_use_tool allow/deny per mode)

## Consequences

**Positive**:
- claude is now callable for full coding tasks like codex/qoter/codebuddy
- Persistent sessions enable mid-turn guidance (steer) and context retention (follow-up)
- Stream-json provides live event feedback instead of waiting for final answer

**Risks**:
- Unverified against real claude binary (endpoint configuration pending); tests are fixture-based only
- Must be regression-tested once endpoint is configured
- Effort mapping excludes `ultracode`; ensure this matches intended scope

**Coverage loss (accepted)**:
- One-shot + readonly no longer exists as a combination. Every readonly-capable adapter is driven over a session (`claude`, `codebuddy`, `codex`, `pi`, `qoder`, `reasonix`), and `kimi` — the only one-shot adapter left — is yolo-only by its own CLI contract.
- The fixtures that needed one-shot transport moved to `kimi` (yolo), and the ones that needed readonly moved to the claude session mock. Where a single batch needed both, the readonly slot now carries the mode that keeps two writers out of one directory.
- Consequence for tests: the "spawn a readonly one-shot argv" path is no longer covered by compare/w2/w3/w4/wait-*; readonly argv construction stays covered by the adapter unit tests (`test/readonly.test.ts`, `test/claude.test.ts`).

**Verification checklist when endpoint is ready**:
- [ ] Dispatch read/write/yolo modes successfully
- [ ] Verify stream-json events flow correctly (initialize, result, tool calls)
- [ ] Confirm can_use_tool respects permission mode (deny in readonly, allow in write/yolo)
- [ ] Validate effort levels accepted by CLI
- [ ] Test steer message delivery during active turn
- [ ] Verify follow-up continues same session context
- [ ] Check usage/cost reporting matches Claude-Code schema

## Files Changed

- `adapters.ts`: line ~924 — claude adapter config updated
- `sessions.ts`: lines ~1088–1400 — new ClaudeStreamJsonDriver class
- `sessions.ts`: line ~1832 — SESSION_DRIVERS registry entry added
- `docs/adapters.md`: line 13 — matrix row updated
- `index.ts`: line 12 — comment updated to remove "readonly" cap reference
- `test/claude.test.ts`: new file — comprehensive test suite
- `.agents/notes/.../2026-09-19-claude-adapter-modernization.md`: this document

## Alternatives considered

1. Keep claude capped at readonly
   - Strongest reason: maintain separation from codebuddy roles
   - Why rejected: claude shares same gateway; role distinction is arbitrary

2. Use ACP protocol instead of stream-json
   - Strongest reason: codebuddy uses ACP for persistence  
   - Why rejected: claude docs emphasize stream-json; less complexity

3. Add ultracode support
   - Strongest reason: match codebuddy's full range
   - Why rejected: pi domain mapping doesn't include ultracode; keep consistent

## Implementation Notes

- Shared logic between Qoder/Claude drivers kept in separate module (optional future PR)
- Parser reuses `parseClaudeFamilyStreamLine` from adapters.ts (common claude-family shape)
- Control requests answered deterministically per mode; no external prompt channel
- Effort validation happens at adapter.buildDispatch time (not forwarded if unsupported)
