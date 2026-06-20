## Description

Originating finding C3 (auditor Consider section; evidence path
view-model.ts:108-130 robotRung + reducer.ts:6573 SessionEnd /
reducer.ts:6637 Killed). `robotRung` checks `last_api_error_at` then
`last_permission_prompt_at`/`last_input_request_at` BEFORE the state
switch and returns error/awaiting unconditionally. The reducer's terminal
transitions (SessionEnd → ended, Killed → killed) clear only `monitors`
(and `close_kind`), NOT the annotation stamps — verified: no
`last_*_at = NULL` clear in either block. So a job that dies mid-block
keeps its stamp and the dash mis-ranks it as needs-you, with no terminal
glyph and immune to the showTerminal toggle (computed rung is non-terminal
via isTerminalRung, view-model.ts:134-136).

Fix in the view-model so terminal `state` (ended/killed) wins over a stale
annotation stamp, while a non-terminal blocked job still resolves to
error/awaiting. Keep the function pure and never-throwing.

## Acceptance

- [ ] robotRung returns ended/killed for a job whose state is ended/killed
      even when last_api_error_at / last_permission_prompt_at /
      last_input_request_at is non-null.
- [ ] A live (non-terminal) job with an annotation stamp still resolves to
      error/awaiting — no regression.
- [ ] The mis-ranked terminal job now lands in the idle band and is hidden
      unless showTerminal is set.
- [ ] Fast-tier test covers the terminal+stale-stamp case for both ended
      and killed, against both api-error and permission/input stamps.

## Done summary
robotRung now resolves terminal state (ended/killed) before annotation stamps, so a job that died mid-block paints terminal and lands in the idle band hidden by showTerminal; live blocked jobs still resolve error/awaiting. Fast-tier test covers ended+killed against api-error/permission/input stamps.
## Evidence
