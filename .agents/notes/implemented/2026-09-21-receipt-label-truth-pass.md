# Receipt labels name the real enforcer

## Problem

Three readonly/authority receipts named an enforcer that cannot be reached:

- claude readonly said `driver-enforced (can_use_tool deny)`. Under `--permission-mode dontAsk` the CLI itself denies every tool the user did not pre-approve and never raises a `can_use_tool` control request, so the driver deny in `src/drivers/stream-json.ts` is unreachable there. The caveat that stays true: `permissions.allow` rules and claude's read-only Bash heuristics still apply under `dontAsk`.
- reasonix readonly said `harness-enforced` although `reasonix acp` rejects `--permission-mode`, so nothing pins the tier. What confines is the driver rejecting `session/request_permission` prompts — and that confines only because reasonix ≤1.38.7 boots sessions in `Ask` (fail-open from 1.38.8; docs/adapters.md "reasonix: readonly version boundary").
- kimi's yolo receipt said `config.toml`'s `default_permission_mode` ("yolo") governs a headless run. Against kimi-code 2.0.2 that is false on two counts. Print mode FORCES `auto` (Never Ask) regardless of config: `run-v2-print.ts:481` `setMode('auto')`. Since Never Ask is more permissive than yolo (Ask When Needed), the declared yolo ceiling is not even a bound; static `[[permission.rules]]` denies still apply. Verified in the installed 2.0.2 dist and against MoonshotAI/kimi-code @2.0.2: `-p` rejects `--yolo`/`--auto`/`--plan` (options.ts:79-87, `OptionConflictError`), `--dangerously-skip-permissions` has zero occurrences in tree and changelog, and `-p` emits no usage/token figures (the adapter has no usage branch, and its `^error:` branch was dead because only stdout reaches `parseEvent`).

The premise of `.agents/notes/implemented/2026-09-07-kimi-yolo-only.md` ("headless runs inherit `default_permission_mode`") is superseded by the kimi findings above. That historical note stays as written; this one carries the corrected facts.

## Decision

- `ReadOnlyEnforcement` gains `cli-mode` and `driver-rejected-prompts`; `Adapter.driverEnforcedReadOnly` (a boolean that could only say "not the harness") becomes `readonlyEnforcement`, the label a readonly turn actually carries. Labels the receipt renders: claude `cli-mode (dontAsk denies everything not pre-approved)`, reasonix `driver-rejected prompts (confines only ≤1.38.7; fail-open from 1.38.8)`.
- claude's driver deny stays as a fail-closed backstop, but the label and its comment no longer claim it is the enforcement point.
- kimi's behavior is unchanged — `minMode: "yolo"`, readonly/write refused, effort refused — with the rationale restated: `-p` rejects every permission flag and print mode forces Never Ask, so headless cannot select a lower tier. The refusal (`Adapter.minModeNote`) and the yolo receipt's effective-policy line now say that instead of naming config.toml.
- kimi's dead `^error:` branch is deleted rather than wired: failures arrive on stderr, which `parseEvent` never sees.
- qoder (`dont_ask` + allowlist), pi (`--tools` allowlist), codebuddy (`--settings` denies + best-effort Bash hook, already documented as best-effort), codex/dsh (sandboxes) keep `harness-enforced`.

## Alternatives considered

1. **Docs-only fix, labels unchanged.** Strongest reason: no code or enum churn, and docs are where nuance belongs. Why rejected: the receipt is the artifact callers read and trust; a label naming an unreachable enforcer is the same dishonest reporting the 2026-09-07 note rejected label-only tiers for.
2. **Probe the installed reasonix version so the label is exact per machine.** Strongest reason: `≤1.38.7` is version-dependent, so a probe would let the receipt state the truth for this install. Why rejected: the receipt is built before any handshake, the ACP `initialize` exchange does not announce a version usable for this, and the real fix is tier pinning via capability negotiation — already documented — not a smarter label.
3. **Rename kimi's `yolo` tier to a `never-ask` tier.** Strongest reason: it would end the mismatch between requested mode and effective policy. Why rejected: it renames the mode vocabulary for one adapter and rewrites the floor story with it; the effective-policy line and docs now carry what runs. Revisit if kimi exposes a usable tier flag for `-p`.
4. **Delete the claude driver's `can_use_tool` deny as dead code.** Strongest reason: unreachable code invites the false claim again. Why rejected: it is a fail-closed backstop for any path or future mode where the CLI does raise a control request; removing fail-closed code to tidy a label is the wrong trade.

## Consequences

Benefit: every readonly receipt names what really bounds the run, and kimi's receipt stops asserting a config value that print mode ignores. Callers can tell a sandbox from a CLI mode from a driver prompt rejection without reading source.

Cost: labels are longer, and the reasonix label states a version boundary rather than a guarantee — a reasonix upgrade still has to be re-checked against docs/adapters.md before relying on readonly. `Adapter` carries one more optional string (`minModeNote`).
