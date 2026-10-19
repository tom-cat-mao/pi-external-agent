# dsh

The current contract for the `dsh` harness. The supported topology starts at
`dsh-v0.2.1-rc.2`; the extension tracks the latest tag rather than maintaining
the path-configured settings-document shape.

## Production transport

dsh is normally driven over ACP (`dsh --profile acp --patch <overlay>`). The
headless one-shot adapter remains only to satisfy the shared `Adapter` interface
and its focused tests; the tools do not select it while dsh has a session driver.
Consequently headless-only surfaces such as `--json` and `--session-id` are not
part of this extension's dsh contract.

## Permissions

Every spawn carries `~/.dsh/cordis.patch.pi-external-agent.yml`. The overlay is
last in dsh's composition order, so it replaces the `permission` row's whole
config with the three extension presets and:

```yaml
defaultPreset: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
```

Fresh sessions pin that preset through dsh's permission service. The
`sandbox-policy` and `approval` rows read the same environment variable at boot.
The overlay is rewritten when stale and replaced rather than followed when a
symlink occupies its reserved name.

An offline `dsh --profile <profile> --patch <overlay> --dump-config` probe checks
the composed permission row, its three presets, the `defaultPreset` env
expression, and the two env-hooked rows. The result is memoized per profile. For
`readonly` and `write`, any finding refuses the dispatch: the extension will not
claim a sandbox boundary it cannot prove. `yolo` warns and continues because it
deliberately promises no confinement.

The ACP driver rejects `session/request_permission` in `readonly` and `write`,
so a sandbox escalation cannot widen either tier. `yolo` allows the request. The
tier vocabulary is `DSH_PERMISSION_MODE=read-only|workspace-write|danger-full-access`.

## Model and effort

`session/new` advertises a `model` selector and, when the exact model supports
reasoning, a `reasoning_effort` selector. The model argument may be the exact
opaque advertised value, a unique model name, or a unique `provider/model` name;
the extension sends only the advertised selector value. Ambiguous or unavailable
models fail the session start.

The model is set first. The returned config options are authoritative for effort:
the normalized extension level is mapped to dsh's token (`minimal` to `low`,
`medium` to `high`, `xhigh` to `max`) and must appear in that model's advertised
vocabulary. Missing or unsupported levels fail the start rather than running at
a default the caller did not request. Receipts report both overrides as
forwarded.

## Session and steering

ACP permits one in-flight prompt per session and dsh advertises no steer method.
`external_agent_steer` therefore refuses dsh immediately and sends no concurrent
prompt. Follow-up after the turn settles is supported and keeps the same session
context. Idle sessions are reclaimed by the hub's normal idle policy.

The shared `~/.dsh` remains the user's own home: profiles, plugins, ACP
credentials and sessions are theirs. An inherited `DSH_HOME` is stripped so the
overlay, probe and child all resolve the same home. Telemetry is the
composition's to decide; the extension sets no telemetry variable.
