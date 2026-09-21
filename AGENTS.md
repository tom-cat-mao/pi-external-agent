# AGENTS.md

Working rules for agents editing this repository.

## Layout

- `src/index.ts` — extension entry: binds the tool surface, `pi.exec`, the stats command and the session lifecycle.
- `src/hub/tools.ts` — the seven tool registrations and their description strings.
- `src/hub/registry.ts` — task registry and state machine: dispatch validation, one-shot and persistent transports, settle finalize, notifications, stall watchdog, worktrees, session lifecycle.
- `src/hub/reporting.ts` — caller-facing text: status report, dispatch receipts, compare report, relay receipt.
- `src/hub/shared.ts` — task/receipt types, hub constants, pure formatting helpers and input predicates.
- `src/adapters.ts` — per-CLI one-shot adapters: argv spelling and stdout parsing (incl. usage/cost), plus the `ADAPTERS` registry.
- `src/dsh-launch.ts` — the dsh launch path against the shared `~/.dsh`: lazy, idempotent provisioning of the scoped settings document and its `--patch` overlay, plus a best-effort anchor guard that warns when the overlay loses effect.
- `src/drivers/` — persistent session drivers for steer / follow-up: `base.ts` (stdio + JSON-RPC plumbing), one file per wire protocol (`pi-rpc`, `codex-app-server`, `acp`, `stream-json`), and `index.ts` (`SESSION_DRIVERS`).
- `src/artifacts.ts` — answer archive: settle-time content-addressed store, inline placeholder, paged recall.
- `src/templates.ts` + `templates/` — task-template loading (project > user > builtin) and the five builtins.
- `src/meter.ts` — CLI-reported usage/cost counters behind `/external_agent_stats`.
- `hooks/` — `codebuddy-readonly.js`, the PreToolUse Bash hook loaded by codebuddy's readonly `--settings`.
- `test/` — `node:test` suites; pi packages are stubbed via `registerHooks`.

## Commands

- `node --test "test/**/*.test.ts"` — full suite.
- `npx tsc --noEmit` — typecheck.

Release flow: push a `v*` tag → [.github/workflows/release.yml](.github/workflows/release.yml) runs both gates, then creates the GitHub Release with generated notes. An existing Release is left untouched, so a re-run is a no-op; to publish a tag pushed earlier, run that workflow manually (`workflow_dispatch`) with the tag name.

Run only the test file relevant to your change locally; run the full suite before committing.

## Invariants

- **No wall-clock kill.** Tasks run to completion. The stall watchdog notifies the model when a running task goes quiet (default 15m); the model decides whether to stop. See [.agents/notes/implemented/2026-08-17-no-wall-clock-timeout.md](.agents/notes/implemented/2026-08-17-no-wall-clock-timeout.md).
- **Permission tiers are enforced mechanically** — by the target CLI harness, or by the session driver answering protocol permission requests (claude's `can_use_tool`) — never by a prompt-level request. See [docs/adapters.md](docs/adapters.md).
- **One tool surface.** `agent` is an enum rather than one tool per CLI, because tool descriptions cost context in every request. See [.agents/notes/implemented/2026-08-17-single-tool-surface.md](.agents/notes/implemented/2026-08-17-single-tool-surface.md).
- **Non-trivial changes ship with a note** in `.agents/notes/` in the same commit.

## Documentation rules

- [docs/](docs/) holds present-tense facts about the current system — no change-of-state or revision history, in English or Chinese. History belongs to git and notes.
- [.agents/notes/](.agents/notes/) holds decision records. Template: Problem / Decision / Alternatives considered / Consequences. Every alternative states its strongest reason and why it was rejected. No `INDEX.md` — the folder is the status.
- Budgets are enforced by test: `AGENTS.md` ≤ 550 words, each `docs/*.md` ≤ 650 words, each `docs/postmortem/*.md` ≤ 800 words, each note ≤ 120 lines, each README ≤ 70 lines.
- Index: [docs/architecture.md](docs/architecture.md) (dispatch flow, receipts, transports) · [docs/adapters.md](docs/adapters.md) (capability matrix) · [docs/capabilities.md](docs/capabilities.md) (archive, verify, templates, isolate) · [docs/qoder.md](docs/qoder.md) (Qoder stream-json contract) · [docs/postmortem/](docs/postmortem/) (incident write-ups).
