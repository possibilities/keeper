## Description

**Size:** M
**Files:** src/db.ts, keeper/api.py, src/types.ts

### Approach

Lay the durable foundation everything else builds on. In `src/db.ts`: bump
`SCHEMA_VERSION` (87 as of planning — VERIFY the current value at implementation
and re-base to the next unused version if higher, since fn-941 moved it to 86).
Add a `CREATE_HANDOFFS` table following the `CREATE_PENDING_DISPATCHES` shape:
columns for `handoff_id` (PK), `status`, doc body, `title`, `target_session`,
raw initiator coords (session + pane), `initiator_job_id` (nullable),
`callee_job_id` (nullable), `claimed_at` (event-ts-derived, nullable),
`never_bound_count`, plus `last_event_id INTEGER NOT NULL`. `handoffs` is the
DETERMINISTIC-REPLAYED class: register it in ALL THREE re-fold wipe DELETE
blocks — NOT in `EPHEMERAL_PROJECTIONS` or `LIVE_ONLY_PROJECTIONS`. Add
`handoffPromptPrefix` to the `KeeperConfig` interface and a best-effort parse
arm mirroring `dispatchPromptPrefix` (non-empty-string-only, default
undefined/empty). In `keeper/api.py`: add the new version to
`SUPPORTED_SCHEMA_VERSIONS` in the SAME commit (`test/schema-version.test.ts`
enforces). In `src/types.ts`: add the `HandoffLinkEntry` interface as a sibling
of `JobLinkEntry` — `kind: "handoff-from" | "handoff-to"`, `handoff_id`,
`peer_job_id`, `status`, plus the same enrich annotation fields `JobLinkEntry`
carries (title, state, last_api_error_at, ...). Do NOT widen `JobLinkEntry`'s
kind union.

### Investigation targets

**Required** (read before coding):
- src/db.ts:1059-1186 — CREATE_PENDING_DISPATCHES / CREATE_DISPATCH_NEVER_BOUND table shape to copy (IF NOT EXISTS, last_event_id INTEGER NOT NULL, event-id-not-wallclock doc note)
- src/db.ts:3560-3577, 4464-4468, 4715-4719 — the THREE re-fold wipe DELETE blocks; handoffs must appear in all three
- src/db.ts:117, :142, :275-279 — KeeperConfig interface, dispatchPromptPrefix field, its parse arm to mirror
- src/db.ts:49 — SCHEMA_VERSION (verify current value; re-base from 87 if higher)
- src/db.ts:1483, :1506 — LIVE_ONLY_PROJECTIONS / EPHEMERAL_PROJECTIONS registries (handoffs goes in NEITHER)
- keeper/api.py — SUPPORTED_SCHEMA_VERSIONS frozenset (ends at 86); add the new version
- src/types.ts:95-106 — JobLinkEntry to model HandoffLinkEntry on

**Optional** (reference as needed):
- src/db.ts migrate() body (~:2196-2206) where new CREATE runs

### Risks

- A missing wipe-list block strands the projection on a rewinding migration (every historical event self-gates below a stale cursor). Add to all three.
- Schema version collision with a concurrently-landing epic — re-base at implementation time.
- The doc-body column is read by a fold (keep-set) → it stays inline forever; it must be capped at WRITE time (enforced in task .2), not here.

### Test notes

- A db.test.ts migration test that the v→v+1 step creates `handoffs` and round-trips; use a real openDb (migration exercise). Add the version to schema-version.test.ts expectations.
- A from-scratch re-fold over zero handoff events reproduces an empty `handoffs` table (schema default matches the zero-event projection).

## Acceptance

- [ ] SCHEMA_VERSION bumped to the next unused version; keeper/api.py SUPPORTED_SCHEMA_VERSIONS includes it (same commit)
- [ ] handoffs table created with the documented columns; present in all three re-fold wipe DELETE blocks; absent from EPHEMERAL/LIVE_ONLY registries
- [ ] handoffPromptPrefix on KeeperConfig + best-effort parse arm (default empty), mirroring dispatch_prompt_prefix
- [ ] HandoffLinkEntry type added to src/types.ts; JobLinkEntry kind union unchanged
- [ ] test:full green incl. schema-version.test.ts and a handoffs migration test

## Done summary

## Evidence
