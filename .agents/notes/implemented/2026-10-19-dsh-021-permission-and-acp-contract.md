# dsh 0.2.1: permission overlay and ACP contract

## Problem

The dsh adapter was pinned to `dsh 0.1.5-rc.2`. By `0.2.1-rc.2` the settings
topology had changed: the `settings` row no longer names a settings document,
and fresh sessions take their permission preset from the composed `permission`
row's `defaultPreset`. The old overlay therefore left a profile's preset free to
outrank `DSH_PERMISSION_MODE`. A readonly task could create a session with
`danger-full-access`, while the receipt still claimed harness-enforced readonly.

The same release exposed ACP model configuration and a one-prompt-at-a-time
contract. The adapter claimed both model forwarding (false) and mid-run steer
(fake: a concurrent prompt is rejected) out of date with the protocol.

## Decision

- Replace the settings-document overlay with a final `--patch` overlay that
  replaces the `permission` row with the three extension presets and a
  `defaultPreset` expression reading `DSH_PERMISSION_MODE`.
- Keep dsh's shared `~/.dsh`; do not fork its profile, credentials or sessions.
- Probe the composed config per profile. For readonly and write, any finding
  refuses the dispatch. yolo warns because it promises no confinement.
- Reject every ACP permission escalation in readonly and write. Only yolo may
  allow one, so write remains workspace-write rather than becoming full access.
- Forward model and effort through `session/set_config_option`. A model is
  resolved to an advertised selector value (exact value, unique name, or unique
  provider/model). Model is set first; the refreshed config options decide
  whether the mapped effort token is advertised.
- dsh is follow-up only. ACP permits one in-flight prompt and advertises no steer
  method, so `external_agent_steer` refuses immediately and sends no prompt.
- Follow the latest dsh release. Do not maintain the 0.1.x topology; an
  incompatible composed row is reported as an unsupported composition.

## Alternatives considered

1. **Keep the settings-document re-point.**
   Strongest reason: it preserved the old verified isolation without touching the permission service.
   Why rejected: the row has no configured document path in 0.2.1, so the overlay is inert while a profile preset can still win.

2. **Keep the old probe and warn only.**
   Strongest reason: a drifted composition still runs, maximizing availability.
   Why rejected: readonly and write promise a boundary; only yolo can continue safely without one.

3. **Keep concurrent-prompt steering.**
   Strongest reason: feature parity with codebuddy.
   Why rejected: dsh rejects the second prompt and the driver swallowed that rejection, producing a false accepted receipt.

4. **Allow write escalations.**
   Strongest reason: avoids failed workspace tasks that ask for wider access.
   Why rejected: it turns write into yolo and breaks the mode contract.

5. **Pass raw model ids.**
   Strongest reason: a simpler model argument.
   Why rejected: ACP advertises opaque selectors; raw ids are not the wire value and can select nothing.

## Consequences

- A dsh readonly/write dispatch can now fail closed when `dsh --dump-config`
  cannot prove the permission row and both environment hooks. That is deliberate
  and must be documented.
- Users with a profile-level `permission.defaultPreset` keep their setting for
  their own dsh runs; extension-spawned runs override it for the lifetime of that
  process through the final patch.
- dsh no longer claims steer. The tool remains available for other agents.
- Model and effort start failures are explicit; no prompt runs on a fallback
  route or lower effort.
- The headless one-shot adapter remains only as an internal compatibility path.
  New headless-only features are outside the dsh production contract.
