## Description

**Size:** S
**Files:** src/commit-work/attribution.ts, plugins/plan/src/store.ts, plugins/plan/test/harness.ts, plugins/plan/package.json, plugins/plan/scripts/promote.sh, plugins/plan/CLAUDE.md

### Approach

Destroy the legacy compat surfaces (behavior-changing removals, not renames — kept separate from the `.1` mechanical commit). (a) Drop `".planctl/"` from `PLANCTL_EXCLUDE_PREFIXES` (attribution.ts:44) → `[".keeper/"]`, and rename the const; FIRST verify no watched repo root still carries a `.planctl/` tree (a remaining one would get re-attributed). (b) Remove the `?? process.env.PLANCTL_NOW` / `?? process.env.PLANCTL_ACTOR` legacy fallbacks (store.ts:358,420) so only `KEEPER_PLAN_*` is read — and in the SAME change flip every setter in plugins/plan/test/harness.ts (PLANCTL_ACTOR/NOW/BIN) to the KEEPER_PLAN_* names. (c) Rename the `PLANCTL_RUN_SLOW` slow-gate → `KEEPER_PLAN_RUN_SLOW` (harness.ts:538 + the plan CLAUDE.md/test refs). (d) The vestigial `planctl-bun` build: the runtime path does NOT use the compiled binary (keeper plan is in-process), but 4 plan tests spawn `dist/planctl-bun` (harness.ts:46, src-cli*.test.ts, src-brief-claim.test.ts) — either rename the build artifact to a keeper-plan name and repoint, or repoint the tests at `src/cli.ts` and delete promote.sh/the build target. Decide based on whether the compiled-binary test path adds value.

### Investigation targets

**Required:**
- src/commit-work/attribution.ts:40-44,267,271
- plugins/plan/src/store.ts:355-358,416-420
- plugins/plan/test/harness.ts:42-50,108,116-117,332-386,538
- plugins/plan/package.json:7-8, plugins/plan/scripts/promote.sh

### Risks

- Dropping `.planctl/` exclude is a real behavior change — verify no watched root has `.planctl/` first.
- Removing the env fallback WITHOUT flipping the harness setters self-breaks the slow suite.

### Test notes

Plan slow suite under the new `KEEPER_PLAN_RUN_SLOW` name must pass; `bun run test:full`.

## Acceptance

- [ ] `.planctl/` exclude-prefix dropped (verified no live `.planctl/` root); const renamed
- [ ] PLANCTL_ACTOR/NOW legacy reads removed; harness setters flipped to KEEPER_PLAN_*; PLANCTL_RUN_SLOW renamed
- [ ] vestigial planctl-bun build removed-or-renamed; the 4 binary-spawning tests pass (repointed or rebuilt)
- [ ] `bun run test:full` + plan slow suite green

## Done summary

## Evidence
