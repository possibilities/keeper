## Description

**Size:** M
**Files:** cli/jobs.ts, test/jobs.test.ts

Three coupled render-shape changes to the `keeper jobs` view, plus the
pure-function tests that pin those shapes.

### Approach

1. **Pill reshape** — rewrite `backendCoordsSeg` to emit `[<tab> p<pane>]`:
   drop the leading `·`, the `backend_exec_type` ("zellij"), and the
   session id. Fallbacks: tab name → tab id → drop; pane missing drops
   ` p<pane>`; tab AND pane both missing → `""` (nothing left to show).
   Bracketing means `colorizePillsInLine` now tints it like other pills.
2. **Session sections** — replace the `plan_verb`-based interactive/autopilot
   split in `renderJobsBody` (and the matching order in `selectableJobIds`)
   with one section per `backend_exec_session_id`, first-seen order,
   header `--- <session> ---`; null session → `--- (no session) ---`.
   Factor a shared `groupJobsBySession` helper so render order and
   selection order stay in lockstep. The `[role]` head-line pill stays.
3. **Collapse + caret** — move the backend pill OUT of `projectJobRow`'s
   always-shown continuation lines into the collapse-controlled region of
   `renderJobsBody` (rendered before sub-agent lines when the job is
   expanded). Show the disclosure triangle on EVERY job row in insert mode
   (not just jobs with children). Keep the `[awaiting:<kind>]` line
   always-visible in `projectJobRow`. Collapse/expand stays insert-mode
   only (space toggles), so backend pills are simply hidden in normal mode.

Update the file's header/JSDoc comments that describe the old
interactive/autopilot frame shape and the ` · <type> <session>/<tab>` segment.

### Investigation targets

**Required** (read before coding):
- cli/jobs.ts:228-256 — `backendCoordsSeg`, the segment being reshaped into a pill
- cli/jobs.ts:183-209 — `projectJobRow`, where backend continuation line is removed
- cli/jobs.ts:295-307 — `selectableJobIds`, the interactive/autopilot order to regroup
- cli/jobs.ts:333-431 — `renderJobsBody`, partition + decorate logic to regroup + collapse
- cli/jobs.ts:370-383 — `decorateJobRow` triangle gating (`hasChildren`) → caret on every row
- test/jobs.test.ts — every assertion pins the old shapes; rewrite to match

## Acceptance

- [ ] `backendCoordsSeg` returns `[<tab> p<pane>]` with no `·`/type/session; fallbacks for missing tab/pane verified
- [ ] `renderJobsBody` groups by `backend_exec_session_id` with `--- <session> ---` / `--- (no session) ---` headers; `selectableJobIds` matches that order
- [ ] backend pill is collapse-controlled and renders before sub-agent lines when expanded; caret on every job row in insert mode
- [ ] `[awaiting:<kind>]` line stays always-visible
- [ ] `bun test test/jobs.test.ts` passes; stale JSDoc updated

## Done summary
Regrouped keeper jobs view by backend_exec_session_id (replacing the interactive/autopilot split), reshaped backendCoordsSeg into the bracketed '[<tab> p<pane>]' pill, moved the backend pill into the collapse-controlled region of renderJobsBody, and now show the disclosure caret on every job row in insert mode. The [awaiting:<kind>] line stays always-visible. 35/35 tests in test/jobs.test.ts pass.
## Evidence
