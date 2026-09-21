# reasonix readonly: a version boundary, not a pinned tier

## Problem

`docs/adapters.md` attributed reasonix readonly enforcement to `--permission-mode manual`. An audit against the deepseek-reasonix Go source found that claim false for the production path, and found that the confinement the extension actually relies on expires at a specific upstream version.

- `reasonix acp` is the only production path: reasonix has a session driver, so `startTask` always takes the persistent transport and the one-shot adapter (whose argv does spell `--permission-mode manual`) never runs. `reasonix acp` rejects `--permission-mode`, so no tier is pinned at all; a readonly session is confined only by the driver rejecting each `session/request_permission` — `this.autoPermission = "reject"` for readonly (`src/drivers/acp.ts:126`), answered with a reject option (`src/drivers/acp.ts:295`).
- v1.38.1–v1.38.7 (installed: 1.38.1): `session/new` boots in `Ask` (`service.go:662`), so a file write or bash call raises a permission request, the driver rejects it, and readonly is EFFECTIVE.
- v1.38.8+ (commit `4daa815be`, 2026-09-13): `session/new` hardcodes `workspace-write` (`service.go:702`), so in-workspace writes and writer bash complete with ZERO permission requests. Readonly silently stops confining on upgrade — fail-open, with no warning anywhere. Outside-workspace writes and the bash Seatbelt sandbox still bound the blast radius.
- `session/set_config_option tool_approval` vocabulary changed at the same boundary: `ask|auto|yolo` (≤1.38.7) vs `read-only|workspace-write|danger-full-access` (≥1.38.8). Any tier pinning must capability-negotiate from the `configOptions` that `session/new` advertises, never hardcode.
- The default deny set is EMPTY; "deny rules" in the docs means user-configured only, and user config cannot widen an ACP session's tier — the constructor pins the most restrictive.
- Receipts carry the same hole: `sessionReadOnlyEnforcement()` (`src/hub/shared.ts:427`) labels a readonly reasonix session `harness-enforced` because the adapter sets no `driverEnforcedReadOnly`, while the actual confinement is the driver's rejections plus the upstream boot mode.

## Decision

Record the boundary where the capability matrix lives — the `reasonix` row and a short section in `docs/adapters.md` — and in this note. Ship NO code fix now; that is the product owner's call.

Behavior on the installed 1.38.1 is genuinely confined, so nothing is broken today: the risk sits entirely in the upgrade. The fix surface, documented here for the PR that needs it: after `session/new` / `session/load` / `session/resume`, capability-negotiate `tool_approval` from the advertised `configOptions`, set it before the first prompt, and pin the tier at spawn with `--workspace-only` and `--sandbox-bash=enforce`; never use `session/set_mode`.

## Alternatives considered

1. **Pin the tier now via `session/set_config_option`.** Strongest reason: it closes the upgrade bomb immediately, and both vocabulary generations are now known, so the negotiation could be written today. Why rejected: readonly is confined on the installed 1.38.1 without it, so the pin buys nothing yet, and a correct pin needs the capability negotiation plus tests — too much to smuggle into a docs change. Revisit before upgrading past 1.38.7.
2. **Refuse readonly dispatch for reasonix, the way kimi refuses tiers it cannot bound.** Strongest reason: a refusal cannot fail open, so the honest-receipt model is satisfied by construction. Why rejected: 1.38.1 is genuinely confined, so refusing would remove a working capability rather than fix a broken one.
3. **Do nothing.** Strongest reason: the installed version is confined, so the finding concerns a version that is not in use. Why rejected: the docs assert a mechanism that does not exist, and the next upgrade flips readonly to fail-open with no signal — a silent upgrade bomb is worth a note even when it is not worth code.

## Consequences

- `docs/adapters.md` carries the boundary inline (row + section), so a reader of the matrix sees `confine ≤1.38.7; fail-open from ≥1.38.8` without opening this note.
- Receipts and their enforcement label are NOT touched here: a readonly reasonix dispatch still reports `harness-enforced` until a later truth-pass PR fixes the label together with whatever tier pinning it adds. Until that PR, the label is a known inaccuracy, deliberately left as-is rather than half-corrected in a docs change.
- Upgrade checklist item: re-verify readonly confinement before moving reasonix past 1.38.7, and land the tier-pinning change (alternative 1) as part of that upgrade.
- This change is docs and notes only — no `src/`, test or receipt text changes.
