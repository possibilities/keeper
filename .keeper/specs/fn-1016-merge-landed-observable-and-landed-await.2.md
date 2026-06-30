## Description

**Size:** S
**Files:** src/await-conditions.ts, cli/await.ts, plugins/plan/skills/{plan,hack}/SKILL.md, plugins/keeper/skills/await/SKILL.md, README.md, test/await-conditions.test.ts

Add the `landed <epic>` await condition reading task-1's merged signal, and
repoint the planning daisy-chain gate to it.

### Approach

Add `landed` as a plan-id-bearing await condition (a pure predicate in
`src/await-conditions.ts` reading the merged-to-default signal from the
snapshot; new slot/arity in `cli/await.ts` alongside the core epic's
conditions). When `worktree_mode` is OFF (read from the snapshot field the
core epic added), `landed` degrades to `complete` semantics (no lanes →
merged ⇔ done-AND-idle). Reuse the frozen exit taxonomy (0/1/3/4/5).

Repoint the planning-dependent daisy-chain gate: `plugins/plan/skills/plan/SKILL.md`
(~:572) and `plugins/plan/skills/hack/SKILL.md` (~:199, :201, :212-213) — where
the premise is "plan B against A's landed/merged files," reference
`landed fn-A` instead of `complete fn-A`. Leave the `depends_on_epics`
EXECUTION-dep wording unchanged (that's not a planning dep). Add a `landed`
row to `await`'s condition table and a README `## Example clients` mention.
Forward-facing prose only.

### Investigation targets

**Required** (read before coding):
- src/await-conditions.ts — the pure-predicate seam + the existing `complete` epic branch (degrade target)
- cli/await.ts:243-256 (arity buckets), :629-791 (slot machine)
- plugins/plan/skills/plan/SKILL.md:572, plugins/plan/skills/hack/SKILL.md:199-213 — the daisy-chain gate prose to repoint
- plugins/keeper/skills/await/SKILL.md — condition table

### Risks

- Only repoint the PLANNING daisy-chain (author-B-against-A's-merged-reality), not the execution `depends_on_epics` wording — they're different concerns.

### Test notes

Pure fixtures: `landed` met when merged signal present; waiting when done-but-unmerged; degrades to `complete` when worktree_mode OFF. `bun test` green.

## Acceptance

- [ ] `keeper await landed <epic>` fires on the merged-to-default signal; degrades to `complete` when worktree mode is OFF.
- [ ] The plan/hack planning daisy-chain gate references `landed`; execution `depends_on_epics` wording unchanged.
- [ ] await skill + README document `landed`; forward-facing prose only.
- [ ] Pure fixture tests; `bun test` green.

## Done summary
Added the 'landed <epic>' await condition: a pure landedState predicate reading the snapshot merge-landed set (worktree ON/OFF degradation baked in by task 1), wired as an epic-only board-family condition in cli/await.ts. Repointed the planning daisy-chain gate in the plan/hack skills from complete to landed and documented landed in the await skill table + README.
## Evidence
