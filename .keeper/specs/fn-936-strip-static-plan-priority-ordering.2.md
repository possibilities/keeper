## Description

**Size:** S
**Files:** plugins/plan/skills/next/SKILL.md, plugins/plan/src/cli.ts, plugins/plan/src/models.ts, plugins/plan/src/emit.ts, plugins/plan/src/invocation.ts, plugins/plan/src/verbs/epic_short_circuit.ts, plugins/plan/src/verbs/scaffold.ts, plugins/plan/README.md, plugins/plan/CLAUDE.md, plugins/plan/skills/defer/SKILL.md, plugins/plan/skills/hack/SKILL.md, plugins/plan/skills/plan/SKILL.md, plugins/keeper/skills/autopilot/SKILL.md, plugins/plan/test/verbs-restamp.test.ts, plugins/plan/test/creation-epic-ops.test.ts

### Approach

Remove the `/queue` surface end to end from the plan plugin: the `/plan:next`
skill and the `keeper plan epic queue-jump` verb plus every model/emit path
that carries `queue_jump`, and prune the doc cross-references. Separate package
from task .1 with its own test suite, so it's parallel-safe and dep-free — the
cross-package data flow is forgiving (the plan envelope's `queue_jump` field is
advisory; task .1's deriver simply ignores it once removed, in either land
order). `/plan:defer` STAYS — only its priority-flip sibling goes.

### Investigation targets

**Required** (read before coding):
- plugins/plan/skills/next/SKILL.md — the `/plan:next` skill (delete the file; no tombstone).
- plugins/plan/src/cli.ts:381-389 — the `queue-jump` verb entry + `--help`/`--agent-help` string.
- plugins/plan/src/models.ts — `EpicDef.queue_jump` field.
- plugins/plan/src/verbs/epic_short_circuit.ts — queue-jump dispatch; scaffold.ts — `epic.queue_jump` acceptance; emit.ts / invocation.ts — `queue_jump` plumbing.

**Optional:**
- plugins/plan/README.md:157 (the `/plan:next` verb-table row); plugins/plan/CLAUDE.md (routing rec + "Removed verbs" guardrail list).

### Risks

- `scaffold.ts` accepts `epic.queue_jump` in its YAML schema — removing it must not break scaffold parsing of plans that omit it (it already defaults false); ensure no required-field regression.

### Test notes

Grep `plugins/plan/src` + `plugins/plan/test` for `queue_jump`/`queue-jump`/`plan:next` to catch every site. `bun run test:full` covers the plan plugin suites. Removing the verb deletes `plugins/plan/test/verbs-restamp.test.ts` + `creation-epic-ops.test.ts` queue-jump cases.

## Acceptance

- [ ] `plugins/plan/skills/next/` deleted; `keeper plan epic --help` no longer lists `queue-jump`.
- [ ] `queue-jump` verb + `EpicDef.queue_jump` + all emit/invocation/scaffold `queue_jump` plumbing removed from `plugins/plan/src`.
- [ ] `/plan:defer` unaffected (its `queue_jump` YAML mention + `/plan:next` sibling ref pruned).
- [ ] Doc cross-refs pruned: plan README row, plan CLAUDE.md ("Removed verbs" list ADDS `queue-jump` + `plan:next`), defer/hack/plan SKILL.md, keeper autopilot SKILL.md `plan:next` negations rewritten forward-facing.
- [ ] Plan plugin tests green under `bun run test:full`.

## Done summary
Removed the /queue surface from the plan plugin: deleted the /plan:next skill + keeper plan epic queue-jump verb and all EpicDef.queue_jump/emit/invocation/scaffold plumbing, pruned doc cross-refs, and rewrote autopilot SKILL.md priority negations forward-facing. Plan plugin suite green.
## Evidence
