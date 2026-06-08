## Overview

Two `keeper-watch` detector / triage quality fixes surfaced by the 2026-06-08
followup synthesis. Neither is a product rollback and neither touches the
event log, reducer, projections, or RPC surface — the babysitter stays a pure
read-only external scanner + read-only headless triager (keeper CLAUDE.md
invariant). Scope is signal wording + merit-judgment evidence rules only.

1. **Approval-review merit signal overstates "unmerited."** The fn-732/fn-733
   approval-review followups read as "unmerited approval" when the real issue
   was thin approval evidence ("Background monitor stopped — no action needed")
   and/or a duplicate approver — while the work actually LANDED (planctl
   07a52e0/4162011/7de6992; keeper c1c3fc4/fccc255/ddc0710). The merit
   judgment must require commit/test/context evidence before asserting
   unmerited, must separate "work merited but duplicate approver" from "merit
   unknown," and must point at BOTH keeper and planctl repos when a task spans
   repos (fn-732 did).

2. **Backstop staleness wording conflates timeout with missed-wake.** The
   `backstop-staleness` finding hardcodes "— a fast path dropped a wake-up"
   for EVERY class, so `timeout`-class backstops (`autopilot-ceiling`,
   `pending-dispatch-sweep`, where `fast_path` is null) get mislabeled as
   missed-wakes. This confused the latest triage into reading timeout and
   missed-wake as identical.

## Quick commands

- `bun test test/keeper-watch.test.ts`
- `KEEPER_WATCH_STATE_DIR=/tmp/kw-fn738 bun cli/keeper-watch.ts --json --window-secs 7200`  # eyeball detail strings

## Acceptance

- [ ] Approval-review prompts never assert a rollback-worthy "unmerited"
  conclusion without verified absence of work (commit/test/context check).
- [ ] "Work merited but duplicate approver" is classified separately from
  "approval merit unknown"; thin final-message cases ask for evidence
  collection, not immediate rejection.
- [ ] Cross-repo tasks (e.g. fn-732) produce prompts that point at both the
  keeper and planctl repos.
- [ ] `missed-wake` findings mention a dropped fast-path wake; `timeout`
  findings mention an elapsed dispatch/confirm/sweep timeout (no "fast path"
  language); tests cover both variants.
- [ ] No event-log write, synthetic event, or RPC introduced — babysitter
  stays read-only.

## References

- Synthesis: `~/docs/keeper-followups-synthesis-2026-06-08.md` §4 + Open Q4.
- Proposal: `~/docs/keeper-followups-epic-plan-proposal-2026-06-08.md`.
- `cli/keeper-watch.ts:582` `detectApprovalReview` (scanner only surfaces,
  does not judge); `:905` `backstop-staleness` hardcoded wording; `:943`
  missed-wake DELTA wording (already correct — mirror it).
- `.claude/agents/keeper-babysitter.md` §"2. approval-review — apply merit
  judgment" (~:97-135) — where the merit/evidence rules live.

## Best practices

- The file has a binary byte — use `grep -a` when searching `cli/keeper-watch.ts`.
- Keep the scanner pure: `detectApprovalReview` surfaces per-op; merit
  judgment is the headless agent's job. Don't move merit logic into the scanner.
