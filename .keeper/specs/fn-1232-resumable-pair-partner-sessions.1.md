## Description

**Size:** M
**Files:** src/agent/resume-policy.ts, test/agent-resume-policy.test.ts

### Approach

A pure module mapping a name-or-id to a resume decision, reusing the bus's
`resolveTarget` with an empty live-channel set — never a second resolver.
Contract: input `(target, db, requireHarness?)`; output a discriminated
union — `ok` carrying `{job_id, harness, resume_target, cwd, title}`,
`live` (refused, names the live candidate, points at `keeper bus chat
send`), `ambiguous` (lists candidates with id + harness + title +
updated_at), `unknown`, and `no-target` (matched row, unusable
resume_target). Policy on top of the raw resolution: liveness is the pid +
start_time recycle identity (the same check the bus worker runs, built
from the dep-free proc-starttime helpers); multiple non-live matches
collapse to newest `updated_at` (the pick is the caller's to echo); a tie
is `ambiguous`; a newest-match that is live refuses — never silently
resume an older dead duplicate. `resolveTarget`'s identity result carries
neither harness nor resume_target, so the module does a second read-only
jobs lookup by the resolved job_id; NULL harness normalizes to claude.
NULL resume_target: codex attempts the existing read-only back-fill seam
(`resolveCodexResumeTarget`) before failing actionable; claude/pi/hermes
fail loud (their targets are pinned at birth or filled post-stop — NULL
means not-resumable). The DB opens read-only; the module never writes.
A name is a lookup that resolves to a resume target, never a resume key
(CONTEXT.md discipline).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/bus-identity.ts:360 — resolveTarget contract; :81 LIVE_PREFER_ORDER (newest-first sort exists); :205 collapseByLive (with [] channels every >1 set returns ambiguous — the module implements its own newest collapse over non-live candidates)
- src/bus-worker.ts:803 — isLiveIdentity (isPidAlive + readStartTime === start_time), the exact recycle check to mirror; :1708-1714 the read-only openDb posture (readonly:true, prepareStmts:false)
- src/agent/codex-session-index.ts:141 — resolveCodexResumeTarget option shape (codexHome/jobId/expectedCwd/startedAtMs)
- src/agent/harness.ts:244 — harnessOrClaude NULL normalization
- test/bus-identity.test.ts:29 — the seedJob freshMemDb helper shape to reuse

**Optional** (reference as needed):
- src/db.ts:3785-3787, :1530 — jobs.resume_target/harness/name_history columns
- cli/show-job.ts:472 — CLI-side read-only open pattern

### Risks

- Rows with NULL pid/start_time cannot run the recycle check — treat as not-live (they cannot be reached over the bus either); document the choice in the module doc comment
- The second jobs lookup must read the SAME row the resolver picked (key on job_id, not re-resolve)

### Test notes

freshMemDb-seeded jobs rows per the bus-identity test helper: tiers
(current name / former name exact-only / id prefix / substring
current-title-only), live refusal (pid alive + start_time match),
recycled-pid treated dead, newest collapse, tie ambiguity,
requireHarness mismatch, NULL-target branches per harness. No real
daemon/subprocess; pure fast tier.

## Acceptance

- [ ] Resolving a current name, any former name, a full session id, and a unique id prefix each returns ok with the matched row's harness, resume target, and recorded cwd
- [ ] A target whose newest match is a live process (pid + start-time identity) returns the live refusal naming that candidate; a recycled pid does not count as live
- [ ] Multiple non-live matches resolve to the newest by updated_at; an exact tie returns ambiguous listing every candidate with id and harness
- [ ] requireHarness mismatch and unknown targets return their distinct error kinds; a codex row with a NULL resume target attempts the rollout back-fill before erroring, other harnesses error immediately
- [ ] The module opens the database read-only and the fast suite covers every union branch

## Done summary

## Evidence
