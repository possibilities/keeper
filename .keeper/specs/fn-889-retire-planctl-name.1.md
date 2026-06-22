## Description

**Size:** S
**Files:** a new frozen-allowlist file; a new lint guard (no-restricted-syntax / grep pre-commit)

### Approach

Build ONLY the safety harness — the guardrail every code sweep (.6/.7/.8) and the
cleanup/migration/docs tasks (.2/.3/.4) lean on. NO code symbols are renamed here.
Enumerate the frozen-string allowlist (strings a rename must NEVER touch):
- trailer literals `Planctl-Op` / `Planctl-Target` / `Planctl-Prev-Op`;
- the git-log scrape format (`src/git-worker.ts:959-960`);
- the passthrough regex (`cli/commit-work.ts:72`);
- the `src/db.ts` schema-history literals — the `planctl_*` `CREATE TABLE` columns
  (`:435,1066-1075`), the `addColumnIfMissing("planctl_*")` ladder (`:2078-2082`), the
  v66→v67 backfill (`:3729`), and the `idx_events_planctl_*` old-name drops (`:4047-4199`);
- the Commit-event data-keys `commit.planctl_op` / `planctl_target` and the
  `planctl-commit-changed` wire kind — frozen for now; `.3` migrates them via the v81 migration.

Add the lint guard machinery (no-restricted-syntax rule or a grep pre-commit) banning the
retired name with an explicit allowlist exemption on the frozen-literal files. **Enforcement
is progressive**, not repo-wide-hard from day one: while .6/.7/.8/.2/.3/.4/.5 still hold
un-renamed references, the guard hard-fails ONLY on the frozen-literal files (catching an
accidental frozen clobber); each sweep tightens the guard over its own scope as it lands.
The repo-wide grep-clean (only the frozen allowlist remains) is the EPIC's final state after
every task lands — do not gate an individual sweep on it.

### Investigation targets

**Required:**
- src/git-worker.ts:959-960,1075 (frozen scrape format)
- cli/commit-work.ts:69-76 (frozen passthrough regex)
- plugins/plan/src/commit.ts:185-203 (frozen trailer emit)
- src/db.ts:435,1066-1075,2078-2082,3729,4047-4199 (schema-history literals — ALLOWLIST)
- src/derivers.ts:1151,1157,1282 + src/reducer.ts:2256-2269 (Commit-event struct fields — `.3` owns)

### Risks

- The allowlist is the SINGLE mitigation against clobbering a frozen/schema-history literal in
  .6/.7/.8 — incompleteness here propagates to every sweep. Enumerate exhaustively.

### Test notes

Guard passes on the current (un-renamed) tree with frozen files exempted, and fails on a
planted retired-name edit to a frozen-literal file.

## Acceptance

- [ ] frozen-allowlist file enumerates trailer literals + schema-history literals + the `.3`-owned Commit-event/wire-kind literals
- [ ] lint guard machinery banning the retired name with the allowlist exemption; hard-fails on a frozen-file clobber, green on the current tree
- [ ] NO code symbols renamed in this task (harness only)

## Done summary

## Evidence
