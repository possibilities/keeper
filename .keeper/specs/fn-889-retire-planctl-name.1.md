## Description

**Size:** M
**Files:** keeper `src/**`, `cli/**`, `plugins/plan/src/**`, `test/**` (.ts/.py incidental naming); a new frozen-allowlist file; a new lint guard

### Approach

Build the safety harness, then sweep. FIRST enumerate the frozen-string allowlist (the strings a rename must NEVER touch): the trailer literals `Planctl-Op`/`Planctl-Target`/`Planctl-Prev-Op` + the git-log scrape format (`git-worker.ts:959-960`) + the passthrough regex (`cli/commit-work.ts:72`); AND the `src/db.ts` schema-history literals (`CREATE TABLE` `planctl_*` columns `:435,1066-1075`, the `addColumnIfMissing("planctl_*")` ladder `:2078-2082`, the v66→v67 backfill `:3729`, the `idx_events_planctl_*` old-name drops in the v78 block `:4047-4199`). Then run an AST codemod (jscodeshift/ast-grep — NOT regex; a `StringLiteral` spelling planctl must not be clobbered) renaming Identifier/type/import nodes across all case variants (planctl/Planctl/PLANCTL/planctlMain) using negative-lookahead identifier boundaries: `planctlMain` (cli/plan.ts:22 + plugins/plan/src/cli.ts export), `cli/await.ts` `"planctl"` slot KIND + types (~56 hits — VERIFY the discriminant is never serialized to the external met/failure line at await.ts:709,916 before renaming), `PLANCTL_STDOUT_CAP`/`PLANCTL_FILES_CAP` (derivers.ts), `parsePlanctlOpTrailer`/`parsePlanctlTargetTrailer`/`filterPlanctlChanges` (git-worker.ts — rename the SYMBOL, keep the literal it reads), `PROG="planctl"` (plugins/plan/src/cli.ts:73 — user-visible --help; verify no test asserts it), test-description strings. Land as ONE atomic mechanical commit (no behavior change) with `git rerere` enabled. Add a lint guard (no-restricted-syntax / a grep pre-commit) banning the retired name with an explicit allowlist exemption on the frozen-literal files. Do NOT rename: the Commit-event data-key reads/struct fields `commit.planctl_op`/`planctl_target` (that's `.3`'s migration), the `planctl-commit-changed` wire kind (that's `.3`), or the schema-history literals.

### Investigation targets

**Required:**
- src/git-worker.ts:959-960,1075,1096,858 (frozen scrape vs renamable parse symbols); cli/commit-work.ts:69-76 (frozen regex + incidental comment HOTSPOT)
- plugins/plan/src/commit.ts:185-203 (frozen trailer emit + renamable surrounding prose HOTSPOT)
- cli/await.ts:238,399,623-624,709,916 (planctl slot kind + the external-line contract to verify)
- src/db.ts:435,1066-1075,2078-2082,3729,4047-4199 (schema-history literals — ALLOWLIST, do not touch)
- src/derivers.ts:1151,1157,1282 + src/reducer.ts:2256-2269 (Commit-event struct fields — OUT of scope, `.3` owns them)

### Risks

- #1 correctness risk: clobbering a frozen literal or a schema-history literal. The allowlist + AST-only transform is the mitigation; a blind `sed` is forbidden.
- The events-writer hook codemod must not introduce any `db.ts`/`bun:sqlite` import.

### Test notes

`bun run test:full` + the plan slow suite. The grep done-gate (Acceptance) must return only the allowlist after this task (minus the `.2`/`.3`/`.4`/`.5` residue those tasks own).

## Acceptance

- [ ] frozen allowlist file enumerates trailer literals + schema-history literals; lint guard bans the retired name with that exemption
- [ ] AST codemod renamed incidental symbols/types/test-descriptions across all case variants; one atomic mechanical commit; rerere enabled
- [ ] frozen literals + schema-history literals UNCHANGED; await.ts discriminant confirmed non-serialized before rename
- [ ] `bun run test:full` + plan slow suite green

## Done summary

## Evidence
