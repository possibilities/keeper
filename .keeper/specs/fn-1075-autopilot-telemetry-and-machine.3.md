## Description

**Size:** M
**Files:** src/commit-work/attribution.ts (read-only reuse), plugins/plan/src/ (reconcile/worker-resume seam), plugins/plan/template/agents/worker.md.tmpl, plugins/plan/plugin/hooks/ (stop-guard family)

### Approach

Promote the close-out discipline from prose+per-call-tips to a machine gate on the
session_files observable (discoverSessionFiles/getSessionDirtyFiles in
src/commit-work/attribution.ts — live git ∩ undischarged file_attributions, fail-open
per-repo). Evidence: 3 of 4 sampled work-cells reconciled in_progress_uncommitted and needed
the identical warm-resume nudge; a Bash hook now injects commit-work tips on every call to
compensate. Design the gate at the seam that already detects the condition — the plan-side
reconcile/worker-resume path that classifies in_progress_uncommitted — so the nudge fires
automatically and deterministically (the exact resume message that already works), and/or the
worker's stop path checks the observable before yielding (stop-guard family — remember: hooks
always exit 0, block via envelope, fail-open on git-read failure but emit a VISIBLE signal
when the gate opens on failure rather than silently passing). Move the worker template's
own-your-close-out rule to the top of the prompt (worker.md.tmpl) as the single statement of
the contract; once the gate holds in practice, the every-call Bash-hook tips retire (that
retirement belongs to the prose-prune epic — note it, don't do it here). No new RPC: the gate
consumes existing reads.

### Investigation targets

**Required** (read before coding):
- src/commit-work/attribution.ts — discoverSessionFiles/getSessionDirtyFiles seams
- plugins/plan/src/ reconcile + worker-resume — where in_progress_uncommitted is classified and the resume message built
- plugins/plan/plugin/hooks/stop-guard.ts + subagent-stop-guard.ts — the yield seam and its envelope contract
- plugins/plan/template/agents/worker.md.tmpl Phase 5 — the current self-check prose

### Risks

- Fail-open is mandatory (a git-read failure must never wedge a worker) but silent fail-open recreates the problem — pair the open gate with a visible marker in the resume/reconcile output.
- Do not hard-block a yield the human initiated (interrupts are legitimate); gate the autopilot-driven close-out path.

### Test notes

Plan-suite tests through the pure seams (setExec/setVcs): dirty session → gate fires the
resume nudge; clean → passes; git-failure → passes WITH visible marker. No real git in tests.

## Acceptance

- [ ] Worker yielding with undischarged files gets the deterministic machine nudge/block; clean yields pass untouched
- [ ] Gate failure mode is fail-open WITH a visible signal
- [ ] worker.md.tmpl carries the close-out contract at top-of-prompt; renders regenerated

## Done summary

## Evidence
