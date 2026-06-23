## Description

**Size:** M
**Files:** src/** (db.ts, git-worker.ts, daemon.ts, plan-worker.ts, derivers.ts, reducer.ts), test/**

### Approach

The HIGH-RISK sweep — this is where frozen carve-outs interleave with renamable symbols in the
SAME core files, so it is isolated as its own top-tier task. Allowlist-guided AST codemod
(ast-grep, NOT regex) over `src/**` + incidental `test/**`: rename `PLANCTL_STDOUT_CAP` /
`PLANCTL_FILES_CAP` (derivers.ts), `parsePlanctlOpTrailer` / `parsePlanctlTargetTrailer` /
`filterPlanctlChanges` (git-worker.ts — rename the SYMBOL, KEEP the literal it reads).
DO NOT rename (per the .1 allowlist): the Commit-event data-key reads / struct fields
`commit.planctl_op` / `planctl_target` (`derivers.ts:1151,1157,1282`, `reducer.ts:2256-2269` —
`.3` owns them), the `planctl-commit-changed` wire kind (`.3`), the git-worker scrape format
(`:959-960`), and the db.ts schema-history literals. The events-writer hook codemod must NOT
introduce any `db.ts` / `bun:sqlite` import. One atomic mechanical commit, `git rerere` enabled.

### Investigation targets

**Required:**
- src/git-worker.ts:858,959-960,1075,1096 (frozen scrape vs renamable parse symbols)
- src/derivers.ts:1151,1157,1282 + src/reducer.ts:2256-2269 (Commit-event struct fields — OUT of scope, `.3` owns)
- src/db.ts:435,1066-1075,2078-2082,3729,4047-4199 (schema-history literals — ALLOWLIST, do not touch)

### Risks

- #1 correctness risk: clobbering a frozen / schema-history literal where it interleaves with a
  renamable symbol in the same core file. Allowlist + AST-only is the mitigation; a blind sed is
  forbidden. Isolated as its own task so a miss is scoped to this sweep.
- The hook codemod must add no `bun:sqlite` / `db.ts` import (cold-start invariant).

### Test notes

`bun run test:full` + the plan slow suite. After this lands, the only retired-name references
left in keeper-core are the frozen allowlist + the `.2`/`.3`/`.4` residue those tasks own.

## Acceptance

- [ ] src/** + incidental test/** planctl symbols/types renamed; frozen literals + schema-history literals UNCHANGED
- [ ] no `bun:sqlite` / `db.ts` import added to the events-writer hook
- [ ] one atomic mechanical commit; `bun run test:full` + plan slow suite green

## Done summary
Allowlist-guided sweep retiring 'planctl' across src/** + incidental keeper test/**: renamed symbols (PLAN_STDOUT_CAP/PLAN_FILES_CAP, parsePlanOpTrailer/parsePlanTargetTrailer/filterPlanChanges, PLAN_EXCLUDE_PREFIXES), locals, and comments. Frozen trailer scrape, the planctl_op/planctl_target data keys + planctl-commit-changed wire kind (.3 owns), and db.ts/db.test/refold schema-history literals left UNCHANGED. test:full green (3691 pass).
## Evidence
