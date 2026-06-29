## Description

**Size:** M
**Files:** cli/usage.ts, test/usage.test.ts, README.md (usage subsection + projection comment)

### Approach

Replace the blanket hide at cli/usage.ts:320 (`rows.filter(r => r.subscription_active !== 0)`)
with a per-row state switch in `renderRowLines`, precedence **stale-error → account_state →
bars**: a `status==="stale"` row with an `error_kind` renders the existing error line
(unchanged); else `account_state==="signed_out"` → `auth · signed out`; else
`account_state==="no_subscription"` OR `subscription_active===0` (back-compat for
pre-rescrape no-sub rows whose `account_state` is still NULL) → `no active subscription`;
else render the bars as today. The two stable-state lines render as a single standalone
annotation line under the header that does NOT feed the `wLabel`/`wId`/`wTarget`/`wMult`/
`wPct` column math (the phrases are 17 and 22 chars — feeding `wLabel` would shove every
healthy row's bars right and wrap the terminal). Force `isStale=false` and skip the
`stale`/`limited` lines for the two stable states (no usage to age). Add a state-label map
near `ERROR_KIND_LABELS` (:108-122). Add `r.account_state` to `usageRowsHashKey` (:860) so a
state flip repaints. Because un-hidden rows now feed the id/target/mult width pools, verify a
no-sub/signed-out row alongside a healthy row does not shift the healthy row's bars. Update
the top-of-file JSDoc/HELP header (revise the "Untracked profiles … do not render" sentence
~:95-96 and the `subscription_active gating` comment ~:316-320) and the README usage.ts
subsection (~:1282-1332) + projection schema comment (~:3800) to describe the three states
and the `account_state` column accurately.

### Investigation targets

**Required** (read before coding):
- cli/usage.ts:309-321 — `renderRowLines` + the `subscription_active !== 0` hide line
- cli/usage.ts:471-501 — the width pools (`wId`/`wTarget`/`wMult`) + the `wLabel` label pool (the regression site; comment at :318 assumed only visible rows feed it)
- cli/usage.ts:526-583 — `renderError` (fixed-width cell math) + the per-row push loop (`renderBody`/`renderLimited`/`renderStale`/`renderError`) — where the new state line appends
- cli/usage.ts:108-122 — `ERROR_KIND_LABELS`/`errorKindLabel` (label-map pattern to mirror)
- cli/usage.ts:855-889 — `usageRowsHashKey` (add `r.account_state`)
- test/usage.test.ts — `renderRowLines` direct-drive pattern (plain rows + fixed `NOW_MS`, `isoOffset()`, `bodyLine()` helper)

**Optional** (reference as needed):
- cli/usage.ts:75-103 — the HELP string prose to keep in sync
- README.md:~1282-1332, ~3800 — the usage subsection + projection comment to revise

### Risks

- Width-math regression — the two state phrases must NOT enter `wLabel`, and un-hidden rows
  now feed `wId`/`wTarget`/`wMult`; assert a healthy row's bars stay put alongside a state row.
- Back-compat keying — a no-sub row scraped before v97 has `account_state=NULL` but
  `subscription_active=0`; the `no active subscription` line must key on BOTH (else empty `?` bars).
- Header status chip (`active`/`stale`) on a bar-less state row — default keep it; flag if it reads oddly.

### Test notes

Drive `renderRowLines` directly with one row per state (account_state="signed_out",
account_state="no_subscription", and a back-compat `subscription_active=0` / null
account_state row): assert the right label is present and quota bars are absent. Add a
mixed-frame test — a state row alongside a healthy bars row — asserting the healthy row's bar
column offset is unchanged. Confirm `renderRowLines([], NOW_MS)` still returns `[]`.

## Acceptance

- [ ] `signed_out` → `auth · signed out`; `no_subscription` (or back-compat `subscription_active===0`)
  → `no active subscription`; `status="stale"`+error_kind → the existing error line. Precedence: stale-error → account_state → bars.
- [ ] No-subscription rows are no longer hidden; the state line does not feed `wLabel`, and a healthy
  row's bar alignment is unchanged alongside a state row (test-asserted).
- [ ] The two stable states render no `stale`/`limited` line and do not age.
- [ ] `r.account_state` is in `usageRowsHashKey` (a state flip repaints).
- [ ] cli/usage.ts HELP header + README usage subsection + projection comment describe the new states; no stale "do not render" prose.
- [ ] `bun test test/usage.test.ts` green incl. the mixed-frame alignment test.

## Done summary

## Evidence
