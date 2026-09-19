# Layout under `src/`: hub and drivers

## Problem

Two modules had grown into the whole extension. `index.ts` was 3724 lines
holding the task registry, both transports, the stall watchdog, worktree
isolation, receipts, compare, relay, and the seven tool registrations with
their description strings. `sessions.ts` was 1850 lines holding five drivers
for five different wire protocols. Any change — a receipt word, a driver
handshake — meant reading and editing a monolith, and no boundary kept
contract details (qoder's version gate, claude's control channel) from leaking
into policy code. The prompt surface also lived in the same file as the
spawn logic, so a description edit and a lifecycle edit were the same diff.

## Decision

Two commits, each mechanically verifiable:

1. **Move, don't change.** `git mv` every source file under `src/`, updating
   import specifiers only (`refactor: move sources under src/`).
2. **Split, don't change.** Break `src/index.ts` into a hub and
   `src/sessions.ts` into drivers (`refactor: split hub and drivers`):
   - `src/index.ts` — the extension entry: binds the tool surface, `pi.exec`,
     the command, and the session lifecycle.
   - `src/hub/tools.ts` — the seven registrations, their description strings
     byte-for-byte, and the hub message renderer.
   - `src/hub/registry.ts` — task registry and state machine, both transports,
     dispatch validation, settle finalize, notifications, stall watchdog,
     worktree isolation, session lifecycle.
   - `src/hub/reporting.ts` — caller-facing text: status report, receipts,
     compare report, relay receipt.
   - `src/hub/shared.ts` — types, tuning constants, pure formatting helpers and
     input predicates.
   - `src/drivers/base.ts` — spawn/LF framing, JSON-RPC 2.0 over stdio, the
     event/turn-end skeleton; `pi-rpc.ts`, `codex-app-server.ts`, `acp.ts` and
     `stream-json.ts` (claude + qoder, which share the control-waiter and
     result framing) hold one wire protocol each; `drivers/index.ts` holds
     `SESSION_DRIVERS`.

`src/sessions.ts` is gone rather than left as a re-export shell: the driver
registry has one canonical home in `drivers/index.ts`, and the seven importers
(test suites included) name it directly.

Moves are whole blocks of code — function bodies, comments and constants
traveled verbatim. What changed per file is exactly what a module boundary
requires: `export` on the symbols a sibling now imports, an import header, and
a doc comment naming the file's role.

## Alternatives considered

1. **Leave the two monoliths, extract only as needed.** Strongest reason:
   zero risk of touching 5500 working lines, and the suite would keep passing
   untouched. Why rejected: the file size is what makes every future change
   expensive, and the split is cheapest exactly when the tree is otherwise
   still (185/185 green, no other branch in flight).
2. **One file per tool (`start.ts`, `wait.ts`, `compare.ts`, …).**
   Strongest reason: a tool, its description and its renderer are the natural unit, and
   the prompt-surface budget then has an obvious owner per file. Why rejected:
   the handlers share the registry, the reporting helpers and the schemas, so
   seven files would each import most of the hub and the descriptions would
   drift apart; the budget test measures the aggregate, not per file.
3. **Keep `src/sessions.ts` as a thin re-export shell** so importers need no
   change. Strongest reason: it keeps the diff to test files at zero and gives
   one obvious legacy entry point. Why rejected: two paths to the same registry
   invite drift, and the shell would exist only to avoid a one-line path edit
   in seven importers.
4. **Do the move and the split in one commit.** Strongest reason: one review,
   one green run, less churn in the history. Why rejected: `git mv` plus a
   content split in one diff hides renames from `git log --follow` and makes
   "did this change behavior?" unanswerable by inspection; two commits let the
   second be verified as a pure move.
5. **Split the hub by layer instead (types / state / render).**
   Strongest reason: layering rules are checkable — a render module that imports no
   state cannot grow a side effect. Why rejected: the honest seam here is
   caller-facing text versus mechanics, and layering would have scattered the
   receipt vocabulary across three files to satisfy an import rule nothing
   else needs.

## Consequences

- No source file exceeds 1500 lines — `adapters.ts` (995) included. The largest
  new file is `hub/registry.ts` (1390), then `hub/tools.ts` (1244).
- `test/effort.test.ts` reads the tool source by path; that path and the seven
  `../src/sessions.ts` imports are the only test edits. No assertion changed.
- `src/index.ts` re-exports `stallClock`, `scanWatchdogs` and `stallTestApi`,
  so the stall suites keep their single import; the hub's other exports are
  internal to `src/hub/`.
- The tool description strings moved byte-for-byte, which is what keeps
  `test/prompt-surface-budget.test.ts` (8900 chars) green.
- A split makes shared state explicit: `tasks`, `meter` and `finalizeHooks`
  are now imports rather than file-locals, so a reviewer can see who can mutate
  the registry.
- `hub/reporting.ts` reads registry state (`tasks`, `retainedWorktreesLine`)
  rather than owning it; if it ever needs to write, that is the signal the
  boundary is wrong.
