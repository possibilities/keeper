## Description

**Size:** M
**Files:** src/db.ts, src/types.ts, keeper/api.py, src/reducer.ts, test/reducer-projections.test.ts

### Approach

Bind each escalation session to its block instance, jobs-side. Migration v113: `addColumnIfMissing` adds nullable `jobs.escalation_instance INTEGER` and `dispatch_failures.instance_event_id INTEGER` — no DEFAULT, so a from-scratch re-fold stays byte-identical NULL; both are whitelist-only Python reads (keeper-py reads neither), and the `SCHEMA_VERSION` bump plus the `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS` entry land in the SAME commit. Match the migration-comment density convention (re-fold-safety justification inline).

Reducer, two fold changes: (1) the `dispatch_failures` fold sets `instance_event_id` to the row's first-appearance event id on first INSERT, preserved across every UPSERT/re-emit of the same open row, reborn fresh when a clear + re-mint creates a new incident instance. (2) A NEW branch at the binding SessionStart seam — structurally separate from the pending_dispatches discharge gate, which escalation sessions never trip — for spawn names parsing to `unblock::<task>` / `deconflict::<epic>` / `resolve::<epic>`: corroborate against the prior deterministic projection (unblock: `block_escalations[(epic,task)]` has `outcome='dispatched'` → instance = `blocked_since`; deconflict: `dispatch_failures[close::<epic>]` has `merge_escalated_at` set → instance = `instance_event_id`; resolve: same row has `resolver_dispatched_at` set → same `instance_event_id`) and stamp `dispatch_origin='escalation'` + `escalation_instance` together. Both-or-neither: a corroboration miss (e.g. the task cycled unblocked→re-blocked before the SessionStart folded) leaves BOTH NULL — stamping origin off the name alone would be the heuristic the design forbids. Set-once, COALESCE-preserved on resume. The corroborating event always precedes the binding SessionStart in total order, so the fold reads only prior projections plus the event's own spawn name — re-fold-deterministic including the miss case.

Add `escalation_instance` to the `Job` type.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/reducer.ts:8132-8161 — the binding seam; the discharge-gated autopilot stamp this branch sits beside but does not share a gate with
- src/db.ts:2298 — addColumnIfMissing; src/db.ts:51 — SCHEMA_VERSION (112 at authoring)
- src/db.ts:6040-6090 — prior nullable-jobs-column migrations incl. the COALESCE-preserve jobs.adopted template and whitelist-only-read comments
- keeper/api.py:435 — SUPPORTED_SCHEMA_VERSIONS frozenset
- src/reducer.ts — the dispatch_failures UPSERT fold (find the INSERT/UPDATE sites for sticky rows; preserve-on-UPSERT is the contract)

**Optional** (reference as needed):
- test/reducer-projections.test.ts:2408-2560 — getDispatchOrigin discharge cases + the mandatory from-scratch re-fold byte-identical test to parallel
- src/types.ts:595 — dispatch_origin on the Job type; escalation_instance rides beside it
- src/daemon.ts:1363 — where merge_escalated_at is stamped (context for the deconflict corroboration)

### Risks

- fn-1164 collides on SCHEMA_VERSION + this fold neighborhood: rebase to the next free version number and re-add the whitelist entry if it lands first.
- The corroboration read is a cross-projection read inside applyEvent — precedented by the discharge branch, but the event-order invariant (corroborator precedes SessionStart) is load-bearing; the re-fold test must cover the stamp-miss ordering, not just the happy path.

### Test notes

Parallel the getDispatchOrigin suite: escalation stamp lands for each of the three verbs; stamp-miss (latch cycled) leaves both NULL; resume preserves; from-scratch re-fold reproduces stamps and misses byte-identically; instance_event_id survives an UPSERT re-emit and is reborn on clear + re-mint.

## Acceptance

- [ ] Migration adds both nullable columns with no DEFAULT; fresh and migrated PRAGMA table_info are byte-identical; SCHEMA_VERSION and the api.py whitelist land in the same commit and the schema-version suite is green
- [ ] An unblock/deconflict/resolve session whose corroborating projection row exists gets dispatch_origin='escalation' and the correct instance id stamped at bind; a corroboration miss leaves both NULL
- [ ] instance_event_id is first-appearance-stable across UPSERT re-emits and reborn on re-mint after a clear
- [ ] From-scratch re-fold reproduces all stamps (and misses) byte-identically

## Done summary
Migration v114 adds nullable jobs.escalation_instance + dispatch_failures.instance_event_id (no DEFAULT, whitelist-only Python read). dispatch_failures folds stamp instance_event_id first-appearance-stable (preserved on UPSERT, reborn on clear+re-mint); a new SessionStart branch binds unblock/deconflict/resolve sessions to their block instance via prior-projection corroboration, stamping dispatch_origin='escalation' + escalation_instance both-or-neither, set-once. Re-fold reproduces stamps and misses byte-identically.
## Evidence
