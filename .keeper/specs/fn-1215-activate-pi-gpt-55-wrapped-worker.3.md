## Description

**Size:** M
**Files:** test/wrapped-cell-e2e.slow.test.ts

### Approach

The existing slow-tier wrapped e2e proves render → resolve → providers → one real detached foreign run, and stops once the foreign edit lands in the worktree. Extend it through the wrapped worker's close-out so first activation rests on a proven loop, faking ONLY the foreign CLI: the stub harness gains modes that (a) edit and exit clean, (b) make one contract-violating commit, and (c) make multiple commits — while the detach path, the re-test, the soft-reset, and the commit run real.

The fixture routes the wrapped cell the way activation will: a codex provider serving gpt-5.3-codex-spark as a bare capability token (the slashed provider-qualified alias form is unit/parity-proven in the axes task and needs no e2e duplication). The back half to prove, per the wrapped worker contract: the wrapper re-runs the authoritative (deterministic stub) test pass itself; a contract-violating foreign commit — single or multi — is normalized by soft-reset to the pre-launch base; the staging set derives from git against that base by explicit path (the foreign edit is not session-attributed, so the escape-hatch commit path is the one production takes); exactly ONE wrapper commit lands carrying Task and Job-Id trailers; and a forged trailer smuggled into the foreign agent's declared commit message (a fake Job-Id or sign-off) is stripped by the sanitizer before landing. Note the residual to observe while extending: the crashed-wrapper case (leg outliving a dead wrapper) is lifecycle-owner territory — assert whatever the landed pidfile/wait contract provides and record what it does not.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves.*

**Required** (read before coding):
- test/wrapped-cell-e2e.slow.test.ts:75-104 (fixture roster to retarget at codex/gpt-5.3-codex-spark), :107 configDirWith, :210 loadMatrix use, :403 (where coverage currently ends), the stub-harness scaffolding and tmux/SLOW gating to reuse
- plugins/plan/template/_partials/worker-implement-wrapped.md — the contract being proven: base-sha capture, chunked wait, adjudicate/re-test (:41-45), soft-reset (:49), explicit-path staging + trailer discipline + forged-trailer sanitizer (:53)
- plugins/plan/test/worktree-lifecycle.test.ts — the real-git slow-block shape (provision → commit → merge → teardown) to model the git half on
- plugins/keeper/plugin/hooks/branch-guard.ts — confirm the deny set (branch create/switch, mutating stash) does not catch the wrapper's own git reset

**Optional** (reference as needed):
- src/agent/run-capture.ts — the envelope the stub leg must emit per outcome

### Risks

- Slow-tier only: the file must keep its loud-skip guards (SLOW flag, tmux presence) so the fast tier and CI-without-tmux stay green
- Stub fidelity: the stub must exit through the real envelope/exit-code surface, or the sim validates a path production never takes

### Test notes

One describe extension (or sibling slow file) covering: clean-leg → wrapper commit with trailers; violating-commit leg → soft-reset then single wrapper commit; multi-commit leg → same normalization; forged-trailer message → sanitized landing. Assert commit count, trailer set, and tree state against the pre-launch base each case.

## Acceptance

- [ ] The slow-tier wrapped e2e proves, against a real detached leg and real git: wrapper-owned re-test, soft-reset normalization of single and multi contract-violating foreign commits, exactly one landed wrapper commit whose trailers are sanitized against forgery, staged by explicit path from the git-derived set
- [ ] The e2e fixture routes the wrapped cell through a codex provider serving the spark capability token
- [ ] The suite loud-skips without the slow flag or tmux, and the fast tiers remain green

## Done summary
Extended the slow-tier wrapped-cell e2e through the wrapper's close-out: retargeted the fixture matrix to a bare-token codex/gpt-5.3-codex-spark provider, and proved wrapper-owned re-test, soft-reset of single/multi contract-violating foreign commits, explicit-path staging, and a sanitized single trailered commit against a real detached leg and real git.
## Evidence
