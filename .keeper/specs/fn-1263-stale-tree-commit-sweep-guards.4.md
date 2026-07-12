## Description

**Size:** S
**Files:** src/dispatch-command.ts, cli/autopilot.ts, src/daemon.ts, test/dispatch-command.test.ts, test/rpc-handlers.test.ts

### Approach

The `retry_dispatch` wire validator (src/dispatch-command.ts) accepts only
`work|close|approve`, while root CLAUDE.md documents `retry_dispatch` as the repair row's
re-arm ("a decline pages once ... until retry_dispatch re-arms it"). Code drifted from the
documented contract: a `repair::<repo>` session that dies mid-verification leaves
`repair_dispatched_at` stamped so the sweep will not re-dispatch, the level-clear needs
positive evidence a broken base cannot produce, and the operator wire rejects the verb — the
sticky is stranded forever (a live specimen existed on this board).

Change: add `"repair"` to `RetryDispatchVerb` and `RETRY_DISPATCH_VERBS` and the validator
error string. `unblock`/`deconflict`/`resolve` STAY excluded — the wire remains deliberately
narrow. Rewrite the now-false separation commentary to the new truth: repair is retryable
because its sticky row carries a verb no other wire can clear, while the merge-conflict
escalation latches sit on retryable `work::`/`close::` rows; the sets are narrow by policy,
not structurally disjoint. NO reducer change: `foldDispatchCleared` already DELETEs
generically on (verb,id) — deletion carries `repair_dispatched_at`, `human_notified_at`, and
`instance_event_id` with it, and the SHARED_BASE_BROKEN sweep re-mints from live evidence
with fresh latches, which IS the re-arm semantics. Keep the boot orphan-GC repair exemption
in src/daemon.ts (the live level-trigger still owns the happy-path clear) but rewrite its
justification comment where it cites un-retryability. Update the `keeper autopilot retry`
help text in cli/autopilot.ts (it enumerates `work|close|approve`). AUDIT: `repair` now
appears in both arms of `DispatchableVerb` and `isEscalationVerb("repair")` stays true —
check every call site of `isEscalationVerb` and every `RETRY_DISPATCH_VERBS` consumer for an
assumption that the two sets are disjoint, and record the audit result in Evidence. This task
is READ-ONLY on src/reducer.ts and src/db.ts (verification only — a paused epic owns schema
work in that neighborhood). All comments forward-facing; the doc-vs-code history belongs in
the commit message. The decision record (ADR) is authored by the sibling
jam-promotion task; do not write an ADR here.

### Investigation targets

*Verify before relying — cited by file + symbol; the repo moves, so re-locate with search.*

**Required (read before coding):**
- src/dispatch-command.ts — `RetryDispatchVerb`, `RETRY_DISPATCH_VERBS`, `EscalationVerb`,
  `DispatchableVerb`, `parseDispatchKey`, `isRetryableDispatchKey`, `isEscalationVerb`, and
  the separation commentary.
- src/rpc-handlers.ts — `retryDispatchHandler` / `parseDispatchKey` wrapper /
  `RetryDispatchResult` (should need no code change; verify types flow).
- src/reducer.ts — `foldDispatchCleared` (verify the generic (verb,id) DELETE covers
  dispatch_failures and the sibling dispatch tables; read-only).
- src/daemon.ts — the boot orphan-GC repair exemption and its comment; `runRepairEscalationSweep`
  re-dispatch conditions (the re-arm path to assert in tests).
- cli/autopilot.ts — the retry verb enumeration in help text.

**Optional:**
- test/dispatch-command.test.ts, test/rpc-handlers.test.ts — existing validator/handler test
  shapes to extend.

### Risks

- A hidden call site assuming retryable and escalation verbs are disjoint would silently
  misroute repair rows — the audit acceptance item exists for exactly this.

### Test notes

Validator: `repair::<token>` parses ok; `unblock::x`/`deconflict::x`/`resolve::x` still
reject with the updated error string. Handler: round-trip through the existing rpc-handlers
test seam. Re-arm: assert via existing fold/sweep test seams that a DispatchCleared for
(repair, token) deletes the row and a persisting candidate re-mints with null latches — no
live daemon, no real DB beyond the sandboxed fixtures already in use there.

## Acceptance

- [ ] `keeper autopilot retry repair::<token>` passes wire validation, the fold deletes the
  row with its latch markers, and the repair sweep re-dispatches on persisting candidates
  (asserted through existing test seams).
- [ ] unblock, deconflict, and resolve remain rejected with the updated error string; the
  autopilot retry help text and every previously-contradicting docstring state the new
  narrow rule.
- [ ] A recorded call-site audit confirms no code path assumes the retryable and escalation
  verb sets are disjoint; src/reducer.ts and src/db.ts carry no modifications.
- [ ] Fast suite green.

## Done summary

## Evidence
