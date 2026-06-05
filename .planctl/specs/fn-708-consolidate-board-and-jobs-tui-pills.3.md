## Description

**Size:** S
**Files:** cli/jobs.ts, test/jobs.test.ts

### Approach

Apply omit-default to the jobs view: `projectJobRow` drops `[stopped]`
via the shared state omit-default from task `.1`; the nested subagent
lines already drop `[ok]`/null via the updated `subagentLinesFor`; the
monitor `[status]` slot is removed from `monitorLinesFor` (dead — the
projection never populates it) with a restore-comment. Append the jobs
footer-legend constant to `bodyLines` in the jobs `renderBody`. Apply the
sanctioned presentation polish (pill/line ordering, spacing) where it
stays lossless; no fixed-width slots. Revise the jobs HELP constant to
the new row shape + the absence-encodes-default legend. Update the jobs
tests.

### Investigation targets

**Required** (read before coding):
- ~/docs/pill-inventory.md — Part 4 jobs render spec (job row / expanded region / banner)
- cli/jobs.ts:192-223 — `projectJobRow` (`[state]` at 210 → omit `stopped`)
- cli/jobs.ts:298-345 — `monitorLinesFor` (status slot 340-342 → remove with restore-comment)
- cli/jobs.ts:454-557, 840-876 — `renderJobsBody` + `renderBody` (where the legend line is appended; subagent lines consumed)
- cli/jobs.ts:97-168 — HELP constant (row-shape doc to revise in place)

**Optional** (reference as needed):
- src/board-render.ts — the shared state omit-default + jobs legend constant from task .1

### Risks

- test/jobs.test.ts asserts exact full-line strings (projectJobRow/monitorLinesFor/renderJobsBody are directly tested) — broad mechanical updates.
- Keep the `[dead-letter:N]` banner (already default-absent) and the two `awaiting:*` pills untouched — they are not consolidation targets.

### Test notes

Update jobs assertions to the new shapes; verify the idle-worker row
(`stopped`) loses its pill and the monitor status slot is gone. Add a
test that the legend line is present.

## Acceptance

- [ ] projectJobRow drops `[stopped]`; subagent lines drop `[ok]`/null (via task .1 helper)
- [ ] monitor `[status]` slot removed with restore-comment
- [ ] Jobs footer legend appended to bodyLines (live + sidecar)
- [ ] Sanctioned pill/line reordering applied where it improves clarity, still lossless; no fixed-width slots
- [ ] Jobs HELP revised in place to the new row shape + legend
- [ ] test/jobs.test.ts green; bun run typecheck clean

## Done summary

## Evidence
