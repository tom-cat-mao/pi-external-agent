# Ship the capability index as a skill rather than in tool descriptions

## Problem

Every reference fact the coordinator needs at dispatch time — the per-agent table, the effort
rules, the permission tiers, the template list, the steer/follow-up matrix, the relay defaults —
lived inside the `external_agent_*` tool descriptions. Descriptions are part of every provider
request, so those facts were a standing cost paid on every turn, including the turns that never
dispatch anything. Budgeting them (`test/prompt-surface-budget.test.ts`) capped the drift but not
the cost: any further detail meant raising a constant that exists to make growth a decision.

At the same time the detail has to remain reachable. A slimmed description that says "see the
skill" is only useful if the model can find and read the reference when it is actually choosing.

## Decision

Ship `skills/external-agent/SKILL.md` and advertise it through pi's `resources_discover` hook:
`src/index.ts` registers a handler returning `skillPaths: [<abs path>]`, resolved from
`import.meta.url` like the codebuddy readonly hook. pi injects only the skill's name and
description into the prompt and the model reads the body with the `read` tool when it needs it, so
the reference is free until it is used.

The body carries the facts the slimmed descriptions drop: the eight-agent matrix (provider, best
use, read-only enforcement, effort range, steer/follow-up, known degradations), effort semantics,
mode tiers, template precedence and the five builtins, the steer/follow-up matrix including kimi
follow-up-only and qoder's 1.1.49 gate, the relay protocol, and verify/isolate/notify/watchdog.
It ends by pointing at the two live channels for runtime detail: dispatch refusal messages and
`external_agent_status`.

`skills/` joins `package.json`'s `files` list, or the npm package would resolve the path to a file
it does not ship. `test/skill.test.ts` pins the contract: the frontmatter name and description
(non-blank, ≤1024 chars, unquoted `": "` rejected) and the handler returning the same absolute
path.

## Alternatives considered

1. **Keep the facts in the tool descriptions.** Strongest reason: zero new machinery, and the
   facts sit where the model already reads them, with no discovery step and no risk of a stale
   skill. Why rejected: descriptions are re-sent in every request, which is exactly the standing
   cost the slim-down workstream exists to remove; the reference is needed at dispatch time, not
   on every turn, and the feature's own budget test was already the symptom.
2. **Ship the reference as a repo markdown file with no hook.** Strongest reason: nothing to
   register, no new pi surface, and `docs/adapters.md` already holds the matrix. Why rejected:
   pi would never tell the model the file exists. `docs/` is a maintainer page, and a
   model-invisible path is only reachable by guessing it, which is a tool call spent on nothing
   when the skill registry does it for free.
3. **Register the same content as a prompt path (`promptPaths`).** Strongest reason: prompts take
   the full file, so the model would never need a second read call. Why rejected: prompt paths are
   appended to the system prompt and therefore paid in every request — the same cost shape as the
   descriptions this change removes, only larger.
4. **Split the reference into one skill per topic.** Strongest reason: each body stays short, so a
   read pulls only what the task needs. Why rejected: every skill's name and description enter the
   prompt, so N skills multiply the recurrent surface; the facts are one decision (which agent,
   which knob), and splitting them would make the model read two files to make one choice.
5. **Deliver the reference as a task template.** Strongest reason: templates already ship in the
   package and are loaded by name through tested code. Why rejected: templates are dispatch
   payloads wrapped around a worker's task, addressed to the external agent rather than the
   coordinator; loading one sends the text to another CLI instead of into this conversation.

## Consequences

- `skills/external-agent/SKILL.md` (110 lines) is the read-on-demand home for the capability
  facts; `src/index.ts` advertises it; `test/skill.test.ts` guards the frontmatter and the path;
  `package.json` ships `skills/`.
- The description scalar is quoted on purpose: pi parses frontmatter as YAML, where an unquoted
  `": "` inside the value starts a nested mapping and the whole skill is dropped silently. The
  suite fails on the unquoted form, because a silently unloaded skill is the failure mode here.
- The matrix now duplicates `ADAPTERS` and `docs/adapters.md`; keeping all three in step is a
  manual contract like the one the registry and the matrix already share — no test enforces it.
- The tool descriptions can now shrink to the dispatch essentials, which is the other half of the
  workstream this unblocks; the extra detail has a home, so its removal is not a loss.
