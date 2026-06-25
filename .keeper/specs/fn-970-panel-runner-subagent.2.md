## Description

**Size:** M
**Files:** plugins/plan/skills/panel/SKILL.md, plugins/plan/skills/panel/references/panel.md, plugins/plan/agents/panel-judge.md, plugins/plan/CLAUDE.md, plugins/plan/test/consistency-skills.test.ts

### Approach

With the runner's return contract from `.1` settled, reduce `/plan:panel` to a thin shim and
update the surrounding docs + tests:

1. **`panel/SKILL.md` → shim:** replace Steps 0-4 (preset resolve, verbatim-prompt, Monitor
   fan-out, judge spawn) with a single `Task(subagent_type="plan:panel-runner", prompt=<question
   + neutral evidence>)` invocation (NO `model=` kwarg), then render the returned answer. KEEP the
   Step 4 answer-shaping prose (absorb-as-your-own-voice, reveal-on-demand, hedge-as-yourself) and
   the cost/latency note. On a runner failure marker, surface that the panel failed — do not
   present it as an answer. DELETE the stale "you run in MAIN … Monitor … never in a subagent
   (verified)" claim; restate the architecture forward-facing (the shim spawns the runner, which
   owns the blocking fan-out).
2. **`references/panel.md`:** revise the "main session" / "you dispatch" framing to name
   `plan:panel-runner` as the dispatch surface; leave the independence / no-lenses rules intact.
3. **`panel-judge.md`:** update the frontmatter `description` to name `plan:panel-runner` as the
   spawner (body unchanged).
4. **`plugins/plan/CLAUDE.md`:** add `panel-runner` to the "Skills and agents" agent enumeration —
   one minimal forward-facing line; prune any wording made redundant.
5. **`consistency-skills.test.ts`:** add coverage following the existing worker/close idioms —
   assert the `plan:panel-runner` static agent exists with `name: panel-runner`, `disallowedTools`
   containing `Monitor` but NOT `Task`, `model: opus`; assert the shim spawns
   `subagent_type="plan:panel-runner"` with no `model=`; assert the stale "never in a subagent"
   string is absent from `SKILL.md` AND `references/panel.md`.

### Investigation targets

**Required** (read before coding):
- plugins/plan/agents/panel-runner.md — the contract from `.1` (what the runner returns on
  success and on failure) the shim must consume.
- plugins/plan/skills/panel/SKILL.md — the current Steps 0-4 + the Step 4 answer-shaping prose to
  keep; the stale claim to delete (~line 26-28; re-read, line numbers shifted).
- plugins/plan/skills/close/SKILL.md, plugins/plan/skills/work/SKILL.md — the canonical `Task()`
  shim spawn idiom (no `model=`, trust the return).
- plugins/plan/test/consistency-skills.test.ts — `parseFrontmatter`, `extractTaskCallBlocks` (the
  no-`model=` assertion), the verb-existence guard — extend these for panel.

**Optional** (reference as needed):
- plugins/plan/skills/panel/references/panel.md — framing to revise.
- plugins/plan/CLAUDE.md "Skills and agents" — the enumeration to extend.

### Risks

- **Don't strand the stale claim:** it may also be echoed in `references/panel.md` — grep both
  files for "subagent" / "MAIN session" before declaring it gone.
- **Shim over-reach:** keep the shim thin — the answer-shaping prose stays, but no fan-out logic
  leaks back into the skill.

### Test notes

`bun test` (fast) from `plugins/plan/` must stay green with the new assertions; `bun run lint &&
bun run typecheck`. The doc edits follow the repo's forward-facing-only discipline (no provenance,
no fn-ids in prose).

## Acceptance

- [ ] `/plan:panel` is a thin shim: one `Task(subagent_type="plan:panel-runner", …)` (no `model=`)
      that renders the returned answer, keeping the answer-shaping + reveal-on-demand + cost prose;
      surfaces a runner failure marker as a panel failure.
- [ ] The stale "never in a subagent (verified)" claim is gone from `panel/SKILL.md` AND
      `references/panel.md`, restated forward-facing.
- [ ] `panel-judge.md` description names `plan:panel-runner` as the spawner; `plugins/plan/CLAUDE.md`
      lists `panel-runner` in the agent enumeration.
- [ ] `consistency-skills.test.ts` asserts the runner frontmatter, the shim spawn shape (no
      `model=`), and the absence of the stale claim; `bun test` fast tier green.

## Done summary

## Evidence
