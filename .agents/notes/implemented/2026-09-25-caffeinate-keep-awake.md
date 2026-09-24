# A caffeinate assertion bound to the task pid holds off idle sleep

## Problem

A dispatched task can run for hours, and the hub has no say over macOS power
management: an idle Mac suspends the task process tree mid-turn. The coordinator
is not the process at risk — the external CLI child is, and an unattended long
task is exactly when idle sleep fires. A suspended task is not a failed one: the
child stops writing, the stall watchdog reports a quiet task, and it resumes only
when something touches the keyboard. Nothing in the hub holds the machine awake,
and telling the user to run `caffeinate` alongside pi is not a contract the
extension can rely on.

## Decision

Every task process gets a companion: once its spawn has succeeded, the hub runs
`spawn("caffeinate", ["-i", "-w", String(proc.pid)], { stdio: "ignore" })` and
`unref()`s it (`src/keep-awake.ts`, `keepAwakeWhileRunning`).

`-i` is the idle *system* sleep assertion rather than `-d`, so the display still
turns off as a user watching a long task expects. `-w <pid>` binds the assertion
to the task process, which makes the task's own exit the only release signal: no
counter to decrement, no kill path to reach, no exit handler a crash can skip. A
task that is stopped, whose spawn fails, or that is reclaimed after its turn ends
releases the assertion exactly as a clean exit does, and if pi itself dies the
companion still leaves with the pid it watches instead of holding the machine
awake for an owner that is gone.

Both spawn sites that hand a task to an external CLI call it:

- `hub/registry.ts` — the one-shot process, immediately after `task.proc = proc`.
- `drivers/base.ts` (`StdioProcess.spawnProcess`) — every persistent session
  driver. Such a task keeps `task.proc === null` (it is driven through
  `task.driver`), and its process deliberately outlives the turn that started it:
  it stays up for steer / follow-up until `IDLE_REAP_MS` (30 min) reclaims it.
  That is the longest-lived process the hub owns, the registry mount never sees
  it, and every agent has a session driver — so it takes its own binding.

The helper is best-effort by construction: off darwin, with no pid, or with a
`caffeinate` that cannot be spawned it is a silent no-op because the child's
`error` is absorbed (unhandled, an ENOENT there is an uncaught exception that
takes pi down). It adds no tool, option, config row or prompt text, so the
prompt-surface cost is zero.

## Alternatives considered

1. **A duration-bound assertion (`caffeinate -i -t <seconds>`), refreshed or not.**
   Strongest reason: it needs nothing from the task process — no pid to hand over,
   so it would work even for a child the hub never spawned.
   Why rejected: the duration is a guess. Too short and a long task still idles the
   Mac mid-turn; too long and the assertion outlives the task with nobody left to
   release it. `-w <pid>` replaces the guess with the task's own exit.
2. **Hub-level bookkeeping: track running tasks and start / stop one caffeinate
   from the registry's state transitions.**
   Strongest reason: one assertion per session instead of one per task, driven by
   state changes the hub already observes.
   Why rejected: teardown would have to be exhaustive — settle, stop, spawn error,
   watchdog reclaim, session shutdown, and pi being killed — and every path missed
   leaves a permanent assertion with no process left to notice it. `-w <pid>`
   delegates that to the kernel's process-exit notification, which cannot be missed.
3. **Wrap the task: run the CLI as `caffeinate -i <executable> <args>`.**
   Strongest reason: the assertion begins and ends with the very process that must
   stay awake — no companion process and no pid.
   Why rejected: it rewrites the dispatched argv, and the receipt's promise is to
   spell out what ran (`executable`, `argv`, `shell: false`). All eight adapters and
   their session drivers would report `caffeinate` as the executable and inherit its
   signal and exit-code behaviour. A companion leaves the receipt untouched.
4. **Cover only the one-shot mount in `hub/registry.ts`.**
   Strongest reason: the smallest diff, and the mount the request named.
   Why rejected: persistent sessions are steered for hours and are kept alive between
   turns by design, so they are the tasks most likely to be left unattended — leaving
   them out would protect the short half of the workload. One shared helper makes
   covering both sites two lines.
5. **A switch: a config knob or env var to opt out.**
   Strongest reason: a user who wants the Mac to sleep during a long task keeps
   today's behaviour without pinning a version, and an explicit default can be
   documented.
   Why rejected: it is new documented, tested surface for a behaviour with no failure
   mode worth switching — off darwin it is already a no-op, the display still turns
   off, and an unwanted assertion is one `pkill caffeinate` away. A switch also
   cannot express the per-task decision the mechanism already makes.

## Consequences

Benefit: a long task is no longer suspended by idle sleep, and the assertion is
released by the task process itself — including when the task is stopped early,
when its spawn fails, and when pi dies mid-task.

Cost: one extra short-lived process per dispatched task (and per persistent
session) on macOS, plus a silent no-op when `caffeinate` is missing, which trades a
visible failure for never failing a dispatch. The behaviour is platform-specific:
CI on ubuntu exercises only the off-darwin case, so the darwin assertions are
covered by a local run rather than by the gate.
