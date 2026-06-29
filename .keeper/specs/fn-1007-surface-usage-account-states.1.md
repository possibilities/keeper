## Description

**Size:** M
**Files:** src/usage-scrape-runner.ts, src/usage-scraper-worker.ts, src/usage-worker.ts, src/reducer.ts, src/db.ts, keeper/api.py, README.md (schema-history)

### Approach

Thread a new `account_state` axis end-to-end, mirroring the `error_kind` (schema v95)
precedent exactly. Add an `AccountState` union (`"signed_out" | "no_subscription"`) +
a `USAGE_ACCOUNT_STATES` set + an `asAccountState` coerce-to-null validator in
usage-scrape-runner.ts (clone the `asUsageErrorKind` shape at :99-124 — do not invent a
new idiom). Add a third `ok` variant to `ScrapeResult` and, in `parseScrapeStdout`'s
`status==="ok"` block (:269-289), check `signed_out` BEFORE `no_subscription` and before
the `usage` check. In `handleSuccess` (:1019), replace the boolean
`subscriptionActive = !noSubscription` with a three-way branch: subscribed →
`subscription_active=true`, `account_state=null`; no_subscription →
`subscription_active=false`, `account_state="no_subscription"`; signed_out →
`subscription_active=null`, `account_state="signed_out"`; codex stays
`account_state=null`. Add `account_state` to `buildEnvelope` (:612); add a
`priorAccountState` helper and carry it forward in `handleFailure` (:1077) alongside
`priorSubscription`/`priorUsage` so a stable signed-out/no-sub account survives a
transient scrape failure without flicker (the stale-error render still surfaces the blip
via precedence). Parse `account_state` (null-safe) into the usage-snapshot message in
usage-worker.ts (:402-441) — `usageGateKey` auto-includes it via the spread (:467). In the
reducer: add `account_state: string | null` to `UsageSnapshotPayload` (:2830); validate
with `asAccountState` in `extractUsageSnapshot` (garbage → null, never throw); add the
column to the usage UPSERT in ALL FOUR places (:3002-3074: column list, `VALUES (?…)`,
`ON CONFLICT DO UPDATE SET`, bind array). In db.ts: add `account_state TEXT` via
`addColumnIfMissing(db,"usage","account_state","TEXT")` in a new v96→v97 block (mirror the
v95 `error_kind` block at ~:5386, with a `v96→v97` provenance comment), nullable, no
DEFAULT, NO cursor rewind / not added to any rewind-DELETE list; bump `SCHEMA_VERSION`
96→97 (:49). In keeper/api.py: add `97` to `SUPPORTED_SCHEMA_VERSIONS` (~:456) in the SAME
commit. Add the README schema-history v96→v97 entry (~:1936) following the v96 pattern.
Do NOT bump `SCRAPE_CONTRACT_SCHEMA_VERSION` or `ENVELOPE_SCHEMA_VERSION` (account_state is
keeper-derived/envelope-only and keeper is the sole envelope reader+writer).

### Investigation targets

**Required** (read before coding):
- src/usage-scrape-runner.ts:99-124 — `UsageErrorKind`/`USAGE_ERROR_KINDS`/`asUsageErrorKind` (the template)
- src/usage-scrape-runner.ts:141-172, 269-289 — `ScrapeResult` arms + `parseScrapeStdout` ok-block
- src/usage-scraper-worker.ts:1008-1070 — `handleResult`/`handleSuccess` (the boolean → three-way change)
- src/usage-scraper-worker.ts:612-664 — `buildEnvelope` + `priorSubscription`/`priorUsage` (add `priorAccountState`)
- src/usage-scraper-worker.ts:1077-1139 — `handleFailure` (carry account_state forward)
- src/usage-worker.ts:402-441, 467 — envelope→message parse + `usageGateKey` spread
- src/reducer.ts:2830-2871 — `UsageSnapshotPayload`
- src/reducer.ts:~2872-2990 — `extractUsageSnapshot` (asString/coerce-to-null helpers)
- src/reducer.ts:3002-3074 — the usage UPSERT (4-spot placeholder discipline)
- src/db.ts:49 — `SCHEMA_VERSION`; src/db.ts:~5373-5386 — the v95 `error_kind` migration block to mirror
- src/db.ts:957-962 — the migration-built usage CREATE literal (do NOT edit; use addColumnIfMissing)
- keeper/api.py:~456 — `SUPPORTED_SCHEMA_VERSIONS`

**Optional** (reference as needed):
- src/db.ts:1925 — `addColumnIfMissing` signature
- README.md:~1936 — the v96 schema-history entry to pattern-match

### Risks

- UPSERT placeholder-count is hand-maintained in 4 spots — a miss silently shifts columns
  or throws a bind-count error. Update all four together.
- Re-fold determinism: `asAccountState` must coerce garbage → NULL and never throw; NULL is
  the zero-event default (no column DEFAULT); a pre-v97 event must re-fold byte-identically.
- No cursor rewind for this additive nullable column (not in any rewind-DELETE list).
- Deploy-skew: this task ADDS keeper's parse of the new arm, so once landed keeper handles
  `signed_out`; ensure it ships before agentusage emits it (a pre-patch keeper → runner_failure).

### Test notes

Extend the reducer/usage fold round-trip: `account_state` persists through UPSERT; a
malformed value folds to NULL; a pre-v97 (field-absent) event folds to NULL. `bun test
test/schema-version.test.ts` auto-fails if db.ts bumps without api.py. Add a
`usageGateKey`-includes-`account_state` assertion in test/usage-worker.test.ts. No daemon /
Worker / subprocess — pure in-process per the suite contract.

## Acceptance

- [ ] `account_state` threads contract → ScrapeResult → envelope → message → fold → `usage` column.
- [ ] `handleSuccess` is a three-way branch (subscribed→true/null, no_subscription→false/"no_subscription",
  signed_out→null/"signed_out"); codex stays NULL.
- [ ] `handleFailure` carries `account_state` forward (via `priorAccountState`).
- [ ] `usage.account_state TEXT` lands via addColumnIfMissing in a v96→v97 block; `SCHEMA_VERSION`=97;
  `SUPPORTED_SCHEMA_VERSIONS` gains 97 in the same commit; no rewind.
- [ ] `extractUsageSnapshot` validates `account_state` (garbage→NULL, never throws); UPSERT updated in all 4 spots.
- [ ] `SCRAPE_CONTRACT_SCHEMA_VERSION` and `ENVELOPE_SCHEMA_VERSION` are unchanged.
- [ ] README schema-history carries the v96→v97 entry.
- [ ] `bun test` green (fold round-trip, schema-version, usage-worker gate).

## Done summary
Threaded the orthogonal account_state axis (signed_out/no_subscription, NULL=subscribed/codex) end-to-end: parse the additive ok+signed_out scrape arm, three-way handleSuccess branch carried forward on transient failure, fold through serialize/extract/UPSERT, and land usage.account_state via schema v96->v97 (+SUPPORTED_SCHEMA_VERSIONS 97). Re-fold deterministic (asAccountState garbage->NULL).
## Evidence
