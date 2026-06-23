## Description

**Size:** M
**Files:** src/bus-identity.ts, test/bus-identity.test.ts

### Approach

Extend the pure two-layer resolver `resolveTarget` with a role-address branch that runs BEFORE the existing exact/prefix/substring tier loop. Add two pure helpers:

- `parseRoleAddress(target)` → `{ role: "planner" | "refiner", epic: string } | null`, matching `/^(planner|refiner)@(.+)$/`. The role token is validated against the closed set `{planner, refiner}` so a typo (`plannr@…`) returns `null` and the target falls through to the existing name tiers. A non-role `@`-bearing string (a literal agent name) also returns `null` and falls through — ordering must never hijack a real name.
- `roleJobIds(db, kind, epic)` → reads `epics.job_links` for the one epic (`WHERE epic_id = ?`, bound param), decodes the JSON-TEXT cell DEFENSIVELY (try/parse/catch → `[]`, mirroring `rowToIdentity`/`decodeRow`), filters entries to `entry.kind === kind`, returns the `job_id`s. `kind` mapping: `planner → "creator"`. It reads `epics`, never `jobs`.

In `resolveTarget`, before the tier loop (`src/bus-identity.ts:243`):
1. `parseRoleAddress(target)`; if `null`, continue to the existing tiers unchanged.
2. For `planner`, `roleJobIds(db, "creator", epic)`. For `refiner`, it is recognized but UNWIRED in this task — return `{kind:"unknown", target}` (clean `unknown`, never a name-tier fall-through).
3. Collect ALL creator job_ids (an epic can carry more than one — cross-session creator edges are never suppressed; `src/plan-classifier.ts:296-360`). Resolve each job_id to a `ResolvedIdentity` (a creator job_id IS a session id; reuse the existing identity path), then:
   - 0 ids → `{kind:"unknown", target}`
   - 1 id → recursively `resolveTarget(channels, db, jobId)` (re-enters the exact tier; the job_id carries no role prefix so it cannot re-recurse), yielding `ok` with a live channel or `not_connected`
   - >1 ids → `collapseByLive` over the resolved identities (clean-pick the single connected one, else `ambiguous`)
4. Keep the branch PURE — no env/clock/fs/`Date.now()`; only the `db` + `channels` inputs the resolver already holds.

No change to the resolver CALL SITE (`src/bus-worker.ts:588-590` already passes the read-only `keeperDb`), no change to `PublishOutcome` (`unknown`→`unknown_target`, `ok` with null channel→`not_connected`, `ambiguous`→`ambiguous_target` all already map), no bus.db schema change.

### Investigation targets

**Required** (read before coding):
- src/bus-identity.ts:238-309 — `resolveTarget` (extend); tier loop begins :243 (branch before it)
- src/bus-identity.ts:205-221 — `collapseByLive` (reuse verbatim for >1)
- src/bus-identity.ts:85-103 — `rowToIdentity` (the never-throw JSON-decode idiom to mirror)
- src/bus-identity.ts:153-189 — `jobsAtTier` (bound-param + `json_each` SQL idiom; identity-resolution path to reuse for a job_id)
- src/types.ts:95-106 — `JobLinkEntry { kind:"creator"|"refiner"; job_id }`; Epic.job_links :690 (JSON-TEXT, sorted ASC on (kind,job_id))
- src/collections.ts:744-766 — `decodeRow` never-throw decode; job_links JSON column registered :158,216
- src/db.ts:709 — `epics.job_links TEXT` schema
- src/plan-classifier.ts:296-360 — `deriveJobLinks` (confirms an epic CAN have >1 creator; cross-session edges never suppressed)
- test/bus-identity.test.ts:29-42 — `seedJob` synthetic-row helper to parallel with a new `seedEpic`; freshMemDb from test/helpers/template-db.ts

**Optional:**
- src/bus-worker.ts:265-292 — `PublishOutcome` + `publishOutcome` (confirm the existing vocabulary covers every role outcome; do NOT add one)
- src/bus-worker.ts:588-590, :892-962 — resolver call site + directed-send handler (confirm no change needed)

### Risks

- Branch ordering is load-bearing: a `planner@…` string would otherwise miss all three job-keyed tiers and return `unknown`. The branch MUST precede the tier loop.
- `roleJobIds` reads `epics` while every existing tier reads `jobs` — two tables in one resolver; keep the recursion terminating (a resolved job_id has no role prefix).
- A defensive parse is mandatory: `resolveTarget` runs in the live relay path — a throw fails a real send. Malformed/empty `job_links` → `[]` → `unknown`.
- A just-scaffolded epic whose creator edge has not folded yet resolves to `unknown` transiently — correct fail-soft, covered by the empty-`job_links` test.

### Test notes

Fast-tier, synthetic only (no real git, no subprocess — guarded by `bun run test:hygiene`). Add a `seedEpic(db, {epic_id, job_links})` helper paralleling `seedJob`. Cases:
- planner hit → resolves the creator's live channel (`ok`)
- creator offline (identity known, no socket) → `not_connected` shape (resolver returns `ok` with null channel)
- no creator edge (refiner-only or empty `job_links`) → `unknown`
- unknown epic id → `unknown`
- malformed `job_links` JSON → `unknown`, does NOT throw
- multi-creator: two creator job_ids, one connected → clean-pick; two connected → `ambiguous`
- `refiner@<epic>` → `unknown` (recognized but unwired)
- a literal agent name containing `@` that is NOT a valid role → falls through to the name tiers and resolves normally

## Acceptance

- [ ] `parseRoleAddress` + `roleJobIds` added as pure, never-throw helpers; role branch wired into `resolveTarget` before the tier loop
- [ ] All `kind=="creator"` job_ids are collected and run through `collapseByLive`; single-creator delegates to the existing identity resolution
- [ ] Every outcome maps onto the existing `PublishOutcome` set; no new result code, no bus.db schema change, no resolver-call-site change
- [ ] `refiner@<epic>` returns `unknown`; a non-role `@`-bearing name still resolves via the name tiers
- [ ] New fast-tier tests cover all cases above and pass under `bun test test/bus-identity.test.ts`; `bun run test:full` green

## Done summary
Added parseRoleAddress + roleJobIds pure helpers and wired a role-address branch into resolveTarget so planner@<epic_id> resolves to the epic's creator session(s) via job_links, collapsing multi-creator edges by live channel and mapping every outcome onto the existing PublishOutcome vocabulary; refiner is recognized but unwired.
## Evidence
