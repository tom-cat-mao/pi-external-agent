# dsh: telemetry policy returns to the user's own composition

## Problem

PR #17 (merge `1e33efe`) made every dsh spawn the extension issues carry
`DSH_TELEMETRY_DISABLED=1` — the design in
[2026-09-21-dsh-telemetry-opt-out.md](2026-09-21-dsh-telemetry-opt-out.md),
which this note supersedes. That put a telemetry policy inside an open-source
extension: the variable rode both spawn paths unconditionally, so the extension
answered a privacy question on behalf of everyone who installs it, and no caller
could opt a run back in. The choice is not the extension's to make. What a dsh
composition uploads is a property of the user's own dsh setup, and each user
holds that choice in their own layers.

The owner's own answer lives in the home layer of their shared `~/.dsh`, as the
launchers' own `{id, disabled}` row shape:

```yaml
# ~/.dsh/cordis.patch.yml
- id: session-telemetry-otel
  disabled: true
```

The home layer outranks the shipped bundle, and the extension's `--patch` overlay
only re-points the settings row, so the row survives every extension composition:
interactive and extension-spawned runs alike. Verified on dsh 0.1.5-rc.2 by
reading the composition, not prose: `dsh --profile {headless,acp} --dump-config`,
with and without `--patch ~/.dsh/cordis.patch.pi-external-agent.yml`, prints
`disabled: true` on the `session-telemetry-otel` row in all four compositions.

## Decision

- Revert PR #17's code and docs: neither spawn path sets `DSH_TELEMETRY_DISABLED`,
  and the `DSH_TELEMETRY_OPT_OUT` constant is gone from `src/adapters.ts`.
- Keep `2026-09-21-dsh-telemetry-opt-out.md` as history — notes are never deleted —
  with this note superseding it.
- The extension is telemetry-neutral: it expresses no telemetry preference and
  honors whatever the user's own composition says.
- `docs/dsh.md` states that neutrality and points at the home-layer row, so a
  user who wants the opt-out has a copyable answer.
- The same environment contract stays otherwise unchanged: `DSH_PERMISSION_MODE`
  still picks the tier and an inherited `DSH_HOME` is still stripped.

## Alternatives considered

1. **Keep the spawn-env opt-out (PR #17 as merged).** Strongest reason: a feedback event raised inside an extension session uploads the session prefix under the shared home's identity, and off-by-default cannot leak by mistake — the privacy argument at full strength, already measured, tested and reviewed.
   Why rejected: it imposes the owner's preference on every downstream user of the extension. What one person wants their dsh to upload is not what the project may decide for every install, and the merged design made it impossible for a caller to choose otherwise.
2. **Do nothing — leave the code and let the owner's home patch coexist.** Strongest reason: the two mechanisms never conflicted, so the home patch already covers the owner's own runs and every downstream user keeps the safer default; reverting costs a reviewed change and its tests.
   Why rejected: the owner explicitly wants the repository neutral. A policy shipped in the extension is still shipped in it, and a user reading the adapter sees the project taking a position that belongs to them.
3. **Revert the code and docs, keep the note (chosen).** Strongest reason: it leaves the decision with the party that holds it — each user's own dsh composition — while the note preserves why the opt-out was tried, so the ground is not re-litigated from scratch.
   Why rejected: nothing was — this is the decision. Its accepted costs are below.

## Consequences

The extension sets no telemetry variable on any spawn path, so a run honors
whatever the user's dsh composition says — a home-layer `disabled: true` row
included, which the shared-home design already lets through.

- A user who wants the opt-out copies the two-line row above into
  `~/.dsh/cordis.patch.yml`; `docs/dsh.md` names the file so the answer is
  reachable from the docs rather than from the source.
- Nothing about the row is extension state: it is the user's file, in their
  layer, and the composition anchor keeps ignoring telemetry rows.
- The extension no longer shields an extension-spawned run from dsh's shipped
  default. That default is `FEEDBACK_ONLY` — ordinary activity captures nothing —
  and what it uploads on explicit feedback is now the user's call, as it is for
  any other dsh run on their machine.
- The upgrade burden PR #17 accepted is gone with the code: no launcher chunk
  needs re-verifying for a variable the extension no longer sets, and the old
  note's "a caller cannot opt a run back into telemetry" cost disappears.
