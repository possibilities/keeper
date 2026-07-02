## Description

**Size:** S
**Files:** src/autopilot-worker.ts, src/worktree-git.ts, test/autopilot-worker.test.ts, test/worktree-git.test.ts, README.md

### Approach

In `recoverWorktrees`' per-repo loop preamble, skip any repo that is a linked worktree, probing via the already-injected `run` (`isLinkedWorktree`, src/worktree-git.ts:386 — currently zero external call sites). The probe must distinguish three outcomes: linked (skip permanently this cycle), main/standalone (proceed), and PROBE ERROR — which DEFERS the repo for this cycle (skip without recovering) per the house rule that every probe inconclusive/error defers; the current `isLinkedWorktree` fails open on nonzero exit, so either extend it (or wrap it at the call site) to surface the error case distinctly rather than folding error into "not linked". Level-triggered retry makes a one-cycle defer safe. In the same change, append the operator remedy to the `worktree-recover-not-on-default` reason DETAIL (after the colon — the `worktree-recover-not-on-default` token and the `worktree-recover` family prefix are load-bearing for auto-clear scoping via `isWorktreeRecoverReason` and must not change): name the expected default-branch switch or dirty-checkout resolution the operator should perform. Update the README recover-sweep membership prose (~3559-3584) and the reason-string mention (~3565-3567).

Heads-up: src/autopilot-worker.ts contains a real NUL byte around offset 175300 — plain grep/rg silently stop below ~line 5000; use `rg -a`.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:4535-4661 — `recoverWorktrees` entry, per-repo loop preamble, and the off-branch reason mint
- src/autopilot-worker.ts:4939-4991,5435-5449 — `reposForRecovery`, the knownRoots union, and how lanes leak in via `toplevelResolver`
- src/worktree-git.ts:220,386-404 — `isLinkedWorktreePure` + wrapper, including the fail-open nonzero-exit behavior to surface
- test/autopilot-worker.test.ts:7357-7460 — the `makeRecoverRun` harness for sweep tests

**Optional** (reference as needed):
- test/worktree-git.test.ts:87-128,318-343 — existing isLinkedWorktree tests to extend
- test/autopilot-worker.test.ts:7634 — the existing pass-1 skips-non-keeper-lane test shape

### Risks

- The three-state probe must not change `isLinkedWorktree`'s existing callers' semantics (there are none outside its module today, but its tests pin fail-open — extend deliberately)
- The reason-detail edit must keep the leading token byte-identical or auto-clear and operator tooling stop recognizing the family

### Test notes

Red-first: a sweep-set test with a lane present in the git projection must fail on current source (lane swept → off-branch row minted) and pass with the filter. Cover: linked → skipped; main → recovered; probe error → deferred this cycle with no row minted. All through the injected `run` — no real git.

## Acceptance

- [ ] A lane in the sweep set is skipped; a probe error defers the repo; a main checkout recovers as before
- [ ] `worktree-recover-not-on-default` reason names the remedy in its detail; token and family prefix byte-unchanged
- [ ] Red-first sweep test exists; full fast suite green

## Done summary
Filter linked worktrees out of the recover sweep via a tri-state classifyLinkedWorktree probe (linked lane skipped; probe error defers the repo, never fail-open into off-branch), and name the operator remedy in the worktree-recover-not-on-default reason detail (token/family prefix byte-unchanged). Added red-first sweep tests + tri-state probe tests.
## Evidence
