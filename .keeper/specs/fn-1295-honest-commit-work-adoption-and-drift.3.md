## Description

**Size:** M
**Files:** src/commit-work/surface.ts, cli/commit-work.ts, cli/descriptor.ts, cli/agent.ts, CONTEXT.md, docs/problem-codes.md, test/commit-work-adoption.test.ts, test/commit-work-process-identity.test.ts

### Approach

Two halves of ADR 0068 decisions 2-3. First, vacated claims: a foreign
claimant proven gone by the pid-and-start-time witness (pid absent, or
start time mismatched via the existing dep-free src/proc-starttime.ts
seam) classifies its claims adoptable, read-side only — no new RPC, no
schema step, the durable record persists. A witness read failure fails
closed to the existing refusal. A stopped-but-resident claimant with a
matching start time is never auto-vacated. Second, the sanctioned
operator verb `keeper session terminate <session-reference>`: resolve
the session, re-check identity as (pid, start_time) plus a
claude/pi-command check, TERM then bounded KILL — a process signal
only, never a DB write; terminal evidence folds from the exit like any
death. Refuse a working session. Also land the glossary: add Vacated
claim + Receipts-pending to CONTEXT.md's commit-ownership section
(definitions in ADR 0068) TOGETHER WITH the prune that brings
CONTEXT.md under the domain-docs lint's 140-line cap — consolidate
per rule #0, judgment required, deletions must not orphan terms other
docs reference.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/commit-work/surface.ts:1169-1185 — defaultClaimLiveness; where the gone-witness verdict joins
- src/proc-starttime.ts — the (pid, start_time) witness seam
- cli/descriptor.ts:988-1019 — flag/verb descriptor pattern for the new session verb
- src/commit-work/domain-docs-lint.ts — the 140-line CONTEXT.md cap + entry-shape rules the glossary edit must satisfy
- test/commit-work-process-identity.test.ts — the existing identity-witness test surface

**Optional** (reference as needed):
- docs/adr/0060-zombie-session-hybrid-reaper.md — the identity-recheck TERM-then-KILL discipline to mirror
- docs/adr/0068-commit-work-vacated-claims-and-honest-drift.md — decisions 2-3

### Risks

- The gone-witness must never classify a merely-suspended or briefly-unreadable process as gone; any inconclusive witness read stays fail-closed.
- The terminate verb is operator-facing power: identity re-check at signal time (pid recycled between resolve and kill) is mandatory; mirror the reaper's discipline.
- The CONTEXT.md prune is editorial: prefer consolidating verbose entries and merging near-duplicates over deleting load-bearing terms.

### Test notes

Matrix rows: pid absent → adoptable; start-time mismatch → adoptable;
matching start-time resident → refused; witness error → refused.
Terminate verb: pure seam tests for the identity-recheck decision
(no real processes in the fast tier). Glossary: the domain-docs lint
passing IS the check — run a commit-work preview or the lint arm
directly.

## Acceptance

- [ ] A gone-proven claimant's paths adopt without operator intervention; a matching-start-time resident claimant still refuses
- [ ] An inconclusive liveness witness leaves the refusal in place
- [ ] `keeper session terminate` TERM-then-KILLs only an identity-confirmed non-working claimant session and never writes the DB
- [ ] CONTEXT.md carries both new terms, passes the domain-docs lint including the line cap, and no removed term is referenced elsewhere in docs
- [ ] The touched suites pass plus the fast gate

## Done summary
Implemented vacated-claim liveness and guarded session termination; operator landed the verified diff through the documented exact-path plain-git escape after commit-work rejected the terminated provider-leg claims.
## Evidence
- Commits: a68dee59dd82c4e1366cc7f4f58ffa7cd46a1150
- Tests: bun test ./test/commit-work-adoption.test.ts ./test/commit-work-process-identity.test.ts ./test/keeper-cli.test.ts — 228 pass, 0 fail, git diff --check — clean, scanContextDoc(CONTEXT.md) — zero findings at 135 lines, provider-leg PIDs 83761 and 54666 absent before exact-path commit