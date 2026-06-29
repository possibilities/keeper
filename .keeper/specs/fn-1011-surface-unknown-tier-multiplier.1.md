## Description

**Size:** M
**Files:** src/usage-scraper-worker.ts, cli/usage.ts, README.md (producer section), test/usage-scraper-worker.test.ts, test/usage.test.ts

### Approach

Propagate the raw nullable multiplier end-to-end and render `?x` for an unresolved
tier. PRODUCER: remove the boot `?? 1` in `resolveMultiplier` (src/usage-scraper-worker.ts:296-299)
so it returns `number | null` (return null, never undefined, so the envelope key
persists); widen `Account.multiplier` (:141) and `Envelope.multiplier` (:151) to
`number | null`; `buildEnvelope` (:646) already copies it through. LEAVE
`reResolveMultiplier` (:308-326) keep-prior INTACT — null surfaces only for a boot-time
never-resolved tier, never a transient re-read failure on a good account; update its
warning text for the boot-null case (avoid the literal "keeping prior multiplier nullx")
and the now-stale comment at :711-716. Verify the `priorNum(prior,"multiplier")`
change-detection (:907-909) + `isRedundantParkedWake` (:721-722) behave with null
(null===null suppress is benign; numeric→null on a restart fires a genuine
downgrade-to-unknown — both correct). Do NOT change the weighting consumer
(src/usage-picker.ts:276-283 already coerces null→1) — just confirm it's the sole math
consumer. No schema/SCHEMA_VERSION change (db.ts:898 already nullable). RENDERER: add a
named `formatMultiplier(raw): string` (null → `?`), used at the chip build (cli/usage.ts:472-475)
and remove the trailing literal `x` from the chip template (:597-601) so the formatted
token feeds `wMult` and `?x`/`20x` align. Scope: `?x` shows for a claude row that is
subscription-active (`!isCodex` :408 AND `stableState===null` :462-471) with a null
multiplier; codex keeps `[codex 1x]`; a signed_out/no_subscription claude row with null
multiplier DROPS the multiplier suffix (`[claude]`, fixing today's broken `[claude  x]`),
it does NOT show `?x`.

### Investigation targets

**Required** (read before coding):
- src/usage-scraper-worker.ts:296-299 (boot `?? 1`), :244-273 (resolveMultiplierOrNull), :308-326 (reResolveMultiplier keep-prior + warning), :627-658 (buildEnvelope, multiplier :646), :141 (Account.multiplier), :151 (Envelope.multiplier), :721-722/:907-909 (priorNum change-detection + parked-wake), :711-716 (stale comment)
- cli/usage.ts:119-121 (seg), :472-475 (cell build, mult), :597-601 (chip composition), :408 (isCodex), :462-471 (stableState signed_out/no_sub), :520 (wMult)
- src/usage-picker.ts:276-283 (multiplier() weighting coercion — already null-safe; confirm sole consumer)
- src/reducer.ts:2843/2904/3026 + db.ts:898 (null folds/persists; no schema change)
- test/usage.test.ts:55-95,262-306 (renderRowLines pattern), test/usage-scraper-worker.test.ts:165-202 (buildEnvelope key-set assert), :731-830 (parked re-resolve)

### Risks

- Type widening ripples: `Account`/`Envelope.multiplier` → `number|null` touches buildEnvelope + the priorNum change-detection; verify a null comparison doesn't misfire the "multiplier changed vs prior" path.
- Keep-prior must stay: a transient re-read failure must NOT render `?x` — null is boot-never-resolved only.
- Chip alignment: feed the full formatted token to `wMult` and drop the literal `x`, else `[claude 20xx]` / width jitter.
- Boot-null flap on restart (rare transient file blip → 1-cycle `?x`) is accepted — honest, self-heals; do NOT add boot-keep-prior-from-envelope.

### Test notes

renderRowLines: `?x` for a sub-active claude null-mult row; `[codex 1x]` unaffected; a
signed_out/no_sub null-mult row shows no `?x` and no broken `[claude  x]`; `?x`/`20x`
align. Producer: `buildEnvelope` with `multiplier:null` (key present, value null) — add to
the key-set test; `reResolveMultiplier` keeps a prior over a null re-read; a numeric→null
across restart fires change-detection.

## Acceptance

- [ ] Boot `?? 1` removed; `resolveMultiplier` returns `number|null` (null, not undefined); `Account`/`Envelope.multiplier` widened.
- [ ] `reResolveMultiplier` keep-prior intact; warning text + stale comment fixed; change-detection verified with null.
- [ ] `formatMultiplier` renders `?x` for a sub-active claude null-mult row; codex `[codex 1x]`; signed_out/no_sub null-mult drops the suffix (no `[claude  x]`, no `?x`); tokens align under `wMult`.
- [ ] Picker weighting unchanged (null→1 already); no schema/SCHEMA_VERSION change.
- [ ] HELP + README producer section describe `?x`.
- [ ] `bun test test/usage.test.ts test/usage-scraper-worker.test.ts` green (incl. null-multiplier envelope + `?x` render cases).

## Done summary
Propagate the raw nullable multiplier end-to-end: drop the boot ?? 1 (resolveMultiplierOrNull direct), widen Account/Envelope.multiplier to number|null, and render ?x ('tier unknown') at the display boundary via a named formatMultiplier. Keep-prior re-resolve stays intact (?x only for a boot-never-resolved tier); signed_out/no_subscription null-mult rows drop the suffix; codex keeps 1x. No schema change.
## Evidence
