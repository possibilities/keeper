## Description

**Size:** M
**Files:** plugins/plan/src/** (.ts)

### Approach

AST codemod (ast-grep / jscodeshift — NOT regex; a `StringLiteral` spelling planctl must not
be clobbered) renaming Identifier / type / import nodes across all case variants
(planctl / Planctl / PLANCTL / planctlMain) in the SELF-CONTAINED plan plugin (~722 hits /
115 files, zero core carve-outs). Includes `planctlMain` (plugins/plan/src/cli.ts export) and
`PROG="planctl"` (plugins/plan/src/cli.ts:73 — user-visible --help; verify no test asserts the
literal). Respect the .1 allowlist + lint guard; tighten the guard over this scope as it lands.
One atomic mechanical commit (no behavior change), `git rerere` enabled.

### Investigation targets

**Required:**
- plugins/plan/src/cli.ts:73 (PROG --help string) + the cli export of planctlMain
- plugins/plan/src/commit.ts:185-203 (frozen trailer emit — rename surrounding SYMBOLS, KEEP the frozen literal)

### Risks

- commit.ts interleaves a frozen trailer literal with renamable prose — allowlist-guided, AST-only, never a blind sed.

### Test notes

The plan slow suite (`PLANCTL_RUN_SLOW=1 bun test` in plugins/plan) + the .1 lint guard green over this scope.

## Acceptance

- [ ] plugins/plan/src/** planctl symbols/types/imports renamed across all case variants; one atomic mechanical commit
- [ ] frozen trailer literal in commit.ts UNCHANGED; lint guard green over the plan-plugin scope
- [ ] plan slow suite green

## Done summary

## Evidence
