## Description

**Size:** S
**Files:** src/reducer.ts, test/reducer-links.test.ts, README.md

### Approach

In the `PreToolUse`/`PostToolUse` case (src/reducer.ts:6380-6415), add a third hot-path
clear for the api-error pair, mirroring the two existing clears' triad exactly: gated
`WHERE job_id = ? AND last_api_error_at IS NOT NULL`, paired-NULL
(`last_api_error_at = NULL, last_api_error_kind = NULL`), `last_event_id`/`updated_at`
bump, and `syncIfPlanRef(db, jobId, event.id, ts)` only on `res.changes > 0`.

Fold an un-stop INTO that new UPDATE and INTO the existing input-request clear UPDATE
(src/reducer.ts:6387-6397) — not as separate statements, so each clear+un-stop is one
write, one `changes > 0`, one fan-out:

- `state = CASE WHEN state = 'stopped' THEN 'working' ELSE state END`
- `active_since = CASE WHEN state = 'stopped' THEN ? ELSE active_since END` (bind the
  event `ts`)

Both CASEs gate on the literal `'stopped'` — NOT the UserPromptSubmit arm's
`state != 'working'` predicate. The narrow gate is load-bearing twice over: it can never
resurrect `ended`/`killed` rows (a killed row with a stale pair still gets its pair
cleared, state untouched), and in the subagent-suppressed api-error case (pair stamped
while state stayed `working`, src/reducer.ts:6273-6280) it leaves `active_since`
untouched so the dash timeline sort key (src/dash/view-model.ts:399-404) does not churn
on every tool event. SQLite evaluates all SET right-hand sides against the pre-UPDATE
row, so both CASEs see the same old state in one statement.

The permission-prompt clear (src/reducer.ts:6403-6413) gets NO un-stop — its stamp arm
(Notification, src/reducer.ts:6417-6452) never flips state. Add a one-line forward-facing
comment there saying why it is the odd one out, so a future reader does not "fix" it into
a fourth un-stop. All new comments state current behavior and invariants in the existing
dense rationale voice — no change history.

Subagent-stream tool events (agent_id non-null) reach this case keyed by the parent job
and already fire the existing clears; the un-stop deliberately inherits those trigger
semantics (subagent running = parent alive, the same logic as the ApiError arm's
suppress guard). Do not add an agent_id filter.

Update the README clearing-contract passages (lines 20-29, 2012-2016, 2460, and check
706-722): both annotation pairs now clear on tool activity and state un-stops to
`working`; consolidate the near-duplicate intro/fan-out prose so one passage is
canonical; echo the existing active_since rising-edge language at README:1810-1816
rather than re-explaining.

Fold-purity constraints: the new SQL reads only the event `ts` and the persisted row —
no `Date.now()`, no env, no filesystem, no JSON parsing, nothing that can throw. No
schema change (all five columns exist at v65) — do not bump SCHEMA_VERSION.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:6380-6415 — the case being extended; the two existing clears are the exact template
- src/reducer.ts:6021-6041 — UPS revival; copy the active_since stamping mechanics (bound ts) but NOT its `!= 'working'` predicate
- src/reducer.ts:6257-6292 — ApiError/RateLimited stamp arm; the dual-case legacy alias and the subagent-suppression CASE both shape the test matrix
- test/reducer-links.test.ts:5098-5219 — hot-path-clear tests, the no-op last_event_id gate test, and the re-fold determinism pattern (drain, snapshot jobs, reset cursor + delete, re-drain, expect equal)
- test/reducer-links.test.ts:52-178 (insertEvent) and :225-233 (drainAll) — the event builder + fold-to-fixpoint helpers every new test uses

**Optional** (reference as needed):
- test/reducer-links.test.ts:3132-3233 — RateLimited (legacy) and ApiError fixtures plus the byte-identical equivalence test both new tests must keep honest
- test/reducer-links.test.ts:4893-4907 — getInputRequestState helper; add a parallel getApiErrorState in this exact shape (none exists)
- src/autopilot-worker.ts:705-720, :1666-1679 — confirmed neutral consumers (working and stopped are the same partition); no changes there

### Risks

- A wrong CASE predicate propagates through every future re-fold — the terminal-row and
  subagent-suppressed tests are the guard rails, write them first.
- Three syncIfPlanRef call sites now live in the hottest fold path; each must stay gated
  on its own `changes > 0` so the all-NULL common case remains a zero-write no-op.
- If both pairs are set on one row, two UPDATEs fire on one tool event: the first
  un-stops and stamps active_since, the second's CASEs no-op. Statement order is fixed,
  so this is deterministic — but the re-fold test should cover the both-pairs sequence.

### Test notes

Matrix (each via insertEvent + drainAll, asserting state + pair + active_since):
1. ApiError stale-stop → tool event → state `working`, pair NULL, active_since = tool event ts.
2. Same for RateLimited (legacy alias) — keep the fold-equivalence with ApiError honest.
3. Subagent-suppressed: pair stamped while state stayed `working` → tool event → pair NULL, state still `working`, active_since UNCHANGED.
4. InputRequest stop → tool event → state `working` (pair clear already covered by existing tests — extend them for state).
5. Terminal: killed row with stale pair → tool event → pair NULL, state still `killed`.
6. No-op gate: both pairs NULL → tool event → last_event_id does NOT advance (mirror :5154-5184).
7. Re-fold determinism for the stamp→stop→tool→working sequence (mirror :5186-5219).

`bun test test/reducer-links.test.ts` for the loop; `bun run test:full` mandatory before
landing (reducer path).

## Acceptance

- [ ] Third hot-path clear for the api-error pair lands in the Pre/PostToolUse case, matching the existing clears' gate/paired-NULL/changes>0 triad
- [ ] Un-stop (state + active_since, both `CASE WHEN state = 'stopped'`) is folded into the api-error AND input-request clear UPDATEs as single statements
- [ ] Permission-prompt clear untouched except the why-no-un-stop comment
- [ ] Test matrix items 1-7 all pass; RateLimited/ApiError equivalence preserved
- [ ] README clearing-contract passages updated and consolidated per the epic Docs gaps
- [ ] `bun run test:full` passes; no SCHEMA_VERSION bump; no new throw paths inside the fold

## Done summary
Pre/PostToolUse fold now clears the api-error pair (new third hot-path clear) and un-stops both the api-error and input-request stopped rows back to working (state + active_since, gated on literal 'stopped'), so the board never shows a dead/failed worker that resumed. README clearing-contract consolidated.
## Evidence
