## Overview

Real-git effect tests exist (plugins/plan/test/worktree-*.test.ts behind KEEPER_PLAN_RUN_SLOW) but no routine gate runs them — a git-effect regression currently passes every default gate. This epic makes the slow tier trustworthy (isolated, de-rotted), wires it as a hard gate at the promotion moment (promote.sh), and verifies the sitter schema-observation channel so the shipped dispatch-storm fix (fn-1061 lineage) has live confirmation. The fast tier stays pure per the CLAUDE.md test-isolation invariant.

## Quick commands

- `cd plugins/plan && bun run test:slow` — run the real-git slow tier directly
- `plugins/plan/scripts/promote.sh` — must now run the slow tier and block on failure
- `plugins/plan/scripts/promote.sh --skip-slow` — documented emergency bypass with a loud warning

## Acceptance

- [ ] The plan slow tier passes repeatedly (3 consecutive clean runs) under full git-env isolation on this machine
- [ ] promote.sh runs the slow tier by default and hard-fails promotion on any slow-tier failure; `--skip-slow` bypasses with a visible warning
- [ ] `bun test` fast tier remains pure — no real-git tests moved in, test-full.ts slow-var env scrub preserved
- [ ] consistency-generated-guard.test.ts passes on a clean checkout (workers/ absent) and on a rendered tree
- [ ] The sitter repin channel is verified live against keeper's current schema version, with the verification procedure written down

## Early proof point

Task that proves the approach: `.1` (slow suite passes clean in isolation). If it fails: fix the rot first — do not wire a broken suite into promote; the gate task is blocked on a green tier by design.

## References

- plugins/plan/test/harness.ts:729-735 — describe.skipIf(!SLOW_ENABLED) slow-gating pattern
- scripts/test-full.ts — env scrub of KEEPER_RUN_SLOW/KEEPER_PLAN_RUN_SLOW from fast children (must be preserved)
- .keeper/specs/fn-1061-dedup-autopilot-dispatch-mint.md:46 — the verification caveat this epic closes
- ~/code/sitter README repin-lane section (~lines 145-157) — the external observation channel

## Docs gaps

- **CLAUDE.md** (Test isolation section): one sentence naming the promote-time slow gate as the routine entry point — net-neutral, keep lint-claude-md.ts green
- **plugins/plan/CLAUDE.md** ("Test (real-git slow tier)" row): update if the invocation path or gated test list changes
- **scripts/test-full.ts** header comment: note any new knob
- **~/code/sitter README** repin section: add the verification procedure if missing

## Best practices

- **Fast tier = hard commit gate; slow tier = promotion gate:** the consensus two-stage pipeline — slow coverage migrates DOWN to the fast tier whenever it catches a regression [martinfowler.com/articles/continuousIntegration.html]
- **Retry only infrastructure-class errors:** never retry assertion failures — a retry masking a worktree-path bug is the exact fn-982/985/1050 failure class
- **Git env isolation on subprocess env, never process.env:** process.env is process-wide in Bun; parallel test workers contaminate each other
